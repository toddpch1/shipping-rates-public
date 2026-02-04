import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  IndexTable,
  Layout,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

export function ShippingChartEditorForm({
  mode, // "create" | "edit"
  chart,
  shippingServiceOptions = [],
  saving = false,
  onSave,
  onCancel,
}) {
    const [name, setName] = useState(chart?.name ?? "");
  const [isActive, setIsActive] = useState(chart?.isActive ?? true);
    const [defaultService, setDefaultService] = useState(
    chart?.defaultServiceCode ?? ""
  );

  const [handlingFee, setHandlingFee] = useState(chart?.handlingFee ?? 0);
  const [handlingFeeText, setHandlingFeeText] = useState(
    formatMoney2(chart?.handlingFee ?? 0)
  );


  const [tiers, setTiers] = useState(() => {
    const incoming = Array.isArray(chart?.tiers) ? chart.tiers : [];
    if (incoming.length) {
      return incoming
        .slice()
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        .map((t) => ({
          _key: t.id ?? crypto.randomUUID(),
          id: t.id ?? null,
          minValue: t.minValue ?? 0,
          minValueText: String(t.minValue ?? 0),
          maxValue: t.maxValue ?? null,
          maxValueText: t.maxValue == null ? "" : String(t.maxValue),
          rateType: t.rateType ?? "FLAT",
          rateValue: t.rateValue == null ? null : Number(t.rateValue),
          rateValueText: t.rateValue == null ? "" : String(t.rateValue),
          priority: t.priority ?? 0,
        }));
    }

    return [
      {
        _key: crypto.randomUUID(),
        id: null,
        minValue: 0,
        minValueText: formatMoney2(0),
        maxValue: null,
        maxValueText: "",
        rateType: "FLAT",
        rateValue: 0,
        rateValueText: formatMoney2(0),
        priority: 0,
      },
    ];
  });

  function addTier() {
    setTiers((prev) => [
      ...prev,
            (() => {
        const last = prev[prev.length - 1];
        const lastMax = last?.maxValue;
        const nextMin =
          typeof lastMax === "number" && Number.isFinite(lastMax)
            ? Number((lastMax + 0.01).toFixed(2))
            : null;

        return {
          _key: crypto.randomUUID(),
          id: null,
          minValue: nextMin,
          minValueText: nextMin == null ? "" : formatMoney2(nextMin),
          maxValue: null,
          maxValueText: "",
          rateType: "FLAT",
          rateValue: prev.length === 0 ? 0 : null,
          rateValueText: prev.length === 0 ? formatMoney2(0) : "",
          priority: prev.length,
        };
      })(),
    ]);
  }

  function updateTier(key, patch) {
    setTiers((prev) =>
      prev.map((t) => (t._key === key ? { ...t, ...patch } : t))
    );
  }

  function deleteTier(key) {
    setTiers((prev) => prev.filter((t) => t._key !== key));
  }

  function formatMoney2(amount) {
  const n = Number(amount ?? 0);
  return n.toFixed(2);
}

  function formatPercentWhole(amount) {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

  useEffect(() => {
    setName(chart?.name ?? "");
    setIsActive(chart?.isActive ?? true);
        setDefaultService(chart?.defaultServiceCode ?? "");
    setHandlingFee(chart?.handlingFee ?? 0);
    setHandlingFeeText(formatMoney2(chart?.handlingFee ?? 0));
        setTiers(() => {
      const incoming = Array.isArray(chart?.tiers) ? chart.tiers : [];
      if (incoming.length) {
                return incoming
          .slice()
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          .map((t) => ({
            _key: t.id ?? crypto.randomUUID(),
            id: t.id ?? null,

            minValue: t.minValue ?? 0,
            minValueText: formatMoney2(t.minValue ?? 0),

            maxValue: t.maxValue ?? null,
            maxValueText: t.maxValue == null ? "" : formatMoney2(t.maxValue),

            rateType: t.rateType ?? "FLAT",
            rateValue: t.rateValue == null ? null : Number(t.rateValue),
            rateValueText:
              t.rateValue == null
                ? ""
                : (t.rateType ?? "FLAT") === "PERCENT"
                  ? formatPercentWhole(t.rateValue)
                  : formatMoney2(t.rateValue),

            priority: t.priority ?? 0,
          }));

      }

            return [
        {
          _key: crypto.randomUUID(),
          id: null,

          minValue: 0,
          minValueText: formatMoney2(0),

          maxValue: null,
          maxValueText: "",

          rateType: "FLAT",
          rateValue: 0,
          rateValueText: formatMoney2(0),

          priority: 0,
        },
      ];
    });

  }, [chart?.id]);

  const statusOptions = useMemo(
    () => [
      { label: "Active", value: "true" },
      { label: "Inactive", value: "false" },
    ],
    []
  );

      const summaryTierLines = useMemo(() => {
    const sorted = (tiers || [])
      .slice()
      .sort((a, b) => Number(a.minValue ?? 0) - Number(b.minValue ?? 0));

    if (!sorted.length) return [];

    return sorted.map((t, i) => {
      const min = formatMoney2(t.minValue ?? 0);
      const maxLabel =
        t.maxValue === null || t.maxValue === undefined || t.maxValue === ""
          ? "No max"
          : formatMoney2(t.maxValue);

      const isPercent = t.rateType === "PERCENT";

      return (
        <InlineStack key={t._key ?? t.id ?? i} gap="100" blockAlign="baseline">
          <Text as="span">{`Min $${min} to ${maxLabel === "No max" ? maxLabel : `$${maxLabel}`} = `}</Text>

          {isPercent ? (
            <InlineStack gap="100" blockAlign="baseline">
              <Text as="span">{`${Math.round(Number(t.rateValue ?? 0))}%`}</Text>
              <Text as="span" variant="bodySm" tone="subdued">
                of Merch Value
              </Text>
            </InlineStack>
          ) : (
            <Text as="span">{`$${formatMoney2(t.rateValue ?? 0)}`}</Text>
          )}
        </InlineStack>
      );
    });
  }, [tiers]);


  function handleSave() {
    if (typeof onSave !== "function") return;

  const payload = {
    name: String(name || "").trim(),
    isActive: Boolean(isActive),
    handlingFee: Number(handlingFee ?? 0),
    tiers: tiers.map((t, index) => ({
    minValue:
    t.minValue == null || t.minValue === ""
      ? index === 0 ? 0 : null
      : Number(t.minValue),
    maxValue: t.maxValue === null || t.maxValue === "" ? null : Number(t.maxValue),
    rateType: t.rateType,
    rateValue:
    t.rateValueText == null || String(t.rateValueText).trim() === ""
      ? (index === 0 ? 0 : null)
      : t.rateType === "PERCENT"
        ? Math.round(Number(t.rateValueText))
        : Number(t.rateValueText),
    priority: index,
    })),
  };

    onSave(payload);
  }

  function handleCancelClick(e) {
    // Defensive: ensure Cancel never behaves like a submit in any accidental form context
    if (e?.preventDefault) e.preventDefault();
    if (e?.stopPropagation) e.stopPropagation();
    if (typeof onCancel === "function") onCancel();
  }
  const showPercentHint = tiers.some((t) => t.rateType === "PERCENT");

  const rateHeadingTitle = showPercentHint ? (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <Text as="span">Rate</Text>
      <Text as="span" variant="bodySm" tone="subdued">
        (% of Merch Value)
      </Text>
    </InlineStack>
  ) : (
    "Rate"
  );

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto" }}>
      <Layout>
        <Layout.Section variant="twoThirds">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Shipping Chart Name
                </Text>
                <TextField
                  label="Name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  placeholder="e.g. US Retail, Catalog Only, Canada…"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Shipping tiers
                  </Text>
                  <Button onClick={addTier}>Add tier</Button>
                </InlineStack>

                <IndexTable
                  itemCount={tiers.length}
                  selectable={false}
                  headings={[
                    { title: "Min $" },
                    { title: "Max $" },
                    { title: "Type" },
                    { title: rateHeadingTitle },
                    { title: "" },
                  ]}
                >
                  {tiers.map((tier, index) => (
                    <IndexTable.Row
                      id={tier._key}
                      key={tier._key}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <TextField
                          type="number"
                          value={tier.minValueText ?? ""}
                          onChange={(v) =>
                            updateTier(tier._key, { minValueText: v })
                          }
                          onBlur={() => {
                            const raw = (tier.minValueText ?? "").trim();

                            // Blank stays blank for tier 2+; tier 1 defaults to 0.00
                            if (raw === "") {
                              if (index === 0) {
                                updateTier(tier._key, {
                                  minValue: 0,
                                  minValueText: formatMoney2(0),
                                });
                              } else {
                                updateTier(tier._key, {
                                  minValue: null,
                                  minValueText: "",
                                });
                              }
                              return;
                            }

                            const n = Number(raw);
                            const safe = Number.isFinite(n) ? n : index === 0 ? 0 : null;

                            updateTier(tier._key, {
                              minValue: safe,
                              minValueText: safe == null ? "" : formatMoney2(safe),
                            });
                          }}
                          autoComplete="off"
                        />
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <TextField
                          type="number"
                          placeholder="∞"
                          value={tier.maxValueText ?? ""}
                          onChange={(v) =>
                            updateTier(tier._key, { maxValueText: v })
                          }
                          onBlur={() => {
                            const raw = (tier.maxValueText ?? "").trim();

                            // If max cleared, keep it cleared and do not auto-fill next min
                            if (raw === "") {
                              updateTier(tier._key, { maxValue: null, maxValueText: "" });
                              return;
                            }

                            const n = Number(raw);
                            const safe = Number.isFinite(n) ? n : null;

                            updateTier(tier._key, {
                              maxValue: safe,
                              maxValueText: safe == null ? "" : formatMoney2(safe),
                            });

                            // Auto-fill next tier min = this max + 0.01 (only if next min is blank)
                            if (safe != null) {
                              const next = tiers[index + 1];
                              if (next && String(next.minValueText ?? "").trim() === "") {
                                const nextMin = Number((safe + 0.01).toFixed(2));
                                updateTier(next._key, {
                                  minValue: nextMin,
                                  minValueText: formatMoney2(nextMin),
                                });
                              }
                            }
                          }}
                          autoComplete="off"
                        />
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Select
                          options={[
                            { label: "Flat", value: "FLAT" },
                            { label: "Percent", value: "PERCENT" },
                          ]}
                          value={tier.rateType}
                          onChange={(v) =>
                            updateTier(tier._key, { rateType: v })
                          }
                        />
                      </IndexTable.Cell>

                                            <IndexTable.Cell>
                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                          <div style={{ minWidth: 110 }}>
                            <TextField
                              type="number"
                              value={tier.rateValueText ?? ""}
                              onChange={(v) =>
                                updateTier(tier._key, { rateValueText: v })
                              }
                              onBlur={() => {
                                const raw = (tier.rateValueText ?? "").trim();

                                // Blank stays blank for tier 2+; tier 1 defaults to 0
                                if (raw === "") {
                                  if (index === 0) {
                                    if (tier.rateType === "PERCENT") {
                                      updateTier(tier._key, {
                                        rateValue: 0,
                                        rateValueText: formatPercentWhole(0),
                                      });
                                    } else {
                                      updateTier(tier._key, {
                                        rateValue: 0,
                                        rateValueText: formatMoney2(0),
                                      });
                                    }
                                  } else {
                                    updateTier(tier._key, { rateValue: null, rateValueText: "" });
                                  }
                                  return;
                                }

                                const n = Number(raw);
                                const safe = Number.isFinite(n) ? n : index === 0 ? 0 : null;

                                if (tier.rateType === "PERCENT") {
                                  const whole = safe == null ? null : Math.round(safe);
                                  updateTier(tier._key, {
                                    rateValue: whole,
                                    rateValueText: whole == null ? "" : formatPercentWhole(whole),
                                  });
                                  return;
                                }

                                updateTier(tier._key, {
                                  rateValue: safe,
                                  rateValueText: safe == null ? "" : formatMoney2(safe),
                                });
                              }}


                              suffix={tier.rateType === "PERCENT" ? "%" : "$"}
                              autoComplete="off"
                            />
                          </div>

                        </InlineStack>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Button
                          tone="critical"
                          onClick={() => deleteTier(tier._key)}
                        >
                          Delete
                        </Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                  </IndexTable>

              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Handling fee
                </Text>

                <TextField
                  label="Handling fee ($)"
                  value={handlingFeeText}
                  onChange={(v) => setHandlingFeeText(v)}
                  onBlur={() => {
                    const n = Number(handlingFeeText);
                    const safe = Number.isFinite(n) ? n : 0;
                    setHandlingFee(safe);
                    setHandlingFeeText(formatMoney2(safe));
                  }}
                  autoComplete="off"
                  helpText="Added to the calculated tier rate (flat or percent). Default is $0.00."
                />
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Summary
                </Text>

                <BlockStack gap="100">

                  <Text tone="subdued">Tiers</Text>
                  {!summaryTierLines.length ? (
                    <Text>0 tiers</Text>
                  ) : (
                    <BlockStack gap="100">
                      {summaryTierLines.map((node, i) => (
                        <div key={i}>{node}</div>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Default shipping service
                </Text>
                <Select
                  label="Service"
                  options={[
                    { label: "Shopify calculated (default)", value: "" },
                    ...(shippingServiceOptions || []),
                  ]}
                  value={defaultService}
                  onChange={setDefaultService}
                />
                <Text tone="subdued">
                  UI only for now (not saved yet). We’ll store this once the database field is added.

                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Status
                </Text>
                <Select
                  label="Status"
                  options={statusOptions}
                  value={String(isActive)}
                  onChange={(v) => setIsActive(v === "true")}
                />
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={isActive ? "success" : "critical"}>
                    {isActive ? "Active" : "Inactive"}
                  </Badge>
                </InlineStack>
              </BlockStack>
            </Card>

            <InlineStack gap="200" align="end">
              <Button onClick={handleCancelClick} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                loading={saving}
                disabled={saving}
              >
                {mode === "edit" ? "Save changes" : "Create chart"}
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </div>
  );
}
