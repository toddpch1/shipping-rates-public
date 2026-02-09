// app/routes/app.jsx
import { Outlet, useLoaderData, useLocation } from "react-router";
import { redirect } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Frame } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

function base64HostFromShop(shop) {
  // Common workaround: host is base64 + URL encoded. Many apps use `${shop}/admin`.
  // Shopify expects `host` to represent the admin host context. :contentReference[oaicite:2]{index=2}
  const raw = `${shop}/admin`;
  return encodeURIComponent(Buffer.from(raw, "utf8").toString("base64"));
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const host = url.searchParams.get("host");

  // If we hard-refresh inside admin, Shopify sometimes does not include `host`.
  // Without it, App Bridge won’t initialize and NavMenu will render as plain links in the iframe.
  if (!host) {
    url.searchParams.set("host", base64HostFromShop(session.shop));
    url.searchParams.set("embedded", "1");
    return redirect(url.toString());
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
}

export default function App() {
  const { apiKey } = useLoaderData();
  const location = useLocation();
  const search = location.search || "";

  return (
    <AppProvider apiKey={apiKey} embedded>
      {/* Dealeasy-style submenu under the app name in Shopify Admin */}
      <NavMenu>
        <a href={`/app/tiers${search}`}>Shipping Charts</a>
        <a href={`/app/settings${search}`}>Settings</a>
      </NavMenu>

      {/* Keep Frame for Polaris layout; NO in-app sidebar */}
      <Frame>
        <Outlet />
      </Frame>
    </AppProvider>
  );
}
