// Shared by the daily summary and the undercut alert:
// works out which of your hub sell orders are worth updating (same rules as the site's Order check).
import { esiGet } from "../shared/eve.js";
import { parseDoctrine } from "../shared/doctrine.js";

export const JITA = 60003760;
export const PROJECT_START = Date.parse("2026-11-07T04:00:00Z");
export const DAY = 86400000;

export const isk = (v) => {
  const a = Math.abs(v || 0), s = v < 0 ? "-" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
  return s + a.toFixed(0);
};
export const n = (v) => Math.round(v).toLocaleString("en-US");
const tick = (p) => (p > 0 ? Math.pow(10, Math.floor(Math.log10(p)) - 3) : 0.01);
const floorTick = (p) => { const t = tick(p); return Math.floor(p / t) * t; };

// The free Workers plan allows 50 outside requests per run. worker.js counts every fetch here,
// and the lookups below stop early (and finish on a later run) instead of going over.
export const sub = { n: 0 };
const LIMIT = 47;
export const requestsLeft = () => LIMIT - sub.n;

export async function names(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 900) {
    const r = await fetch("https://esi.evetech.net/latest/universe/names/?datasource=tranquility", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids.slice(i, i + 900)),
    });
    if (r.ok) (await r.json()).forEach((x) => out.set(x.id, x.name));
  }
  return out;
}

// Item sizes never change, so they're kept in KV for good. New ones are looked up a few per run.
export async function volumes(ids, env) {
  const cache = (env && (await env.WATCH.get("cache:volumes", "json"))) || {};
  const missing = [...new Set(ids)].filter((id) => cache[id] === undefined);
  const take = missing.slice(0, Math.max(0, requestsLeft() - 4));
  await Promise.all(take.map(async (id) => {
    try { const t = await esiGet(`/universe/types/${id}/`); cache[id] = t.packaged_volume ?? t.volume ?? 0; } catch {}
  }));
  if (take.length && env) await env.WATCH.put("cache:volumes", JSON.stringify(cache));
  const out = new Map();
  ids.forEach((id) => { if (cache[id] !== undefined) out.set(id, cache[id]); });
  out.missing = missing.length - take.filter((id) => cache[id] !== undefined).length;
  return out;
}

async function dailyAvg(regionId, id) {
  try {
    const h = await esiGet(`/markets/${regionId}/history/?type_id=${id}`, null, { paged: false });
    const cut = Date.now() - 30 * DAY;
    return h.filter((d) => Date.parse(d.date) >= cut).reduce((a, d) => a + d.volume, 0) / 30;
  } catch { return 0; }
}

// Everything both features need: settings, your Jita costs, the hub book, your orders, demand.
export async function loadContext(env, w, access, info, corpId) {
  const row = await env.DB.prepare("SELECT data FROM settings WHERE char = ?").bind(w.charId).first();
  const data = row ? JSON.parse(row.data) : {};
  const s = Object.assign({ acc: 5, abr: 4, hubFee: 2, haulRate: 800, coll: 1, haulDisc: 0, dMinRoi: 20, oAheadDays: 1, oMinGap: 1, oAlert: "on" }, data.settings || {});
  const hub = data.hub;
  const tracker = parseDoctrine(data.doctrineCsv || "");
  const tax = 0.075 * (1 - 0.11 * Math.min(5, s.acc));
  const bf = (s.hubFee || 0) / 100;
  const keep = 1 - tax - bf;
  const k = 1 - Math.min(100, Math.max(0, s.haulDisc || 0)) / 100;
  const from = Math.max(PROJECT_START, s.jFrom ? Date.parse(s.jFrom) || 0 : 0);
  const fromIso = new Date(from).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sources = w.sources || [];
  let txs = [], taxRows = [];
  if (sources.length) {
    const marks = sources.map(() => "?").join(",");
    txs = (await env.DB.prepare(`SELECT transaction_id, date, type_id, quantity, unit_price, is_buy, location_id FROM transactions WHERE source IN (${marks}) AND date >= ?`).bind(...sources, fromIso).all()).results;
    taxRows = (await env.DB.prepare(`SELECT context_id, amount FROM journal WHERE source IN (${marks}) AND date >= ? AND ref_type = 'transaction_tax'`).bind(...sources, new Date(Date.now() - 2 * DAY).toISOString()).all()).results;
  }
  let book = [], myOrders = [], marketNote = "";
  if (hub) {
    try { book = await esiGet(`/markets/structures/${hub.id}/`, access); }
    catch (e) { marketNote = e.status === 403 ? "Couldn't read the hub market (turn alerts on again so the login includes market access)." : "Hub market: " + e.message; }
    try { myOrders = myOrders.concat(await esiGet(`/characters/${info.charId}/orders/`, access, { paged: false })); } catch {}
    if (corpId) { try { myOrders = myOrders.concat(await esiGet(`/corporations/${corpId}/orders/`, access)); } catch {} }
  }
  const seen = new Set();
  myOrders = myOrders.filter((o) => (seen.has(o.order_id) ? false : (seen.add(o.order_id), true)));
  return { env, s, hub, tracker, tax, bf, keep, k, txs, taxRows, book, myOrders, marketNote };
}

