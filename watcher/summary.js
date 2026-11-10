// Daily Discord summary: yesterday's profit, what needs restocking, and which orders are worth updating.
import { discord } from "../shared/eve.js";
import { loadContext, itemCosts, demandFor, findUpdates, names, isk, n } from "./orders.js";

// Build and post the summary for one watcher. `access` is a fresh token for w.charId.
export async function postSummary(env, w, access, info, corpId) {
  if (!env.DB) return "no database";
  const ctx = await loadContext(env, w, access, info, corpId);
  const { hub, bf, book, myOrders } = ctx;
  if (!hub) { await discord(w.webhook, { content: "📊 Daily summary: pick your hub on the site first." }); return "no hub"; }
  if (!(w.sources || []).length) { await discord(w.webhook, { content: "📊 Daily summary: no wallet history copied yet. Turn alerts on again so the worker gets wallet access." }); return "no sources"; }

  const costs = await itemCosts(ctx);
  const mine = costs.mine;
  const nm = await names(mine.map((r) => r.id));
  mine.forEach((r) => (r.name = nm.get(r.id) || "Type " + r.id));

  // Last 24 hours.
  const sold24 = mine.filter((r) => r.q24 > 0);
  const rev24 = sold24.reduce((a, r) => a + r.r24, 0);
  const profitOf = (r) => r.r24 - r.t24 - r.r24 * bf - r.q24 * r.cost;
  const profit24 = sold24.reduce((a, r) => a + profitOf(r), 0);
  const top = sold24.map((r) => ({ name: r.name, p: profitOf(r), q: r.q24 })).sort((a, b) => b.p - a.p).slice(0, 5);

  // Restock: items that sold and are running low (your stock = bought - sold, listed or not).
  const myIds = new Set(myOrders.map((o) => o.order_id));
  const demand = await demandFor(ctx, w, mine.filter((r) => r.sold > 0).map((r) => r.id));
  const restock = mine.filter((r) => r.sold > 0).map((r) => {
    const per = demand.get(r.id) || 0;
    const othersListed = book.filter((b) => b.type_id === r.id && !b.is_buy_order && !myIds.has(b.order_id)).length;
    return { ...r, per, days: per > 0 ? r.left / per : Infinity, othersListed };
  }).filter((r) => r.left === 0 || r.days < 3).sort((a, b) => a.days - b.days).slice(0, 12);

  const updates = await findUpdates(ctx, costs, w);

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
  if (ctx.marketNote) fields.push({ name: "⚠️ Note", value: ctx.marketNote });
  await discord(w.webhook, {
    content: `📊 **Daily trading summary** for ${w.name}: ${hub.system || hub.name}`,
    embeds: [{ color: profit24 >= 0 ? 0x4fbf7f : 0xe0605a, fields, timestamp: new Date().toISOString(),
      footer: { text: "EveTrader · stock = bought in Jita minus sold at the hub" } }],
  });
  return "sent";
}

// Undercut alert: post only orders that have newly become worth updating since the last check.
// Remember each hub sell order between runs: record price changes (with their update fee) in D1,
// and warn once on Discord when an order is close to expiring.
const ORDER_UPDATES_SQL = `CREATE TABLE IF NOT EXISTS order_updates (order_id INTEGER NOT NULL, owner INTEGER NOT NULL, date TEXT NOT NULL,
  type_id INTEGER NOT NULL, old_price REAL, new_price REAL, remain INTEGER, fee REAL, PRIMARY KEY (order_id, date))`;
