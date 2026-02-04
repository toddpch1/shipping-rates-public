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

  const goToChart = (chartId) => {
    navigate(`/app/tiers/${chartId}${search}`);
  };

  const goCreate = () => {
    // ✅ SPA navigation (prevents Shopify iframe bounce/arrow)
    navigate(`/app/tiers/new${search}`);
  };

  const rowMarkup = charts.map((chart, index) => {
    const statusBadge = chart.isActive ? (
      <Badge tone="success">Active</Badge>
    ) : (
      <Badge tone="subdued">Inactive</Badge>
    );

    return (
      <IndexTable.Row id={chart.id} key={chart.id} position={index}>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {chart.name}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>{statusBadge}</IndexTable.Cell>

        <IndexTable.Cell>
          <InlineStack gap="200" align="end">
            <ButtonGroup>
              <Button onClick={() => goToChart(chart.id)}>Edit</Button>

              <Button
                onClick={() => {
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
                onClick={() => {
                  const ok = window.confirm(
                    `Delete "${chart.name}"?\n\nThis will permanently delete:\n• the chart\n• all tiers\n• all selectors\n\nThis cannot be undone.`
                  );
                  if (!ok) return;

                  submit(
                    { intent: "delete-chart", id: chart.id },
                    { method: "post" }
                  );
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
      title="Shipping Charts"
      primaryAction={{
        content: "Create New Shipping Chart",
        onAction: goCreate, // ✅ NOT url
      }}
    >
      {/* Zebra striping + darker header */}
      <style>{`
        .sr-zebra thead th { background: #f3f4f6; }
        .sr-zebra tbody tr:nth-child(even) td { background: #f6f6f7; }
      `}</style>

      <div className="sr-zebra">
        <Card padding="0">
          <IndexTable
            resourceName={{ singular: "chart", plural: "charts" }}
            itemCount={charts.length}
            selectable={false}
            headings={[
              { title: "Shipping Chart" },
              { title: "Status" },
              { title: "Actions" },
            ]}
          >
            {rowMarkup}
          </IndexTable>
        </Card>
      </div>
    </Page>
  );
}
