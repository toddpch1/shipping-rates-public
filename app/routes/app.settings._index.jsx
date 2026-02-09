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
  const json = JSON.stringify(obj);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * We persist granular selection here:
 * ShopSettings.managedZoneConfigJson
 *
 * Shape:
 * {
 *   groups: {
 *     northAmerica: {
 *       countries: {
 *         US: { provinces: ["CO","CA", ...] }, // explicit list
 *         CA: { provinces: ["AB","BC", ...] }, // explicit list
 *         MX: { provinces: ["CMX", ...] } or { selected: true } // if no provinces returned
 *       }
 *     },
 *     international: {
 *       countries: {
 *         GB: { selected: true },
 *         AU: { selected: true },
 *         ...
 *       }
 *     }
 *   }
 * }
 *
 * NOTE: “Select all” works by filling explicit provinces list when we have provinces,
 * otherwise we treat it as a single “All of Country” checkbox inside the country expand.
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
 * Build a { [countryCode]: { name, provinces:[{code,name}] } } map from deliveryProfiles.
 * This keeps the province list accurate (no hardcoding).
 */
function extractCountriesFromDeliveryProfilesSnapshot(snapshot) {
  const out = {};

  // We store the raw graphql response-ish structure in zonesSnapshotJson.
  // This extractor is defensive so schema changes don’t hard-break the UI.
  const profiles =
    snapshot?.data?.deliveryProfiles?.edges?.map((e) => e?.node) ||
    snapshot?.data?.deliveryProfiles?.nodes ||
    snapshot?.deliveryProfiles?.edges?.map((e) => e?.node) ||
    snapshot?.deliveryProfiles?.nodes ||
    [];

  for (const p of profiles) {
    const plgs = p?.profileLocationGroups || [];
    for (const plg of plgs) {
      // Option A: Shopify query includes countriesInAnyZone (some community examples do)
      const ciaz = plg?.countriesInAnyZone || [];
      for (const entry of ciaz) {
        const country = entry?.country;
        const countryCode = country?.code?.countryCode;
        if (!countryCode) continue;

        if (!out[countryCode]) out[countryCode] = { name: country?.name || countryCode, provinces: [] };

        const provs = Array.isArray(entry?.provinces) ? entry.provinces : [];
        for (const pr of provs) {
          if (!pr?.code) continue;
          out[countryCode].provinces.push({ code: pr.code, name: pr.name || pr.code });
        }
      }

      // Option B: Shopify query includes locationGroupZones.zone.countries[].provinces[] (official docs example)
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

  // Dedupe + sort provinces for stable UI/digest
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

/**
 * Markets digest: if markets change, we want to force a sync.
 * Markets requires read_markets. If that scope isn’t present yet, this will fail
 * and we’ll fall back to zone-based picker options.
 */
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

  // We treat “market includes a province” as “market includes that country”
  for (const m of markets) {
    const regions = m?.regions?.nodes || [];
    for (const r of regions) {
      if (r?.__typename === "MarketRegionCountry" && r?.code) countryCodes.add(r.code);
    }
  }

  // Stable digest input
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
            // country removed (we only support MarketRegionCountry regions)
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };

  return { digest: stableHash(digestInput), marketCountryCodes: Array.from(countryCodes).sort() };
}

/**
 * Full sync: zones + services snapshot.
 * This uses deliveryProfiles (Shipping & fulfillment) and is the “checkout truth”.
 * Official docs show deliveryProfiles can return zones/countries/provinces. :contentReference[oaicite:1]{index=1}
 */
async function syncShippingConfig(admin) {
  const query = `#graphql
    query DeliveryZoneList {
      deliveryProfiles(first: 50) {
        edges {
          node {
            id
            name
            profileLocationGroups {
              locationGroup { id }
              locationGroupZones(first: 250) {
                edges {
                  node {
                    zone {
                      id
                      name
                      countries {
                        name
                        code {
                          countryCode
                          restOfWorld
                        }
                        provinces {
                          name
                          code
                        }
                      }
                    }
                    methodDefinitions(first: 250) {
                      edges {
                        node {
                          id
                          active
                          name
                          description
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

  const res = await admin.graphql(query);
  const json = await res.json();

  if (json?.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  // We store the full response for now; UI code extracts defensively.
  // You already have servicesSnapshotJson in the DB, but we keep it simple:
  // - zonesSnapshotJson: full json
  // - servicesSnapshotJson: derived minimal list for later service picker
  const services = [];
  const profiles = json?.data?.deliveryProfiles?.edges || [];
  for (const pEdge of profiles) {
    const plgs = pEdge?.node?.profileLocationGroups || [];
    for (const plg of plgs) {
      const lgzEdges = plg?.locationGroupZones?.edges || [];
      for (const lgzEdge of lgzEdges) {
        const mdEdges = lgzEdge?.node?.methodDefinitions?.edges || [];
        for (const mdEdge of mdEdges) {
          const md = mdEdge?.node;
          if (!md?.id) continue;
          services.push({
            id: md.id,
            name: md.name || md.description || "Shipping service",
            active: !!md.active,
            description: md.description || null,
          });
        }
      }
    }
  }

  // Dedupe services
  const seen = new Set();
  const servicesDeduped = services.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  return {
    zonesSnapshot: json,
    servicesSnapshot: { services: servicesDeduped },
  };
}

export async function loader({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });

  // We store a tiny meta object inside zonesSnapshotJson so we can detect Markets changes
  const existingZonesSnapshot = safeJsonParse(settings?.zonesSnapshotJson, null);
  const existingMeta = existingZonesSnapshot?._meta || {};
  const existingMarketsDigest = existingMeta?.marketsDigest || null;

  // Throttle forced sync so refresh spam doesn’t hammer Shopify
  const lastSyncedAt = settings?.lastSyncedAt ? new Date(settings.lastSyncedAt).getTime() : 0;
  const now = Date.now();
  const THROTTLE_MS = 2 * 60 * 1000; // 2 minutes

  let marketCountryCodes = null;
  let marketsDigest = null;
  let marketsError = null;

  // 1) Try Markets digest (best UX, “truth is Markets”). Requires read_markets. :contentReference[oaicite:2]{index=2}
  try {
    const markets = await fetchMarketsDigestAndCountryCodes(admin);
    marketsDigest = markets.digest;
    marketCountryCodes = markets.marketCountryCodes;
  } catch (e) {
    marketsError = e instanceof Error ? e.message : String(e);
  }

  // 2) If markets changed, force a sync (zones/services) immediately (throttled)
  const shouldForceSync =
    marketsDigest &&
    (existingMarketsDigest == null || marketsDigest !== existingMarketsDigest) &&
    now - lastSyncedAt > THROTTLE_MS;

  if (shouldForceSync || (!settings?.zonesSnapshotJson && now - lastSyncedAt > 5000)) {
    try {
      const { zonesSnapshot, servicesSnapshot } = await syncShippingConfig(admin);

      // Attach meta (markets digest + codes) to zones snapshot for the picker
      const withMeta = {
        ...zonesSnapshot,
        _meta: {
          marketsDigest: marketsDigest || null,
          marketCountryCodes: marketCountryCodes || null,
          marketsError: marketsError || null,
          updatedAtIso: new Date().toISOString(),
        },
      };

      await prisma.shopSettings.update({
        where: { shop },
        data: {
          zonesSnapshotJson: JSON.stringify(withMeta),
          servicesSnapshotJson: JSON.stringify(servicesSnapshot),
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });

      const updated = await prisma.shopSettings.findUnique({ where: { shop } });
      return { settings: updated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.shopSettings.update({
        where: { shop },
        data: { lastSyncError: msg },
      });
      const updated = await prisma.shopSettings.findUnique({ where: { shop } });
      return { settings: updated };
    }
  }

  // If we didn’t sync, still persist markets meta if we have it and there’s already a snapshot
  if (settings?.zonesSnapshotJson && (marketsDigest || marketsError)) {
    const nextSnapshot = existingZonesSnapshot || {};
    const nextMeta = {
      ...(nextSnapshot._meta || {}),
      marketsDigest: marketsDigest || nextSnapshot?._meta?.marketsDigest || null,
      marketCountryCodes: marketCountryCodes || nextSnapshot?._meta?.marketCountryCodes || null,
      marketsError: marketsError || null,
    };

    // Only write if it changed materially
    const changed =
      JSON.stringify(nextMeta) !== JSON.stringify(existingMeta || {});
    if (changed) {
      await prisma.shopSettings.update({
        where: { shop },
        data: { zonesSnapshotJson: JSON.stringify({ ...nextSnapshot, _meta: nextMeta }) },
      });
      const updated = await prisma.shopSettings.findUnique({ where: { shop } });
      return { settings: updated };
    }
  }

  return { settings };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  if (intent !== "save") return { ok: false, error: "Unknown intent" };

  const managedZoneConfigJson = String(formData.get("managedZoneConfigJson") || "{}");

  let parsed = getDefaultConfig();
  try {
    parsed = normalizeConfig(JSON.parse(managedZoneConfigJson));
  } catch {
    parsed = getDefaultConfig();
  }

  await prisma.shopSettings.update({
    where: { shop },
    data: {
      managedZoneConfigJson: JSON.stringify(parsed),
    },
  });

  return { ok: true };
}

export default function SettingsIndex() {
  const { settings } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const location = useLocation();
  const search = location.search || "";

  const [saving, setSaving] = useState(false);
  const [zoneModalOpen, setZoneModalOpen] = useState(false);

  const zonesLastUpdatedLabel = useMemo(
    () => formatUpdatedLabel(settings?.lastSyncedAt),
    [settings?.lastSyncedAt],
  );

  const savedConfig = useMemo(() => {
    const raw = safeJsonParse(settings?.managedZoneConfigJson, getDefaultConfig());
    return normalizeConfig(raw);
  }, [settings?.managedZoneConfigJson]);

  const [draftConfig, setDraftConfig] = useState(savedConfig);

  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [expandedCountries, setExpandedCountries] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => setDraftConfig(savedConfig), [JSON.stringify(savedConfig)]);
  useEffect(() => {
    if (actionData?.ok !== undefined) setSaving(false);
  }, [actionData?.ok]);

  // Build country/province data from zonesSnapshotJson (accurate, no hardcoding)
  const zonesSnapshot = useMemo(
    () => safeJsonParse(settings?.zonesSnapshotJson, null),
    [settings?.zonesSnapshotJson],
  );

  const zonesCountriesByCode = useMemo(() => {
    return extractCountriesFromDeliveryProfilesSnapshot(zonesSnapshot || {});
  }, [zonesSnapshot]);
  const debugZonesCount = Object.keys(zonesCountriesByCode || {}).length;

  // Markets filter (truth = Markets). If markets scope isn’t available yet, this may be null.
  const marketCountryCodes = useMemo(() => {
    const meta = zonesSnapshot?._meta || {};
    const codes = meta?.marketCountryCodes;
    return Array.isArray(codes) ? codes : null;
  }, [zonesSnapshot]);

  const availableCountryCodes = useMemo(() => {
    const zoneCodes = Object.keys(zonesCountriesByCode || {}).sort();
    if (marketCountryCodes && marketCountryCodes.length) {
      // Only show countries that are in markets AND in zones snapshot (so we can list provinces)
      const allowed = new Set(marketCountryCodes);
      return zoneCodes.filter((cc) => allowed.has(cc));
    }
    // Fallback if Markets isn’t available yet
    return zoneCodes;
  }, [zonesCountriesByCode, marketCountryCodes]);

  const NORTH_AMERICA_SET = new Set(["US", "CA", "MX"]);

  const northAmericaCountryCodes = useMemo(() => {
    return availableCountryCodes.filter((cc) => NORTH_AMERICA_SET.has(cc));
  }, [availableCountryCodes]);

  const internationalCountryCodes = useMemo(() => {
    return availableCountryCodes.filter((cc) => !NORTH_AMERICA_SET.has(cc));
  }, [availableCountryCodes]);

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
      if (entryOrNull === null) {
        delete countries[countryCode];
      } else {
        countries[countryCode] = entryOrNull;
      }
      next.groups[groupKey].countries = countries;
      return next;
    });
  };

  const selectAllInCountry = (groupKey, countryCode) => {
    const regions = getCountryRegions(countryCode, zonesCountriesByCode);
    if (regions.length === 0) {
      // No provinces returned; represent selection as selected=true
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
      // Only “All of Country” exists
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
    submit(fd, { method: "post" });
  };

  const zonesButtonLabel =
    Object.keys(draftConfig.groups.northAmerica.countries || {}).length ||
    Object.keys(draftConfig.groups.international.countries || {}).length
      ? "Edit Zones"
      : "Select Shipping Zones";

  // Main page display list (expandable summary)
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
            <Button variant="tertiary" onClick={() => toggleMain(groupKey)}>
              <Icon source={expanded ? ChevronUpIcon : ChevronDownIcon} />
            </Button>
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

    // Hide if search matches nothing
    const groupMatches =
      matchesSearch(title) ||
      countryCodes.some((cc) => matchesSearch(getCountryDisplayName(cc, zonesCountriesByCode)));

    if (!groupMatches && searchQuery.trim()) return null;

    return (
      <Box borderWidth="025" borderColor="border" borderRadius="200">
        {/* Header row: title + summary inline, chevron at end */}
        <Box padding="200">
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
              onClick={() => toggleGroup(groupKey)}
              accessibilityLabel={`Toggle ${title}`}
            >
              <Icon source={expanded ? ChevronUpIcon : ChevronDownIcon} />
            </Button>
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
                    {/* Country row: NO checkbox here (per your requirement). Click chevron to expand. */}
                    <Box padding="200">
                      <InlineGrid columns={["1fr", "auto"]} gap="200" alignItems="center">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd">{countryName}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {counts.label || (entry ? "Selected" : "")}
                          </Text>
                        </InlineStack>

                        <Button
                          variant="tertiary"
                          onClick={() => toggleCountryExpand(groupKey, cc)}
                          accessibilityLabel={`Toggle ${countryName}`}
                        >
                          <Icon source={cExpanded ? ChevronUpIcon : ChevronDownIcon} />
                        </Button>
                      </InlineGrid>
                    </Box>

                    <Collapsible open={cExpanded}>
                      <Divider />
                      <Box padding="200">
                        <BlockStack gap="150">
                          {/* Select all row (checkbox starts here, not at country row) */}
                          <InlineGrid columns={["auto", "1fr"]} gap="200" alignItems="center">
                            <Checkbox
                              label=""
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
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                              Select all
                            </Text>
                          </InlineGrid>

                          {/* Region rows */}
                          {regions.length ? (
                            regions
                              .filter((r) => matchesSearch(r.name) || !searchQuery.trim())
                              .map((r) => {
                                const selectedSet = new Set(Array.isArray(entry?.provinces) ? entry.provinces : []);
                                const isChecked = selectedSet.has(r.code);

                                return (
                                  <InlineGrid
                                    key={`${groupKey}-${cc}-${r.code}`}
                                    columns={["auto", "1fr"]}
                                    gap="200"
                                    alignItems="center"
                                  >
                                    <Checkbox
                                      label=""
                                      checked={isChecked}
                                      onChange={(isNowChecked) => toggleRegion(groupKey, cc, r.code, isNowChecked)}
                                    />
                                    <Text as="span" variant="bodySm">
                                      {r.name}
                                    </Text>
                                  </InlineGrid>
                                );
                              })
                          ) : (
                            // No provinces returned for this country; show a single “All of country” checkbox row
                            <InlineGrid columns={["auto", "1fr"]} gap="200" alignItems="center">
                              <Checkbox
                                label=""
                                checked={!!entry?.selected}
                                onChange={(isNowChecked) => toggleRegion(groupKey, cc, "__ALL__", isNowChecked)}
                              />
                              <Text as="span" variant="bodySm">
                                All of {countryName}
                              </Text>
                            </InlineGrid>
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

  return (
    <Page title="Settings">
      <BlockStack gap="400">
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

            {/* Bottom-left sync label */}
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
                <Text as="p" variant="bodySm" tone="subdued">
                  Debug: zonesCountriesByCode = {debugZonesCount}
                </Text>


              {settings?.lastSyncError ? (
                <Box paddingBlockStart="150">
                  <Text as="p" variant="bodySm" tone="critical">
                    {settings.lastSyncError}
                  </Text>
                </Box>
              ) : null}
            </Box>

            {/* Optional: show markets warning if scope missing */}
            {zonesSnapshot?._meta?.marketsError ? (
              <Box paddingBlockStart="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  Markets filter unavailable (needs read_markets scope): {String(zonesSnapshot._meta.marketsError)}
                </Text>
              </Box>
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Shipping Services</Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Next: service selection (after zone selection is finalized).
            </Text>
          </BlockStack>
        </Card>

        {/* Bottom-right actions (locked UX) */}
        <Box paddingBlockStart="200">
          <InlineStack align="end" gap="200">
            <Button onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={onSave} loading={saving}>Save</Button>
          </InlineStack>
        </Box>
      </BlockStack>

      <Modal
        open={zoneModalOpen}
        onClose={() => setZoneModalOpen(false)}
        title="Select shipping zones"
        primaryAction={{ content: "Done", onAction: () => setZoneModalOpen(false) }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setDraftConfig(savedConfig);
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
    </Page>
  );
}
