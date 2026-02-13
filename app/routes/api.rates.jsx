// app/routes/api.rates.jsx
import crypto from "crypto";
import prisma from "../db.server";
import { loadVolumePricingForShop } from "../lib/pricing/volumePricingProvider.server";
import { computeVolumeAdjustedMerchCents } from "../lib/pricing/volumePricingEngine.server";

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
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
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
  return String(c || "").trim().toUpperCase();
}

/**
 * managedZoneConfigJson shape (from Settings):
 * {
 *   groups: {
 *     northAmerica: { countries: { US:{provinces:["CO",...]}, CA:{...} } },
 *     international:{ countries: { GB:{selected:true}, ... } }
 *   }
 * }
 */
function isDestinationManaged(managedZoneConfig, destCountry, destProvince) {
  const cfg = managedZoneConfig?.groups || {};
  const cc = normalizeCountryCode(destCountry);
  const pc = normalizeProvinceCode(destProvince);

  // Same split as Settings UI
  const isNA = cc === "US" || cc === "CA" || cc === "MX";
  const groupKey = isNA ? "northAmerica" : "international";

  const countries = cfg?.[groupKey]?.countries || {};
  const entry = countries?.[cc];
  if (!entry) return false;

  // Country-level selection
  if (entry?.selected === true) return true;

  const provs = Array.isArray(entry?.provinces)
    ? entry.provinces.map(normalizeProvinceCode)
    : [];
  if (provs.length === 0) return false;

  // If Shopify doesn’t send a province, be safe: treat as unmanaged
  if (!pc) return false;

  return provs.includes(pc);
}

function computeTierPriceCents(tier, basisCents, handlingFeeCents = 0) {
  const tierRateCents =
    tier.priceType === "PERCENT_OF_BASIS"
      ? Math.round((basisCents * (tier.percentBps ?? 0)) / 10000)
      : tier.flatPriceCents ?? 0;

  // Locked behavior: chart-level handlingFeeCents added after tier math
  return tierRateCents + (handlingFeeCents ?? 0);
}

function safeJsonParse(str, fallback) {
  try {
    if (typeof str !== "string") return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
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
    // Fail closed: no rates
    return json({ rates: [] });
  }

  const items = (payload?.rate?.items ?? []).filter((i) => i.requires_shipping);
  if (items.length === 0) return json({ rates: [] });

  // Shipping basis (locked):
  // merchandise subtotal AFTER Volume Pricing only; ignore promo/discount-code discounts.
  // In carrier payload, item.price is integer cents and is the best available
  // "ignore promo discounts" signal (do NOT use discounted_price / total_price).
  let merchCents = 0;
  for (const item of items) {
    const unitCents = Number(item?.price);
    const qty = Number(item?.quantity || 0);
    if (!Number.isFinite(unitCents) || !Number.isFinite(qty)) {
      // Fail closed
      return json({ rates: [] });
    }
    merchCents += unitCents * qty;
  }

  // --- Managed zones gate (locked behavior) ---
  const shopSettings = await prisma.shopSettings.findUnique({ where: { shop } });

  let managedZoneConfig = safeJsonParse(shopSettings?.managedZoneConfigJson, null);

  const dest = payload?.rate?.destination || {};
  const destCountry = dest.country_code || dest.country || "";
  const destProvince = dest.province_code || dest.province || "";

  // Outside managed zones => [] so Shopify/manual rates apply (locked)
  if (!isDestinationManaged(managedZoneConfig, destCountry, destProvince)) {
    return json({ rates: [] });
  }

  // --- Apply cached Volume Pricing (NO Shopify calls) ---
  let basisCents = merchCents;
  let volumeMeta = null;

  try {
    const { config, eligibilitySnapshot } = await loadVolumePricingForShop(shop);
    const result = computeVolumeAdjustedMerchCents({
      items,
      config,
      eligibilitySnapshot,
      hardItemCap: 500,
    });

    // If provider/eligibility missing, engine returns safe fallbacks
    if (result?.ok === true) {
      basisCents = result.volumeAdjustedMerchCents;
      volumeMeta = result;
    }
  } catch {
    // Safe: keep basisCents = merchCents
    volumeMeta = { ok: false, error: "volume_pricing_failed_safe_fallback" };
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

  let best = null;

  // First match wins (charts already sorted by priority desc)
  for (const chart of charts) {
    for (const tier of chart.tiers) {
      if (!isBetween(basisCents, tier.minCents, tier.maxCents)) continue;

      const priceCents = computeTierPriceCents(
        tier,
        basisCents,
        chart?.handlingFeeCents ?? 0
      );

      best = {
        service_name: tier.name,
        service_code: tier.serviceCode ?? tier.id,
        priceCents,
      };
      break;
    }
    if (best) break;
  }

  // Fail closed if no tier matched
  if (!best) return json({ rates: [] });

  const descParts = [
    `Merch (payload): $${(merchCents / 100).toFixed(2)}`,
    `Basis after volume: $${(basisCents / 100).toFixed(2)}`,
  ];

  if (volumeMeta?.appliedTier) {
    descParts.push(
      `Vol tier: ${volumeMeta.appliedTier.minEligibleQty}+ => -$${(
        volumeMeta.appliedTier.discountCentsEach / 100
      ).toFixed(2)}/ea`
    );
    descParts.push(`Eligible qty: ${volumeMeta.eligibleQty}`);
  }

  return json({
    rates: [
      {
        service_name: best.service_name,
        service_code: String(best.service_code),
        total_price: String(best.priceCents),
        currency: payload?.rate?.currency || "USD",
        description: descParts.join(" • "),
      },
    ],
  });
}
