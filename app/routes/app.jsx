import { Outlet, useLoaderData, useLocation, useNavigate } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import {
  Frame,
  Navigation,
  Text,
  Box,
} from "@shopify/polaris";
import { HomeIcon, SettingsIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  await authenticate.admin(request);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  return { apiKey };
}

export default function App() {
  const { apiKey } = useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (path) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  return (
    <AppProvider apiKey={apiKey} embedded>
      <Frame
        navigation={
          <Navigation location={location.pathname}>
            <Navigation.Section
              items={[
                {
                  label: "Shipping Charts",
                  icon: HomeIcon,
                  url: "/app/tiers",
                  selected: isActive("/app/tiers"),
                  onClick: () => navigate("/app/tiers"),
                },
                {
                  label: "Settings",
                  icon: SettingsIcon,
                  url: "/app/settings",
                  selected: isActive("/app/settings"),
                  onClick: () => navigate("/app/settings"),
                },
              ]}
            />
          </Navigation>
        }
      >
        <Box padding="400">
          <Outlet />
        </Box>
      </Frame>
    </AppProvider>
  );
}
