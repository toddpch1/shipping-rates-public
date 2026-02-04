import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (!q) {
    return new Response(JSON.stringify({ ok: true, options: [] }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { admin } = await authenticate.admin(request);

  // Shopify productTags query exists in Admin GraphQL (returns string tag values)
  const query = `
    query ProductTags($first: Int!, $query: String!) {
      productTags(first: $first, query: $query) {
        edges { node }
      }
    }
  `;

  const variables = { first: 20, query: q };

  const resp = await admin.graphql(query, { variables });
  const data = await resp.json();

  const edges = data?.data?.productTags?.edges || [];
  const options = edges.map((e) => ({
    id: e.node,
    label: e.node,
    value: e.node, // store tag text
  }));

  return new Response(JSON.stringify({ ok: true, options }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
