import { useEffect, useMemo, useState } from "react";
import { Page } from "@shopify/polaris";
import {
  useActionData,
  useLoaderData,
  useLocation,
  useNavigate,
  useSubmit,
} from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ShippingChartEditorForm } from "../components/ShippingChartEditorForm";
import fs from "node:fs/promises";
import path from "node:path";

async function getAppBridgeApiKey() {
  // Prefer environment variable (production-safe)
  if (process.env.SHOPIFY_API_KEY) return process.env.SHOPIFY_API_KEY;

  // Dev fallback: read shopify.app.toml and extract client_id
  try {
    const tomlPath = path.resolve(process.cwd(), "shopify.app.toml");
    const content = await fs.readFile(tomlPath, "utf8");

    // matches: client_id = "...."
    const match = content.match(/^\s*client_id\s*=\s*"([^"]+)"\s*$/m);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export async function loader({ request, params }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const chart = await prisma.shippingChart.findFirst({
    where: { id: params.id, shop },
    include: {
      tiers: { orderBy: [{ sortOrder: "asc" }, { minCents: "asc" }] },
    },
  });

  if (!chart) throw new Response("Shipping chart not found", { status: 404 });

  const appBridgeApiKey = await getAppBridgeApiKey();

  // Settings-driven later. Keep empty but stable for now.
  const shippingServiceOptions = [];

  const uiTiers = (chart.tiers || []).map((t) => {
    const minValue = (t.minCents ?? 0) / 100;
    const maxValue = t.maxCents == null ? null : t.maxCents / 100;

    const rateType = t.priceType === "PERCENT_OF_BASIS" ? "PERCENT" : "FLAT";
    const rateValue =
      rateType === "PERCENT"
        ? Math.round((t.percentBps ?? 0) / 100) // bps -> whole percent
        : (t.flatPriceCents ?? 0) / 100;

    return {
      id: t.id,
      minValue,
      maxValue,
      rateType,
      rateValue,
      priority: t.sortOrder ?? 0,
    };
  });

  return {
    chart: {
      id: chart.id,
      shop: chart.shop,
      name: chart.name,
      isActive: chart.isActive,
      handlingFee: (chart.handlingFeeCents ?? 0) / 100,
      defaultServiceCode: chart.defaultServiceCode || "",
      tiers: uiTiers,
    },
    shippingServiceOptions,
    appBridgeApiKey,
  };
}

