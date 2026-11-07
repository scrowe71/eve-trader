// Cloudflare Pages Function: POST /api/token
// Passes the EVE SSO PKCE token exchange (and refreshes) through to CCP.
// No client secret is stored anywhere: PKCE only needs the public Client ID.

const EVE_TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
const ALLOWED_GRANTS = new Set(["authorization_code", "refresh_token"]);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  let params;
  try {
    params = new URLSearchParams(await request.text());
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (!ALLOWED_GRANTS.has(params.get("grant_type"))) {
    return json({ error: "unsupported_grant_type" }, 400);
  }
  // Optional lock: set EVE_CLIENT_ID in the Pages project settings so this
  // function only works for your own app.
  if (env.EVE_CLIENT_ID && params.get("client_id") !== env.EVE_CLIENT_ID) {
    return json({ error: "invalid_client" }, 400);
  }

  const upstream = await fetch(EVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function onRequest() {
  return json({ error: "method_not_allowed" }, 405);
}
