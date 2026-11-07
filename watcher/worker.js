// eve-trader-watcher: Cloudflare Worker on a 10-minute cron.
// For every character that turned on delivery alerts (stored in KV by /api/watch),
// it reads courier contracts and posts to Discord when one is picked up, delivered or fails.

import { refreshToken, tokenInfo, esiGet, discord, placeName } from "../shared/eve.js";
import { postSummary, undercutCheck } from "./summary.js";

const UNDERCUT_EVERY_MS = 29 * 60 * 1000;   // undercut check about every 30 minutes

const SUMMARY_CRON = "0 13 * * *";   // 8:00 AM Eastern (EST) every day

async function summaryOne(env, key) {
  const w = await env.WATCH.get(key, "json");
  if (!w) return "missing";
  try {
    const tok = await refreshToken(env.EVE_CLIENT_ID, w.refresh);
    if (tok.refresh_token) { w.refresh = tok.refresh_token; await env.WATCH.put(key, JSON.stringify(w)); }
    const info = tokenInfo(tok.access_token);
    const ch = await esiGet(`/characters/${info.charId}/`);
    return await postSummary(env, w, tok.access_token, info, ch.corporation_id);
  } catch (e) {
    try { await discord(w.webhook, { content: "📊 Daily summary failed: " + e.message }); } catch {}
    return "error: " + e.message;
  }
}

const ARCHIVE_EVERY_MS = 55 * 60 * 1000;   // copy wallets into D1 about once an hour

