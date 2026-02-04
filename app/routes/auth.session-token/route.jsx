// app/routes/auth.session-token/route.jsx

/**
 * React Router route module (NOT Remix).
 *
 * Shopify embedded apps hit this endpoint to "refresh" embedded context and then
 * navigate back to the intended in-app URL via `shopify-reload`.
 *
 * IMPORTANT:
 * Do NOT do a server-side 302 here. In an embedded iframe, Shopify expects an
 * HTML response that loads App Bridge and then redirects the TOP window.
 */

function safeGetUrl(request) {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function loader({ request }) {
  const url = safeGetUrl(request);

  // If we can't parse the URL, at least return valid HTML.
  if (!url) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>session-token</title>`, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const reloadParam = url.searchParams.get("shopify-reload") || "";

  // Default safe landing inside the embedded app.
  const safeFallback = `${url.origin}/app/tiers`;

  // If Shopify didn't send a reload target, just go to app home (tiers list).
  if (!reloadParam) {
    const html = `<!doctype html>
<meta charset="utf-8" />
<title>session-token</title>
<script>
  (function () {
    var target = ${JSON.stringify(safeFallback)};
    try {
      if (window.top) {
        window.top.location.replace(target);
        return;
      }
    } catch (e) {}
    window.location.replace(target);
  })();
</script>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // Resolve relative reload URLs against our current origin
  let redirectTo = safeFallback;
  try {
    redirectTo = new URL(reloadParam, url.origin).toString();
  } catch {
    redirectTo = safeFallback;
  }

  // Guard against redirect loops back to /auth/session-token
  try {
    const rt = new URL(redirectTo, url.origin);
    if (rt.pathname.includes("/auth/session-token")) {
      // Also strip shopify-reload so we don't re-trigger session refresh.
      const params = new URLSearchParams(url.search);
      params.delete("shopify-reload");
      const suffix = params.toString() ? `?${params.toString()}` : "";
      redirectTo = `${safeFallback}${suffix}`;
    }
  } catch {
    redirectTo = safeFallback;
  }

  const apiKey = process.env.SHOPIFY_API_KEY || "";

  const html = `<!doctype html>
<meta charset="utf-8" />
<title>session-token</title>
<meta name="referrer" content="no-referrer" />
<script data-api-key="${escapeHtml(apiKey)}" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<script>
  (function () {
    var target = ${JSON.stringify(redirectTo)};
    try {
      if (window.top) {
        window.top.location.replace(target);
        return;
      }
    } catch (e) {}
    window.location.replace(target);
  })();
</script>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
