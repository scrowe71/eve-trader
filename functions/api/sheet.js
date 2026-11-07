// Cloudflare Pages Function: GET /api/sheet?url=<Google Sheets link>
// Fetches a Google Sheet as CSV so the Doctrine list can load it live.
// Only docs.google.com links are allowed. The sheet must be viewable
// without a Google login ("Anyone with the link" or "Publish to web").

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function toCsvUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  if (!u.pathname.startsWith("/spreadsheets/")) return null;

  // Published-to-web links: .../pub?gid=...&output=csv
  if (u.pathname.endsWith("/pub") || u.pathname.endsWith("/pubhtml")) {
    u.pathname = u.pathname.replace(/\/pubhtml$/, "/pub");
    u.searchParams.set("output", "csv");
    return u.toString();
  }

  // Normal links: /spreadsheets/d/<id>/edit#gid=123 -> /export?format=csv&gid=123
  const m = u.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
  if (!m) return null;
  const gid = u.searchParams.get("gid") || (u.hash.match(/gid=(\d+)/) || [])[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

export async function onRequestGet({ request }) {
  const raw = new URL(request.url).searchParams.get("url") || "";
  const target = toCsvUrl(raw);
  if (!target) return json({ error: "That isn't a Google Sheets link." }, 400);

  const up = await fetch(target, { redirect: "follow", headers: { "User-Agent": "eve-trader (Cloudflare Pages)" } });
  const type = up.headers.get("Content-Type") || "";
  if (!up.ok || type.includes("text/html")) {
    return json({ error: "Google wouldn't share that sheet. Set it to 'Anyone with the link can view' or Publish to web, or upload a CSV instead." }, 502);
  }
  return new Response(await up.text(), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
  });
}
