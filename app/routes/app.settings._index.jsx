// app/routes/app.settings._index.jsx
import { Page, Card, Text, BlockStack, InlineStack, Badge } from "@shopify/polaris";
import { useLocation } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  // Keep auth so embedded app routing/session stays stable
  await authenticate.admin(request);
  return {};
}

export default function SettingsIndex() {
  const location = useLocation();
  const search = location.search || ""; // preserve ?shop=...&host=...

  return (
    <Page
      title="Settings"
      primaryAction={{
        content: "Back to Shipping Charts",
        url: `/app/tiers${search}`,
      }}
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Settings temporarily disabled
              </Text>
              <Badge tone="warning">Paused</Badge>
            </InlineStack>

            <Text as="p" variant="bodyMd" tone="subdued">
              Shipping zone assignment is managed directly in Shopify Shipping and delivery settings.
              This page will return when we add “Default Shipping Service” selection.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
