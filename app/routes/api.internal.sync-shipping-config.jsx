import prisma from "../db.server";
import { sessionStorage } from "../shopify.server";

async function adminGraphql(session, query, variables) {
  const apiVersion = "2025-10"; // matches ApiVersion.October25 used in shopify.server.js
  const url = `https://${session.shop}/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `Admin GraphQL HTTP ${res.status}: ${JSON.stringify(json) || res.statusText}`
    );
  }

  if (json?.errors?.length) {
    throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireInternalSecret(request) {
  const expected = process.env.INTERNAL_SYNC_SECRET;
  if (!expected) {
    return new Response("INTERNAL_SYNC_SECRET not configured", { status: 500 });
  }
  const got = request.headers.get("x-internal-secret");
  if (!got || got !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

// --- Shopify fetchers ---

async function fetchZonesSnapshot(session) {
  // Delivery zones live under deliveryProfiles -> profileLocationGroups -> locationGroupZones -> zone
  // (Shopify Admin GraphQL docs: deliveryProfiles + DeliveryZone fields) :contentReference[oaicite:1]{index=1}
  const query = `
    query ZonesSnapshot {
      deliveryProfiles(first: 50, merchantOwnedOnly: true) {
        nodes {
          id
          name
          profileLocationGroups {
            locationGroupZones(first: 100) {
              nodes {
                zone {
                  id
                  name
                  countries {
                    id
                    code {
                        countryCode
                        restOfWorld
                    }
                    name
                    provinces {
                        code
                        name
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

  const res = await adminGraphql(session, query);
  const profiles = res?.data?.deliveryProfiles?.nodes ?? [];


  // Flatten unique zones by ID
  const zoneById = new Map();

  for (const p of profiles) {
    const groups = p?.profileLocationGroups ?? [];
    for (const g of groups) {
      const lgz = g?.locationGroupZones?.nodes ?? [];
      for (const row of lgz) {
        const z = row?.zone;
        if (!z?.id) continue;

        if (!zoneById.has(z.id)) {
          zoneById.set(z.id, {
            id: z.id,
            name: z.name ?? "",
            countries: (z.countries ?? []).map((c) => ({
              id: c.id,
              code: c.code?.restOfWorld
                ? "REST_OF_WORLD"
                : c.code?.countryCode ?? null, // ISO alpha-2
              name: c.name ?? "",
              provinces: (c.provinces ?? []).map((pr) => ({
                code: pr.code,
                name: pr.name ?? "",
              })),
            })),
          });
        }
      }
    }
  }

  return {
    version: 1,
    pulledAt: new Date().toISOString(),
    zones: Array.from(zoneById.values()),
  };
}

async function fetchServicesSnapshot(session) {
  // carrierServices gives configured carrier services (shipping services) :contentReference[oaicite:2]{index=2}
  const query = `
    query ServicesSnapshot {
      carrierServices(first: 50) {
        nodes {
          id
          name
          active
          callbackUrl
        }
      }
    }
  `;

  const res = await adminGraphql(session, query);

  const services = res?.data?.carrierServices?.nodes ?? [];

    return {
    version: 1,
    pulledAt: new Date().toISOString(),
    services: services.map((s) => ({
        id: s.id,
        name: s.name ?? "",
        active: !!s.active,
        callbackUrl: s.callbackUrl ?? "",
    })),
    };
}

async function maybeEmitFlowZonesSyncFailed({ session, error }) {
  const triggerId = process.env.FLOW_ZONES_SYNC_FAILED_TRIGGER_ID;
  if (!triggerId) return;

  // We’ll wire the exact mutation payload once your Flow trigger extension is in place.
  // For now: do nothing unless triggerId exists.
  // (Flow triggers are fired via Admin GraphQL flowTriggerReceive once configured.) :contentReference[oaicite:3]{index=3}
  void session;
  void error;
}

// --- main action ---

export async function action({ request }) {
  const authErr = requireInternalSecret(request);
  if (authErr) return authErr;

  // Find shops with offline sessions
  const offlineSessions = await prisma.session.findMany({
    where: { id: { startsWith: "offline_" } },
    select: { id: true, shop: true },
  });

  const results = [];

  for (const row of offlineSessions) {
    const shop = row.shop;

    try {
      const session = await sessionStorage.loadSession(row.id);
      console.log("[internal sync] loaded session", {
        id: row.id,
        shopFromRow: shop,
        shopFromSession: session?.shop,
        tokenLen: session?.accessToken?.length ?? 0,
        tokenPrefix: session?.accessToken ? session.accessToken.slice(0, 6) : null,
        tokenSuffix: session?.accessToken ? session.accessToken.slice(-4) : null,
      });

      if (!session) throw new Error(`Offline session missing for ${shop}`);

      const zonesSnapshot = await fetchZonesSnapshot(session);
      const servicesSnapshot = await fetchServicesSnapshot(session);

      await prisma.shopSettings.upsert({
        where: { shop },
        create: {
          shop,
          zonesSnapshotJson: JSON.stringify(zonesSnapshot),
          servicesSnapshotJson: JSON.stringify(servicesSnapshot),
          managedZoneIdsJson: "[]",
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
        update: {
          zonesSnapshotJson: JSON.stringify(zonesSnapshot),
          servicesSnapshotJson: JSON.stringify(servicesSnapshot),
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });

      results.push({ shop, ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

      await prisma.shopSettings.upsert({
        where: { shop },
        create: {
          shop,
          managedZoneIdsJson: "[]",
          zonesSnapshotJson: "{}",
          servicesSnapshotJson: "{}",
          lastSyncedAt: null,
          lastSyncError: message,
        },
        update: {
          lastSyncError: message,
        },
      });

      // If/when Flow trigger ID is configured, emit only on failure.
      try {
        const session = await sessionStorage.loadSession(row.id);
        if (session) {
          await maybeEmitFlowZonesSyncFailed({ session, error: message });
        }
      } catch {
        // swallow: we already recorded lastSyncError
      }

      results.push({ shop, ok: false, error: message });
    }
  }

  return json({ ok: true, count: results.length, results });
}
