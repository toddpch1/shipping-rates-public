import { Outlet, useLoaderData } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  // Make sure we have a valid admin session for embedded pages
  await authenticate.admin(request);

  // App Bridge config needs the API key
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  return { apiKey };
}

// minimal embedded shell
export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider apiKey={apiKey}>
      <NavMenu
        navigationLinks={[
          { label: "Shipping Charts", destination: "/app/tiers" },
          { label: "Settings", destination: "/app/settings" },
        ]}
      />
      <Outlet />
    </AppProvider>
  );
}