async function trackOrders(env, w, ctx) {
  const { s, hub, bf } = ctx;
  const rr = 1 - (0.5 + 0.06 * Math.min(5, s.abr || 0));
  const sells = ctx.myOrders.filter((o) => !o.is_buy_order && o.location_id === hub.id);
  const seen = w.ordersSeen || {}, next = {}, rows = [];
  const firstRun = !w.ordersSeen;
  for (const o of sells) {
    const p = seen[o.order_id];
    if (p && o.price !== p.price) {
      const up = Math.max(0, o.price - p.price) * o.volume_remain;
      const fee = Math.max(100, rr * bf * o.price * o.volume_remain + bf * up);
      rows.push([o.order_id, w.charId, o.issued || new Date().toISOString(), o.type_id, p.price, o.price, o.volume_remain, fee]);
    }
    // Expiry counts from when the order was first placed; an update doesn't extend it.
    next[o.order_id] = { price: o.price, first: p ? p.first : o.issued, dur: o.duration || 90, type: o.type_id };
  }
  w.ordersSeen = next;
  if (rows.length && env.DB) {
    try {
      await env.DB.prepare(ORDER_UPDATES_SQL).run();
      await env.DB.batch(rows.map((r) => env.DB.prepare("INSERT OR IGNORE INTO order_updates (order_id, owner, date, type_id, old_price, new_price, remain, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(...r)));
    } catch (e) { w.orderUpdatesError = e.message; }
  }

  const days = s.oExpireDays ?? 3;
  const warned = w.expiryWarned || {}, keepWarned = {};
  const soon = [];
  for (const [id, x] of Object.entries(next)) {
    const left = (Date.parse(x.first) + x.dur * 86400000 - Date.now()) / 86400000;
    if (warned[id]) { keepWarned[id] = 1; continue; }
    if (days > 0 && left <= days && !firstRun) { soon.push({ id, type: x.type, left }); keepWarned[id] = 1; }
    else if (days > 0 && left <= days && firstRun) keepWarned[id] = 1;   // already close when tracking started: don't flood
  }
  w.expiryWarned = keepWarned;
  if (!soon.length) return;
  const nm = await names([...new Set(soon.map((x) => x.type))]);
  soon.sort((a, b) => a.left - b.left);
  await discord(w.webhook, {
    content: `⏳ **${soon.length} sell order${soon.length === 1 ? "" : "s"} expiring soon** at ${hub.system || hub.name}`,
    embeds: [{
      color: 0xd9822b,
      description: soon.slice(0, 20).map((x) => {
        const o = sells.find((y) => String(y.order_id) === String(x.id));
        return `**${nm.get(x.type) || "Type " + x.type}**: ${o ? `${n(o.volume_remain)} left at ${isk(o.price)} · ` : ""}expires in about ${x.left < 1 ? Math.max(1, Math.round(x.left * 24)) + " hours" : x.left.toFixed(1) + " days"}`;
      }).join("\n").slice(0, 4000),
      footer: { text: "EveTrader · cancel and relist before it runs out, or the rest goes back to your hangar" },
      timestamp: new Date().toISOString(),
    }],
  });
}

export async function undercutCheck(env, w, access, info, corpId) {
  const at = new Date().toISOString();
  if (!env.DB) { w.undercutInfo = { at, note: "The cloud database isn't connected to the worker." }; return; }
  const ctx = await loadContext(env, w, access, info, corpId);
  if (!ctx.hub) { w.undercutInfo = { at, note: "No hub saved in the cloud yet. Open the site and pick your hub once." }; return; }
  try { await trackOrders(env, w, ctx); } catch (e) { w.orderUpdatesError = e.message; }
  if (ctx.s.oAlert === "off") { w.undercutInfo = { at, note: "Undercut alerts are switched off in Order check settings." }; return; }
  if (ctx.marketNote) { w.undercutInfo = { at, note: ctx.marketNote }; return; }
  const costs = await itemCosts(ctx);
  const updates = await findUpdates(ctx, costs, w);
  const sells = ctx.myOrders.filter((o) => !o.is_buy_order && o.location_id === ctx.hub.id).length;
  const prev = w.undercut || {};
  const next = {};
  const fresh = [];
  for (const u of updates) {
    const key = u.kind === "buyout" ? `buy:${u.qty}:${u.maxPrice}` : `${u.target}`;   // same order + same advice = already told you
    next[u.orderId] = key;
    if (prev[u.orderId] !== key) fresh.push(u);
  }
  w.undercut = next;                          // orders no longer worth updating drop out, so a later undercut alerts again
  w.undercutInfo = { at, sells, worth: updates.length, posted: fresh.length,
    note: !sells ? "Found none of your sell orders at the hub (the alert character needs to be in the corp that owns them, with order access)."
      : updates.pending ? `${updates.pending} orders skipped this time while item details are still being looked up; they're checked on the next runs.` : "" };
  if (!fresh.length) return;
  await discord(w.webhook, {
    content: `🔧 **${fresh.length} order${fresh.length === 1 ? " needs" : "s need"} attention** at ${ctx.hub.system || ctx.hub.name}`,
    embeds: [{
      color: 0xe0a645,
      description: fresh.slice(0, 15).map((u) => u.kind === "buyout"
        ? `**${u.name}**: you ${isk(u.price)}, lowest ${isk(u.lowest)}\n💰 **buy out** all ${n(u.qty)} cheaper (up to ${isk(u.maxPrice)} each, ${isk(u.cost)}) and relist at your price → about **+${isk(u.profit)}**`
        : `**${u.name}**: you ${isk(u.price)}, lowest ${isk(u.lowest)} · ${n(u.ahead)} cheaper units ahead` +
          `${isFinite(u.aheadDays) ? ` (~${u.aheadDays.toFixed(1)} days)` : ""}\n→ update to **${n(u.target)}** · fee ${isk(u.fee)}`).join("\n\n").slice(0, 4000),
      footer: { text: "EveTrader · only orders the Order check says are worth acting on" },
      timestamp: new Date().toISOString(),
    }],
  });
}