async function runBatches(env, stmts) {
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// Copy wallet transactions + journal (character and corp division) into D1. CCP only keeps ~30 days.
async function archiveWallets(env, w, access, info, corpId) {
  if (!env.DB) return;
  if (!info.scopes.includes("esi-wallet.read_character_wallet.v1")) { w.archiveError = "The alert login has no wallet access. Turn alerts on again."; return; }
  if (w.lastArchive && Date.now() - Date.parse(w.lastArchive) < ARCHIVE_EVERY_MS) return;

  const txSql = "INSERT OR IGNORE INTO transactions (transaction_id, source, date, type_id, quantity, unit_price, is_buy, location_id, client_id, journal_ref_id) VALUES (?,?,?,?,?,?,?,?,?,?)";
  const jSql = "INSERT OR IGNORE INTO journal (id, source, date, ref_type, amount, balance, context_id, context_id_type, first_party_id, second_party_id, description) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
  const tx = (src, t) => env.DB.prepare(txSql).bind(t.transaction_id, src, t.date, t.type_id, t.quantity, t.unit_price, t.is_buy ? 1 : 0, t.location_id, t.client_id ?? null, t.journal_ref_id ?? null);
  const jr = (src, e) => env.DB.prepare(jSql).bind(e.id, src, e.date, e.ref_type, e.amount ?? null, e.balance ?? null, e.context_id ?? null, e.context_id_type ?? null, e.first_party_id ?? null, e.second_party_id ?? null, e.description ?? null);

  const errors = [];
  const sources = new Set(w.sources || []);
  const stmts = [];

  const charSrc = "char:" + info.charId;
  try {
    const t = await esiGet(`/characters/${info.charId}/wallet/transactions/`, access, { paged: false });
    const j = await esiGet(`/characters/${info.charId}/wallet/journal/`, access);
    t.forEach((x) => stmts.push(tx(charSrc, x)));
    j.forEach((x) => stmts.push(jr(charSrc, x)));
    sources.add(charSrc);
  } catch (e) { errors.push("Character wallet: " + e.message); }

  // Which corp division to copy comes from the site settings stored in D1 (Trade journal tab).
  let div = 1, corpOn = true;
  try {
    const row = await env.DB.prepare("SELECT data FROM settings WHERE char = ?").bind(info.charId).first();
    if (row) {
      const d = JSON.parse(row.data);
      const s = d.settings || {};
      div = Math.min(7, Math.max(1, Math.round(Number(s.jCorpDiv) || 1)));
      corpOn = s.jCorpWallet !== "off";
    }
  } catch {}
  if (corpOn && corpId) {
    const corpSrc = `corp:${corpId}:${div}`;
    try {
      const t = await esiGet(`/corporations/${corpId}/wallets/${div}/transactions/`, access, { paged: false });
      const j = await esiGet(`/corporations/${corpId}/wallets/${div}/journal/`, access);
      t.forEach((x) => stmts.push(tx(corpSrc, x)));
      j.forEach((x) => stmts.push(jr(corpSrc, x)));
      sources.add(corpSrc);
    } catch (e) {
      errors.push(e.status === 403 ? `Corp wallet ${div}: this character needs the Accountant or Junior Accountant role` : `Corp wallet ${div}: ${e.message}`);
    }
  }

  await runBatches(env, stmts);
  w.sources = [...sources];
  w.lastArchive = new Date().toISOString();
  w.archiveError = errors.length ? errors.join("; ") : null;
}

// Keep every courier contract (with its real cost) in D1.
async function saveHauls(env, w, couriers) {
  if (!env.DB || !couriers.size) return;
  const sql = `INSERT INTO hauls (contract_id, owner, issuer_id, status, start_location_id, end_location_id, volume, collateral, reward, title, date_issued, date_accepted, date_completed, updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(contract_id) DO UPDATE SET status = excluded.status, date_accepted = excluded.date_accepted,
      date_completed = excluded.date_completed, updated = excluded.updated`;
  const now = new Date().toISOString();
  const stmts = [...couriers.values()].map((c) => env.DB.prepare(sql).bind(
    c.contract_id, w.charId, c.issuer_id ?? null, c.status, c.start_location_id ?? null, c.end_location_id ?? null,
    c.volume ?? null, c.collateral ?? null, c.reward ?? null, c.title ?? null,
    c.date_issued ?? null, c.date_accepted ?? null, c.date_completed ?? null, now));
  await runBatches(env, stmts);
}

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
    w.lastError = null;
    const tok = await refreshToken(env.EVE_CLIENT_ID, w.refresh);
    if (tok.refresh_token) w.refresh = tok.refresh_token;
    const access = tok.access_token;
    const info = tokenInfo(access);

    let contracts = await esiGet(`/characters/${info.charId}/contracts/`, access);
    const ch = await esiGet(`/characters/${info.charId}/`);
    const corpId = ch.corporation_id;
    if (w.corp) {
      try { contracts = contracts.concat(await esiGet(`/corporations/${corpId}/contracts/`, access)); }
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
    try { await saveHauls(env, w, couriers); } catch (e) { w.archiveError = "Saving hauls: " + e.message; }
    try { await archiveWallets(env, w, access, info, corpId); } catch (e) { w.archiveError = "Wallet copy: " + e.message; }
    if (!w.lastUndercut || Date.now() - Date.parse(w.lastUndercut) >= UNDERCUT_EVERY_MS) {
      try { await undercutCheck(env, w, access, info, corpId); w.lastUndercut = new Date().toISOString(); w.undercutError = null; }
      catch (e) { w.undercutError = e.message; }
    }

    // Forget contracts that dropped off ESI (old ones) so the record stays small.
    for (const id of Object.keys(seen)) if (!couriers.has(Number(id))) delete seen[id];
    w.seen = seen;
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
    if (event.cron === SUMMARY_CRON) { for (const k of list.keys) await summaryOne(env, k.name); return; }
    for (const k of list.keys) await checkOne(env, k.name);
  },
  // Visiting the worker's URL runs a check right away; add ?summary=1 to post the daily summary now.
  async fetch(request, env) {
    const list = await env.WATCH.list({ prefix: "watch:" });
    if (new URL(request.url).searchParams.get("summary")) {
      const res = [];
      for (const k of list.keys) res.push(await summaryOne(env, k.name));
      return new Response(`Summary: ${res.join(", ") || "no watchers"}\n`, { headers: { "Content-Type": "text/plain" } });
    }
    for (const k of list.keys) await checkOne(env, k.name);
    return new Response(`Checked ${list.keys.length} watcher(s).\n`, { headers: { "Content-Type": "text/plain" } });
  },
};
