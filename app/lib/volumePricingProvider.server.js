// app/lib/pricing/volumePricingProvider.server.js
import prisma from "../../db.server";

function safeJsonParse(str, fallback) {
  try {
    if (typeof str !== "string" || !str.trim()) return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Accept either {version:1, tiers:[...]} or legacy-ish {volumeTable:[...]}
  if (raw.version === 1 && Array.isArray(raw.tiers)) {
    return { version: 1, tiers: raw.tiers };
  }

  if (Array.isArray(raw.volumeTable)) {
    return {
      version: 1,
      tiers: raw.volumeTable.map((t) => ({
        minEligibleQty: Number(t?.minEligibleQty ?? 0),
        discountCentsEach: Number(t?.discountCentsEach ?? 0),
      })),
    };
  }

  return null;
}

function normalizeEligibility(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.version === 1) return raw;

  // If someone stored { eligibleProductIds, excludedProductIds } without version:
  if (Array.isArray(raw.eligibleProductIds) || Array.isArray(raw.excludedProductIds)) {
    return {
      version: 1,
      eligibleProductIds: raw.eligibleProductIds || [],
      excludedProductIds: raw.excludedProductIds || [],
    };
  }

  return null;
}

export async function loadVolumePricingForShop(shop) {
  const shopSettings = await prisma.shopSettings.findUnique({ where: { shop } });

  const config = normalizeConfig(
    safeJsonParse(shopSettings?.volumePricingConfigJson, null)
  );
  const eligibilitySnapshot = normalizeEligibility(
    safeJsonParse(shopSettings?.volumeEligibilitySnapshotJson, null)
  );

  return {
    config,
    eligibilitySnapshot,
  };
}
