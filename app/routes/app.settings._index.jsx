// app/routes/app.settings._index.jsx
import { useEffect, useMemo, useState } from "react";
import {
  Page,
  Card,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Box,
  Modal,
  ResourceList,
  ResourceItem,
  Badge,
  Divider,
  Icon,
  Collapsible,
  ButtonGroup,
  } from "@shopify/polaris";
import { ClockIcon } from "@shopify/polaris-icons";
import { useActionData, useLoaderData, useLocation, useNavigate, useSubmit } from "react-router";
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

/**
 * Best-effort extraction of zones from whatever shape we have stored.
 * We intentionally keep this forgiving because the zones snapshot query
 * is still evolving (and there’s a known selection mismatch issue).
 */
function extractZones(zonesSnapshot) {
  if (!zonesSnapshot) return [];

  // Preferred normalized shape (if/when we store it like this)
  if (Array.isArray(zonesSnapshot.zones)) {
    return zonesSnapshot.zones
      .map((z) => ({
        id: String(z?.id || ""),
        name: String(z?.name || "Untitled zone"),
        countries: Array.isArray(z?.countries) ? z.countries : [],
      }))
      .filter((z) => z.id);
  }

  // Fallback: try a couple common “GraphQL response-ish” shapes
  const maybeZones =
    zonesSnapshot?.data?.deliveryProfiles?.nodes ||
    zonesSnapshot?.data?.deliveryProfile?.zones ||
    zonesSnapshot?.data?.zones ||
    zonesSnapshot?.zones;

  if (Array.isArray(maybeZones)) {
    return maybeZones
    .map((z) => ({
      id: String(z?.id || z?.gid || ""),
      name: String(z?.name || z?.title || "Untitled zone"),
      countries: Array.isArray(z?.countries) ? z.countries : (Array.isArray(z?.locations) ? z.locations : []),
    }))
      .filter((z) => z.id);
  }

  return [];
}

