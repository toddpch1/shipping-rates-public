import { Page, Card, BlockStack, Text, Button } from "@shopify/polaris";
import { useNavigate } from "react-router";

export default function AdditionalPage() {
  const navigate = useNavigate();

  return (
    <Page title="Additional page">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Shipping Rates</Text>
            <Text as="p">
              Use the Tier Charts page to manage your shipping tiers (including catalog-only free shipping).
            </Text>
            <Button onClick={() => navigate("/app/tiers")}>
              Go to Tier Charts
            </Button>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
