import prisma from "../db.server";

// POST /api/internal/sync-volume-pricing?shop=...
// Header: x-internal-secret: <INTERNAL_SYNC_SECRET>
export async function action({ request }) {
  const secret = request.headers.get("x-internal-secret");
  if (!process.env.INTERNAL_SYNC_SECRET || secret !== process.env.INTERNAL_SYNC_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (!shop) return new Response("Missing shop param", { status: 400 });

  // Offline session token (same table your app already uses)
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
  });

  if (!session?.accessToken) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "No offline session found for shop. Open the app in Shopify Admin to re-auth and create offline_<shop> session.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const settings =
    (await prisma.shopSettings.findUnique({ where: { shop } })) ||
    (await prisma.shopSettings.create({ data: { shop } }));

  const label = (settings.volumeDiscountLabel || "Volume Pricing").trim();
  const labelLower = label.toLowerCase();

  const adminGraphql = async (query, variables) => {
    // Match your existing pattern: direct Admin GraphQL call with session.accessToken
    const apiVersion = "2025-10";
    const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Admin GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
    if (json.errors?.length) throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors)}`);
    return json;
  };

  try {
    const query = `#graphql
      query DiscountNodesByTitle($first:Int!, $query:String!) {
        discountNodes(first: $first, query: $query) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
                startsAt
                endsAt
              }
              ... on DiscountAutomaticBasic {
                title
                status
                startsAt
                endsAt
                customerGets {
                  value {
                    __typename
                    ... on DiscountPercentage { percentage }
                    ... on DiscountAmount { amount { amount currencyCode } }
                  }
                }
              }
              ... on DiscountAutomaticBxgy {
                title
                status
                startsAt
                endsAt
              }
              ... on DiscountAutomaticFreeShipping {
                title
                status
                startsAt
                endsAt
              }
            }
          }
        }
      }
    `;

    // Reduce payload; we still JS-filter case-insensitive contains
    const vars = { first: 100, query: `title:${label}` };
    const json = await adminGraphql(query, vars);

    const nodes = json?.data?.discountNodes?.nodes || [];
    const matches = nodes
      .map((n) => n?.discount)
      .filter(Boolean)
      .filter((d) => String(d.title || "").toLowerCase().includes(labelLower));

    const snapshot = {
      version: 1,
      pulledAt: new Date().toISOString(),
      labelMatched: label,
      discounts: matches.map((d) => ({
        type: d.__typename,
        title: d.title,
        status: d.status,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        // Keep minimal raw for now; we’ll expand once we confirm Dealeasy shape
        raw: d.__typename === "DiscountAutomaticBasic" ? d : undefined,
        note:
          d.__typename === "DiscountAutomaticApp"
            ? "App-managed automatic discount; rule details may not be readable enough to apply in /api/rates until we confirm structure."
            : undefined,
      })),
    };

    await prisma.shopSettings.update({
      where: { shop },
      data: {
        volumePricingSnapshotJson: JSON.stringify(snapshot),
        volumePricingSnapshotVersion: 1,
        volumePricingLastSyncedAt: new Date(),
        volumePricingLastSyncError: null,
      },
    });

    return new Response(JSON.stringify({ ok: true, shop, matched: snapshot.discounts.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.shopSettings.update({
      where: { shop },
      data: { volumePricingLastSyncError: message },
    });

    return new Response(JSON.stringify({ ok: false, shop, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