function extractServices(servicesSnapshot) {
  if (!servicesSnapshot) return [];

  // Preferred normalized shape
  if (Array.isArray(servicesSnapshot.services)) {
    return servicesSnapshot.services
      .map((s) => ({
        code: String(s?.code || ""),
        name: String(s?.name || s?.title || s?.code || "Service"),
        carrier: String(s?.carrier || ""),
      }))
      .filter((s) => s.code);
  }

  // Fallback shapes
  const maybe =
    servicesSnapshot?.data?.carrierServices?.nodes ||
    servicesSnapshot?.data?.shippingServices ||
    servicesSnapshot?.services;

  if (Array.isArray(maybe)) {
    return maybe
      .map((s) => ({
        code: String(s?.code || s?.serviceCode || s?.handle || s?.id || ""),
        name: String(s?.name || s?.title || s?.code || "Service"),
        carrier: String(s?.carrier || ""),
      }))
      .filter((s) => s.code);
  }

  return [];
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });

  return { settings };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "save") {
    return { ok: false, error: "Unknown intent" };
  }

  const managedZoneIdsJson = String(formData.get("managedZoneIdsJson") || "[]");

  // Validate JSON string (must be an array)
  let parsed = [];
  try {
    parsed = JSON.parse(managedZoneIdsJson);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    parsed = [];
  }

  await prisma.shopSettings.update({
    where: { shop },
    data: {
      managedZoneIdsJson: JSON.stringify(parsed),
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

  const search = location.search || (typeof window !== "undefined" ? window.location.search : "") || "";

  const [saving, setSaving] = useState(false);
  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [expandedZoneIds, setExpandedZoneIds] = useState(() => new Set());

  const zonesSnapshot = useMemo(
    () => safeJsonParse(settings?.zonesSnapshotJson, {}),
    [settings?.zonesSnapshotJson],
  );
  const servicesSnapshot = useMemo(
    () => safeJsonParse(settings?.servicesSnapshotJson, {}),
    [settings?.servicesSnapshotJson],
  );

  const zones = useMemo(() => extractZones(zonesSnapshot), [zonesSnapshot]);
  const services = useMemo(() => extractServices(servicesSnapshot), [servicesSnapshot]);
  const zonesLastUpdatedLabel = useMemo(() => {
    // Prefer zones snapshot freshness if present; fallback to lastSyncedAt
    const dt = settings?.lastSyncedAt ? new Date(settings.lastSyncedAt) : null;
    if (!dt || Number.isNaN(dt.getTime())) return "Zones last updated on: Not synced yet";
    return `Zones last updated on: ${dt.toLocaleString()}`;
  }, [settings?.lastSyncedAt]);

  const managedZoneIds = useMemo(() => {
    const arr = safeJsonParse(settings?.managedZoneIdsJson, []);
    return Array.isArray(arr) ? arr.map(String) : [];
  }, [settings?.managedZoneIdsJson]);

  const [draftManagedZoneIds, setDraftManagedZoneIds] = useState(managedZoneIds);

  // Keep draft in sync if loader changes (e.g., after save)
  useEffect(() => {
    setDraftManagedZoneIds(managedZoneIds);
  }, [managedZoneIds.join("|")]);

  useEffect(() => {
    if (actionData?.ok !== undefined) {
      setSaving(false);
    }
  }, [actionData?.ok]);

  const selectedZones = useMemo(() => {
    const set = new Set(draftManagedZoneIds);
    return zones.filter((z) => set.has(z.id));
  }, [zones, draftManagedZoneIds]);

  const toggleZone = (zoneId) => {
    setDraftManagedZoneIds((prev) => {
      const set = new Set(prev.map(String));
      if (set.has(String(zoneId))) set.delete(String(zoneId));
      else set.add(String(zoneId));
      return Array.from(set);
    });
  };
  const isZoneExpanded = (zoneId) => expandedZoneIds.has(String(zoneId));
  const toggleZoneExpanded = (zoneId) => {
    setExpandedZoneIds((prev) => {
      const next = new Set(prev);
      const key = String(zoneId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const onCancel = () => {
    navigate(`/app/tiers${search}`);
  };

  const onSave = () => {
    setSaving(true);
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("managedZoneIdsJson", JSON.stringify(draftManagedZoneIds));
    submit(fd, { method: "post" });
  };

  const zonesButtonLabel = draftManagedZoneIds.length ? "Edit Zones" : "Select Shipping Zones";

  return (
    <Page title="Settings">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Zones Managed by this app
              </Text>
              <Button onClick={() => setZoneModalOpen(true)}>{zonesButtonLabel}</Button>
            </InlineStack>

            <Text as="p" variant="bodyMd" tone="subdued">
              Choose which Shopify shipping zones this app will manage. Zones not selected will fall back to Shopify/manual
              rates (carrier service returns an empty list outside managed zones).
            </Text>

            <Divider />

            {draftManagedZoneIds.length === 0 ? (
              <Box paddingBlockStart="200">
                <Text as="p" variant="bodyMd" tone="subdued">
                  No zones selected yet.
                </Text>
              </Box>
            ) : (
              <BlockStack gap="200">
                {selectedZones.length ? (
                  selectedZones.map((z) => (
                    <InlineStack key={z.id} align="space-between">
                      <Text as="span" variant="bodyMd">
                        {z.name}
                      </Text>
                      <Badge tone="success">Managed</Badge>
                    </InlineStack>
                  ))
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Selected zone IDs are saved, but the zones snapshot doesn’t currently include matching zone objects.
                    (This is expected until the zones snapshot normalization is finalized.)
                  </Text>
                )}
              </BlockStack>
            )}
            <Box paddingBlockStart="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="100" blockAlign="center">
                  <Icon source={ClockIcon} />
                  <Text as="span" variant="bodySm" tone="subdued">
                    {zonesLastUpdatedLabel}
                  </Text>
                </InlineStack>

                {/* Optional: show error state without adding any “refresh” action */}
                {settings?.lastSyncError ? (
                  <Badge tone="critical">Sync issue</Badge>
                ) : null}
              </InlineStack>

              {settings?.lastSyncError ? (
                <Box paddingBlockStart="150">
                  <Text as="p" variant="bodySm" tone="critical">
                    {settings.lastSyncError}
                  </Text>
                </Box>
              ) : null}
            </Box>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Shipping Services
            </Text>

            <Text as="p" variant="bodyMd" tone="subdued">
              Phase 1 is read-only: we display the synced services snapshot structure here. Next we’ll add the Shopify-style
              selection UI and persistence.
            </Text>

            <Divider />

            {services.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No services snapshot available yet.
              </Text>
            ) : (
              <BlockStack gap="150">
                {services.slice(0, 12).map((s) => (
                  <InlineStack key={s.code} align="space-between">
                    <Text as="span" variant="bodyMd">
                      {s.name}
                    </Text>
                    <Badge>{s.code}</Badge>
                  </InlineStack>
                ))}
                {services.length > 12 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Showing first 12 services…
                  </Text>
                ) : null}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* Bottom-right actions (locked UX) */}
        <Box paddingBlockStart="200">
          <InlineStack align="end" gap="200">
            <Button onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSave} loading={saving}>
              Save
            </Button>
          </InlineStack>
        </Box>
      </BlockStack>

      <Modal
        open={zoneModalOpen}
        onClose={() => setZoneModalOpen(false)}
        title="Select Shipping Zones"
        primaryAction={{
          content: "Done",
          onAction: () => setZoneModalOpen(false),
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              // revert draft changes back to saved state
              setDraftManagedZoneIds(managedZoneIds);
              setZoneModalOpen(false);
            },
          },
        ]}
      >
        <Modal.Section>
          {zones.length === 0 ? (
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                No zones snapshot found.
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                This page expects zones to be synced daily from Shopify into <Text as="span" variant="bodyMd">zonesSnapshotJson</Text>.
              </Text>
            </BlockStack>
          ) : (
            <ResourceList
              resourceName={{ singular: "zone", plural: "zones" }}
              items={zones}
              renderItem={(zone) => {
                const selected = draftManagedZoneIds.includes(zone.id);
                return (
                  <ResourceItem
                    id={zone.id}
                    accessibilityLabel={`Select ${zone.name}`}
                    onClick={() => toggleZone(zone.id)}
                  >
                    <BlockStack gap="150">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd">
                          {zone.name}
                        </Text>

                        <ButtonGroup>
                          <Button
                            size="slim"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleZoneExpanded(zone.id);
                            }}
                          >
                            {isZoneExpanded(zone.id) ? "Hide" : "View"}
                          </Button>
                          <Badge tone={selected ? "success" : undefined}>
                            {selected ? "Selected" : "Not selected"}
                          </Badge>
                        </ButtonGroup>
                      </InlineStack>

                      <Collapsible open={isZoneExpanded(zone.id)}>
                        {Array.isArray(zone.countries) && zone.countries.length ? (
                          <Box paddingBlockStart="150">
                            <BlockStack gap="100">
                              {zone.countries.slice(0, 12).map((c, idx) => {
                                const countryName = String(c?.name || c?.countryName || c?.code || `Country ${idx + 1}`);
                                const provinces = Array.isArray(c?.provinces) ? c.provinces : (Array.isArray(c?.regions) ? c.regions : []);
                                return (
                                  <Box key={`${zone.id}-c-${idx}`}>
                                    <InlineStack align="space-between">
                                      <Text as="span" variant="bodySm">
                                        {countryName}
                                      </Text>
                                      {provinces.length ? (
                                        <Text as="span" variant="bodySm" tone="subdued">
                                          {provinces.length} provinces
                                        </Text>
                                      ) : null}
                                    </InlineStack>

                                    {provinces.length ? (
                                      <Box paddingBlockStart="100">
                                        <Text as="p" variant="bodySm" tone="subdued">
                                          {provinces
                                            .slice(0, 20)
                                            .map((p) => String(p?.name || p?.code || p))
                                            .join(", ")}
                                          {provinces.length > 20 ? "…" : ""}
                                        </Text>
                                      </Box>
                                    ) : null}
                                  </Box>
                                );
                              })}

                              {zone.countries.length > 12 ? (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  Showing first 12 countries…
                                </Text>
                              ) : null}
                            </BlockStack>
                          </Box>
                        ) : (
                          <Box paddingBlockStart="150">
                            <Text as="p" variant="bodySm" tone="subdued">
                              No country/province details available in the current zones snapshot.
                            </Text>
                          </Box>
                        )}
                      </Collapsible>
                    </BlockStack>
                  </ResourceItem>
                );
              }}
            />
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}
