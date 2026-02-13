// app/routes/api.rates.jsx
import crypto from "crypto";
import prisma from "../db.server";

import { loadVolumePricingForShop } from "../lib/volumePricingProvider.server";
import { computeVolumeAdjustedMerchCents } from "../lib/volumePricingEngine.server";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_API_SECRET env var");
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

function isBetween(value, minCents, maxCents) {
  if (value < minCents) return false;
  if (maxCents == null) return true;
  return value <= maxCents;
}

function normalizeProvinceCode(p) {
  return String(p || "").trim().toUpperCase();
}
function normalizeCountryCode(c) {
  function getPayableMerchCentsFromPayload(payload) {
    // Shopify "payable" (discounted) subtotal. Used only as fallback if volume-basis fails.
    const r = payload?.rate || {};
    const candidates = [
      r?.order_total,
      r?.order_total_price,
      r?.order_totals?.total_price,
      r?.order_totals?.order_total,
      r?.order_totals?.subtotal_price,
      r?.subtotal_price,
      r?.total_price,
    ];

    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  return String(c || "").trim().toUpperCase();
}

function computeTierPriceCents(tier, basisCents, handlingFeeCents = 0) {
  const tierRateCents =
    tier.priceType === "PERCENT_OF_BASIS"
      ? Math.round((basisCents * (tier.percentBps ?? 0)) / 10000)
      : tier.flatPriceCents ?? 0;

  // Locked behavior: chart-level handlingFeeCents added after tier math
  return tierRateCents + (handlingFeeCents ?? 0);
}

export async function action({ request }) {
  const rawBody = await request.clone().text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyHmac(rawBody, hmac)) {
    return new Response("Invalid HMAC", { status: 401 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (!shop) return new Response("Missing shop param", { status: 400 });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ rates: [] });
  }

  const items = (payload?.rate?.items ?? []).filter((i) => i.requires_shipping);
  if (items.length === 0) return json({ rates: [] });

  // Shipping basis (locked):
  // merchandise subtotal AFTER Volume Pricing only; ignore promo/discount-code discounts.
  // In carrier payload, item.price is integer cents; do NOT use order_totals for basis.
  let merchCents = 0;
  for (const item of items) {
    const unitCents = Number(item?.price);
    const qty = Number(item?.quantity || 0);
    if (!Number.isFinite(unitCents) || !Number.isFinite(qty)) {
      return json({ rates: [] });
    }
    merchCents += unitCents * qty;
  }
  const payableBasisCents = getPayableMerchCentsFromPayload(payload);
  // Load ShopSettings once
  const shopSettings = await prisma.shopSettings.findUnique({ where: { shop } });

  // Optional managed-zone gate:
  // - If managedZoneConfigJson is populated, gate.
  // - If empty/unset, do NOT gate (app returns rates everywhere).
  let managedZoneConfig = null;
  try {
    managedZoneConfig = shopSettings?.managedZoneConfigJson
      ? JSON.parse(shopSettings.managedZoneConfigJson)
      : null;
  } catch {
    managedZoneConfig = null;
  }

  const dest = payload?.rate?.destination || {};
  const destCountry = dest.country_code || dest.country || "";
  const destProvince = dest.province_code || dest.province || "";

  // Apply cached Volume Pricing (NO Shopify calls)
  let basisCents = merchCents;
  let volDebug = null;

  try {
    const { config, eligibilitySnapshot } = await loadVolumePricingForShop(shop);
    const result = computeVolumeAdjustedMerchCents({
      items,
      config,
      eligibilitySnapshot,
      hardItemCap: 500,
    });

    if (result?.ok === true && Number.isFinite(result.volumeAdjustedMerchCents)) {
      basisCents = result.volumeAdjustedMerchCents;
      volDebug = result;
    }
  } catch {
    // Fallback to Shopify payable (discounted) subtotal, but still use OUR tiers.
    if (Number.isFinite(payableBasisCents)) {
      basisCents = payableBasisCents;
      volDebug = { ok: false, error: "volume_pricing_failed_payable_fallback" };
    }
  }

  const charts = await prisma.shippingChart.findMany({
    where: { shop, isActive: true },
    include: {
      tiers: {
        where: { isActive: true },
        orderBy: [{ minCents: "asc" }, { maxCents: "asc" }],
      },
    },
    orderBy: { priority: "desc" },
  });

  const descParts = [];
  // Keep your helpful debug line if you want; comment out if not needed:
  descParts.push(`Merch (payload): $${(merchCents / 100).toFixed(2)}`);
  descParts.push(`Basis after vol: $${(basisCents / 100).toFixed(2)}`);
  if (volDebug?.appliedTier?.minEligibleQty) {
    const off = (Number(volDebug.appliedTier.discountCentsEach || 0) / 100).toFixed(2);
    descParts.push(
      `Vol tier: ${volDebug.appliedTier.minEligibleQty}+ → -$${off}/ea`
    );
    descParts.push(`Eligible qty: ${Number(volDebug.eligibleQty || 0)}`);
  }

  // Return ONE rate per active chart
  const rates = [];
  for (const chart of charts) {
    let matchedTier = null;

    for (const tier of chart.tiers) {
      if (!isBetween(basisCents, tier.minCents, tier.maxCents)) continue;
      matchedTier = tier;
      break;
    }
    if (!matchedTier) continue;

    const priceCents = computeTierPriceCents(
      matchedTier,
      basisCents,
      chart?.handlingFeeCents ?? 0
    );

    rates.push({
      chartName: chart.name, // fixes “Standard” issue
      chartId: chart.id,
      tierName: matchedTier.name,
      priceCents,
    });
  }

  if (rates.length === 0) return json({ rates: [] });

  return json({
    rates: rates.map((r) => ({
      service_name: r.chartName,
      service_code: String(r.chartId),
      total_price: String(r.priceCents),
      currency: payload?.rate?.currency || "USD",
      description: [...descParts, `Tier: ${r.tierName}`].join(" • "),
    })),
  });
}
