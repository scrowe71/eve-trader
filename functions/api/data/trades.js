// GET /api/data/trades?char=<id>&key=<key>&since=<ISO>
// Your archived wallet history (from D1), for the Trade journal and Sell prices tabs.
// Auth: the delivery-alert registration (char + key).

import { authWatch, isoSeconds, PROJECT_START_ISO } from "../../../shared/eve.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Cloud history isn't set up yet: bind the D1 database as DB to this Pages project (see README)." }, 501);
  const url = new URL(request.url);
  const w = await authWatch(env, url.searchParams.get("char"), url.searchParams.get("key"));
  if (!w) return json({ error: "Not signed in to cloud history. Turn on delivery alerts first." }, 401);

  const sinceRaw = url.searchParams.get("since");
  const since = isoSeconds(Math.max(Date.parse(PROJECT_START_ISO), sinceRaw ? Date.parse(sinceRaw) || 0 : 0));
  const sources = w.sources || [];
  const out = { since, sources, lastArchive: w.lastArchive || null, archiveError: w.archiveError || null, transactions: [], journal: [], hauls: [] };

  if (sources.length) {
    const marks = sources.map(() => "?").join(",");
    const tx = await env.DB.prepare(
      `SELECT transaction_id, source, date, type_id, quantity, unit_price, is_buy, location_id FROM transactions
       WHERE source IN (${marks}) AND date >= ? ORDER BY date DESC LIMIT 50000`).bind(...sources, since).all();
    out.transactions = tx.results.map((t) => ({ ...t, is_buy: !!t.is_buy }));
    // all=1 (Wallet tab): every journal entry with balance and description; otherwise just the fees.
    const all = url.searchParams.get("all") === "1";
    const jr = await env.DB.prepare(all
      ? `SELECT id, source, date, ref_type, amount, balance, context_id, context_id_type, first_party_id, second_party_id, description FROM journal
         WHERE source IN (${marks}) AND date >= ? ORDER BY date DESC LIMIT 50000`
      : `SELECT id, source, date, ref_type, amount, context_id, context_id_type FROM journal
       WHERE source IN (${marks}) AND date >= ? AND (ref_type IN ('brokers_fee', 'transaction_tax') OR ref_type LIKE '%surcharge%' OR ref_type LIKE '%scc%') LIMIT 50000`).bind(...sources, since).all();
    out.journal = jr.results;
  }
  const h = await env.DB.prepare("SELECT * FROM hauls WHERE owner = ? AND date_issued >= ? ORDER BY date_issued DESC").bind(w.charId, since).all();
  out.hauls = h.results;
  // Price updates the watcher saw (with estimated fees), so they can be charged to the right item.
  try {
    const ou = await env.DB.prepare("SELECT order_id, date, type_id, old_price, new_price, remain, fee FROM order_updates WHERE owner = ? AND date >= ?").bind(w.charId, since).all();
    out.orderUpdates = ou.results;
  } catch { out.orderUpdates = []; }
  return json(out);
}
