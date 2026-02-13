// app/lib/pricing/volumePricingEngine.server.js

/**
 * Volume Pricing engine (server-only).
 * - Integer cents only
 * - Safe fallbacks
 * - Mix-and-match eligible qty across cart
 *
 * Normalized config shape (v1):
 * {
 *   version: 1,
 *   tiers: [{ minEligibleQty: number, discountCentsEach: number }],
 * }
 *
 * Eligibility snapshot shape (v1):
 * {
 *   version: 1,
 *   eligibleProductIds: string[],   // numeric Shopify product IDs as strings (no gid://)
 *   excludedProductIds: string[],   // exclusions win over eligibility
 * }
 */

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

function clampInt(n, min, max) {
  const x = toInt(n, min);
  return Math.min(Math.max(x, min), max);
}

function normalizeIdLike(v) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  // If gid://shopify/Product/123 -> 123
  const m = s.match(/\/(\d+)\s*$/);
  if (m) return m[1];
  // If already numeric-like
  if (/^\d+$/.test(s)) return s;
  return s;
}

function pickBestTier(tiers, eligibleQty) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const q = toInt(eligibleQty, 0);

  // Highest minEligibleQty <= q wins
  let best = null;
  for (const t of tiers) {
    const minEligibleQty = toInt(t?.minEligibleQty, 0);
    const discountCentsEach = toInt(t?.discountCentsEach, 0);
    if (minEligibleQty <= 0) continue;
    if (discountCentsEach <= 0) continue;
    if (q >= minEligibleQty) {
      if (!best || minEligibleQty > best.minEligibleQty) {
        best = { minEligibleQty, discountCentsEach };
      }
    }
  }
  return best;
}

/**
 * @param {Object} args
 * @param {Array} args.items Shopify carrier payload items (requires_shipping already filtered is fine)
 * @param {Object|null} args.config normalized config
 * @param {Object|null} args.eligibilitySnapshot eligibility snapshot
 * @param {number} args.hardItemCap safety cap
 */
export function computeVolumeAdjustedMerchCents({
  items,
  config,
  eligibilitySnapshot,
  hardItemCap = 500,
}) {
  // Safe fallback: no change
  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: true,
      volumeAdjustedMerchCents: 0,
      eligibleQty: 0,
      appliedTier: null,
      discountCentsTotal: 0,
      warnings: [],
    };
  }

  const warnings = [];

  const tiers = config?.version === 1 ? config?.tiers : null;
  const eligibleSet =
    eligibilitySnapshot?.version === 1
      ? new Set((eligibilitySnapshot.eligibleProductIds || []).map(normalizeIdLike))
      : new Set();
  const excludedSet =
    eligibilitySnapshot?.version === 1
      ? new Set((eligibilitySnapshot.excludedProductIds || []).map(normalizeIdLike))
      : new Set();

  // If there’s no config tiers, do nothing
  if (!Array.isArray(tiers) || tiers.length === 0) {
    let merchCents = 0;
    const capped = items.slice(0, hardItemCap);
    if (items.length > hardItemCap) warnings.push("items_capped");
    for (const item of capped) {
      const unitCents = toInt(item?.price, 0);
      const qty = clampInt(item?.quantity, 0, 1_000_000);
      merchCents += unitCents * qty;
    }
    return {
      ok: true,
      volumeAdjustedMerchCents: merchCents,
      eligibleQty: 0,
      appliedTier: null,
      discountCentsTotal: 0,
      warnings,
    };
  }

  const cappedItems = items.slice(0, hardItemCap);
  if (items.length > hardItemCap) warnings.push("items_capped");

  // 1) compute original merch + eligible qty
  let merchCents = 0;
  let eligibleQty = 0;

  const normalized = cappedItems.map((item) => {
    const unitCents = toInt(item?.price, 0);
    const qty = clampInt(item?.quantity, 0, 1_000_000);
    const productId = normalizeIdLike(item?.product_id || item?.productId || item?.product);

    const isExcluded = productId && excludedSet.has(productId);
    const isEligible = productId && eligibleSet.has(productId) && !isExcluded;

    merchCents += unitCents * qty;
    if (isEligible) eligibleQty += qty;

    return {
      unitCents,
      qty,
      productId,
      isEligible,
      isExcluded,
    };
  });

  // If eligibility snapshot is empty, default to “ineligible” (safe)
  if (eligibleSet.size === 0) {
    return {
      ok: true,
      volumeAdjustedMerchCents: merchCents,
      eligibleQty: 0,
      appliedTier: null,
      discountCentsTotal: 0,
      warnings: [...warnings, "eligibility_missing_or_empty"],
    };
  }

  // 2) pick tier by eligibleQty
  const appliedTier = pickBestTier(tiers, eligibleQty);
  if (!appliedTier) {
    return {
      ok: true,
      volumeAdjustedMerchCents: merchCents,
      eligibleQty,
      appliedTier: null,
      discountCentsTotal: 0,
      warnings,
    };
  }

  const discountEach = toInt(appliedTier.discountCentsEach, 0);

  // 3) apply discount to eligible items only, clamp at 0 per unit
  let discountCentsTotal = 0;
  let adjustedMerchCents = 0;

  for (const it of normalized) {
    const baseUnit = it.unitCents;
    const qty = it.qty;

    if (!it.isEligible) {
      adjustedMerchCents += baseUnit * qty;
      continue;
    }

    const discountedUnit = Math.max(0, baseUnit - discountEach);
    adjustedMerchCents += discountedUnit * qty;
    discountCentsTotal += (baseUnit - discountedUnit) * qty;
  }

  return {
    ok: true,
    volumeAdjustedMerchCents: adjustedMerchCents,
    eligibleQty,
    appliedTier,
    discountCentsTotal,
    warnings,
  };
}
