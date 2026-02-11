// app/routes/app.jsx
import { Outlet, useLoaderData, useLocation } from "react-router";
import { redirect } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Frame } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";


async function syncZonesSnapshot(admin) {
  const zonesQuery = `#graphql
    query DeliveryZonesOnly {
      deliveryProfiles(first: 25) {
        edges {
          node {
            profileLocationGroups {
              locationGroupZones(first: 150) {
                edges {
                  node {
                    zone {
                      id
                      name
                      countries {
                        name
                        code { countryCode restOfWorld }
                        provinces { name code }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const zonesRes = await admin.graphql(zonesQuery);
  const zonesJson = await zonesRes.json();

  if (zonesJson?.errors?.length) {
    throw new Error(zonesJson.errors.map((e) => e.message).join("; "));
  }

  const zones = [];
  const dpEdges = zonesJson?.data?.deliveryProfiles?.edges || [];
  for (const dpEdge of dpEdges) {
    const plgs = dpEdge?.node?.profileLocationGroups || [];
    for (const plg of plgs) {
      const lgzEdges = plg?.locationGroupZones?.edges || [];
      for (const lgzEdge of lgzEdges) {
        const zone = lgzEdge?.node?.zone;
        if (!zone?.id) continue;

        const countries = Array.isArray(zone?.countries) ? zone.countries : [];
        zones.push({
          id: zone.id,
          name: zone.name || "Zone",
          countries: countries
            .map((c) => ({
              name: c?.name || (c?.code?.countryCode ?? "Country"),
              code: c?.code?.countryCode ?? null,
              provinces: (Array.isArray(c?.provinces) ? c.provinces : [])
                .map((p) => ({
                  code: p?.code ?? null,
                  name: p?.name ?? p?.code ?? "Province",
                }))
                .filter((p) => p.code),
            }))
            .filter((c) => c.code),
        });
      }
    }
  }

  // Dedup by zone id
  const seen = new Set();
  const zonesDeduped = zones.filter((z) => {
    if (seen.has(z.id)) return false;
    seen.add(z.id);
    return true;
  });

  return {
    version: 1,
    pulledAt: new Date().toISOString(),
    zones: zonesDeduped,
  };
}

function base64HostFromShop(shop) {
  // Common workaround: host is base64 + URL encoded. Many apps use `${shop}/admin`.
  // Shopify expects `host` to represent the admin host context. :contentReference[oaicite:2]{index=2}
  const raw = `${shop}/admin`;
  return encodeURIComponent(Buffer.from(raw, "utf8").toString("base64"));
}

export async function loader({ request }) {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const host = url.searchParams.get("host");

  // If we hard-refresh inside admin, Shopify sometimes does not include `host`.
  // Without it, App Bridge won’t initialize and NavMenu will render as plain links in the iframe.
  if (!host) {
  url.searchParams.set("host", base64HostFromShop(session.shop));
  url.searchParams.set("embedded", "1");
  return redirect(url.toString());
}

// ---- Initial install: ensure zones snapshot exists ----
const shop = session.shop;

const settings = await prisma.shopSettings.upsert({
  where: { shop },
  update: {},
  create: { shop },
});

// If we have never synced zones, do it immediately (first load after install)
if (!settings?.zonesSnapshotJson) {
  try {
    const zonesSnapshot = await syncZonesSnapshot(admin);

    await prisma.shopSettings.update({
      where: { shop },
      data: {
        zonesSnapshotJson: JSON.stringify(zonesSnapshot),
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.shopSettings.update({
      where: { shop },
      data: { lastSyncError: msg },
    });
    // You said you’re okay if it throws; but keeping the app usable is nicer.
    // If you truly want it to hard-fail, we can `throw e` here.
  }
}

return { apiKey: process.env.SHOPIFY_API_KEY || "" };

}

export default function App() {
  const { apiKey } = useLoaderData();
  const location = useLocation();
  const search = location.search || "";

  return (
    <AppProvider apiKey={apiKey} embedded>
      {/* Dealeasy-style submenu under the app name in Shopify Admin */}
      <NavMenu>
        <a href={`/app/tiers${search}`}>Shipping Charts</a>
        <a href={`/app/settings${search}`}>Settings</a>
      </NavMenu>

      {/* Keep Frame for Polaris layout; NO in-app sidebar */}
      <Frame>
        <Outlet />
      </Frame>
    </AppProvider>
  );
}
