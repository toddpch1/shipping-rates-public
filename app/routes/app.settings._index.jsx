import { useMemo, useState, useCallback } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Divider,
  Box,
  Link,
  Modal,
} from "@shopify/polaris";
import {
  useLoaderData,
  useSubmit,
  useActionData,
  useNavigate,
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

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings =
    (await prisma.shopSettings.findUnique({ where: { shop } })) ||
    (await prisma.shopSettings.create({ data: { shop } }));

  return {
    shop,
    volumeDiscountLabel: settings.volumeDiscountLabel || "Volume Pricing",
    volumePricingSnapshot: safeJsonParse(settings.volumePricingSnapshotJson, null),
    volumePricingLastSyncedAt: settings.volumePricingLastSyncedAt
      ? settings.volumePricingLastSyncedAt.toISOString()
      : null,
    volumePricingLastSyncError: settings.volumePricingLastSyncError || null,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "save-volume-label") {
    const label = String(form.get("volumeDiscountLabel") || "").trim() || "Volume Pricing";
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, volumeDiscountLabel: label },
      update: { volumeDiscountLabel: label },
    });
    return { ok: true };
  }

  if (intent === "refresh-volume-pricing") {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret) return { ok: false, error: "Missing INTERNAL_SYNC_SECRET" };

    const url = new URL(request.url);
    const origin = url.origin;

    const resp = await fetch(
      `${origin}/api/internal/sync-volume-pricing?shop=${encodeURIComponent(shop)}`,
      { method: "POST", headers: { "x-internal-secret": secret } }
    );

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: json?.error || "Refresh failed" };

    return { ok: true, refreshed: true, matched: json?.matched ?? null };
  }

  return { ok: false, error: "Unknown intent" };
}

export default function SettingsPage() {
  const submit = useSubmit();
  const navigate = useNavigate();
  const actionData = useActionData();
  const data = useLoaderData();

  const [label, setLabel] = useState(data.volumeDiscountLabel || "Volume Pricing");

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedDiscount, setSelectedDiscount] = useState(null);

  const openDiscountModal = useCallback((discount) => {
    setSelectedDiscount(discount);
    setModalOpen(true);
  }, []);

  const closeDiscountModal = useCallback(() => {
    setModalOpen(false);
    setSelectedDiscount(null);
  }, []);

  const snapshot = data.volumePricingSnapshot;
  const discounts = Array.isArray(snapshot?.discounts) ? snapshot.discounts : [];

  const snapshotPulledAt = snapshot?.pulledAt || "(unknown)";
  const lastSyncedLabel = data.volumePricingLastSyncedAt || "Never";

  return (
    <Page
      title="Settings"
      primaryAction={{
        content: "Back to charts",
        onAction: () => navigate("/app/tiers"),
      }}
    >
      <BlockStack gap="400">
        {actionData?.ok === false && actionData?.error ? (
          <Banner tone="critical" title="Settings error">
            <p>{actionData.error}</p>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="200">
            <Text variant="headingMd" as="h2">
              Volume Price settings
            </Text>

            {/* Label + field exactly as requested */}
            <TextField
              label="Volume discount label to match"
              value={label}
              onChange={setLabel}
              autoComplete="off"
            />

            {/* Help text left, Save button right, both under the TextField */}
            <InlineStack align="space-between" blockAlign="start" gap="200">
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">
                  We’ll match automatic discounts whose title contains this text (case-insensitive).
                  Default: Volume Pricing.
                </Text>
              </Box>

              <Button
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "save-volume-label");
                  fd.set("volumeDiscountLabel", label);
                  submit(fd, { method: "post" });
                }}
              >
                Save label
              </Button>
            </InlineStack>

            <Divider />

            <Box>
              <Text as="p" variant="bodySm" tone="subdued">
                Last synced: {lastSyncedLabel}
              </Text>
              {data.volumePricingLastSyncError ? (
                <Text as="p" variant="bodySm" tone="critical">
                  Last sync error: {data.volumePricingLastSyncError}
                </Text>
              ) : null}
            </Box>

            <Divider />

            {/* Snapshot preview left + Refresh button right aligned to bottom */}
            <InlineStack align="space-between" blockAlign="end" gap="300" wrap={false}>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">
                  Cached snapshot preview
                </Text>

                <Text as="p" variant="bodySm">
                  Snapshot pulledAt: {snapshotPulledAt}
                </Text>

                <Text as="p" variant="bodySm">
                  Matched: {snapshot ? discounts.length : 0}
                </Text>

                {discounts.length ? (
                  <BlockStack gap="100">
                    {discounts.map((d, idx) => (
                      <Text as="p" key={idx} variant="bodySm">
                        •{" "}
                        <Link removeUnderline onClick={() => openDiscountModal(d)}>
                          {d.title}
                        </Link>{" "}
                        ({d.type}, {d.status})
                      </Text>
                    ))}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm">
                    {snapshot ? "No matching discounts found." : "No cached snapshot yet."}
                  </Text>
                )}
              </BlockStack>

              <Button
                variant="primary"
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "refresh-volume-pricing");
                  submit(fd, { method: "post" });
                }}
              >
                Refresh volume pricing now
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Modal
          open={modalOpen}
          onClose={closeDiscountModal}
          title={selectedDiscount?.title || "Discount details"}
          primaryAction={{ content: "Close", onAction: closeDiscountModal }}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p" variant="bodySm" tone="subdued">
                Type: {selectedDiscount?.type || "(unknown)"} • Status:{" "}
                {selectedDiscount?.status || "(unknown)"}
              </Text>

              {selectedDiscount?.type === "DiscountAutomaticApp" ? (
                <Banner tone="info" title="App-managed automatic discount">
                  <p>
                    This discount is managed by another app (Dealeasy). Shopify’s Admin API usually
                    does not expose the tier table for app-managed discounts. Next step is to locate
                    where Dealeasy stores the tier config so we can display it here and apply it in
                    /api/rates.
                  </p>
                </Banner>
              ) : null}

              <Box>
                <Text as="p" variant="bodySm" tone="subdued">
                  Cached snapshot entry (raw)
                </Text>
                <Box paddingBlockStart="200">
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(selectedDiscount, null, 2)}
                  </pre>
                </Box>
              </Box>
            </BlockStack>
          </Modal.Section>
        </Modal>
      </BlockStack>
    </Page>
  );
}
