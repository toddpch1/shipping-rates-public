import crypto from "crypto";
import prisma from "../db.server";

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
  return String(c || "").trim().toUpperCase();
}

/**
 * managedZoneConfigJson shape (from Settings):
 * {
 *   groups: {
 *     northAmerica: { countries: { US:{provinces:["CO",...]}, CA:{...} } },
 *     international: { countries: { GB:{selected:true}, ... } }
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
      : (tier.flatPriceCents ?? 0);

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
    console.log("[/api/rates] keys", Object.keys(payload || {}));
    console.log("[/api/rates] rate keys", Object.keys(payload?.rate || {}));
    console.log("[/api/rates] first item sample", JSON.stringify(payload?.rate?.items?.[0] ?? null, null, 2));
    console.log("[/api/rates] discounts sample", JSON.stringify(payload?.rate?.discounts ?? payload?.rate?.applied_discounts ?? null, null, 2));
    console.log("[/api/rates] order_totals", JSON.stringify(payload?.rate?.order_totals ?? null, null, 2));
  } catch {
    // Fail closed: no rates
    return json({ rates: [] });
  }

  const items = (payload?.rate?.items ?? []).filter((i) => i.requires_shipping);
  // DEBUG: inspect carrier payload item fields (remove once confirmed)
const first = payload?.rate?.items?.[0] ?? null;
if (first) {
  console.log("[/api/rates] first item keys", Object.keys(first));
  console.log("[/api/rates] first item price fields", {
    price: first.price,
    discounted_price: first.discounted_price,
    line_price: first.line_price,
    total_price: first.total_price,
    original_line_price: first.original_line_price,
    original_price: first.original_price,
  });
}
console.log("[/api/rates] order_totals", payload?.rate?.order_totals);

  if (items.length === 0) return json({ rates: [] });

  // Shipping basis (locked):
  // pre-discount merchandise subtotal AFTER Volume Pricing only.
  // In carrier-service payload, item.price is integer cents and is the best available
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

  // --- Managed zones gate ---
  // TEMP: disable gate while Settings are paused so we can validate tier math + Shopify shipping discounts.
  // When you re-enable managed zones later, flip this to true.
  const ENABLE_MANAGED_ZONE_GATE = false;
  const shopSettings = await prisma.shopSettings.findUnique({ where: { shop } });

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

  // Outside managed zones => [] so Shopify/manual rates apply (locked)
  if (ENABLE_MANAGED_ZONE_GATE && !isDestinationManaged(managedZoneConfig, destCountry, destProvince)) {
    return json({ rates: [] });
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

  const basisCentsRaw = payload?.rate?.order_totals?.total_price;
  const basisCents = Number.isFinite(Number(basisCentsRaw)) ? Number(basisCentsRaw) : merchCents;

  let best = null;

  const rates = [];

  // First match wins (charts already sorted by priority desc)
  for (const chart of charts) {
    for (const tier of chart.tiers) {
      if (!isBetween(basisCents, tier.minCents, tier.maxCents)) continue;

      const priceCents = computeTierPriceCents(
        tier,
        basisCents,
        chart?.handlingFeeCents ?? 0
      );

      rates.push({
        service_name: chart.name,
        service_code: `${chart.id}:${tier.id}`,
        priceCents,
      });
      break;
    }
  }

  // Fail closed if no tier matched
  if (rates.length === 0) return json({ rates: [] });

  return json({
    rates: rates.map((r) => ({
      service_name: r.service_name,
      service_code: r.service_code,
      total_price: String(r.priceCents),
      currency: "USD",
    })),
  });
}