// Per item cost from Jita purchases (+ hauling) and sales at the hub.
export async function itemCosts(ctx) {
  const { txs, hub, s, k, keep, tax } = ctx;
  const taxBySale = new Map(ctx.taxRows.map((t) => [t.context_id, -(t.amount || 0)]));
  const items = new Map();
  const get = (id) => { let r = items.get(id); if (!r) { r = { id, bq: 0, bisk: 0, sold: 0, q24: 0, r24: 0, t24: 0 }; items.set(id, r); } return r; };
  const since24 = Date.now() - DAY;
  for (const t of txs) {
    if (t.is_buy && t.location_id === JITA) { const r = get(t.type_id); r.bq += t.quantity; r.bisk += t.quantity * t.unit_price; }
    else if (hub && !t.is_buy && t.location_id === hub.id) {
      const r = get(t.type_id); r.sold += t.quantity;
      if (Date.parse(t.date) >= since24) { r.q24 += t.quantity; r.r24 += t.quantity * t.unit_price; r.t24 += taxBySale.get(t.transaction_id) ?? t.quantity * t.unit_price * tax; }
    }
  }
  const mine = [...items.values()].filter((r) => r.bq > 0);
  const vol = await volumes(mine.map((r) => r.id), ctx.env);
  mine.forEach((r) => {
    r.sized = vol.has(r.id);
    r.avg = r.bisk / r.bq;
    r.cost = r.avg + k * (s.haulRate * (vol.get(r.id) || 0) + (s.coll / 100) * r.avg);
    r.left = Math.max(0, r.bq - r.sold);
    r.min = r.cost * (1 + s.dMinRoi / 100) / keep;
  });
  return { items, mine, sizesMissing: vol.missing || 0 };
}

// Demand per day for a set of item ids: tracker first, then regional history (cached in w.demand for the day).
export async function demandFor(ctx, w, ids) {
  const today = new Date().toISOString().slice(0, 10);
  if (!w.demand || w.demand.date !== today) w.demand = { date: today, d: {} };
  const out = new Map();
  let budget = Math.max(0, requestsLeft() - 4);   // ids not looked up this run are left out of the map
  await Promise.all(ids.map(async (id) => {
    const t = ctx.tracker.get(id);
    if (t) { out.set(id, t.a30 || t.a7); return; }
    if (w.demand.d[id] === undefined) {
      if (!ctx.hub || budget <= 0) return;
      budget--;
      w.demand.d[id] = await dailyAvg(ctx.hub.regionId, id);
    }
    out.set(id, w.demand.d[id]);
  }));
  return out;
}

// Orders worth updating, using the Order check rules.
export async function findUpdates(ctx, costs, w) {
  const { s, hub, book, myOrders, bf } = ctx;
  if (!hub) return [];
  const myIds = new Set(myOrders.map((o) => o.order_id));
  const mySells = myOrders.filter((o) => !o.is_buy_order && o.location_id === hub.id);
  const demand = await demandFor(ctx, w, [...new Set(mySells.map((o) => o.type_id))]);
  const rr = 1 - (0.5 + 0.06 * Math.min(5, s.abr));
  const out = [];
  let pending = 0;
  for (const o of mySells) {
    const it0 = costs.items.get(o.type_id);
    // Not enough information yet (size or demand still being looked up): check it on a later run.
    if (!demand.has(o.type_id) || (it0 && it0.bq && !it0.sized)) { pending++; continue; }
    const others = book.filter((b) => b.type_id === o.type_id && !b.is_buy_order && !myIds.has(b.order_id));
    if (!others.length) continue;
    const lowest = Math.min(...others.map((b) => b.price));
    if (o.price <= lowest) continue;
    if (Date.now() - Date.parse(o.issued) < 5 * 60000) continue;
    const ahead = others.filter((b) => b.price < o.price).reduce((a, b) => a + b.volume_remain, 0);
    const it = costs.items.get(o.type_id);
    const per = demand.get(o.type_id) || 0;
    const aheadDays = per > 0 ? ahead / per : Infinity;
    const gap = (o.price - lowest) / o.price * 100;
    const target = floorTick(lowest - tick(lowest) * 0.5);
    const min = it && it.bq ? it.min : 0;
    if (target < min) continue;
    if (aheadDays <= s.oAheadDays) continue;
    if (gap < s.oMinGap && aheadDays <= s.oAheadDays * 3) continue;
    const fee = Math.max(100, rr * bf * target * o.volume_remain);
    out.push({ orderId: o.order_id, id: o.type_id, price: o.price, lowest, target, ahead, aheadDays, fee, remain: o.volume_remain });
  }
  const nm = await names([...new Set(out.map((u) => u.id))]);
  out.forEach((u) => (u.name = nm.get(u.id) || "Type " + u.id));
  out.pending = pending;
  return out;
}
