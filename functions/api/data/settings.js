// GET/PUT /api/data/settings?char=<id>&key=<key>
// Site settings + doctrine tracker, shared between your devices. Auth: the delivery-alert registration.

import { authWatch } from "../../../shared/eve.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: "Cloud history isn't set up yet (no D1 binding)." }, 501);
  const url = new URL(request.url);
  const w = await authWatch(env, url.searchParams.get("char"), url.searchParams.get("key"));
  if (!w) return json({ error: "Not signed in to cloud history." }, 401);

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT data, updated FROM settings WHERE char = ?").bind(w.charId).first();
    return json(row ? { data: JSON.parse(row.data), updated: row.updated } : { data: null, updated: null });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > 900000) return json({ error: "Too large." }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Bad JSON." }, 400); }
    const updated = new Date().toISOString();
    await env.DB.prepare("INSERT INTO settings (char, data, updated) VALUES (?,?,?) ON CONFLICT(char) DO UPDATE SET data = excluded.data, updated = excluded.updated")
      .bind(w.charId, JSON.stringify(body.data || {}), updated).run();
    return json({ ok: true, updated });
  }
  return json({ error: "method_not_allowed" }, 405);
}
