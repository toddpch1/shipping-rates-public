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
    const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST;

  // In dev, the app can start before Shopify CLI has provided a tunnel URL.
  // Skip carrier service registration until we have a real HTTPS URL.
  if (!appUrl) return;

  // CarrierService callback must be https in Shopify; localhost won't work.
  if (appUrl.startsWith("http://localhost") || appUrl.startsWith("http://127.")) return;

  // Ensure no trailing slash
  const base = appUrl.replace(/\/$/, "");

  // Include ?shop=... so the callback can load the correct offline session
  const callbackUrl = `${base}/api/rates?shop=${encodeURIComponent(session.shop)}`;

  const client = new shopify.api.clients.Graphql({ session });

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

  const findRes = await client.request(findQuery);
  const services = findRes?.data?.carrierServices?.nodes ?? [];

  const SERVICE_NAME = "Shipping Rates (Pre-discount tiers)";
  const existing = services.find((s) => s?.name === SERVICE_NAME);

  // 2) Create if not found, otherwise update
  if (!existing) {
    const createMutation = `
      mutation carrierServiceCreate($name: String!, $callbackUrl: URL!, $active: Boolean!, $discovery: Boolean!) {
        carrierServiceCreate(
          name: $name
          callbackUrl: $callbackUrl
          active: $active
          supportsServiceDiscovery: $discovery
        ) {
          carrierService { id name active callbackUrl }
          userErrors { field message }
        }
      }
    `;

    const createRes = await client.request(createMutation, {
      variables: {
        name: SERVICE_NAME,
        callbackUrl,
        active: true,
        discovery: true,
      },
    });

    const errs = createRes?.data?.carrierServiceCreate?.userErrors ?? [];
    if (errs.length) {
      throw new Error(`carrierServiceCreate failed: ${JSON.stringify(errs)}`);
    }

    return;
  }

  // Update existing (ensure active + correct callback)
  const updateMutation = `
    mutation carrierServiceUpdate($id: ID!, $name: String!, $callbackUrl: URL!, $active: Boolean!, $discovery: Boolean!) {
      carrierServiceUpdate(
        id: $id
        name: $name
        callbackUrl: $callbackUrl
        active: $active
        supportsServiceDiscovery: $discovery
      ) {
        carrierService { id name active callbackUrl }
        userErrors { field message }
      }
    }
  `;

  const updateRes = await client.request(updateMutation, {
    variables: {
      id: existing.id,
      name: SERVICE_NAME,
      callbackUrl,
      active: true,
      discovery: true,
    },
  });

  const errs = updateRes?.data?.carrierServiceUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`carrierServiceUpdate failed: ${JSON.stringify(errs)}`);
  }
}

const shopify = shopifyApp({
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

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
