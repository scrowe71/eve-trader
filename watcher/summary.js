// Daily Discord summary: yesterday's profit, what needs restocking, and which orders are worth updating.
import { esiGet, discord } from "../shared/eve.js";
import { parseDoctrine } from "../shared/doctrine.js";

const JITA = 60003760;
const PROJECT_START = Date.parse("2026-11-07T04:00:00Z");
const DAY = 86400000;

const isk = (v) => {
  const a = Math.abs(v || 0), s = v < 0 ? "-" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
  return s + a.toFixed(0);
};
const n = (v) => Math.round(v).toLocaleString("en-US");
const tick = (p) => (p > 0 ? Math.pow(10, Math.floor(Math.log10(p)) - 3) : 0.01);
const floorTick = (p) => { const t = tick(p); return Math.floor(p / t) * t; };

async function names(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 900) {
    const r = await fetch("https://esi.evetech.net/latest/universe/names/?datasource=tranquility", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids.slice(i, i + 900)),
    });
    if (r.ok) (await r.json()).forEach((x) => out.set(x.id, x.name));
  }
  return out;
}

async function volumes(ids) {
  const out = new Map();
  await Promise.all(ids.map(async (id) => {
    try { const t = await esiGet(`/universe/types/${id}/`); out.set(id, t.packaged_volume ?? t.volume ?? 0); } catch { out.set(id, 0); }
  }));
  return out;
}

async function dailyAvg(regionId, id) {
  try {
    const h = await esiGet(`/markets/${regionId}/history/?type_id=${id}`, null, { paged: false });
    const cut = Date.now() - 30 * DAY;
    return h.filter((d) => Date.parse(d.date) >= cut).reduce((a, d) => a + d.volume, 0) / 30;
  } catch { return 0; }
}

