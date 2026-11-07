// eve-trader-watcher: Cloudflare Worker on a 10-minute cron.
// For every character that turned on delivery alerts (stored in KV by /api/watch),
// it reads courier contracts and posts to Discord when one is picked up, delivered or fails.

import { refreshToken, tokenInfo, esiGet, discord, placeName } from "../shared/eve.js";

const ALERT = {
  in_progress: { emoji: "🚚", text: "picked up" },
  finished: { emoji: "📦", text: "DELIVERED" },
  failed: { emoji: "⚠️", text: "FAILED" },
  rejected: { emoji: "↩️", text: "rejected by the hauler" },
  deleted: { emoji: "🗑️", text: "deleted" },
};

const fmtIsk = (v) => {
  const a = Math.abs(v || 0);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  return Math.round(v || 0).toLocaleString("en-US");
};

async function checkOne(env, key) {
  const w = await env.WATCH.get(key, "json");
  if (!w) return;
  w.lastCheck = new Date().toISOString();
  try {
    const tok = await refreshToken(env.EVE_CLIENT_ID, w.refresh);
    if (tok.refresh_token) w.refresh = tok.refresh_token;
    const access = tok.access_token;
    const info = tokenInfo(access);

    let contracts = await esiGet(`/characters/${info.charId}/contracts/`, access);
    if (w.corp) {
      const ch = await esiGet(`/characters/${info.charId}/`);
      try { contracts = contracts.concat(await esiGet(`/corporations/${ch.corporation_id}/contracts/`, access)); }
      catch (e) { w.lastError = "Corp contracts: " + e.message; }
    }
    const couriers = new Map();
    for (const c of contracts) if (c.type === "courier") couriers.set(c.contract_id, c);

    const first = !w.seen;
    const seen = w.seen || {};
    for (const [id, c] of couriers) {
      const was = seen[id];
      seen[id] = c.status;
      if (first || was === c.status) continue;
      const a = ALERT[c.status];
      if (!a) continue;
      const [from, to] = await Promise.all([placeName(c.start_location_id, access), placeName(c.end_location_id, access)]);
      await discord(w.webhook, {
        content: `${a.emoji} Courier contract **${a.text}**: ${from} → ${to}`,
        embeds: [{
          color: c.status === "finished" ? 0x4fbf7f : c.status === "in_progress" ? 0xe0a645 : 0xe0605a,
          fields: [
            { name: "Volume", value: `${Math.round(c.volume || 0).toLocaleString("en-US")} m³`, inline: true },
            { name: "Collateral", value: fmtIsk(c.collateral), inline: true },
            { name: "Reward", value: fmtIsk(c.reward), inline: true },
          ],
          footer: { text: `Contract ${id}${c.title ? " · " + c.title : ""}` },
          timestamp: c.date_completed || c.date_accepted || new Date().toISOString(),
        }],
      });
    }
    // Forget contracts that dropped off ESI (old ones) so the record stays small.
    for (const id of Object.keys(seen)) if (!couriers.has(Number(id))) delete seen[id];
    w.seen = seen;
    if (!w.corp || !String(w.lastError || "").startsWith("Corp")) w.lastError = null;
  } catch (e) {
    w.lastError = e.message;
    if (e.status === 400 || e.status === 401) {
      // Refresh token no longer valid: tell the user once.
      if (!w.notifiedBadToken) {
        try { await discord(w.webhook, { content: `⚠️ Delivery alerts for **${w.name}** stopped: the EVE login expired or was revoked. Turn alerts on again from the site.` }); } catch {}
        w.notifiedBadToken = true;
      }
    }
  }
  await env.WATCH.put(key, JSON.stringify(w));
}

export default {
  async scheduled(event, env, ctx) {
    const list = await env.WATCH.list({ prefix: "watch:" });
    for (const k of list.keys) await checkOne(env, k.name);
  },
  // Visiting the worker's URL runs a check right away (handy for testing).
  async fetch(request, env) {
    const list = await env.WATCH.list({ prefix: "watch:" });
    for (const k of list.keys) await checkOne(env, k.name);
    return new Response(`Checked ${list.keys.length} watcher(s).\n`, { headers: { "Content-Type": "text/plain" } });
  },
};
