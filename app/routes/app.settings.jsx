import { Page, Card, Text } from "@shopify/polaris";

export default function SettingsPage() {
  return (
    <Page title="Settings">
      <Card>
        <Text as="p" tone="subdued">
          Settings will manage default shipping services (app-defined list first).
          Later we can map these to real checkout identifiers when we implement the
          carrier service / functions layer.
        </Text>
      </Card>
    </Page>
  );
}