// Build and post the summary for one watcher. `access` is a fresh token for w.charId.
export async function postSummary(env, w, access, info, corpId) {
  if (!env.DB) return "no database";
  const row = await env.DB.prepare("SELECT data FROM settings WHERE char = ?").bind(w.charId).first();
  const data = row ? JSON.parse(row.data) : {};
  const s = Object.assign({ acc: 5, abr: 4, hubFee: 2, haulRate: 800, coll: 1, haulDisc: 0, dMinRoi: 20, oAheadDays: 1, oMinGap: 1 }, data.settings || {});
  const hub = data.hub;
  if (!hub) { await discord(w.webhook, { content: "📊 Daily summary: pick your hub on the site first." }); return "no hub"; }
  const tracker = parseDoctrine(data.doctrineCsv || "");

  const tax = 0.075 * (1 - 0.11 * Math.min(5, s.acc));
  const bf = (s.hubFee || 0) / 100;
  const keep = 1 - tax - bf;
  const k = 1 - Math.min(100, Math.max(0, s.haulDisc || 0)) / 100;
  const from = Math.max(PROJECT_START, s.jFrom ? Date.parse(s.jFrom) || 0 : 0);
  const fromIso = new Date(from).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sources = w.sources || [];
  if (!sources.length) { await discord(w.webhook, { content: "📊 Daily summary: no wallet history copied yet. Turn alerts on again so the worker gets wallet access." }); return "no sources"; }
  const marks = sources.map(() => "?").join(",");
  const txs = (await env.DB.prepare(`SELECT transaction_id, date, type_id, quantity, unit_price, is_buy, location_id FROM transactions WHERE source IN (${marks}) AND date >= ?`).bind(...sources, fromIso).all()).results;
  const taxRows = (await env.DB.prepare(`SELECT context_id, amount FROM journal WHERE source IN (${marks}) AND date >= ? AND ref_type = 'transaction_tax'`).bind(...sources, new Date(Date.now() - 2 * DAY).toISOString()).all()).results;
  const taxBySale = new Map(taxRows.map((t) => [t.context_id, -(t.amount || 0)]));

  // Per item: Jita buys (cost), hub sales (all / last 24h).
  const items = new Map();
  const get = (id) => { let r = items.get(id); if (!r) { r = { id, bq: 0, bisk: 0, sold: 0, q24: 0, r24: 0, t24: 0 }; items.set(id, r); } return r; };
  const since24 = Date.now() - DAY;
  for (const t of txs) {
    if (t.is_buy && t.location_id === JITA) { const r = get(t.type_id); r.bq += t.quantity; r.bisk += t.quantity * t.unit_price; }
    else if (!t.is_buy && t.location_id === hub.id) {
      const r = get(t.type_id); r.sold += t.quantity;
      if (Date.parse(t.date) >= since24) { r.q24 += t.quantity; r.r24 += t.quantity * t.unit_price; r.t24 += taxBySale.get(t.transaction_id) ?? t.quantity * t.unit_price * tax; }
    }
  }
  const mine = [...items.values()].filter((r) => r.bq > 0);           // only items you imported from Jita
  const ids = mine.map((r) => r.id);
  const [nm, vol] = await Promise.all([names(ids), volumes(ids)]);
  mine.forEach((r) => {
    r.name = nm.get(r.id) || "Type " + r.id;
    r.avg = r.bisk / r.bq;
    r.cost = r.avg + k * (s.haulRate * (vol.get(r.id) || 0) + (s.coll / 100) * r.avg);
    r.left = Math.max(0, r.bq - r.sold);
    r.min = r.cost * (1 + s.dMinRoi / 100) / keep;
  });

  // Yesterday.
  const sold24 = mine.filter((r) => r.q24 > 0);
  const rev24 = sold24.reduce((a, r) => a + r.r24, 0);
  const profit24 = sold24.reduce((a, r) => a + r.r24 - r.t24 - r.r24 * bf - r.q24 * r.cost, 0);
  const top = sold24.map((r) => ({ name: r.name, p: r.r24 - r.t24 - r.r24 * bf - r.q24 * r.cost, q: r.q24 })).sort((a, b) => b.p - a.p).slice(0, 5);

  // Hub market + your orders.
  let book = [], myOrders = [], marketNote = "";
  try { book = await esiGet(`/markets/structures/${hub.id}/`, access); }
  catch (e) { marketNote = e.status === 403 ? "Couldn't read the hub market (turn alerts on again so the login includes market access)." : "Hub market: " + e.message; }
  try { myOrders = myOrders.concat(await esiGet(`/characters/${info.charId}/orders/`, access, { paged: false })); } catch {}
  if (corpId) { try { myOrders = myOrders.concat(await esiGet(`/corporations/${corpId}/orders/`, access)); } catch {} }
  const myIds = new Set(myOrders.map((o) => o.order_id));
  const mySells = myOrders.filter((o) => !o.is_buy_order && o.location_id === hub.id);

  // Demand per day: tracker first, then regional history.
  const demand = new Map();
  await Promise.all(mine.filter((r) => r.left > 0 || r.sold > 0).map(async (r) => {
    const d = tracker.get(r.id);
    demand.set(r.id, d ? (d.a30 || d.a7) : await dailyAvg(hub.regionId, r.id));
  }));

  // Restock: items that sold and are running low (your stock = bought - sold, listed or not).
  const restock = mine.filter((r) => r.sold > 0).map((r) => {
    const per = demand.get(r.id) || 0;
    const othersListed = book.filter((b) => b.type_id === r.id && !b.is_buy_order && !myIds.has(b.order_id)).length;
    return { ...r, per, days: per > 0 ? r.left / per : Infinity, othersListed };
  }).filter((r) => r.left === 0 || r.days < 3).sort((a, b) => a.days - b.days).slice(0, 12);

  // Orders worth updating (same rules as the site's Order check).
  const rr = 1 - (0.5 + 0.06 * Math.min(5, s.abr));
  const updates = [];
  for (const o of mySells) {
    const others = book.filter((b) => b.type_id === o.type_id && !b.is_buy_order && !myIds.has(b.order_id));
    if (!others.length) continue;
    const lowest = Math.min(...others.map((b) => b.price));
    if (o.price <= lowest) continue;
    const ahead = others.filter((b) => b.price < o.price).reduce((a, b) => a + b.volume_remain, 0);
    const it = items.get(o.type_id);
    const per = demand.get(o.type_id) || (tracker.get(o.type_id) || {}).a30 || 0;
    const aheadDays = per > 0 ? ahead / per : Infinity;
    const gap = (o.price - lowest) / o.price * 100;
    const target = floorTick(lowest - tick(lowest) * 0.5);
    const min = it && it.bq ? it.cost * (1 + s.dMinRoi / 100) / keep : 0;
    if (target < min) continue;
    if (aheadDays <= s.oAheadDays) continue;
    if (gap < s.oMinGap && aheadDays <= s.oAheadDays * 3) continue;
    const fee = Math.max(100, rr * bf * target * o.volume_remain);
    updates.push({ id: o.type_id, price: o.price, target, ahead, aheadDays, fee });
  }
  const unames = await names([...new Set(updates.map((u) => u.id))].filter((id) => !nm.has(id)));
  updates.forEach((u) => (u.name = nm.get(u.id) || unames.get(u.id) || "Type " + u.id));

  // Message.
  const lines = (arr, f, none) => (arr.length ? arr.map(f).join("\n") : none).slice(0, 1020);
  const fields = [
    { name: "💰 Last 24 hours", value: sold24.length
        ? `**${isk(profit24)}** profit on ${isk(rev24)} of sales (${n(sold24.reduce((a, r) => a + r.q24, 0))} units, ${sold24.length} item${sold24.length === 1 ? "" : "s"})\n` +
          top.map((t) => `• ${t.name}: ${n(t.q)} sold, ${isk(t.p)}`).join("\n")
        : "No import sales in the last 24 hours." },
    { name: `📦 Restock soon (${restock.length})`, value: lines(restock,
        (r) => `• ${r.name}: ${r.left ? `${n(r.left)} left (~${r.days.toFixed(1)} days)` : "**sold out**"}${r.othersListed ? "" : " · no other sellers"}`,
        "Nothing running low.") },
    { name: `🔧 Orders worth updating (${updates.length})`, value: lines(updates,
        (u) => `• ${u.name}: ${isk(u.price)} → ${isk(u.target)} (${n(u.ahead)} ahead${isFinite(u.aheadDays) ? `, ~${u.aheadDays.toFixed(1)}d` : ""}; fee ${isk(u.fee)})`,
        "None. Leave your orders alone today. 👍") },
  ];
  if (marketNote) fields.push({ name: "⚠️ Note", value: marketNote });
  await discord(w.webhook, {
    content: `📊 **Daily trading summary** for ${w.name}: ${hub.system || hub.name}`,
    embeds: [{ color: profit24 >= 0 ? 0x4fbf7f : 0xe0605a, fields, timestamp: new Date().toISOString(),
      footer: { text: "EveTrader · stock = bought in Jita minus sold at the hub" } }],
  });
  return "sent";
}
