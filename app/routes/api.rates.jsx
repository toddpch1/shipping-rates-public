import crypto from "crypto";
import prisma from "../db.server";
import { shopify } from "../shopify.server";

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
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

function dollarsToCents(n) {
  return Math.round(n * 100);
}

function isBetween(value, minCents, maxCents) {
  if (value < minCents) return false;
  if (maxCents == null) return true;
  return value <= maxCents;
}

function computeTierPriceCents(tier, basisCents, handlingFeeCents = 0) {
  const tierRateCents =
    tier.priceType === "PERCENT_OF_BASIS"
      ? Math.round((basisCents * (tier.percentBps ?? 0)) / 10000)
      : (tier.flatPriceCents ?? 0);

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
    return new Response("Invalid JSON", { status: 400 });
  }

  const items = (payload?.rate?.items ?? []).filter(i => i.requires_shipping);
  if (items.length === 0) return json({ rates: [] });

  const offlineSessionId = `offline_${shop}`;
  const session = await shopify.sessionStorage.loadSession(offlineSessionId);
  if (!session) return new Response("Offline session not found", { status: 404 });

  const client = new shopify.api.clients.Graphql({ session });

  const variantIds = items.map(
    i => `gid://shopify/ProductVariant/${i.variant_id}`
  );

  const query = `
    query VariantInfo($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
        }
      }
    }
  `;

  const result = await client.request(query, { variables: { ids: variantIds } });
  const nodes = result?.data?.nodes ?? [];

  const priceByVariant = new Map();
  for (const n of nodes) {
    if (n?.id && n?.price != null) {
      priceByVariant.set(n.id, dollarsToCents(Number(n.price)));
    }
  }

  let merchCents = 0;
  for (const item of items) {
    const gid = `gid://shopify/ProductVariant/${item.variant_id}`;
    const unit = priceByVariant.get(gid);
    if (unit == null) return new Response("Missing variant price", { status: 404 });
    merchCents += unit * item.quantity;
  }

  const charts = await prisma.shippingChart.findMany({
    where: { shop, isActive: true },
    include: { tiers: { where: { isActive: true } } },
    orderBy: { priority: "desc" },
  });

  let best = null;

  for (const chart of charts) {
    for (const tier of chart.tiers) {
      if (!isBetween(merchCents, tier.minCents, tier.maxCents)) continue;

      const rateCents = computeTierPriceCents(
        tier,
        basisCents,
        chart?.handlingFeeCents ?? 0
      );

      if (!best || priceCents > best.priceCents) {
        best = {
          service_name: tier.name,
          service_code: tier.serviceCode ?? tier.id,
          priceCents,
        };
      }
    }
  }

  if (!best) return json({ rates: [] });

  return json({
    rates: [
      {
        service_name: best.service_name,
        service_code: best.service_code,
        total_price: String(best.priceCents),
        currency: payload.rate.currency,
        description: `Pre-discount merchandise: $${(merchCents / 100).toFixed(2)}`,
      },
    ],
  });
}
