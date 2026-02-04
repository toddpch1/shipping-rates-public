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
  if (process.env.SHOPIFY_API_KEY) return process.env.SHOPIFY_API_KEY;

  try {
    const tomlPath = path.resolve(process.cwd(), "shopify.app.toml");
    const content = await fs.readFile(tomlPath, "utf8");
    const match = content.match(/^\s*client_id\s*=\s*"([^"]+)"\s*$/m);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export async function loader({ request }) {
  await authenticate.admin(request);

  const appBridgeApiKey = await getAppBridgeApiKey();

    const chart = {
      id: null,
      name: "",
      isActive: true,
      defaultServiceCode: "",
      handlingFee: 0,
      tiers: [],
    };


  return {
    chart,
    shippingServiceOptions: [],
    appBridgeApiKey,
  };
}

function toCentsOrNull(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function makeTierName({ minCents, maxCents, priceType, flatPriceCents, percentBps }) {
  const min = minCents == null ? null : (minCents / 100).toFixed(2);
  const max = maxCents == null ? null : (maxCents / 100).toFixed(2);

  const range =
    maxCents == null
      ? `$${min}+`
      : `$${min}–$${max}`;

  if (priceType === "PERCENT_OF_BASIS") {
    const pct = percentBps == null ? "0" : (percentBps / 100).toString();
    return `${range} @ ${pct}%`;
  }

  const flat = flatPriceCents == null ? "0.00" : (flatPriceCents / 100).toFixed(2);
  return `${range} → $${flat}`;
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();

  const name = String(formData.get("name") || "").trim();
  const isActive = String(formData.get("isActive") || "true") === "true";
  const tiersJson = String(formData.get("tiers") || "[]");
  const handlingFee = String(formData.get("handlingFee") || "0");

  if (!name) return { ok: false, fieldErrors: { name: "Name is required" } };


  let tiers = [];
  try {
    tiers = JSON.parse(tiersJson) || [];
  } catch {
    tiers = [];
  }

    const tierCreates = (tiers || [])
    .map((t, idx) => {
      const minCents = toCentsOrNull(t?.minValue);
      const maxCents = toCentsOrNull(t?.maxValue);

      const priceType =
        t?.rateType === "PERCENT" ? "PERCENT_OF_BASIS" : "FLAT";

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

      const tier = {
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

      return tier;
    })
    .filter((t) => {
      const hasAnyRange = t.minCents != null || t.maxCents != null;
      const hasRate =
        (t.priceType === "PERCENT_OF_BASIS" && t.percentBps != null) ||
        (t.priceType === "FLAT" && t.flatPriceCents != null);
      return hasAnyRange && hasRate;
    });

    const created = await prisma.shippingChart.create({
    data: {
      shop,
      name,
      isActive,
      handlingFeeCents: toCentsOrNull(handlingFee) ?? 0,
      tiers: {
        create: tierCreates,
  },
    },
    select: { id: true },
  });

  return { ok: true, id: created.id };
}

export default function CreateShippingChartPage() {
  const submit = useSubmit();
  const navigate = useNavigate();
  const location = useLocation();
  const actionData = useActionData();
  const loaderData = useLoaderData();

  const search =
    location.search ||
    (typeof window !== "undefined" ? window.location.search : "") ||
    "";
  const params = new URLSearchParams(search || "");
  params.delete("shopify-reload");
  const cleaned = params.toString();
  const backUrl = cleaned ? `/app/tiers?${cleaned}` : `/app/tiers`;


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

    submit(fd, { method: "post" });
  };

  useEffect(() => {
  if (actionData?.ok !== undefined) {
    setSaving(false);
  }
}, [actionData?.ok]);

    // After create, return to the charts list (Home)
  useEffect(() => {
    if (actionData?.ok === true) {
      navigate(backUrl);
    }
  }, [actionData?.ok, navigate, backUrl]);

  return (
    <Page
      title="Create Shipping Chart"
      backAction={{ content: "Shipping Charts", url: backUrl }}
    >
      <ShippingChartEditorForm
        mode="create"
        chart={chart}
        shippingServiceOptions={shippingServiceOptions}
        saving={saving}
        onCancel={() => navigate(backUrl)}
        onSave={onSave}
        appBridgeApiKey={appBridgeApiKey}
      />
    </Page>
  );
}