function toCentsOrNull(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toPercentOrNull(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function action({ request, params }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();

  const name = String(formData.get("name") || "").trim();
  const isActive = String(formData.get("isActive") || "true") === "true";
  const tiersJson = String(formData.get("tiers") || "[]");
  const handlingFee = String(formData.get("handlingFee") || "0");
  const defaultServiceCode = String(formData.get("defaultServiceCode") || "");
  if (!name) return { ok: false, fieldErrors: { name: "Name is required" } };

  // Ensure ownership
  const existing = await prisma.shippingChart.findFirst({
    where: { id: params.id, shop },
    select: { id: true },
  });
  if (!existing) throw new Response("Shipping chart not found", { status: 404 });

  let tiers = [];
  try {
    tiers = JSON.parse(tiersJson) || [];
  } catch {
    tiers = [];
  }

  function makeTierName({
    minCents,
    maxCents,
    priceType,
    flatPriceCents,
    percentBps,
  }) {
    const min = minCents == null ? null : (minCents / 100).toFixed(2);
    const max = maxCents == null ? null : (maxCents / 100).toFixed(2);
    const range = maxCents == null ? `$${min}+` : `$${min}–$${max}`;

    if (priceType === "PERCENT_OF_BASIS") {
      const pct = percentBps == null ? "0" : (percentBps / 100).toString();
      return `${range} @ ${pct}%`;
    }

    const flat =
      flatPriceCents == null ? "0.00" : (flatPriceCents / 100).toFixed(2);
    return `${range} → $${flat}`;
  }

  const tierCreates = (tiers || [])
    .map((t, idx) => {
      const minCents = toCentsOrNull(t?.minValue);
      const maxCents = toCentsOrNull(t?.maxValue);

      const priceType = t?.rateType === "PERCENT" ? "PERCENT_OF_BASIS" : "FLAT";

      const flatPriceCents =
        priceType === "FLAT" ? toCentsOrNull(t?.rateValue) : null;

      // percentBps = percent * 100 (e.g. 6% => 600 bps)
      const percentBps =
        priceType === "PERCENT_OF_BASIS"
          ? Math.round(Number(t?.rateValue ?? 0) * 100)
          : null;

      const sortOrder = Number.isFinite(Number(t?.priority))
        ? Number(t.priority)
        : idx;

      return {
        name: makeTierName({
          minCents,
          maxCents,
          priceType,
          flatPriceCents,
          percentBps,
        }),
        minCents: minCents ?? 0,
        maxCents,
        priceType,
        flatPriceCents,
        percentBps,
        serviceCode: null,
        isActive: true,
        sortOrder,
      };
    })
    .filter((t) => {
      const hasAnyRange = t.minCents != null || t.maxCents != null;
      const hasRate =
        (t.priceType === "PERCENT_OF_BASIS" && t.percentBps != null) ||
        (t.priceType === "FLAT" && t.flatPriceCents != null);
      return hasAnyRange && hasRate;
    });

  // Delete+recreate tiers in a transaction so the DB matches the UI exactly
  await prisma.$transaction([
    prisma.shippingTier.deleteMany({
      where: { chartId: existing.id },
    }),
    prisma.shippingChart.update({
      where: { id: existing.id },
      data: {
        name,
        isActive,
        defaultServiceCode,
        handlingFeeCents: toCentsOrNull(handlingFee) ?? 0,
        tiers: {
          create: tierCreates,
        },
      },
      select: { id: true },
    }),
  ]);

  return { ok: true };
}

export default function EditShippingChartPage() {
  const submit = useSubmit();
  const navigate = useNavigate();
  const location = useLocation();
  const actionData = useActionData();
  const loaderData = useLoaderData();

  const search =
    location.search ||
    (typeof window !== "undefined" ? window.location.search : "") ||
    "";
  const backUrl = `/app/tiers${search}`;

  const [saving, setSaving] = useState(false);

  const chart = loaderData?.chart;
  const appBridgeApiKey = loaderData?.appBridgeApiKey || "";
  const shippingServiceOptions = useMemo(
    () => loaderData?.shippingServiceOptions || [],
    [loaderData]
  );

  const onSave = (payload) => {
    setSaving(true);

    const fd = new FormData();
    fd.set("name", payload?.name || "");
    fd.set("isActive", payload?.isActive ? "true" : "false");
    fd.set("tiers", JSON.stringify(payload?.tiers || []));
    fd.set("handlingFee", String(payload?.handlingFee ?? 0));
    fd.set("defaultServiceCode", String(payload?.defaultServiceCode || ""));
    submit(fd, { method: "post" });
  };

  // stop spinner when action returns (success OR failure)
  useEffect(() => {
    if (actionData?.ok !== undefined) {
      setSaving(false);
    }
  }, [actionData?.ok]);

  // redirect back to list after successful save
  useEffect(() => {
    if (actionData?.ok === true) {
      navigate(backUrl);
    }
  }, [actionData?.ok, navigate, backUrl]);

  return (
    <Page
      title="Edit Shipping Chart"
      backAction={{ content: "Shipping Charts", url: backUrl }}
    >
      <ShippingChartEditorForm
        mode="edit"
        chart={chart}
        shippingServiceOptions={shippingServiceOptions}
        saving={saving}
        onCancel={() => navigate(backUrl)}
        onSave={onSave}
        appBridgeApiKey={appBridgeApiKey}
        // actionData is available if you later want to show a Polaris toast
        // saveSuccess={actionData?.ok === true}
      />
    </Page>
  );
}
