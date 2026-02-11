import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Create or update the Carrier Service so Shopify calls our /api/rates endpoint at checkout.
 * This runs after a shop installs/authenticates the app.
 */
  async function ensureCarrierService({ session }) {
  try {
        console.log("[ensureCarrierService] RUN", {
      shop: session?.shop,
      appUrl: process.env.SHOPIFY_APP_URL || process.env.HOST,
    });


    const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST;

  // In dev, the app can start before Shopify CLI has provided a tunnel URL.
  // Skip carrier service registration until we have a real HTTPS URL.
    if (!appUrl) {
    console.error("[ensureCarrierService] SKIP: missing SHOPIFY_APP_URL/HOST");
    return;
  }


  // CarrierService callback must be https in Shopify; localhost won't work.
  if (appUrl.startsWith("http://localhost") || appUrl.startsWith("http://127.")) {
    console.error("[ensureCarrierService] SKIP: non-https appUrl =", appUrl);
    return;
  }

  // Ensure no trailing slash
  const base = appUrl.replace(/\/$/, "");

  // Include ?shop=... so the callback can load the correct offline session
  const callbackUrl = `${base}/api/rates?shop=${encodeURIComponent(session.shop)}`;
      const adminGraphql = async (query, variables) => {
      const url = `https://${session.shop}/admin/api/${ApiVersion.October25}/graphql.json`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(
          `Admin GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`
        );
      }

      if (json.errors?.length) {
        throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors)}`);
      }

      return json;
    };


  // 1) Find existing carrier service by name
  const findQuery = `
    query CarrierServices {
      carrierServices(first: 50) {
        nodes {
          id
          name
          active
          callbackUrl
        }
      }
    }
  `;

  const findRes = await adminGraphql(findQuery);
  const services = findRes?.data?.carrierServices?.nodes ?? [];

  const SERVICE_NAME = "Shipping Rates (Pre-discount tiers)";
  const existing = services.find((s) => s?.name === SERVICE_NAME);

  // 2) Create if not found, otherwise update
  if (!existing) {
    const createMutation = `
      mutation CarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
        carrierServiceCreate(input: $input) {
          carrierService {
            id
            name
            active
            callbackUrl
            supportsServiceDiscovery
          }
          userErrors { field message }
        }
      }
    `;

    const createRes = await adminGraphql(createMutation, {
      input: {
        name: SERVICE_NAME,
        callbackUrl,
        active: true,
        supportsServiceDiscovery: true,
      },
    });

    const errs = createRes?.data?.carrierServiceCreate?.userErrors ?? [];
if (errs.length) {
  const msg = JSON.stringify(errs);

  if (msg.includes("Carrier Calculated Shipping must be enabled")) {
    console.error(
      "[ensureCarrierService] Store cannot enable third-party calculated rates on current plan. Skipping carrier service creation.",
      errs
    );
    return;
  }

  throw new Error(`carrierServiceCreate failed: ${msg}`);
}

return;
}

  // Update existing (ensure active + correct callback)
  const updateMutation = `
    mutation CarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
      carrierServiceUpdate(input: $input) {
        carrierService {
          id
          name
          callbackUrl
          active
        }
        userErrors { field message }
      }
    }
  `;
  const updateRes = await adminGraphql(updateMutation, {
    input: {
      id: existing.id,
      name: SERVICE_NAME,
      callbackUrl,
      active: true,
    },
  });
  const errs = updateRes?.data?.carrierServiceUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`carrierServiceUpdate failed: ${JSON.stringify(errs)}`);
  }
  } catch (err) {
    console.error("[ensureCarrierService] FAILED", {
      shop: session?.shop,
      message: err?.message,
      cause: err?.cause,
      stack: err?.stack,
      response: err?.response,
      body: err?.body,
    });
    throw err;
  }
}

const shopifyAppInstance = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl:
  process.env.SHOPIFY_APP_URL ||
  process.env.HOST ||
  (process.env.NODE_ENV === "development"
    ? `http://localhost:${process.env.PORT || 3000}`
    : ""),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    /**
     * Runs after auth completes. This is where we register the Carrier Service.
     */
    afterAuth: async ({ session }) => {
      await ensureCarrierService({ session });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopifyAppInstance;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopifyAppInstance.addDocumentResponseHeaders;
export const authenticate = shopifyAppInstance.authenticate;
export const unauthenticated = shopifyAppInstance.unauthenticated;
export const login = shopifyAppInstance.login;
export const registerWebhooks = shopifyAppInstance.registerWebhooks;
export const sessionStorage = shopifyAppInstance.sessionStorage;
