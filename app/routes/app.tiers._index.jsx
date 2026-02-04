import { useLoaderData, useSubmit, useNavigate, useLocation } from "react-router";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Button,
  ButtonGroup,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Loader: list charts for this shop
 */
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const charts = await prisma.shippingChart.findMany({
    where: { shop },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  return { charts };
}

/**
 * Action: toggle active, delete chart (+ tiers/selectors)
 */
export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (!id) return { ok: false, error: "Missing id" };

  const chart = await prisma.shippingChart.findFirst({
    where: { id, shop },
    select: { id: true, isActive: true, name: true },
  });

  if (!chart) return { ok: false, error: "Chart not found" };

  if (intent === "toggle-active") {
    await prisma.shippingChart.update({
      where: { id: chart.id },
      data: { isActive: !chart.isActive },
    });
    return { ok: true };
  }

  if (intent === "delete-chart") {
    await prisma.$transaction([
      prisma.shippingChart.update({
        where: { id: chart.id },
        data: {
          tiers: { deleteMany: {} },
          selectors: { deleteMany: {} },
        },
      }),
      prisma.shippingChart.delete({ where: { id: chart.id } }),
    ]);
    return { ok: true };
  }

  return { ok: false, error: "Unknown intent" };
}

export default function ShippingChartsIndex() {
  const { charts } = useLoaderData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const location = useLocation();

  // Preserve embedded params
  const search = location.search || window.location.search || "";

  const goToChart = (chartId) => navigate(`/app/tiers/${chartId}${search}`);
  const goCreate = () => navigate(`/app/tiers/new${search}`);

  const resourceName = { singular: "chart", plural: "charts" };

  const emptyStateMarkup = (
    <Box padding="400">
      <Text as="h2" variant="headingMd">
        No shipping charts yet
      </Text>
      <Box paddingBlockStart="200">
        <Text as="p" tone="subdued">
          Create your first chart to start configuring tiered shipping rates.
        </Text>
      </Box>
      {/* Intentionally no Create button here (Page primaryAction is the single Create entry point) */}
    </Box>
  );

  const rowMarkup = charts.map((chart, index) => {
    const statusBadge = chart.isActive ? (
      <Badge tone="success">Active</Badge>
    ) : (
      <Badge>Inactive</Badge>
    );

    return (
      <IndexTable.Row id={chart.id} key={chart.id} position={index}>
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="semibold" as="span">
            {chart.name}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>{statusBadge}</IndexTable.Cell>

        <IndexTable.Cell>
          <InlineStack gap="200" align="end">
            <ButtonGroup>
              <Button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  goToChart(chart.id);
                }}
              >
                Edit
              </Button>

              <Button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  submit(
                    { intent: "toggle-active", id: chart.id },
                    { method: "post" }
                  );
                }}
              >
                {chart.isActive ? "Disable" : "Enable"}
              </Button>

              <Button
                tone="critical"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  const ok = window.confirm(
                    `Delete "${chart.name}"?\n\nThis will permanently delete:\n• the chart\n• all tiers\n• all selectors\n\nThis cannot be undone.`
                  );
                  if (!ok) return;

                  submit({ intent: "delete-chart", id: chart.id }, { method: "post" });
                }}
              >
                Delete
              </Button>
            </ButtonGroup>
          </InlineStack>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title="Shipping charts"
      primaryAction={{ content: "Create shipping chart", onAction: goCreate }}
    >
      <Card padding="0">
        <IndexTable
          resourceName={resourceName}
          itemCount={charts.length}
          headings={[{ title: "Chart" }, { title: "Status" }, { title: "Actions" }]}
          selectable={false}
          emptyState={emptyStateMarkup}
        >
          {rowMarkup}
        </IndexTable>
      </Card>
    </Page>
  );
}
