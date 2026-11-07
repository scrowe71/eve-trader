// Cloudflare Pages Function: /api/watch
// Turns courier-contract delivery alerts on or off for a character.
//
//   POST   { code, code_verifier, client_id, webhook, corp }  -> turn on (exchanges the SSO code here,
//          so the alert token never sits in the browser), sends a test message to Discord
//   GET    ?char=<id>&key=<key>                                -> status
//   DELETE ?char=<id>&key=<key>                                -> turn off
//
// Needs a KV namespace bound as WATCH (the same one the watcher Worker uses).
// Optional: ALLOWED_CHARACTERS = comma-separated character IDs allowed to register.

import { exchangeCode, tokenInfo, isDiscordWebhook, discord, ALERT_SCOPES } from "../../shared/eve.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "");
}

async function load(env, char, key) {
  if (!/^\d+$/.test(char || "")) return null;
  const w = await env.WATCH.get("watch:" + char, "json");
  if (!w || !key || w.key !== key) return null;
  return w;
}

export async function onRequest({ request, env }) {
  if (!env.WATCH) return json({ error: "Delivery alerts aren't set up yet: bind a KV namespace called WATCH to this Pages project (see README)." }, 501);
  const url = new URL(request.url);

  if (request.method === "GET") {
    const w = await load(env, url.searchParams.get("char"), url.searchParams.get("key"));
    if (!w) return json({ on: false });
    // Contracts the worker is watching, with details from the cloud database when available.
    const seen = w.seen || {};
    let contracts = Object.entries(seen).map(([id, status]) => ({ contract_id: Number(id), status }));
    if (env.DB && contracts.length) {
      try {
        const ids = contracts.map((c) => c.contract_id);
        const rows = (await env.DB.prepare(`SELECT * FROM hauls WHERE contract_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
        const byId = new Map(rows.map((r) => [r.contract_id, r]));
        contracts = contracts.map((c) => Object.assign({}, byId.get(c.contract_id) || {}, c));
      } catch {}
    }
    contracts.sort((a, b) => String(b.date_issued || "").localeCompare(String(a.date_issued || "")));
    return json({ on: true, contracts, name: w.name, corp: w.corp, lastCheck: w.lastCheck || null, lastError: w.lastError || null,
      tracking: Object.keys(w.seen || {}).length, lastArchive: w.lastArchive || null, archiveError: w.archiveError || null,
      sources: w.sources || [], cloud: !!env.DB, undercut: w.undercutInfo || null });
  }

  if (request.method === "DELETE") {
    const char = url.searchParams.get("char");
    const w = await load(env, char, url.searchParams.get("key"));
    if (!w) return json({ error: "Not found." }, 404);
    await env.WATCH.delete("watch:" + char);
    try { await discord(w.webhook, { content: `🔕 Delivery alerts turned off for **${w.name}**.` }); } catch {}
    return json({ on: false });
  }

  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { code, code_verifier, client_id, webhook } = body || {};
  if (!code || !code_verifier || !client_id) return json({ error: "Missing login details. Try again." }, 400);
  if (env.EVE_CLIENT_ID && client_id !== env.EVE_CLIENT_ID) return json({ error: "invalid_client" }, 400);
  if (!isDiscordWebhook(webhook)) return json({ error: "That isn't a Discord webhook link (it should start with https://discord.com/api/webhooks/)." }, 400);

  let tok;
  try { tok = await exchangeCode(client_id, code, code_verifier); }
  catch (e) { return json({ error: e.message }, 400); }
  const info = tokenInfo(tok.access_token);

  if (env.ALLOWED_CHARACTERS) {
    const ok = env.ALLOWED_CHARACTERS.split(",").map((s) => s.trim()).includes(String(info.charId));
    if (!ok) return json({ error: "This character isn't allowed to use delivery alerts on this site." }, 403);
  }
  const missing = ALERT_SCOPES.filter((s) => !info.scopes.includes(s));
  if (missing.length) return json({ error: "The EVE login didn't grant: " + missing.join(", ") + ". Add them to your EVE app (see README) and try again." }, 400);

  const key = randomKey();
  const record = {
    charId: info.charId,
    name: info.name,
    refresh: tok.refresh_token,
    webhook,
    corp: !!body.corp,
    key,
    seen: null,          // first run records current contracts without alerting
    created: new Date().toISOString(),
  };
  await env.WATCH.put("watch:" + info.charId, JSON.stringify(record));

  try {
    await discord(webhook, {
      content: `🔔 Delivery alerts are on for **${info.name}**${record.corp ? " (character + corp contracts)" : ""}. ` +
        "I'll post here when a courier contract is picked up and when it's delivered. Checks run every 10 minutes.",
    });
  } catch (e) {
    return json({ error: "Saved, but the test message to Discord failed (" + e.message + "). Check the webhook link.", char: info.charId, key, name: info.name }, 200);
  }
  return json({ on: true, char: info.charId, key, name: info.name });
}
