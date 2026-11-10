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
export async function undercutCheck(env, w, access, info, corpId) {
  const at = new Date().toISOString();
  if (!env.DB) { w.undercutInfo = { at, note: "The cloud database isn't connected to the worker." }; return; }
  const ctx = await loadContext(env, w, access, info, corpId);
  if (!ctx.hub) { w.undercutInfo = { at, note: "No hub saved in the cloud yet. Open the site and pick your hub once." }; return; }
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
