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

  // Shopify collection search via Admin GraphQL
  const query = `
    query Collections($first: Int!, $query: String!) {
      collections(first: $first, query: $query) {
        edges {
          node {
            id
            title
            handle
          }
        }
      }
    }
  `;

  // Query syntax supports title:... searching
  const variables = { first: 20, query: `title:*${q}*` };

  const resp = await admin.graphql(query, { variables });
  const data = await resp.json();

  const edges = data?.data?.collections?.edges || [];
  const options = edges.map((e) => ({
    id: e.node.id,
    label: e.node.title,
    value: e.node.id, // store ID
  }));

  return new Response(JSON.stringify({ ok: true, options }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
