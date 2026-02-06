import { redirect } from "react-router";

export async function loader({ request }) {
  // App opens to the requested embedded `path` (when provided by Shopify),
  // otherwise default to Shipping Charts.
  const url = new URL(request.url);

  const params = new URLSearchParams(url.search);
  const desiredPath = params.get("path");

  // Shopify uses ?path=/app/... to deep-link inside the embedded app.
  // If present, honor it and REMOVE the param to avoid it overriding navigation forever.
  if (desiredPath && desiredPath.startsWith("/app/")) {
    params.delete("path");
    const rest = params.toString();
    return redirect(`${desiredPath}${rest ? `?${rest}` : ""}`);
  }

  // Default landing page
  params.delete("path");
  const rest = params.toString();
  return redirect(`/app/tiers${rest ? `?${rest}` : ""}`);
}

export default function AppIndex() {
  return null;
}
