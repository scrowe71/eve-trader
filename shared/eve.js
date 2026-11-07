// Shared by the /api/watch Pages Function and the watcher Worker.

export const EVE_TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
export const ESI = "https://esi.evetech.net/latest";
export const ALERT_SCOPES = [
  "esi-contracts.read_character_contracts.v1",
  "esi-contracts.read_corporation_contracts.v1",
  "esi-universe.read_structures.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-wallet.read_corporation_wallets.v1",
  "esi-markets.structure_markets.v1",          // daily summary: hub prices
  "esi-markets.read_corporation_orders.v1",    // daily summary: your orders
  "esi-markets.read_character_orders.v1",
];

export function decodeJwt(t) {
  let p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  p += "=".repeat((4 - (p.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function tokenInfo(access) {
  const c = decodeJwt(access);
  const scopes = Array.isArray(c.scp) ? c.scp : c.scp ? [c.scp] : [];
  return { charId: Number(String(c.sub || "").split(":").pop()), name: c.name || "", scopes };
}

async function tokenCall(params) {
  const r = await fetch(EVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error("EVE login: " + (j.error_description || j.error || r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

export const exchangeCode = (clientId, code, verifier) =>
  tokenCall({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });

export const refreshToken = (clientId, refresh) =>
  tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });

export async function esiGet(path, access, { paged = true } = {}) {
  const out = [];
  let page = 1, pages = 1;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${ESI}${path}${sep}datasource=tranquility${paged ? "&page=" + page : ""}`, {
      headers: access ? { Authorization: "Bearer " + access } : {},
    });
    if (!r.ok) {
      const e = new Error(`ESI ${r.status} on ${path}`);
      e.status = r.status;
      throw e;
    }
    const data = await r.json();
    if (!Array.isArray(data)) return data;
    out.push(...data);
    if (!paged) return out;
    pages = parseInt(r.headers.get("X-Pages") || "1", 10);
    page++;
  } while (page <= pages && page <= 20);
  return out;
}

export function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" &&
      ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(u.hostname) &&
      u.pathname.startsWith("/api/webhooks/");
  } catch { return false; }
}

export async function discord(webhook, payload) {
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ username: "EVE Trader" }, payload)),
  });
  if (!r.ok && r.status !== 204) {
    const e = new Error("Discord said " + r.status);
    e.status = r.status;
    throw e;
  }
}

// Station and structure names (structures need esi-universe.read_structures.v1 and docking access).
export async function placeName(id, access) {
  if (!id) return "?";
  if (id >= 60000000 && id < 64000000) {
    try {
      const r = await fetch(`${ESI}/universe/names/?datasource=tranquility`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([id]),
      });
      if (r.ok) { const j = await r.json(); if (j[0]) return j[0].name; }
    } catch {}
    return String(id);
  }
  try { const s = await esiGet(`/universe/structures/${id}/`, access); return s.name || String(id); }
  catch { return `Structure ${id}`; }
}

// ---- shared by the cloud-history API ----
export const PROJECT_START_ISO = "2026-11-07T04:00:00Z";   // Nov 6 2026, 11:00 PM Eastern

// The alert registration (char + key) is the account for cloud data.
export async function authWatch(env, char, key) {
  if (!env.WATCH || !/^\d+$/.test(char || "") || !key) return null;
  const w = await env.WATCH.get("watch:" + char, "json");
  return w && w.key === key ? w : null;
}

export const isoSeconds = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
