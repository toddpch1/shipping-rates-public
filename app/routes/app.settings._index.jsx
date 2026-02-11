// app/routes/app.settings._index.jsx
import { useEffect, useMemo, useState, useCallback } from "react";
import crypto from "node:crypto";
import {
  Page,
  Card,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Box,
  Modal,
  Badge,
  Divider,
  Icon,
  Collapsible,
  Checkbox,
  TextField,
  Scrollable,
  InlineGrid,
} from "@shopify/polaris";
import {
  ClockIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
} from "@shopify/polaris-icons";
import {
  useActionData,
  useLoaderData,
  useLocation,
  useNavigate,
  useSubmit,
} from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
// TEMP: pause Shipping Services UI + sync.
// We’ll re-enable later once service labels are sourced correctly.
const ENABLE_SHIPPING_SERVICES = false;

/* ---------------- helpers ---------------- */

function safeJsonParse(str, fallback) {
  try {
    if (typeof str !== "string") return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function formatUpdatedLabel(dt) {
  if (!dt) return "Zones last updated on: Not synced yet";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return "Zones last updated on: Not synced yet";
  return `Zones last updated on: ${d.toLocaleString()}`;
}

function stableHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

/**
 * We persist granular selection here:
 * ShopSettings.managedZoneConfigJson
 *
 * Shape:
 * {
 *   groups: {
 *     northAmerica: { countries: { US:{provinces:["CO",...]}, CA:{...} } },
 *     international: { countries: { GB:{selected:true}, ... } }
 *   }
 * }
 */
function getDefaultConfig() {
  return { groups: { northAmerica: { countries: {} }, international: { countries: {} } } };
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : getDefaultConfig();
  const groups = cfg.groups && typeof cfg.groups === "object" ? cfg.groups : {};
  const na =
    groups.northAmerica?.countries && typeof groups.northAmerica.countries === "object"
      ? groups.northAmerica.countries
      : {};
  const intl =
    groups.international?.countries && typeof groups.international.countries === "object"
      ? groups.international.countries
      : {};
  return { groups: { northAmerica: { countries: na }, international: { countries: intl } } };
}

function getCountryDisplayName(code, countriesByCode) {
  const c = countriesByCode?.[code];
  return c?.name || code;
}

function getCountryRegions(code, countriesByCode) {
  const c = countriesByCode?.[code];
  const provinces = Array.isArray(c?.provinces) ? c.provinces : [];
  return provinces.map((p) => ({ code: p.code, name: p.name }));
}

/**
 * Build a { [countryCode]: { name, provinces:[{code,name}] } } map from snapshot.
 *
 * IMPORTANT: your stored zonesSnapshotJson is normalized to:
 * { version, pulledAt, zones:[{id,name,countries:[{name,code,provinces:[{code,name}]}]}], _meta }
 *
 * We support both:
 * - Shape A: normalized snapshot (preferred)
 * - Shape B: raw-ish GraphQL response (fallback)
 */
function extractCountriesFromDeliveryProfilesSnapshot(snapshot) {
  const out = {};

  // ---- Shape A: normalized snapshot ----
  const zones = Array.isArray(snapshot?.zones) ? snapshot.zones : null;
  if (zones && zones.length) {
    for (const z of zones) {
      const countries = Array.isArray(z?.countries) ? z.countries : [];
      for (const c of countries) {
        const rawCode = c?.code ?? c?.countryCode ?? c?.country ?? null;
        const countryCode =
          typeof rawCode === "string"
            ? rawCode
            : rawCode?.countryCode || null;

        if (!countryCode) continue;

        if (!out[countryCode]) out[countryCode] = { name: c?.name || countryCode, provinces: [] };

        const provs = Array.isArray(c?.provinces) ? c.provinces : [];
        for (const pr of provs) {
          const prCode = typeof pr === "string" ? pr : pr?.code;
          if (!prCode) continue;
          const prName = typeof pr === "string" ? pr : pr?.name || prCode;
          out[countryCode].provinces.push({ code: prCode, name: prName });
        }
      }
    }
  } else {
    // ---- Shape B: defensive fallback ----
    const profiles =
      snapshot?.data?.deliveryProfiles?.edges?.map((e) => e?.node) ||
      snapshot?.data?.deliveryProfiles?.nodes ||
      snapshot?.deliveryProfiles?.edges?.map((e) => e?.node) ||
      snapshot?.deliveryProfiles?.nodes ||
      [];

    for (const p of profiles) {
      const plgs = p?.profileLocationGroups || [];
      for (const plg of plgs) {
        const lgzEdges = plg?.locationGroupZones?.edges || [];
        const lgzNodes = plg?.locationGroupZones?.nodes || [];
        const lgzs = lgzEdges.length ? lgzEdges.map((e) => e?.node) : lgzNodes;

        for (const lgz of lgzs) {
          const zone = lgz?.zone;
          const countries = Array.isArray(zone?.countries) ? zone.countries : [];
          for (const c of countries) {
            const countryCode = c?.code?.countryCode;
            if (!countryCode) continue;

            if (!out[countryCode]) out[countryCode] = { name: c?.name || countryCode, provinces: [] };

            const provs = Array.isArray(c?.provinces) ? c.provinces : [];
            for (const pr of provs) {
              if (!pr?.code) continue;
              out[countryCode].provinces.push({ code: pr.code, name: pr.name || pr.code });
            }
          }
        }
      }
    }
  }

  // dedupe + sort for stable UI
  for (const cc of Object.keys(out)) {
    const seen = new Set();
    out[cc].provinces = (out[cc].provinces || [])
      .filter((p) => {
        const k = `${p.code}|${p.name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  return out;
}

/* ---------------- Markets digest ---------------- */

async function fetchMarketsDigestAndCountryCodes(admin) {
  const query = `#graphql
    query MarketsForZonePicker {
      markets(first: 250, query: "status:ACTIVE") {
        nodes {
          id
          name
          regions(first: 250) {
            nodes {
              __typename
              name
              ... on MarketRegionCountry { code }
            }
          }
        }
      }
    }
  `;

  const res = await admin.graphql(query);
  const json = await res.json();

  if (json?.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  const markets = json?.data?.markets?.nodes || [];
  const countryCodes = new Set();

  for (const m of markets) {
    const regions = m?.regions?.nodes || [];
    for (const r of regions) {
      if (r?.__typename === "MarketRegionCountry" && r?.code) countryCodes.add(r.code);
    }
  }

  const digestInput = {
    markets: markets
      .map((m) => ({
        id: m.id,
        name: m.name,
        regions: (m?.regions?.nodes || [])
          .map((r) => ({
            t: r.__typename,
            name: r.name,
            code: r.code || null,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };

  return {
    digest: stableHash(digestInput),
    marketCountryCodes: Array.from(countryCodes).sort(),
  };
}

/* ---------------- Sync (split queries to avoid cost > 1000) ---------------- */

async function syncShippingConfig(admin) {
  // A) Zones query (countries + provinces) — keep this focused
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

  // Normalize zones snapshot to your lightweight Shape A
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
          countries: countries.map((c) => ({
            name: c?.name || (c?.code?.countryCode ?? "Country"),
            code: c?.code?.countryCode ?? null,
            provinces: (Array.isArray(c?.provinces) ? c.provinces : []).map((p) => ({
              code: p?.code ?? null,
              name: p?.name ?? p?.code ?? "Province",
            })).filter((p) => p.code),
          })).filter((c) => c.code),
        });
      }
    }
  }

  // Dedup zones by id (keeping first)
  const zoneSeen = new Set();
  const zonesDeduped = zones.filter((z) => {
    if (zoneSeen.has(z.id)) return false;
    zoneSeen.add(z.id);
    return true;
  });

      // B) Services query — capped to stay under cost limit
const servicesQuery = `#graphql
  query DeliveryServicesOnly {
    deliveryProfiles(first: 10) {
      edges {
        node {
          profileLocationGroups {
            locationGroupZones(first: 25) {
              edges {
                node {
                  methodDefinitions(first: 50) {
                    edges {
                      node {
                        id
                        active
                        name
                        rateProvider {
                          __typename
                          ... on DeliveryParticipant {
                            id
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
      }
    }
  }
`;

const servicesRes = await admin.graphql(servicesQuery);
const servicesJson = await servicesRes.json();
if (servicesJson?.errors?.length) {
  throw new Error(servicesJson.errors.map((e) => e.message).join("; "));
}

// Build service list from methodDefinitions (human-facing labels)
const services = [];
const dpEdges2 = servicesJson?.data?.deliveryProfiles?.edges || [];

for (const dpEdge of dpEdges2) {
  const plgs = dpEdge?.node?.profileLocationGroups || [];
  for (const plg of plgs) {
    const lgzEdges = plg?.locationGroupZones?.edges || [];
    for (const lgzEdge of lgzEdges) {
      const mdEdges = lgzEdge?.node?.methodDefinitions?.edges || [];
      for (const mdEdge of mdEdges) {
        const md = mdEdge?.node;
        if (!md?.id) continue;

        const rp = md?.rateProvider;
        const participantName =
          rp?.__typename === "DeliveryParticipant" ? (rp?.name || null) : null;

        services.push({
          id: String(md.id),
          name: String(md.name || "Shipping service"), // <-- THIS is the label you want
          active: !!md.active,
          participantName,
          description: participantName || null, // carrier label for grouping
        });
      }
    }
  }
}

// Dedup by id + stable sort by label
const seen = new Set();
const servicesDeduped = services
  .filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  })
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));

return {
  zonesSnapshot: {
    version: 1,
    pulledAt: new Date().toISOString(),
    zones: zonesDeduped,
  },
  servicesSnapshot: {
    version: 2,
    services: servicesDeduped,
  },
};

  }

/* ---------------- loader ---------------- */

export async function loader({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  // Auto-first-sync: if this shop has never synced, do it immediately on first Settings load.
if (!settings?.lastSyncedAt) {
  try {
    const zonesSnapshot = await fetchZonesSnapshot(session);
    const servicesSnapshot = await fetchServicesSnapshot(session);

    settings = await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        managedZoneIdsJson: "[]",
        zonesSnapshotJson: "{}",
        servicesSnapshotJson: "{}",
        lastSyncedAt: null,
        lastSyncError: msg,
      },
      update: { lastSyncError: msg },
    });
  }
}

  const existingZonesSnapshot = safeJsonParse(settings?.zonesSnapshotJson, null);
  const existingMeta = existingZonesSnapshot?._meta || {};
  const existingMarketsDigest = existingMeta?.marketsDigest || null;

  const lastSyncedAt = settings?.lastSyncedAt ? new Date(settings.lastSyncedAt).getTime() : 0;
  const now = Date.now();
  const THROTTLE_MS = 2 * 60 * 1000; // 2 minutes

  let marketCountryCodes = null;
  let marketsDigest = null;
  let marketsError = null;

  try {
    const markets = await fetchMarketsDigestAndCountryCodes(admin);
    marketsDigest = markets.digest;
    marketCountryCodes = markets.marketCountryCodes;
  } catch (e) {
    marketsError = e instanceof Error ? e.message : String(e);
  }

  const shouldForceSync =
    marketsDigest &&
    (existingMarketsDigest == null || marketsDigest !== existingMarketsDigest) &&
    now - lastSyncedAt > THROTTLE_MS;

  const existingServicesSnapshot = safeJsonParse(settings?.servicesSnapshotJson, null);
  const hasServicesSnapshot =
    Array.isArray(existingServicesSnapshot?.services) && existingServicesSnapshot.services.length > 0;

  // Force re-sync if snapshot missing OR from older format/version
  const servicesSnapshotVersion = Number(existingServicesSnapshot?.version || 0);
  const shouldSyncServices = ENABLE_SHIPPING_SERVICES
  ? (!hasServicesSnapshot || servicesSnapshotVersion < 2)
  : false;


  if (
    shouldForceSync ||
    shouldSyncServices ||
    (!settings?.zonesSnapshotJson && now - lastSyncedAt > 5000)
  ) {
      try {
      const { zonesSnapshot, servicesSnapshot } = await syncShippingConfig(admin);

      const withMeta = {
        ...zonesSnapshot,
        _meta: {
          marketsDigest: marketsDigest || null,
          marketCountryCodes: marketCountryCodes || null,
          marketsError: marketsError || null,
          updatedAtIso: new Date().toISOString(),
        },
      };

      const updated = await prisma.shopSettings.update({
        where: { shop },
        data: {
          zonesSnapshotJson: JSON.stringify(withMeta),
          ...(ENABLE_SHIPPING_SERVICES
            ? { servicesSnapshotJson: JSON.stringify(servicesSnapshot) }
            : {}),
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });

      return { settings: updated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const updated = await prisma.shopSettings.update({
        where: { shop },
        data: { lastSyncError: msg },
      });
      return { settings: updated };
    }
  }
  // Persist markets meta even if we didn’t sync (so picker can filter)
  if (settings?.zonesSnapshotJson && (marketsDigest || marketsError)) {
    const nextSnapshot = existingZonesSnapshot || {};
    const nextMeta = {
      ...(nextSnapshot._meta || {}),
      marketsDigest: marketsDigest || nextSnapshot?._meta?.marketsDigest || null,
      marketCountryCodes: marketCountryCodes || nextSnapshot?._meta?.marketCountryCodes || null,
      marketsError: marketsError || null,
    };

    const changed = JSON.stringify(nextMeta) !== JSON.stringify(existingMeta || {});
    if (changed) {
      const updated = await prisma.shopSettings.update({
        where: { shop },
        data: { zonesSnapshotJson: JSON.stringify({ ...nextSnapshot, _meta: nextMeta }) },
      });
      return { settings: updated };
    }
  }

  return { settings };
}

/* ---------------- action ---------------- */

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  if (intent !== "save") return { ok: false, error: "Unknown intent" };

  const managedZoneConfigJson = String(formData.get("managedZoneConfigJson") || "{}");
  const managedServiceIdsJson = ENABLE_SHIPPING_SERVICES
    ? String(formData.get("managedServiceIdsJson") || "[]")
    : "[]";

  let zonesParsed = getDefaultConfig();
  try {
    zonesParsed = normalizeConfig(JSON.parse(managedZoneConfigJson));
  } catch {
    zonesParsed = getDefaultConfig();
  }

  let serviceIds = [];
  try {
    const parsed = JSON.parse(managedServiceIdsJson);
    serviceIds = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    serviceIds = [];
  }

  await prisma.shopSettings.update({
    where: { shop },
    data: {
      managedZoneConfigJson: JSON.stringify(zonesParsed),
      ...(ENABLE_SHIPPING_SERVICES ? { managedServiceIdsJson: JSON.stringify(serviceIds) } : {}),
    },
  });

  return { ok: true };
}

/* ---------------- component ---------------- */

export default function SettingsIndex() {
  const { settings } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const location = useLocation();
  const search = location.search || "";

  const [saving, setSaving] = useState(false);

  const zonesLastUpdatedLabel = useMemo(
    () => formatUpdatedLabel(settings?.lastSyncedAt),
    [settings?.lastSyncedAt],
  );

  const savedConfig = useMemo(() => {
    const raw = safeJsonParse(settings?.managedZoneConfigJson, getDefaultConfig());
    return normalizeConfig(raw);
  }, [settings?.managedZoneConfigJson]);

  const [draftConfig, setDraftConfig] = useState(savedConfig);

  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [servicesModalOpen, setServicesModalOpen] = useState(false);

  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [expandedCountries, setExpandedCountries] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [servicesSearchQuery, setServicesSearchQuery] = useState("");
  const resetZonesModalUi = useCallback(() => {
    setSearchQuery("");
    setExpandedGroups(new Set());
    setExpandedCountries(new Set());
  }, []);
  const resetServicesModalUi = useCallback(() => {
    setServicesSearchQuery("");
  }, []);

  useEffect(() => setDraftConfig(savedConfig), [JSON.stringify(savedConfig)]);
  useEffect(() => {
    // Locked UX: Save redirects to /app/tiers; Cancel already does this.
    if (actionData?.ok === true) {
      setSaving(false);
      navigate(`/app/tiers${search}`);
      return;
    }

    // If we got a non-success response, still stop the spinner
    if (actionData?.ok !== undefined) {
      setSaving(false);
    }
  }, [actionData?.ok, navigate, search]);

  const zonesSnapshot = useMemo(
    () => safeJsonParse(settings?.zonesSnapshotJson, null),
    [settings?.zonesSnapshotJson],
  );

  const zonesCountriesByCode = useMemo(() => {
    return extractCountriesFromDeliveryProfilesSnapshot(zonesSnapshot || {});
  }, [zonesSnapshot]);

  // Markets filter (truth = Markets). Fallback if markets is not available.
  const marketCountryCodes = useMemo(() => {
    const meta = zonesSnapshot?._meta || {};
    const codes = meta?.marketCountryCodes;
    return Array.isArray(codes) ? codes : null;
  }, [zonesSnapshot]);

  const availableCountryCodes = useMemo(() => {
    const zoneCodes = Object.keys(zonesCountriesByCode || {}).sort();
    if (marketCountryCodes && marketCountryCodes.length) {
      const allowed = new Set(marketCountryCodes);
      return zoneCodes.filter((cc) => allowed.has(cc));
    }
    return zoneCodes;
  }, [zonesCountriesByCode, marketCountryCodes]);

  const NORTH_AMERICA_SET = new Set(["US", "CA", "MX"]);

  const northAmericaCountryCodes = useMemo(() => {
    return availableCountryCodes.filter((cc) => NORTH_AMERICA_SET.has(cc));
  }, [availableCountryCodes]);

  const internationalCountryCodes = useMemo(() => {
    return availableCountryCodes.filter((cc) => !NORTH_AMERICA_SET.has(cc));
  }, [availableCountryCodes]);

  // Services snapshot + selection
  // --- Services UI helpers (must be above first use) ---
function normalizeServiceNameKey(service) {
  // Key = exact Shopify label (trim only).
  // Lowercasing is fine for dup detection, but do NOT rewrite underscores/spaces.
  return String(service?.name || "").trim().toLowerCase();
}
function prettifyServiceName(service) {
  // Shopify already provides the correct human-facing label.
  // Keep it verbatim so it matches invoices and Admin UI.
  return String(service?.name || "Service").trim();
}
function shortServiceId(id) {
  const s = String(id || "");
  if (!s) return "";
  return s.length > 6 ? `…${s.slice(-6)}` : s;
}
  const servicesSnapshot = useMemo(
    () => safeJsonParse(settings?.servicesSnapshotJson, { services: [] }),
    [settings?.servicesSnapshotJson],
  );
  const availableServices = Array.isArray(servicesSnapshot?.services)
    ? servicesSnapshot.services
    : [];

  const inferCarrier = (service) => {
    // Prefer participantName when present (best grouping signal)
    const pn = String(service?.participantName || "").trim();
    if (pn) return pn;

    const hay = `${service?.name || ""} ${service?.description || ""}`.toLowerCase();
    if (hay.includes("usps")) return "USPS";
    if (hay.includes("ups")) return "UPS";
    if (hay.includes("dhl")) return "DHL";
    return "Other";
  };

  const serviceNameCounts = useMemo(() => {
    const m = new Map();
    for (const s of availableServices) {
      const k = normalizeServiceNameKey(s);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [availableServices]);

  const savedServiceIds = useMemo(() => {
    const arr = safeJsonParse(settings?.managedServiceIdsJson, []);
    return Array.isArray(arr) ? arr.map(String) : [];
  }, [settings?.managedServiceIdsJson]);

  const [draftServiceIds, setDraftServiceIds] = useState(savedServiceIds);
  useEffect(() => {
    // Deterministic:
    // - If saved selection exists, use it.
    // - Otherwise, if services exist, default to all selected.
    // - Otherwise, empty.
    if (savedServiceIds.length > 0) {
      setDraftServiceIds(savedServiceIds);
      resetServicesModalUi();
      return;
    }

    if (availableServices.length > 0) {
      setDraftServiceIds(availableServices.map((s) => String(s.id)));
      return;
    }

    setDraftServiceIds([]);
  }, [
    savedServiceIds.join("|"),
    availableServices.map((s) => String(s.id)).join("|"),
  ]);

  const toggleGroup = useCallback((groupKey) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      const k = String(groupKey);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const toggleCountryExpand = useCallback((groupKey, countryCode) => {
    setExpandedCountries((prev) => {
      const next = new Set(prev);
      const k = `${groupKey}:${countryCode}`;
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const isGroupExpanded = (groupKey) => expandedGroups.has(String(groupKey));
  const isCountryExpanded = (groupKey, countryCode) => expandedCountries.has(`${groupKey}:${countryCode}`);

  const matchesSearch = (text) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return String(text || "").toLowerCase().includes(q);
  };

  const getCountryEntry = (groupKey, countryCode) => {
    const countries = draftConfig.groups[groupKey].countries || {};
    return countries[countryCode] || null;
  };

  const setCountryEntry = (groupKey, countryCode, entryOrNull) => {
    setDraftConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const countries = next.groups[groupKey].countries || {};
      if (entryOrNull === null) delete countries[countryCode];
      else countries[countryCode] = entryOrNull;
      next.groups[groupKey].countries = countries;
      return next;
    });
  };

  const selectAllInCountry = (groupKey, countryCode) => {
    const regions = getCountryRegions(countryCode, zonesCountriesByCode);
    if (regions.length === 0) {
      setCountryEntry(groupKey, countryCode, { selected: true });
      return;
    }
    setCountryEntry(groupKey, countryCode, { provinces: regions.map((r) => r.code) });
  };

  const clearAllInCountry = (groupKey, countryCode) => {
    setCountryEntry(groupKey, countryCode, null);
  };

  const toggleRegion = (groupKey, countryCode, regionCode, checked) => {
    const regions = getCountryRegions(countryCode, zonesCountriesByCode);
    if (regions.length === 0) {
      if (checked) setCountryEntry(groupKey, countryCode, { selected: true });
      else setCountryEntry(groupKey, countryCode, null);
      return;
    }

    const entry = getCountryEntry(groupKey, countryCode);
    const current = new Set(Array.isArray(entry?.provinces) ? entry.provinces.map(String) : []);
    if (checked) current.add(String(regionCode));
    else current.delete(String(regionCode));

    if (current.size === 0) {
      setCountryEntry(groupKey, countryCode, null);
      return;
    }
    setCountryEntry(groupKey, countryCode, { provinces: Array.from(current) });
  };

  const countryCounts = (groupKey, countryCode) => {
    const regions = getCountryRegions(countryCode, zonesCountriesByCode);
    const entry = getCountryEntry(groupKey, countryCode);

    if (regions.length === 0) {
      const selected = entry?.selected ? 1 : 0;
      return { selected, total: 1, label: selected ? "Selected" : "" };
    }

    const selected = Array.isArray(entry?.provinces) ? entry.provinces.length : 0;
    const total = regions.length;
    return { selected, total, label: `${selected} of ${total} states/provinces` };
  };

  const groupSummaryCounts = (groupKey, countryCodes) => {
    let selected = 0;
    let total = 0;

    for (const cc of countryCodes) {
      const regions = getCountryRegions(cc, zonesCountriesByCode);
      const entry = getCountryEntry(groupKey, cc);

      if (regions.length === 0) {
        total += 1;
        if (entry?.selected) selected += 1;
      } else {
        total += regions.length;
        selected += Array.isArray(entry?.provinces) ? entry.provinces.length : 0;
      }
    }

    return { selected, total, label: `${selected} of ${total} states/provinces` };
  };

  const onCancel = () => navigate(`/app/tiers${search}`);
  const onSave = () => {
    setSaving(true);
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("managedZoneConfigJson", JSON.stringify(draftConfig));
    fd.set("managedServiceIdsJson", JSON.stringify(draftServiceIds));
    submit(fd, { method: "post" });
  };

  const zonesButtonLabel =
    Object.keys(draftConfig.groups.northAmerica.countries || {}).length ||
    Object.keys(draftConfig.groups.international.countries || {}).length
      ? "Edit Zones"
      : "Select Shipping Zones";

  // Summary display
  const [expandedMain, setExpandedMain] = useState(() => new Set());
  const toggleMain = (key) => {
    setExpandedMain((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderSelectedGroupSummary = (groupKey, title, countryCodes) => {
    const hasAny = Object.keys(draftConfig.groups[groupKey].countries || {}).length > 0;
    if (!hasAny) return null;

    const expanded = expandedMain.has(groupKey);
    const summary = groupSummaryCounts(groupKey, countryCodes);

    return (
      <Box key={groupKey}>
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="150" blockAlign="center">
            <Button
              variant="tertiary"
              icon={expanded ? ChevronUpIcon : ChevronDownIcon}
              onClick={() => toggleMain(groupKey)}
            />
            <Text as="span" variant="bodyMd">{title}</Text>
            <Badge tone="success">Managed</Badge>
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">{summary.label}</Text>
        </InlineStack>

        <Collapsible open={expanded}>
          <Box paddingBlockStart="150" paddingInlineStart="400">
            <BlockStack gap="150">
              {countryCodes.map((cc) => {
                const entry = getCountryEntry(groupKey, cc);
                if (!entry) return null;

                const regions = getCountryRegions(cc, zonesCountriesByCode);
                const counts = countryCounts(groupKey, cc);

                return (
                  <Box key={`${groupKey}-${cc}`}>
                    <Text as="p" variant="bodySm">
                      • {getCountryDisplayName(cc, zonesCountriesByCode)}{" "}
                      {regions.length ? (
                        <Text as="span" variant="bodySm" tone="subdued">
                          ({Array.isArray(entry?.provinces) ? entry.provinces.join(", ") : ""})
                        </Text>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">
                          (selected)
                        </Text>
                      )}
                    </Text>
                    {regions.length ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {counts.label}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}
            </BlockStack>
          </Box>
        </Collapsible>
      </Box>
    );
  };

  const renderGroupPicker = (groupKey, title, countryCodes) => {
    const expanded = isGroupExpanded(groupKey);
    const summary = groupSummaryCounts(groupKey, countryCodes);

    const groupMatches =
      matchesSearch(title) ||
      countryCodes.some((cc) => matchesSearch(getCountryDisplayName(cc, zonesCountriesByCode)));

    if (!groupMatches && searchQuery.trim()) return null;

    return (
      <Box borderWidth="025" borderColor="border" borderRadius="200">
        <Box padding="150">
          <InlineGrid columns={["1fr", "auto"]} gap="200" alignItems="center">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {title}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {summary.label}
              </Text>
            </InlineStack>

            <Button
              variant="tertiary"
              icon={expanded ? ChevronUpIcon : ChevronDownIcon}
              onClick={() => toggleGroup(groupKey)}
              accessibilityLabel={`Toggle ${title}`}
            />
          </InlineGrid>
        </Box>

        <Collapsible open={expanded}>
          <Divider />
          <Box padding="200">
            <BlockStack gap="150">
              {countryCodes.map((cc) => {
                const countryName = getCountryDisplayName(cc, zonesCountriesByCode);
                const regions = getCountryRegions(cc, zonesCountriesByCode);
                const entry = getCountryEntry(groupKey, cc);
                const counts = countryCounts(groupKey, cc);
                const cExpanded = isCountryExpanded(groupKey, cc);

                const matches =
                  matchesSearch(countryName) ||
                  (regions.length ? regions.some((r) => matchesSearch(r.name)) : false);
                if (!matches) return null;

                return (
                  <Box key={`${groupKey}-${cc}`} borderWidth="025" borderColor="border" borderRadius="200">
                    <Box padding="200">
                      <InlineGrid columns={["1fr", "auto"]} gap="200" alignItems="start">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd">{countryName}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {counts.label || (entry ? "Selected" : "")}
                          </Text>
                        </InlineStack>

                        <Button
                          variant="tertiary"
                          icon={cExpanded ? ChevronUpIcon : ChevronDownIcon}
                          onClick={() => toggleCountryExpand(groupKey, cc)}
                          accessibilityLabel={`Toggle ${countryName}`}
                        />
                      </InlineGrid>
                    </Box>

                    <Collapsible open={cExpanded}>
                      <Divider />
                      <Box padding="200">
                        <BlockStack gap="150">
                          {/* Select all row */}
                          <Checkbox
                            label="Select all"
                            disabled={saving}
                            checked={
                              regions.length
                                ? Array.isArray(entry?.provinces) && entry.provinces.length === regions.length
                                : !!entry?.selected
                            }
                            indeterminate={
                              regions.length
                                ? Array.isArray(entry?.provinces) &&
                                  entry.provinces.length > 0 &&
                                  entry.provinces.length < regions.length
                                : false
                            }
                            onChange={(isChecked) => {
                              if (isChecked) selectAllInCountry(groupKey, cc);
                              else clearAllInCountry(groupKey, cc);
                            }}
                          />

                          {/* Region rows */}
                          {regions.length ? (
                            regions
                              .filter((r) => matchesSearch(r.name) || !searchQuery.trim())
                              .map((r) => {
                                const selectedSet = new Set(Array.isArray(entry?.provinces) ? entry.provinces : []);
                                const isChecked = selectedSet.has(r.code);

                                return (
                                  <Checkbox
                                    key={`${groupKey}-${cc}-${r.code}`}
                                    label={r.name}
                                    checked={isChecked}
                                    disabled={saving}
                                    onChange={(isNowChecked) => toggleRegion(groupKey, cc, r.code, isNowChecked)}
                                  />
                                );
                              })
                          ) : (
                            <Checkbox
                              label={`All of ${countryName}`}
                              checked={!!entry?.selected}
                              disabled={saving}
                              onChange={(isNowChecked) => toggleRegion(groupKey, cc, "__ALL__", isNowChecked)}
                            />
                          )}
                        </BlockStack>
                      </Box>
                    </Collapsible>
                  </Box>
                );
              })}
            </BlockStack>
          </Box>
        </Collapsible>
      </Box>
    );
  };

    const groupedServices = useMemo(() => {
      const groups = new Map(); // carrier -> services[]
      for (const s of availableServices) {
        const carrier = inferCarrier(s);
        if (!groups.has(carrier)) groups.set(carrier, []);
        groups.get(carrier).push(s);
      }

      // stable sort inside groups
      for (const [k, arr] of groups.entries()) {
        arr.sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
        groups.set(k, arr);
      }

      // stable carrier order
      const order = ["USPS", "UPS", "DHL", "Other"];
      const out = [];
      for (const k of order) {
        if (groups.has(k)) out.push([k, groups.get(k)]);
      }
      // any unexpected carrier keys
      for (const [k, arr] of groups.entries()) {
        if (!order.includes(k)) out.push([k, arr]);
      }

      return out; // [ [carrier, services[]], ... ]
    }, [availableServices]);

  const servicesButtonLabel = draftServiceIds.length ? "Edit Services" : "Select Shipping Services";
  const selectedServicesLabel = useMemo(() => {
    const idToName = new Map(availableServices.map((s) => [String(s.id), String(s.name || "Service")]));
    const names = draftServiceIds
      .map((id) => idToName.get(String(id)))
      .filter(Boolean);

    if (names.length === 0) return "";
    const first = names.slice(0, 4);
    const more = names.length - first.length;
    return more > 0 ? `${first.join(", ")} + ${more} more` : first.join(", ");
  }, [availableServices, draftServiceIds]);


  return (
    <Page title="Settings">
      <BlockStack gap="400">
        {/* Zones */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Zones Managed by this app
              </Text>
              <Button onClick={() => setZoneModalOpen(true)}>{zonesButtonLabel}</Button>
            </InlineStack>

            <Text as="p" variant="bodyMd" tone="subdued">
              Select countries and regions this app should manage. Anything not selected will fall back to Shopify/manual rates.
            </Text>

            <Divider />

            <BlockStack gap="250">
              {renderSelectedGroupSummary("northAmerica", "North America", northAmericaCountryCodes)}
              {renderSelectedGroupSummary("international", "International", internationalCountryCodes)}

              {!Object.keys(draftConfig.groups.northAmerica.countries || {}).length &&
              !Object.keys(draftConfig.groups.international.countries || {}).length ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No zones selected yet.
                </Text>
              ) : null}
            </BlockStack>

            <Box paddingBlockStart="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="100" blockAlign="center">
                  <Icon source={ClockIcon} />
                  <Text as="span" variant="bodySm" tone="subdued">
                    {zonesLastUpdatedLabel}
                  </Text>
                </InlineStack>
                {settings?.lastSyncError ? <Badge tone="critical">Sync issue</Badge> : null}
              </InlineStack>

              {settings?.lastSyncError ? (
                <Box paddingBlockStart="150">
                  <Text as="p" variant="bodySm" tone="critical">
                    {settings.lastSyncError}
                  </Text>
                </Box>
              ) : null}
            </Box>

            {zonesSnapshot?._meta?.marketsError ? (
              <Box paddingBlockStart="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  Markets filter unavailable (needs read_markets scope): {String(zonesSnapshot._meta.marketsError)}
                </Text>
              </Box>
            ) : null}
          </BlockStack>
        </Card>

        {/* Shipping Services (paused) */}
        {ENABLE_SHIPPING_SERVICES ? (
          <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Shipping Services</Text>
              <Button
                onClick={() => { setServicesSearchQuery(""); setServicesModalOpen(true); }}
                disabled={availableServices.length === 0}
              >
                {servicesButtonLabel}
              </Button>
            </InlineStack>

            <Text as="p" variant="bodyMd" tone="subdued">
              Select which Shopify shipping services to use as your defaults.
            </Text>

            <Divider />

            <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm" tone="subdued">
                  {draftServiceIds.length === availableServices.length && availableServices.length > 0
                    ? "All services managed"
                    : `${draftServiceIds.length} selected of ${availableServices.length} available`}
                </Text>

                {selectedServicesLabel ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Selected: {selectedServicesLabel}
                  </Text>
                ) : null}
              {settings?.lastSyncError ? <Badge tone="critical">Sync issue</Badge> : null}
            </InlineStack>

            {settings?.lastSyncError ? (
              <Box paddingBlockStart="150">
                <Text as="p" variant="bodySm" tone="critical">
                  {settings.lastSyncError}
                </Text>
              </Box>
            ) : null}

          </BlockStack>
                </Card>
          ) : null}


        {/* Bottom-right actions (locked UX) */}
        <Box paddingBlockStart="200">
          <InlineStack align="end" gap="200">
            <Button onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={onSave} loading={saving}>Save</Button>
          </InlineStack>
        </Box>
      </BlockStack>

      {/* Zone modal */}
      <Modal
        open={zoneModalOpen}
        onClose={() => setZoneModalOpen(false)}
        title="Select shipping zones"
        primaryAction={{
          content: "Done",
          onAction: () => { resetZonesModalUi(); setZoneModalOpen(false); },
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setDraftConfig(savedConfig);
              resetZonesModalUi();
              setZoneModalOpen(false);
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              labelHidden
              label="Search countries and regions to ship to"
              prefix={<Icon source={SearchIcon} />}
              placeholder="Search countries and regions to ship to"
              value={searchQuery}
              onChange={setSearchQuery}
              autoComplete="off"
            />

            <Scrollable style={{ maxHeight: 520 }}>
              <BlockStack gap="200">
                {renderGroupPicker("northAmerica", "North America", northAmericaCountryCodes)}
                {renderGroupPicker("international", "International", internationalCountryCodes)}
              </BlockStack>
            </Scrollable>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Services modal (paused) */}
      {ENABLE_SHIPPING_SERVICES ? (
      <Modal
        open={servicesModalOpen}
        onClose={() => setServicesModalOpen(false)}
        title="Select shipping services"
        primaryAction={{
          content: "Done",
          onAction: () => { resetServicesModalUi(); setServicesModalOpen(false); },
          disabled: saving,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setDraftServiceIds(savedServiceIds);
              resetServicesModalUi();
              setServicesModalOpen(false);
            },
          },
        ]}
      >
        <Modal.Section>
          <TextField
            labelHidden
            label="Search services"
            prefix={<Icon source={SearchIcon} />}
            placeholder="Search services"
            value={servicesSearchQuery}
            onChange={setServicesSearchQuery}
            autoComplete="off"
          />
          <InlineStack gap="200">
            <Button
              variant="tertiary"
              onClick={() => setDraftServiceIds(availableServices.map((s) => String(s.id)))}
              disabled={availableServices.length === 0}
            >
              Select all
            </Button>

            <Button
              variant="tertiary"
              onClick={() => setDraftServiceIds([])}
              disabled={draftServiceIds.length === 0}
            >
              Clear all
            </Button>
          </InlineStack>
          <Scrollable style={{ maxHeight: 520 }}>
            <BlockStack gap="200">
            {availableServices.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No services found yet. Services are synced automatically in the Settings loader.
              </Text>
            ) : (
              groupedServices
                .map(([carrier, services]) => {
                  const q = servicesSearchQuery.trim().toLowerCase();

                  const carrierMatches = q ? String(carrier).toLowerCase().includes(q) : false;
                  const visibleServices = !q
                    ? services
                    : carrierMatches
                      ? services
                      : services.filter((s) => {
                          const name = String(s?.name || "").toLowerCase();
                          const desc = String(s?.description || "").toLowerCase();
                          return name.includes(q) || desc.includes(q);
                        });

                  if (visibleServices.length === 0) return null;

                  const carrierIds = services.map((s) => String(s.id));
                  const allSelected = carrierIds.every((id) => draftServiceIds.includes(id));
                  const someSelected = carrierIds.some((id) => draftServiceIds.includes(id));

                  return (
                    <BlockStack key={carrier} gap="100">
                      <Checkbox
                        label={carrier}
                        checked={allSelected}
                        indeterminate={!allSelected && someSelected}
                        disabled={saving}
                        onChange={(checked) => {
                          setDraftServiceIds((prev) => {
                            const set = new Set(prev.map(String));
                            if (checked) carrierIds.forEach((id) => set.add(id));
                            else carrierIds.forEach((id) => set.delete(id));
                            return Array.from(set);
                          });
                        }}
                      />

                      <Box paddingInlineStart="400">
                        <BlockStack gap="100">
                          {visibleServices.map((s) => {
                            const id = String(s.id);
                            const checked = draftServiceIds.includes(id);

                            const pretty = prettifyServiceName(s);
                            const key = normalizeServiceNameKey(s);
                            const isDup = key && (serviceNameCounts.get(key) || 0) > 1;

                            const labelText = isDup ? `${pretty} (${shortServiceId(s.id)})` : pretty;

                            const rawDesc = s?.description ? String(s.description).trim() : "";
                            const looksMachine = /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i.test(rawDesc);
                            const helpTextText =
                              rawDesc && rawDesc !== labelText && !looksMachine ? rawDesc : undefined;
                            return (
                              <Checkbox
                                key={id}
                                label={labelText}
                                helpText={helpTextText}


                                checked={checked}
                                disabled={saving}
                                onChange={(isNowChecked) => {
                                  setDraftServiceIds((prev) => {
                                    const set = new Set(prev.map(String));
                                    if (isNowChecked) set.add(id);
                                    else set.delete(id);
                                    return Array.from(set);
                                  });
                                }}
                              />
                            );
                          })}
                        </BlockStack>
                      </Box>
                    </BlockStack>
                  );
                })
                .filter(Boolean)

            )}
          </BlockStack>
          </Scrollable>
        </Modal.Section>
            </Modal>
      ) : null}
    </Page>
  );
}
