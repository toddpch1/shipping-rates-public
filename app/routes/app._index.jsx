import { redirect } from "react-router";

export async function loader({ request }) {
  // App opens to Shipping Charts (preserve embedded params)
  const url = new URL(request.url);
  return redirect(`/app/tiers${url.search || ""}`);
}

export default function AppIndex() {
  return null;
}
