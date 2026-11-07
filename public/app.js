(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const ESI = "https://esi.evetech.net/latest";
  const JITA_REGION = 10000002;   // The Forge
  // Import project start: Nov 6 2026, 11:00 PM Eastern (UTC-5). Wallet activity before this
  // (earlier trading out of the same corp wallet) is never counted in the Trade journal.
  const PROJECT_START = Date.parse("2026-11-07T04:00:00Z");
  const JF_CARGO = 350000;        // m³ per hauling contract (one full JF load)
  const JITA_STATION = 60003760;  // Jita IV - Moon 4 - Caldari Navy Assembly Plant
  const SSO_AUTHORIZE = "https://login.eveonline.com/v2/oauth/authorize/";
  const BASE_SCOPES = [
    "esi-markets.structure_markets.v1",
    "esi-search.search_structures.v1",
    "esi-universe.read_structures.v1",
  ];
  // Extra permissions for the Trade journal (wallet transactions + journal).
  // Delivery alerts: the token goes straight to the server (functions/api/watch.js), never kept here.
  const ALERT_SCOPES = [
    "esi-contracts.read_character_contracts.v1",
    "esi-contracts.read_corporation_contracts.v1",
    "esi-universe.read_structures.v1",
    "esi-wallet.read_character_wallet.v1",       // the worker also copies your wallets into the cloud database
    "esi-wallet.read_corporation_wallets.v1",
    "esi-markets.structure_markets.v1",          // daily summary: hub prices and your orders
    "esi-markets.read_corporation_orders.v1",
    "esi-markets.read_character_orders.v1",
  ];
  const WALLET_SCOPES = [
    "esi-wallet.read_character_wallet.v1",
    "esi-wallet.read_corporation_wallets.v1",
    "esi-markets.read_character_orders.v1",      // Order check
    "esi-markets.read_corporation_orders.v1",
    "esi-skills.read_skills.v1",                 // skills + order slots read from the game
  ];

  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const DEFAULTS = {
    acc: 5, br: 5, abr: 4, jFac: 0, jCorp: 0, hubFee: 1.0,
    haulRate: 800, coll: 1, haulDisc: 0, haulExpress: 25000000, buyHow: "instant", minRoi: 8, minPrice: 100000, maxRows: 100,
    dDays: 30, dDemand: "a30", dClasses: "seed", dMarkup: 130, dMinRoi: 20,
    dItemCap: 500000000, dBudget: 10000000000, dCargo: 0, dShow: "all", dMinProfit: 1000000, dPriority: "soldout", dTol: 2,
    trade: 4, retail: 0, wholesale: 0, tycoon: 0, openOrders: 0,
    oAheadDays: 1, oMinGap: 1, oAlert: "on", lMaxDays: 7, lBbPct: 95, lBbFeePct: 0, lBbFlat: 0, lBbUnder: 50000000, lBbExclude: "Frequency Crystal, Laser Crystal", dSpike: 15, dSpikeAct: "skip", dMinDaily: 2, dMaxSellers: 3, dMaxStockDays: 7, dStockBand: 15, dExclude: "Material, Asteroid, Planetary Commodities, Planetary Resources", dBudgetMode: "wallet", dReserve: 10, rPreset: "30", rGroup: "day", rFrom: "", rTo: "",
    jPeriod: 14, jWhere: "hub", jCorpWallet: "on", jCorpDiv: 1, jCorpChar: "", jFrom: "", jSource: "jita",
  };
  const TEXT_SETTINGS = new Set(["dExclude", "oAlert", "rPreset", "rGroup", "rFrom", "rTo", "lBbExclude", "dSpikeAct", "dBudgetMode", "buyHow", "dDemand", "dClasses", "dShow", "dPriority", "jWhere", "jCorpWallet", "jCorpChar", "jFrom", "jSource"]);
  const settings = Object.assign({}, DEFAULTS, store.get("settings", {}));
  // Repair: v2.0–2.1 stored the corp-wallet switch under "jCorp", the Caldari Navy standing's key.
  if (typeof settings.jCorp !== "number" || !isFinite(settings.jCorp)) {
    if (settings.jCorp === "on" || settings.jCorp === "off") settings.jCorpWallet = settings.jCorp;
    settings.jCorp = 0;
  }
  let token = store.get("token", null);                 // the hub (primary) character
  const chars = store.get("chars", {});                 // every logged-in character, by id
  if (token && !chars[token.charId]) { chars[token.charId] = token; store.set("chars", chars); }
  let hub = store.get("hub", null);
  let results = [];
  let sortKey = "dayProfit", sortDir = -1;

  // ---------- formatting ----------
  function isk(v) {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
    return s + a.toFixed(2);
  }
  const pct = (v) => (isFinite(v) ? (v * 100).toFixed(1) + "%" : "–");
  const intf = (v) => (isFinite(v) ? Math.round(v).toLocaleString("en-US") : "–");

  function status(msg, kind = "") {
    const el = $("status");
    el.textContent = msg;
    el.dataset.kind = kind;
  }

  // ---------- fees ----------
  const salesTax = () => 0.075 * (1 - 0.11 * Math.min(5, Math.max(0, settings.acc)));
  const jitaBroker = () => Math.max(0.01, 0.03 - 0.003 * settings.br - 0.0003 * settings.jFac - 0.0002 * settings.jCorp);
  const hubBroker = () => settings.hubFee / 100;
  const haulCost = (vol, cost) =>
    (settings.haulRate * (vol || 0) + (settings.coll / 100) * cost) * (1 - Math.min(100, Math.max(0, settings.haulDisc || 0)) / 100);
  const lvl = (v) => Math.min(5, Math.max(0, Math.round(v || 0)));
  const orderSlots = () => 5 + 4 * lvl(settings.trade) + 8 * lvl(settings.retail) + 16 * lvl(settings.wholesale) + 32 * lvl(settings.tycoon);
  const freeSlots = () => Math.max(0, orderSlots() - Math.max(0, Math.round(settings.openOrders || 0)));

  // ---------- PKCE / SSO ----------
  function b64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // mode "primary": the hub character (market permissions only).
  // mode "journal": add or refresh a character with wallet permissions too.
  async function login(mode = "primary", extra = {}) {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith("PASTE")) {
      status("Add your EVE app's Client ID to config.js first (see README).", "err");
      return;
    }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem("pkce", JSON.stringify(Object.assign({ verifier, state, mode }, extra)));
    const scopes = mode === "alerts" ? ALERT_SCOPES : mode === "journal" ? BASE_SCOPES.concat(WALLET_SCOPES) : BASE_SCOPES;
    const p = new URLSearchParams({
      response_type: "code",
      redirect_uri: CFG.CALLBACK_URL,
      client_id: CFG.CLIENT_ID,
      scope: scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    location.href = SSO_AUTHORIZE + "?" + p.toString();
  }

  async function tokenRequest(params) {
    const r = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("EVE login failed: " + (j.error_description || j.error || r.status));
    return j;
  }

  function decodeJwt(t) {
    let p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    const bin = atob(p);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function saveToken(t, mode) {
    const claims = decodeJwt(t.access_token);
    const charId = String(claims.sub || "").split(":").pop();
    const prev = chars[charId];
    const scp = Array.isArray(claims.scp) ? claims.scp : (claims.scp ? [claims.scp] : []);
    const obj = {
      access: t.access_token,
      refresh: t.refresh_token || (prev && prev.refresh),
      exp: Date.now() + (t.expires_in || 1199) * 1000,
      charId,
      name: claims.name || (prev && prev.name) || "",
      scopes: scp,
      include: prev ? prev.include !== false : true,
    };
    chars[charId] = obj;
    store.set("chars", chars);
    if (mode === "primary" || !token || token.charId === charId) {
      token = obj;
      store.set("token", token);
    }
    return obj;
  }

  const hasWallet = (c) => !!(c && c.scopes && c.scopes.includes("esi-wallet.read_character_wallet.v1"));
  const hasOrders = (c) => !!(c && c.scopes && c.scopes.includes("esi-markets.read_character_orders.v1"));
  const hasSkills = (c) => !!(c && c.scopes && c.scopes.includes("esi-skills.read_skills.v1"));

  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem("pkce") || "null"); } catch {}
    sessionStorage.removeItem("pkce");
    if (!saved || saved.state !== q.get("state")) throw new Error("Login check failed (state mismatch). Please log in again.");
    if (saved.mode === "alerts") { await finishAlerts(code, saved); return null; }
    status("Finishing login…", "busy");
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: CFG.CLIENT_ID,
      code_verifier: saved.verifier,
    });
    const c = saveToken(t, saved.mode || "primary");
    if (saved.mode === "journal") store.set("tab", "journal");
    return c;
  }

  async function accessToken(charId) {
    const c = charId ? chars[charId] : token;
    if (!c) throw new Error("You're not logged in.");
    if (Date.now() < c.exp - 60000) return c.access;
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: CFG.CLIENT_ID });
    return saveToken(t, token && token.charId === c.charId ? "primary" : "journal").access;
  }

  function logout() {
    token = null;
    store.del("token");
    for (const k of Object.keys(chars)) delete chars[k];
    store.del("chars");
    render();
    renderChars();
    status("Logged out of every character.", "ok");
  }

  // ---------- ESI ----------
  async function esi(path, { auth = false, method = "GET", body = null, charId = null } = {}) {
    const headers = {};
    if (auth) headers.Authorization = "Bearer " + (await accessToken(charId));
    if (body) headers["Content-Type"] = "application/json";
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(ESI + path + sep + "datasource=tranquility", {
      method, headers, body: body ? JSON.stringify(body) : null,
    });
    if (!r.ok) {
      let m = "";
      try { m = (await r.json()).error || ""; } catch {}
      const e = new Error(`ESI ${r.status} on ${path.split("?")[0]}${m ? ": " + m : ""}`);
      e.status = r.status;
      throw e;
    }
    return { data: await r.json(), pages: parseInt(r.headers.get("X-Pages") || "0", 10) };
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    });
    await Promise.all(workers);
    return out;
  }

  const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

  // ---------- hub ----------
  async function searchHub(text) {
    const r = await esi(`/characters/${token.charId}/search/?categories=structure&strict=false&search=${encodeURIComponent(text)}`, { auth: true });
    const ids = (r.data.structure || []).slice(0, 15);
    const infos = await pool(ids, 5, (id) => esi(`/universe/structures/${id}/`, { auth: true }).then((x) => ({ id, ...x.data })).catch(() => null));
    return infos.filter(Boolean);
  }

  async function setHubById(id) {
    status("Looking up structure…", "busy");
    const s = (await esi(`/universe/structures/${id}/`, { auth: true })).data;
    const sys = (await esi(`/universe/systems/${s.solar_system_id}/`)).data;
    const con = (await esi(`/universe/constellations/${sys.constellation_id}/`)).data;
    const reg = (await esi(`/universe/regions/${con.region_id}/`)).data;
    hub = { id: Number(id), name: s.name, system: sys.name, regionId: con.region_id, region: reg.name };
    store.set("hub", hub);
    markSettingsChanged();
    render();
    status(`Hub set to ${hub.name}.`, "ok");
  }

  async function hubOrders(id) {
    const first = await esi(`/markets/structures/${id}/?page=1`, { auth: true });
    let all = first.data;
    if (first.pages > 1) {
      let done = 1;
      const pages = Array.from({ length: first.pages - 1 }, (_, i) => i + 2);
      const rest = await pool(pages, 6, async (p) => {
        const d = (await esi(`/markets/structures/${id}/?page=${p}`, { auth: true })).data;
        status(`Downloading hub orders: page ${++done} of ${first.pages}…`, "busy");
        return d;
      });
      rest.forEach((d) => { all = all.concat(d); });
    } else if (!first.pages && first.data.length >= 1000) {
      // Page count header not readable; walk pages until a short one.
      for (let p = 2; p <= 300; p++) {
        const d = (await esi(`/markets/structures/${id}/?page=${p}`, { auth: true })).data;
        all = all.concat(d);
        status(`Downloading hub orders: page ${p}…`, "busy");
        if (d.length < 1000) break;
      }
    }
    return all;
  }

  // ---------- caches for slow-changing data ----------
  const volCache = store.get("volCache", {});      // type_id -> packaged m³
  const nameCache = store.get("nameCache", {});    // type_id -> name
  const today = new Date().toISOString().slice(0, 10);
  let histCache = store.get("histCache", { date: "", region: 0, data: {} });
  if (histCache.date !== today || (hub && histCache.region !== hub.regionId)) histCache = { date: today, region: hub ? hub.regionId : 0, data: {} };

  // Item group names (e.g. "Frequency Crystal"), cached in the browser.
  const groupOfType = store.get("groupOfType", {});   // type_id -> group_id
  const groupName = store.get("groupName", {});       // group_id -> name
  const catOfGroup = store.get("catOfGroup", {});     // group_id -> category_id
  const catName = store.get("catName", {});           // category_id -> name
  // True when the item's category or group name matches one of the comma-separated names.
  function inGroups(typeId, list) {
    const names = String(list || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!names.length) return false;
    const g = (groupName[groupOfType[typeId]] || "").toLowerCase();
    const c = (catName[catOfGroup[groupOfType[typeId]]] || "").toLowerCase();
    return names.some((n) => n === c || g.includes(n));
  }
  async function groups(ids) {
    const needT = ids.filter((id) => groupOfType[id] === undefined);
    await pool(needT, 10, async (id) => {
      try { groupOfType[id] = (await esi(`/universe/types/${id}/`)).data.group_id; } catch { groupOfType[id] = 0; }
    });
    const needG = [...new Set(ids.map((id) => groupOfType[id]).filter((g) => g && (groupName[g] === undefined || catOfGroup[g] === undefined)))];
    await pool(needG, 10, async (g) => {
      try { const d = (await esi(`/universe/groups/${g}/`)).data; groupName[g] = d.name; catOfGroup[g] = d.category_id; }
      catch { groupName[g] = groupName[g] || ""; catOfGroup[g] = 0; }
    });
    const needC = [...new Set(ids.map((id) => catOfGroup[groupOfType[id]]).filter((c) => c && catName[c] === undefined))];
    await pool(needC, 5, async (c) => {
      try { catName[c] = (await esi(`/universe/categories/${c}/`)).data.name; } catch { catName[c] = ""; }
    });
    store.set("groupOfType", groupOfType);
    store.set("groupName", groupName);
    store.set("catOfGroup", catOfGroup);
    store.set("catName", catName);
  }

  async function volumes(ids) {
    const need = ids.filter((id) => volCache[id] === undefined);
    let done = 0;
    await pool(need, 10, async (id) => {
      try {
        const t = (await esi(`/universe/types/${id}/`)).data;
        volCache[id] = t.packaged_volume ?? t.volume ?? 0;
      } catch { volCache[id] = 0; }
      if (++done % 20 === 0) status(`Looking up item sizes: ${done} of ${need.length}…`, "busy");
    });
    store.set("volCache", volCache);
  }

  async function names(ids) {
    const need = ids.filter((id) => !nameCache[id]);
    for (const c of chunk(need, 1000)) {
      try {
        const r = await esi(`/universe/names/`, { method: "POST", body: c });
        r.data.forEach((n) => { nameCache[n.id] = n.name; });
      } catch {}
    }
    store.set("nameCache", nameCache);
  }

  async function dailyVolumes(ids, regionId) {
    if (histCache.region !== regionId || histCache.date !== today) histCache = { date: today, region: regionId, data: {} };
    const need = ids.filter((id) => histCache.data[id] === undefined);
    let done = 0;
    const cutoff = Date.now() - 30 * 86400000;
    await pool(need, 10, async (id) => {
      try {
        const h = (await esi(`/markets/${regionId}/history/?type_id=${id}`)).data;
        const recent = h.filter((d) => Date.parse(d.date) >= cutoff);
        histCache.data[id] = recent.reduce((a, d) => a + d.volume, 0) / 30;
      } catch { histCache.data[id] = 0; }
      if (++done % 10 === 0) status(`Checking how fast items sell: ${done} of ${need.length}…`, "busy");
    });
    histCache.region = regionId;
    store.set("histCache", histCache);
  }

  // ---------- analysis ----------
  function evaluate(typeId, h, j, vol) {
    const jSell = parseFloat(j && j.sell && j.sell.min) || 0;
    const jBuy = parseFloat(j && j.buy && j.buy.max) || 0;
    let cost, buyFee = 0;
    if (settings.buyHow === "order") {
      if (!jBuy) return null;
      cost = jBuy;
      buyFee = jitaBroker() * jBuy;
    } else {
      if (!jSell) return null;
      cost = jSell;
    }
    if (cost < settings.minPrice) return null;
    const haul = haulCost(vol, cost);
    const sell = h.sellMin;
    const sellFees = (hubBroker() + salesTax()) * sell;
    const profit = sell - sellFees - cost - buyFee - haul;
    const spent = cost + buyFee + haul;
    return {
      typeId, cost, jSell, jBuy, sell, haul, profit, roi: spent > 0 ? profit / spent : 0,
      vol: vol || 0, listed: h.sellQty, orders: h.sellOrders, hubBuy: h.buyMax,
      markup: cost > 0 ? sell / cost - 1 : 0,
    };
  }

  async function loadHubAgg() {
    status("Downloading hub orders…", "busy");
    const orders = await hubOrders(hub.id);
    const agg = new Map();
    for (const o of orders) {
      let a = agg.get(o.type_id);
      if (!a) { a = { sellMin: Infinity, sellQty: 0, sellOrders: 0, buyMax: 0, sellIds: [], sells: [] }; agg.set(o.type_id, a); }
      if (o.is_buy_order) { if (o.price > a.buyMax) a.buyMax = o.price; }
      else { a.sellQty += o.volume_remain; a.sellOrders++; a.sellIds.push(o.order_id); a.sells.push([o.price, o.volume_remain]); if (o.price < a.sellMin) a.sellMin = o.price; }
    }
    agg.orderCount = orders.length;
    return agg;
  }

  async function loadJita(typeIds) {
    const jita = {};
    const batches = chunk(typeIds, 200);
    let done = 0;
    await pool(batches, 4, async (b) => {
      const r = await fetch("/api/jita?types=" + b.join(","));
      if (!r.ok) throw new Error("Jita price lookup failed (" + r.status + "). Try again in a minute.");
      Object.assign(jita, await r.json());
      status(`Pulling Jita prices: ${++done} of ${batches.length}…`, "busy");
    });
    return jita;
  }

  function scanError(e) {
    console.error(e);
    if (e.status === 403) status("CCP refused the hub's market (403). Make sure this character can dock there and the structure's market is open to you.", "err");
    else if (e.status === 401) status("Your login expired. Log out and log in again.", "err");
    else status(e.message || String(e), "err");
  }

  async function scan() {
    if (!hub) return;
    $("scan").disabled = true;
    $("csv").disabled = true;
    try {
      const agg = await loadHubAgg();
      const typeIds = [...agg.keys()].filter((t) => agg.get(t).sellMin < Infinity);
      status(`Hub has ${intf(agg.orderCount)} orders across ${intf(typeIds.length)} items for sale. Pulling Jita prices…`, "busy");
      const jita = await loadJita(typeIds);

      // Pass 1: no hauling volume yet; keep anything that could clear the bar.
      let cands = typeIds
        .map((t) => evaluate(t, agg.get(t), jita[t], 0))
        .filter((r) => r && r.roi >= settings.minRoi / 100)
        .sort((a, b) => b.roi - a.roi)
        .slice(0, 400);

      // Pass 2: add item sizes for hauling cost.
      await volumes(cands.map((c) => c.typeId));
      cands = cands
        .map((c) => evaluate(c.typeId, agg.get(c.typeId), jita[c.typeId], volCache[c.typeId]))
        .filter((r) => r && r.roi >= settings.minRoi / 100)
        .sort((a, b) => b.profit * Math.min(b.listed, 50) - a.profit * Math.min(a.listed, 50))
        .slice(0, Math.max(10, Math.min(500, settings.maxRows * 2)));

      // Pass 3: how fast they sell.
      await dailyVolumes(cands.map((c) => c.typeId), hub.regionId);
      await names(cands.map((c) => c.typeId));
      cands.forEach((c) => {
        c.name = nameCache[c.typeId] || "Type " + c.typeId;
        c.daily = histCache.data[c.typeId] || 0;
        c.dayProfit = c.profit * c.daily;
        c.daysListed = c.daily > 0 ? c.listed / c.daily : Infinity;
      });
      results = cands.sort((a, b) => b.dayProfit - a.dayProfit).slice(0, settings.maxRows);

      $("sItems").textContent = intf(typeIds.length);
      $("sGood").textContent = intf(results.length);
      $("sTop").textContent = isk(results.slice(0, 10).reduce((a, r) => a + Math.max(0, r.dayProfit), 0));
      $("sTime").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      $("resultsPanel").classList.remove("hidden");
      sortKey = "dayProfit"; sortDir = -1;
      drawTable();
      $("csv").disabled = !results.length;
      status(results.length
        ? `Found ${results.length} imports at ${settings.minRoi}%+ return. Sorted by profit per day of trade volume.`
        : `No imports cleared ${settings.minRoi}% return. Try a lower minimum or check your fee settings.`, "ok");
    } catch (e) {
      scanError(e);
    } finally {
      $("scan").disabled = !hub || !token;
    }
  }

  // ---------- trading wallet balance ----------
  async function walletBalance() {
    const div = Math.min(7, Math.max(1, Math.round(settings.jCorpDiv || 1)));
    const cid = settings.jCorpChar && chars[settings.jCorpChar] ? settings.jCorpChar
      : (Object.values(chars).find((c) => hasWallet(c)) || {}).charId;
    if (!cid || !hasWallet(chars[cid])) return null;
    if (settings.jCorpWallet !== "on") {
      try { return { isk: (await esi(`/characters/${cid}/wallet/`, { auth: true, charId: cid })).data, where: chars[cid].name + "'s wallet" }; } catch { return null; }
    }
    const corpId = (await esi(`/characters/${cid}/`)).data.corporation_id;
    const w = (await esi(`/corporations/${corpId}/wallets/`, { auth: true, charId: cid })).data;
    const d = w.find((x) => x.division === div);
    return d ? { isk: d.balance, where: `corp wallet division ${div}` } : null;
  }

  // ---------- skills + open orders from the game ----------
  const SKILL_IDS = { trade: 3443, retail: 3444, wholesale: 16596, tycoon: 18580, acc: 16622, br: 3446, abr: 16597 };
  function traderChar() {
    const list = Object.values(chars).filter(hasSkills);
    return (settings.jCorpChar && chars[settings.jCorpChar] && hasSkills(chars[settings.jCorpChar])) ? chars[settings.jCorpChar] : list[0] || null;
  }
  async function syncFromGame(quiet = false) {
    const c = traderChar();
    if (!c) {
      $("syncLine").textContent = "Typed in by hand. To read these from the game, add your trading character on the Trade journal tab and click \"Allow skill access\".";
      return false;
    }
    try {
      const sk = (await esi(`/characters/${c.charId}/skills/`, { auth: true, charId: c.charId })).data.skills || [];
      const lvl = new Map(sk.map((x) => [x.skill_id, x.active_skill_level ?? x.trained_skill_level ?? 0]));
      for (const [k, id] of Object.entries(SKILL_IDS)) settings[k] = lvl.get(id) || 0;
      let open = settings.openOrders;
      if (hasOrders(c)) {
        try { open = (await esi(`/characters/${c.charId}/orders/`, { auth: true, charId: c.charId })).data.length; } catch {}
      }
      settings.openOrders = open;
      SETTING_IDS.forEach((k) => { const el = $(k); if (el) el.value = settings[k]; });
      store.set("settings", settings);
      markSettingsChanged();
      feeLine();
      $("syncLine").textContent = `Read from ${c.name} at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ` +
        `Trade ${settings.trade}, Retail ${settings.retail}, Wholesale ${settings.wholesale}, Tycoon ${settings.tycoon}, ` +
        `Accounting ${settings.acc}, Broker Relations ${settings.br}, Adv. Broker Relations ${settings.abr}; ${open} orders open.`;
      return true;
    } catch (e) {
      if (!quiet) status("Couldn't read skills from the game: " + e.message, "err");
      $("syncLine").textContent = `Couldn't read from ${c.name} (${e.message}). Using the values below.`;
      return false;
    }
  }

  // 30-day average price in the hub's region (what buyers there actually paid), cached for the day.
  let regionHist = store.get("regionHist", { date: "", region: 0, data: {} });
  async function regionAvg30(ids, regionId) {
    if (regionHist.date !== today || regionHist.region !== regionId) regionHist = { date: today, region: regionId, data: {} };
    const need = ids.filter((id) => regionHist.data[id] === undefined);
    let done = 0;
    await pool(need, 10, async (id) => {
      try {
        const h = (await esi(`/markets/${regionId}/history/?type_id=${id}`)).data;
        const cut = Date.now() - 30 * 86400000;
        const rec = h.filter((x) => Date.parse(x.date) >= cut);
        const vol = rec.reduce((a, x) => a + x.volume, 0);
        regionHist.data[id] = vol ? rec.reduce((a, x) => a + x.average * x.volume, 0) / vol : 0;
      } catch { regionHist.data[id] = 0; }
      if (++done % 20 === 0) status(`Checking recent prices for sold-out items: ${done} of ${need.length}…`, "busy");
    });
    try { store.set("regionHist", regionHist); } catch {}
    return regionHist.data;
  }

  // 30-day average Jita (The Forge) price per item, cached for the day.
  let jitaHist = store.get("jitaHist", { date: "", data: {} });
  async function jitaAvg30(ids) {
    if (jitaHist.date !== today) jitaHist = { date: today, data: {} };
    const need = ids.filter((id) => jitaHist.data[id] === undefined);
    await pool(need, 10, async (id) => {
      try {
        const h = (await esi(`/markets/${JITA_REGION}/history/?type_id=${id}`)).data;
        const cut = Date.now() - 30 * 86400000;
        const rec = h.filter((d) => Date.parse(d.date) >= cut);
        const vol = rec.reduce((a, d) => a + d.volume, 0);
        jitaHist.data[id] = vol ? rec.reduce((a, d) => a + d.average * d.volume, 0) / vol : 0;
      } catch { jitaHist.data[id] = 0; }
    });
    store.set("jitaHist", jitaHist);
    return jitaHist.data;
  }

  // ---------- doctrine list ----------
  let doctrine = null;       // parsed tracker rows
  let docResults = [];
  let docSort = { key: "totalProfit", dir: -1 };

  function parseNum(s) {
    s = String(s == null ? "" : s).trim().replace(/,/g, "").replace(/%$/, "");
    if (!s) return 0;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    const v = parseFloat(s);
    return isFinite(v) ? (neg ? -v : v) : 0;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
      else if (c !== "\r") f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function parseDoctrine(text) {
    const rows = parseCsv(text.replace(/^﻿/, ""));
    const hi = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "type id"));
    if (hi < 0) throw new Error("Couldn't find the 'Type ID' header. Is this the Doctrine Stock Tracker?");
    const h = rows[hi].map((c) => c.trim().toLowerCase());
    const col = (n) => h.indexOf(n);
    const c = { id: col("type id"), name: col("item"), stock: col("stock"), a7: col("7d avg"), a30: col("30d avg"), alert: col("alert"), cls: col("classification"), kind: col("class v2") };
    if ([c.id, c.name, c.stock, c.a7, c.a30].some((i) => i < 0)) throw new Error("The tracker is missing one of: Type ID, Item, Stock, 7D Avg, 30D Avg.");
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      const id = parseInt(r[c.id], 10);
      if (!id) continue;
      out.push({
        typeId: id,
        name: (r[c.name] || "").trim(),
        stock: parseNum(r[c.stock]),
        a7: parseNum(r[c.a7]),
        a30: parseNum(r[c.a30]),
        alert: c.alert >= 0 ? (r[c.alert] || "").trim() : "",
        cls: c.cls >= 0 ? (r[c.cls] || "").trim() : "",
        kind: c.kind >= 0 ? (r[c.kind] || "").trim() : "",
      });
    }
    if (!out.length) throw new Error("No item rows found in the tracker.");
    return out;
  }

  function setDoctrine(text, label) {
    doctrine = parseDoctrine(text);
    const seed = doctrine.filter((d) => d.cls === "Seeding" || !d.cls).length;
    const src = { label, at: new Date().toLocaleString(), count: doctrine.length, seed, noCls: doctrine.every((d) => !d.cls) };
    try { localStorage.setItem("doctrineCsv", text); } catch {}
    store.set("doctrineSrc", src);
    markSettingsChanged();
    showDocSource(src);
    renderDocButtons();
    status(`Loaded ${intf(doctrine.length)} tracker items (${intf(seed)} Seeding). Click "Build import list".`, "ok");
  }

  function showDocSource(src) {
    $("docSource").textContent = src
      ? `Loaded ${intf(src.count)} items ` + (src.noCls ? "(no Seeding/Industry column, so all are included)" : `(${intf(src.seed)} Seeding)`) + ` from ${src.label} · ${src.at}`
      : "No tracker loaded yet.";
  }

  function renderDocButtons() {
    $("docRun").disabled = !doctrine || !hub || !token;
    $("docMulti").disabled = !docResults.length;
    $("docCsv").disabled = !docResults.length;
  }

  async function runDoctrine() {
    if (!doctrine || !hub) return;
    $("docRun").disabled = true;
    try {
      status("Reading your skills and open orders…", "busy");
      await syncFromGame(true);
      let budget = settings.dBudget, budgetNote = "";
      if (settings.dBudgetMode === "wallet") {
        try {
          const wb = await walletBalance();
          if (wb) {
            budget = Math.max(0, wb.isk * (1 - (settings.dReserve || 0) / 100) - (settings.haulExpress || 0));
            budgetNote = `Budget ${isk(budget)}: ${wb.where} holds ${isk(wb.isk)}, minus ${settings.dReserve}% kept for listing fees` + (settings.haulExpress ? ` and the ${isk(settings.haulExpress)} express fee` : "") + ". ";
          } else budgetNote = `Couldn't read your wallet, so the fixed budget of ${isk(budget)} was used. `;
        } catch (e) {
          budgetNote = e.status === 403 ? "Wallet balance needs the Accountant role; the fixed budget was used. " : `Wallet balance: ${e.message}; the fixed budget was used. `;
        }
      }
      const pick = settings.dDemand;
      // Restock mode: what sold at the hub since your last haul goes first, at least as many as sold.
      const restock = new Map();
      let restockNote = "", restockDays = 1;
      if (settings.dPriority === "restock") {
        status("Reading what you sold since your last haul…", "busy");
        try {
          await runJournal({ show: false });
          const hs = (jRaw.hauls || []).filter((h) => h.start_location_id === JITA_STATION && h.end_location_id === hub.id && h.status !== "deleted" && h.status !== "rejected");
          const last = hs.reduce((m, h) => Math.max(m, Date.parse(h.date_issued) || 0), 0) || PROJECT_START;
          jRaw.tx.forEach((t) => {
            if (!t.is_buy && t.location_id === hub.id && Date.parse(t.date) >= last) restock.set(t.type_id, (restock.get(t.type_id) || 0) + t.quantity);
          });
          restockDays = Math.max(1, (Date.now() - last) / 86400000);
          restockNote = `Restocking ${restock.size} item${restock.size === 1 ? "" : "s"} sold since your last haul (${new Date(last).toLocaleString()}). `;
        } catch (e) {
          restockNote = "Couldn't read your sales for restocking (" + e.message + "). ";
        }
      }

      const inTracker = new Set(doctrine.map((d) => d.typeId));
      let items = doctrine
        .filter((d) => settings.dClasses === "all" || d.cls === "Seeding" || !d.cls || restock.has(d.typeId))
        .map((d) => {
          const demand = pick === "a7" ? d.a7 : pick === "max" ? Math.max(d.a7, d.a30) : (d.a30 || d.a7);
          const sold = restock.get(d.typeId) || 0;
          const need = Math.max(Math.ceil(settings.dDays * demand - d.stock), sold);
          return { ...d, demand, need, sold, daysLeft: demand > 0 ? d.stock / demand : Infinity };
        })
        .filter((d) => d.need > 0);
      // Items you sold that aren't on the tracker: restock what sold.
      restock.forEach((sold, typeId) => {
        if (inTracker.has(typeId)) return;
        items.push({ typeId, name: "", stock: 0, a7: 0, a30: 0, alert: "", cls: "Restock", kind: "", demand: sold / restockDays, need: sold, sold, daysLeft: Infinity });
      });

      // Leave out slow sellers.
      let slowCount = 0;
      if (settings.dMinDaily > 0) {
        const before = items.length;
        items = items.filter((d) => d.demand >= settings.dMinDaily);
        slowCount = before - items.length;
      }

      // Leave out item categories/groups you don't import (minerals, ore, ice, PI…).
      let excludedCount = 0;
      if (String(settings.dExclude || "").trim() && items.length) {
        status("Checking item categories…", "busy");
        await groups(items.map((d) => d.typeId));
        const before = items.length;
        items = items.filter((d) => !inGroups(d.typeId, settings.dExclude));
        excludedCount = before - items.length;
      }
      if (!items.length) { status(excludedCount || slowCount ? `Nothing left after filters: ${slowCount} sell under ${settings.dMinDaily}/day, ${excludedCount} are in categories you don't import.` : "Nothing on the tracker is short for that many days. Try more days to cover.", "ok"); return; }

      const agg = await loadHubAgg();

      // Leave out items where others already have several sell orders up (your own orders don't count).
      let crowdedCount = 0;
      if (settings.dMaxSellers > 0) {
        const myIds = new Set();
        try { (await myOpenOrders()).orders.forEach((o) => myIds.add(o.order_id)); } catch {}
        const before = items.length;
        items = items.filter((d) => {
          const h = agg.get(d.typeId);
          const others = h ? h.sellIds.filter((id) => !myIds.has(id)).length : 0;
          d.otherOrders = others;
          return others < settings.dMaxSellers;
        });
        crowdedCount = before - items.length;
        if (!items.length) { status(`Nothing left: ${crowdedCount} short items already have ${settings.dMaxSellers}+ other sell orders at the hub.`, "ok"); return; }
      }
      // Leave out items the hub already has plenty of: listed units (everyone's, yours included) / daily sales.
      // Only listings priced near the lowest count: overpriced ones aren't competing for buyers.
      let stockedCount = 0;
      const stockedNames = [];
      if (settings.dMaxStockDays > 0) {
        const before = items.length;
        const band = 1 + Math.max(0, settings.dStockBand || 0) / 100;
        items = items.filter((d) => {
          const h = agg.get(d.typeId);
          const listed = h ? h.sells.filter(([p]) => p <= h.sellMin * band).reduce((a, [, q]) => a + q, 0) : 0;
          d.listedDays = listed === 0 ? 0 : d.demand > 0 ? listed / d.demand : Infinity;
          const keep = d.listedDays <= settings.dMaxStockDays;
          if (!keep) stockedNames.push(`${d.name || nameCache[d.typeId] || "Type " + d.typeId} (${isFinite(d.listedDays) ? d.listedDays.toFixed(1) : "∞"}d)`);
          return keep;
        });
        stockedCount = before - items.length;
        if (!items.length) { status(`Nothing left: every short item already has more than ${settings.dMaxStockDays} days of stock listed at the hub.`, "ok"); return; }
      }
      status(`${intf(items.length)} tracker items are short. Pulling Jita prices…`, "busy");
      const jita = await loadJita(items.map((d) => d.typeId));
      await volumes(items.map((d) => d.typeId));

      const tax = salesTax(), bfH = hubBroker(), bfJ = jitaBroker();
      const minRoi = settings.dMinRoi / 100;
      const k = 1 - Math.min(100, Math.max(0, settings.haulDisc || 0)) / 100;   // hauling discount factor
      const priced = [], skipped = { noJita: 0, lowRoi: 0, thin: 0, lowProfit: 0, slots: 0, budget: 0, spike: 0 }, spikeNames = [];

      // Sold-out items: what they actually sold for in the hub's region over 30 days (caps the markup guess).
      const soldOutIds = items.filter((d) => { const h = agg.get(d.typeId); return !(h && h.sellMin < Infinity); }).map((d) => d.typeId);
      const hubAvg = soldOutIds.length ? (status(`Checking recent prices for ${soldOutIds.length} sold-out items…`, "busy"), await regionAvg30(soldOutIds, hub.regionId)) : {};

      // Pass 1: screen on Jita's best price.
      const screened = [];
      for (const d of items) {
        const j = jita[d.typeId];
        const jSell = parseFloat(j && j.sell && j.sell.min) || 0;
        const jBuy = parseFloat(j && j.buy && j.buy.max) || 0;
        const best = settings.buyHow === "order" ? jBuy : jSell;
        if (!best) { skipped.noJita++; continue; }
        const h = agg.get(d.typeId);
        const hubSell = h && h.sellMin < Infinity ? h.sellMin : null;
        const guess = jSell * settings.dMarkup / 100 || best * settings.dMarkup / 100;
        const hist = hubAvg[d.typeId] || 0;
        const sell = hubSell !== null ? hubSell : (hist > 0 ? Math.min(guess, hist) : guess);
        const vol = volCache[d.typeId] || 0;
        const buyFee = settings.buyHow === "order" ? bfJ * best : 0;
        const spend = best + buyFee + haulCost(vol, best);
        const profit = sell * (1 - bfH - tax) - spend;
        if (spend <= 0 || profit / spend < minRoi) { skipped.lowRoi++; continue; }
        screened.push({ d, h, hubSell, sell, vol, best, hist });
      }

      // Pass 2: walk Jita 4-4's real sell orders (buy-now mode) so big quantities
      // are priced the way Multibuy prices them. Stop before any unit that would
      // drop below the minimum return.
      let doneBooks = 0;
      await pool(screened, 8, async (c) => {
        const { d, h, hubSell, sell, vol, best, hist } = c;
        const net = sell * (1 - bfH - tax);                     // ISK you keep per unit sold
        const fixedHaul = k * settings.haulRate * vol;          // per-unit hauling that doesn't depend on price
        const collRate = k * settings.coll / 100;               // per-unit collateral share of price
        const cap = settings.dItemCap > 0 ? settings.dItemCap : Infinity;
        let qty = 0, itemCost = 0, worst = best;

        if (settings.buyHow === "order") {
          const unit = best * (1 + bfJ) + fixedHaul + collRate * best;
          qty = Math.min(d.need, Math.floor(cap / unit));
          itemCost = qty * best * (1 + bfJ);
        } else {
          let book = [];
          try {
            const r = await esi(`/markets/${JITA_REGION}/orders/?order_type=sell&type_id=${d.typeId}`);
            book = r.data.filter((o) => o.location_id === JITA_STATION).sort((a, b) => a.price - b.price);
          } catch { book = []; }
          const maxPrice = (net / (1 + minRoi) - fixedHaul) / (1 + collRate);
          let spent = 0;
          for (const o of book) {
            if (qty >= d.need || o.price > maxPrice) break;
            const unit = o.price * (1 + collRate) + fixedHaul;
            let take = Math.min(o.volume_remain, d.need - qty);
            if (spent + take * unit > cap) take = Math.floor((cap - spent) / unit);
            if (take <= 0) break;
            qty += take; itemCost += take * o.price; spent += take * unit; worst = o.price;
          }
        }
        status(`Checking Jita order depth: ${++doneBooks} of ${screened.length}…`, "busy");
        if (qty <= 0) { skipped.thin++; return; }

        const cost = itemCost / qty;                               // average price paid per unit
        // Highest average unit price that still clears the minimum return.
        const feeMult = settings.buyHow === "order" ? 1 + bfJ : 1;
        const maxAvg = (net / (1 + minRoi) - fixedHaul) / (feeMult + collRate);
        const payMax = Math.min(cost * (1 + settings.dTol / 100), maxAvg);
        const unitSpend = cost + fixedHaul + collRate * cost;
        const profit = net - unitSpend;
        const roi = profit / unitSpend;
        if (qty * profit < settings.dMinProfit) { skipped.lowProfit++; return; }
        priced.push({
          ...d, cost, best, worst, sell, est: hubSell === null, hist, maxAvg, payMax,
          hubListed: h ? h.sellQty : 0, hubSellers: h ? h.sellOrders : 0,
          vol, unitSpend, profit, roi, qty, short: qty < d.need,
        });
      });

      // Jita price spike check: compare what you'd pay with the 30-day Jita average.
      if (settings.dSpike > 0 && priced.length) {
        status("Checking Jita prices against their 30-day average…", "busy");
        const avgs = await jitaAvg30(priced.map((p) => p.typeId));
        for (let i = priced.length - 1; i >= 0; i--) {
          const p = priced[i], a = avgs[p.typeId];
          if (!a) continue;
          p.avg30 = a;
          p.spike = p.cost / a - 1;
          if (p.spike > settings.dSpike / 100 && settings.dSpikeAct === "skip") { priced.splice(i, 1); skipped.spike = (skipped.spike || 0) + 1; spikeNames.push(p.name || nameCache[p.typeId] || "Type " + p.typeId); }
        }
      }

      // Fill best-first by total profit until budget / cargo runs out.
      const soldFirst = settings.dPriority === "soldout" || settings.dPriority === "restock";
      const restockFirst = settings.dPriority === "restock";
      priced.sort((a, b) =>
        (restockFirst && !!a.sold !== !!b.sold ? (a.sold ? -1 : 1) : 0) ||
        (soldFirst && a.est !== b.est ? (a.est ? -1 : 1) : 0) ||
        (b.profit * b.qty - a.profit * a.qty));
      let budgetLeft = budget > 0 ? budget : Infinity;
      let cargoLeft = settings.dCargo > 0 ? settings.dCargo : Infinity;
      const maxItems = freeSlots();
      docResults = [];
      for (const p of priced) {
        if (docResults.length >= maxItems) { skipped.slots++; continue; }
        let q = Math.min(p.qty, Math.floor(budgetLeft / p.unitSpend));
        if (p.vol > 0) q = Math.min(q, Math.floor(cargoLeft / p.vol));
        if (q <= 0) { skipped.budget++; continue; }
        if (q * p.profit < settings.dMinProfit) { skipped.lowProfit++; continue; }
        p.qty = q;
        p.totalSpend = q * p.unitSpend;
        p.totalM3 = q * p.vol;
        p.totalProfit = q * p.profit;
        p.rank = docResults.length + 1;
        budgetLeft -= p.totalSpend;
        cargoLeft -= p.totalM3;
        docResults.push(p);
      }

      await names(docResults.map((r) => r.typeId));
      docResults.forEach((r) => { if (!r.name) r.name = nameCache[r.typeId] || "Type " + r.typeId; });

      const sum = (k) => docResults.reduce((a, r) => a + r[k], 0);
      const bits = [];
      if (skipped.noJita) bits.push(`${skipped.noJita} have no Jita price`);
      if (skipped.lowRoi) bits.push(`${skipped.lowRoi} are under ${settings.dMinRoi}% return`);
      if (stockedCount) bits.push(`${stockedCount} already have more than ${settings.dMaxStockDays} days of competitively priced stock listed at the hub (${stockedNames.slice(0, 8).join(", ")}${stockedNames.length > 8 ? "…" : ""})`);
      if (crowdedCount) bits.push(`${crowdedCount} already have ${settings.dMaxSellers} or more other sell orders at the hub`);
      if (slowCount) bits.push(`${slowCount} sell fewer than ${settings.dMinDaily} a day`);
      if (excludedCount) bits.push(`${excludedCount} are in categories you don't import (${settings.dExclude})`);
      if (skipped.spike) bits.push(`${skipped.spike} skipped because Jita is more than ${settings.dSpike}% above its 30-day average right now (${spikeNames.slice(0, 6).join(", ")}${spikeNames.length > 6 ? "…" : ""})`);
      if (skipped.thin) bits.push(`${skipped.thin} have no Jita 4-4 sell orders cheap enough to clear ${settings.dMinRoi}%`);
      if (skipped.lowProfit) bits.push(`${skipped.lowProfit} would make under ${isk(settings.dMinProfit)} in total`);
      if (skipped.slots) bits.push(`${skipped.slots} more were cut because you have ${maxItems} free order slots`);
      if (skipped.budget) bits.push(`${skipped.budget} didn't fit the budget or cargo`);
      $("dSkipped").textContent = bits.length ? "Left out: " + bits.join(", ") + "." : "";
      $("docResults").classList.remove("hidden");
      docSort = { key: "rank", dir: 1 };
      drawDocTable();
      status(budgetNote + restockNote + (docResults.length
        ? `Buy list ready: ${docResults.length} items, ${isk(sum("totalSpend"))} to spend, about ${isk(sum("totalProfit"))} profit.`
        : "No short items cleared your minimum return. Try a lower minimum or a higher sold-out markup."), "ok");
    } catch (e) {
      scanError(e);
    } finally {
      renderDocButtons();
    }
  }

  const visibleDocRows = () => (settings.dShow === "soldout" ? docResults.filter((r) => r.est) : docResults);

  function docSummary() {
    const rows = visibleDocRows();
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const m3 = sum("totalM3");
    const contracts = rows.length ? Math.max(1, Math.ceil(m3 / JF_CARGO)) : 0;
    const express = contracts * (settings.haulExpress || 0);
    $("dItems").textContent = intf(rows.length);
    const jitaTotal = rows.reduce((t, r) => t + r.qty * r.cost, 0);
    $("dJita").textContent = isk(jitaTotal);
    $("dMaxJita").textContent = isk(rows.reduce((t, r) => t + r.qty * r.payMax, 0));
    $("dHaul").textContent = isk(sum("totalSpend") - jitaTotal + express);
    $("dHaulNote").textContent = express ? `incl. ${isk(express)} express (${contracts} contract${contracts === 1 ? "" : "s"})` : "";
    $("dSpend").textContent = isk(sum("totalSpend") + express);
    $("dM3").textContent = intf(sum("totalM3")) + " m³";
    $("dProfit").textContent = isk(sum("totalProfit") - express);
    const so = docResults.filter((r) => r.est);
    $("dSoldOut").textContent = so.length
      ? `${so.length} item${so.length === 1 ? " is" : "s are"} sold out at the Keepstar, so you'd be the only seller (${isk(so.reduce((a, r) => a + r.totalProfit, 0))} of the expected profit).`
      : "Nothing on this list is sold out at the Keepstar.";
  }

  const DOC_COLS = [
    { k: "rank", label: "#", f: intf },
    { k: "name", label: "Item" },
    { k: "cls", label: "Type" },
    { k: "hubListed", label: "Hub listed / sellers" },
    { k: "demand", label: "Sold / day", f: (v) => (v >= 100 ? intf(v) : v.toFixed(1)) },
    { k: "daysLeft", label: "Days left", f: (v) => (isFinite(v) ? v.toFixed(1) : "–") },
    { k: "need", label: "Short by", f: intf },
    { k: "cost", label: "Jita avg cost", f: isk },
    { k: "payMax", label: "Pay at most", f: isk },
    { k: "sell", label: "Hub sell", f: isk },
    { k: "roi", label: "Return", f: pct },
    { k: "qty", label: "Buy", f: intf },
    { k: "totalSpend", label: "ISK", f: isk },
    { k: "totalM3", label: "m³", f: (v) => (v >= 100 ? intf(v) : v.toFixed(1)) },
    { k: "totalProfit", label: "Profit", f: isk },
  ];

  const docCols = () => DOC_COLS.filter((c) => c.k !== "cls" || settings.dClasses === "all" || settings.dPriority === "restock");

  function drawDocTable() {
    const cols = docCols();
    const tr = $("dThead");
    tr.innerHTML = "";
    cols.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c.label;
      th.tabIndex = 0;
      if (c.k === "name") th.className = "name";
      if (c.k === docSort.key) th.setAttribute("aria-sort", docSort.dir < 0 ? "descending" : "ascending");
      const go = () => {
        if (docSort.key === c.k) docSort.dir = -docSort.dir;
        else docSort = { key: c.k, dir: ["rank", "name", "cls", "daysLeft", "hubListed"].includes(c.k) ? 1 : -1 };
        drawDocTable();
      };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      tr.appendChild(th);
    });

    docSummary();
    const { key, dir } = docSort;
    const rows = [...visibleDocRows()].sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "string") return dir * x.localeCompare(y);
      return dir * ((isFinite(x) ? x : 1e18) - (isFinite(y) ? y : 1e18));
    });

    const tb = $("dTbody");
    tb.innerHTML = "";
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const row = document.createElement("tr");
      cols.forEach((c) => {
        const td = document.createElement("td");
        if (c.k === "name") {
          td.className = "name";
          td.textContent = r.name;
          if (r.sold) { const e = document.createElement("span"); e.className = "est"; e.style.color = "var(--good)"; e.textContent = `SOLD ${intf(r.sold)}`; e.title = "Sold since your last haul"; td.appendChild(e); }
        } else if (c.k === "cls") {
          const s = document.createElement("span");
          s.className = "cls" + (r.cls === "Seeding" ? " seed" : "");
          s.textContent = r.cls || "?";
          if (r.kind) s.title = r.kind;
          td.appendChild(s);
        } else if (c.k === "hubListed") {
          if (r.est) {
            const s = document.createElement("span");
            s.className = "chip good";
            s.textContent = "SOLD OUT";
            s.title = "No sell orders at the Keepstar. You'd be the only seller.";
            td.appendChild(s);
          } else {
            td.textContent = `${intf(r.hubListed)} / ${r.hubSellers}`;
            td.title = `${intf(r.hubListed)} units listed by ${r.hubSellers} seller${r.hubSellers === 1 ? "" : "s"}`;
            if (r.hubSellers <= 2) td.className = "pos";
          }
        } else if (c.k === "roi") {
          const s = document.createElement("span");
          s.className = "chip " + (r.roi >= 0.2 ? "good" : r.roi >= 0.1 ? "warn" : "bad");
          s.textContent = pct(r.roi);
          td.appendChild(s);
        } else if (c.k === "sell") {
          td.textContent = isk(r.sell);
          if (r.est) {
            const e = document.createElement("span"); e.className = "est"; e.textContent = "EST"; td.appendChild(e);
            td.title = r.hist ? `Sold out at the hub. Estimated from the 30-day ${hub.region} average (${isk(r.hist)}) or your ${settings.dMarkup}% markup, whichever is lower.` : `Sold out at the hub and no recent sales history: your ${settings.dMarkup}% markup on Jita.`;
          }
        } else {
          td.textContent = c.f(r[c.k]);
          if (c.k === "totalProfit") td.className = r.totalProfit >= 0 ? "pos" : "neg";
          if (c.k === "daysLeft" && r.daysLeft < 3) td.className = "neg";
          if (c.k === "payMax") {
            td.className = "pay";
            td.title = r.payMax < r.cost * (1 + settings.dTol / 100) - 0.5
              ? `Capped by your ${settings.dMinRoi}% minimum return. Expected ${isk(r.cost)}; above ${isk(r.payMax)} each, this item isn't worth it.`
              : `Expected ${isk(r.cost)} + ${settings.dTol}% allowance. Your ${settings.dMinRoi}% return still holds up to ${isk(r.maxAvg)} each.`;
          }
          if (c.k === "cost") {
            td.title = `Average over the orders you'd buy. Cheapest ${isk(r.best)}, most expensive ${isk(r.worst)}.` +
              (r.avg30 ? ` 30-day Jita average ${isk(r.avg30)} (${r.spike >= 0 ? "+" : ""}${(r.spike * 100).toFixed(0)}%).` : "");
            if (r.spike > settings.dSpike / 100) {
              const ch = document.createElement("span");
              ch.className = "chip orange"; ch.style.marginLeft = "4px";
              ch.textContent = `+${(r.spike * 100).toFixed(0)}%`;
              ch.title = "Jita is above its 30-day average right now";
              td.appendChild(ch);
            }
          }
          if (c.k === "qty" && r.short) { td.title = `Short by ${intf(r.need)}, but only ${intf(r.qty)} are cheap enough in Jita (or your per-item cap stopped it).`; td.className = "warnc"; }
          if (c.k === "demand") td.title = `7-day avg ${r.a7.toFixed(1)} / day · 30-day avg ${r.a30.toFixed(1)} / day`;
        }
        row.appendChild(td);
      });
      frag.appendChild(row);
    });
    tb.appendChild(frag);
  }

  async function copyMultibuy() {
    const text = visibleDocRows().map((r) => `${r.name}\t${r.qty}`).join("\n");
    const btn = $("docMulti");
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied!";
      status(`Copied ${docResults.length} lines. In Jita, open the market's Multibuy window and paste.`, "ok");
    } catch {
      btn.textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.textContent = "Copy for Multibuy"), 1500);
  }

  function downloadDocCsv() {
    const head = ["type_id", "Item", "Type", "Hub units listed", "Hub sellers", "Sells per day", "7D avg", "30D avg", "Days left", "Short by", "Jita avg cost", "Pay at most", "Hub sell", "Hub price estimated", "Return", "Buy qty", "ISK", "m3", "Profit"];
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [head.join(",")];
    visibleDocRows().forEach((r) => {
      lines.push([r.typeId, q(r.name), q(r.cls), r.hubListed, r.hubSellers, r.demand.toFixed(2), r.a7, r.a30, isFinite(r.daysLeft) ? r.daysLeft.toFixed(2) : "", r.need,
        Math.round(r.cost), Math.round(r.payMax), Math.round(r.sell), r.est ? "yes" : "no", r.roi.toFixed(4), r.qty,
        Math.round(r.totalSpend), r.totalM3.toFixed(2), Math.round(r.totalProfit)].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `doctrine-buy-list-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function loadSheetUrl() {
    const url = $("docUrl").value.trim();
    if (!url) { status("Paste the Google Sheets link first.", "err"); return; }
    store.set("docUrl", url);
    status("Loading the sheet…", "busy");
    try {
      const r = await fetch("/api/sheet?url=" + encodeURIComponent(url));
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "Couldn't load the sheet (" + r.status + ")."); }
      setDoctrine(await r.text(), "Google Sheet");
    } catch (e) { status(e.message, "err"); }
  }

  function setTab(which) {
    if (!["doc", "scan", "journal", "sell", "orders", "liq", "rep"].includes(which)) which = "doc";
    const doc = which === "doc", scanT = which === "scan", jr = which === "journal", sl = which === "sell";
    $("tabDoc").setAttribute("aria-pressed", String(doc));
    $("tabScan").setAttribute("aria-pressed", String(scanT));
    $("tabJournal").setAttribute("aria-pressed", String(jr));
    $("tabSell").setAttribute("aria-pressed", String(sl));
    const rp = which === "rep";
    $("tabRep").setAttribute("aria-pressed", String(rp));
    $("rPanel").classList.toggle("hidden", !rp);
    $("rResults").classList.toggle("hidden", !rp || !rRows.length);
    const lq = which === "liq";
    $("tabLiq").setAttribute("aria-pressed", String(lq));
    $("lPanel").classList.toggle("hidden", !lq);
    $("lResults").classList.toggle("hidden", !lq || !lRows.length);
    const oc = which === "orders";
    $("tabOrders").setAttribute("aria-pressed", String(oc));
    $("oPanel").classList.toggle("hidden", !oc);
    $("oResults").classList.toggle("hidden", !oc || !oRows.length);
    $("sPanel").classList.toggle("hidden", !sl);
    $("sResults").classList.toggle("hidden", !sl || !sRows.length);
    $("docPanel").classList.toggle("hidden", !doc);
    $("docResults").classList.toggle("hidden", !doc || !docResults.length);
    $("scanPanel").classList.toggle("hidden", !scanT);
    $("resultsPanel").classList.toggle("hidden", !scanT || !results.length);
    $("jPanel").classList.toggle("hidden", !jr);
    $("jResults").classList.toggle("hidden", !jr || !jRows.length);
    store.set("tab", which);
  }

  // ---------- cloud (D1) ----------
  // The delivery-alert registration (char + key) is the account for cloud history and settings.
  const cloudAuth = () => store.get("alerts", null);
  const cloudQs = (a) => `char=${a.char}&key=${encodeURIComponent(a.key)}`;
  let cloudTimer = null;

  function markSettingsChanged() {
    store.set("settingsUpdated", new Date().toISOString());
    const a = cloudAuth();
    if (!a) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(pushSettings, 2500);
  }

  async function pushSettings() {
    const a = cloudAuth();
    if (!a) return;
    let csv = null;
    try { csv = localStorage.getItem("doctrineCsv"); } catch {}
    const data = { settings, hub, doctrineCsv: csv, doctrineSrc: store.get("doctrineSrc", null), docUrl: store.get("docUrl", "") };
    try {
      const r = await fetch(`/api/data/settings?${cloudQs(a)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
      const j = await r.json();
      if (r.ok && j.updated) store.set("settingsUpdated", j.updated);
    } catch {}
  }

  async function pullSettings() {
    const a = cloudAuth();
    if (!a) return false;
    try {
      const r = await fetch(`/api/data/settings?${cloudQs(a)}`);
      if (!r.ok) return false;
      const j = await r.json();
      const local = store.get("settingsUpdated", "");
      if (!j.data) { pushSettings(); return false; }          // first time: upload this device's settings
      if (local && j.updated <= local) return false;           // this device is newer or the same
      Object.assign(settings, j.data.settings || {});
      store.set("settings", settings);
      if (j.data.hub) { hub = j.data.hub; store.set("hub", hub); }
      if (j.data.doctrineCsv) {
        try { localStorage.setItem("doctrineCsv", j.data.doctrineCsv); } catch {}
        store.set("doctrineSrc", j.data.doctrineSrc || null);
      }
      if (j.data.docUrl) store.set("docUrl", j.data.docUrl);
      store.set("settingsUpdated", j.updated);
      SETTING_IDS.forEach((k) => { const el = $(k); if (el) el.value = settings[k]; });
      feeLine();
      restoreDoctrine();
      return true;
    } catch { return false; }
  }

  async function cloudTrades(since) {
    const a = cloudAuth();
    if (!a) return null;
    const r = await fetch(`/api/data/trades?${cloudQs(a)}&since=${encodeURIComponent(new Date(since).toISOString())}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "Cloud history " + r.status); e.status = r.status; throw e; }
    return j;
  }

  // ---------- delivery alerts ----------
  async function finishAlerts(code, saved) {
    store.set("tab", "journal");
    status("Turning on delivery alerts…", "busy");
    const r = await fetch("/api/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: saved.verifier, client_id: CFG.CLIENT_ID, webhook: saved.webhook, corp: saved.corp === "on" }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.key) { store.set("alerts", { char: j.char, key: j.key, name: j.name }); pushSettings(); }
    if (!r.ok || j.error) throw new Error(j.error || "Couldn't turn on alerts (" + r.status + ").");
    status(`Delivery alerts are on for ${j.name}. Check your Discord channel for the test message.`, "ok");
  }

  async function alertsOn() {
    const webhook = $("aWebhook").value.trim();
    if (!/^https:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\//.test(webhook)) {
      status("Paste your Discord webhook link first (Server Settings → Integrations → Webhooks → Copy Webhook URL).", "err");
      return;
    }
    store.set("aWebhook", webhook);
    await login("alerts", { webhook, corp: $("aCorp").value });
  }

  async function alertsOff() {
    const a = store.get("alerts", null);
    if (!a) return;
    try { await fetch(`/api/watch?char=${a.char}&key=${encodeURIComponent(a.key)}`, { method: "DELETE" }); } catch {}
    store.del("alerts");
    renderAlerts();
    status("Delivery alerts turned off.", "ok");
  }

  const STATUS_TEXT = {
    outstanding: "Waiting for a hauler", in_progress: "Picked up (in transit)", finished: "Delivered",
    failed: "Failed", rejected: "Rejected", deleted: "Deleted", cancelled: "Cancelled", expired: "Expired",
  };
  function placeLabel(id) {
    if (!id) return "?";
    if (id === JITA_STATION) return "Jita 4-4";
    if (hub && id === hub.id) return hub.system || hub.name;
    return "Location " + id;
  }
  function drawWatched(list, lastCheck) {
    const box = $("aList");
    box.innerHTML = "";
    if (!lastCheck) return;
    if (!list.length) {
      box.innerHTML = '<p class="hint">No courier contracts found for this character or its corp right now. If you have one in transit, check you logged in with the character that issued it, or one in the same corp with "Character + corp" selected.</p>';
      return;
    }
    const t = document.createElement("table");
    t.innerHTML = "<thead><tr><th class='name'>Route</th><th>Status</th><th>Volume</th><th>Collateral</th><th>Reward</th><th>Issued</th><th>Contract</th></tr></thead>";
    const tb = document.createElement("tbody");
    list.forEach((c) => {
      const tr = document.createElement("tr");
      const cells = [
        c.start_location_id ? `${placeLabel(c.start_location_id)} → ${placeLabel(c.end_location_id)}` : "(details after the next check)",
        STATUS_TEXT[c.status] || c.status,
        c.volume ? intf(c.volume) + " m³" : "–",
        c.collateral ? isk(c.collateral) : "–",
        c.reward ? isk(c.reward) : "–",
        c.date_issued ? new Date(c.date_issued).toLocaleString() : "–",
        String(c.contract_id),
      ];
      cells.forEach((v, i) => {
        const td = document.createElement("td");
        if (i === 0) td.className = "name";
        if (i === 1) {
          const sp = document.createElement("span");
          sp.className = "chip " + (c.status === "finished" ? "good" : c.status === "in_progress" || c.status === "outstanding" ? "warn" : "bad");
          sp.textContent = v;
          td.appendChild(sp);
        } else td.textContent = v;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    const wrap = document.createElement("div");
    wrap.className = "tablewrap watched";
    wrap.appendChild(t);
    const cap = document.createElement("p");
    cap.className = "hint";
    cap.textContent = `Courier contracts the worker is watching (${list.length}). You'll get a Discord message when any of these changes status.`;
    box.append(cap, wrap);
  }

  async function renderAlerts() {
    const a = store.get("alerts", null);
    $("aWebhook").value = store.get("aWebhook", "");
    $("aOff").classList.toggle("hidden", !a);
    $("aOn").textContent = a ? "Turn on again / change" : "Turn on alerts";
    $("aList").innerHTML = "";
    if (!a) { $("aState").textContent = "Alerts are off."; return; }
    $("aState").textContent = `Alerts are on for ${a.name}. Checking status…`;
    try {
      const r = await fetch(`/api/watch?char=${a.char}&key=${encodeURIComponent(a.key)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      if (!j.on) { $("aState").textContent = "Alerts are off (the server doesn't have them any more). Turn them on again."; return; }
      $("aState").textContent = `Alerts are on for ${j.name}${j.corp ? " (character + corp contracts)" : ""}. ` +
        (j.lastCheck ? `Last check ${new Date(j.lastCheck).toLocaleString()}, watching ${j.tracking} courier contract${j.tracking === 1 ? "" : "s"}.` : "Waiting for the first check (runs every 10 minutes).") +
        (j.lastError ? ` Last problem: ${j.lastError}` : "") +
        (j.cloud
          ? (j.lastArchive ? ` Cloud history: wallets last copied ${new Date(j.lastArchive).toLocaleString()} (${(j.sources || []).join(", ") || "none yet"}).` : " Cloud history: first wallet copy happens on the next check.") +
            (j.archiveError ? ` Cloud problem: ${j.archiveError}` : "")
          : " Cloud history isn't set up yet (see README).");
      drawWatched(j.contracts || [], j.lastCheck);
    } catch (e) {
      $("aState").textContent = `Alerts were turned on for ${a.name}, but I couldn't check their status (${e.message}).`;
    }
  }

  // ---------- trade journal ----------
  let jRows = [];
  let jRaw = { tx: [], hauls: [], journal: [] };   // last journal read: unique transactions + courier contracts
  let jSort = { key: "profit", dir: -1 };

  function renderChars() {
    const box = $("jChars");
    if (!box) return;
    box.innerHTML = "";
    const list = Object.values(chars);
    if (!list.length) {
      box.innerHTML = '<p class="hint">No characters yet. Click "Add a character" and log in with each character that buys or sells.</p>';
    }
    list.forEach((c) => {
      const row = document.createElement("div");
      row.className = "charrow";
      const img = document.createElement("img");
      img.src = `https://images.evetech.net/characters/${c.charId}/portrait?size=32`;
      img.alt = "";
      const lab = document.createElement("label");
      lab.className = "inline";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = c.include !== false;
      cb.disabled = !hasWallet(c);
      cb.addEventListener("change", () => { c.include = cb.checked; store.set("chars", chars); });
      const nm = document.createElement("span");
      nm.textContent = c.name + (token && token.charId === c.charId ? " (hub character)" : "");
      lab.append(cb, nm);
      row.append(img, lab);
      if (!hasWallet(c) || !hasOrders(c) || !hasSkills(c)) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = !hasWallet(c) ? "Allow wallet access" : !hasOrders(c) ? "Allow order access" : "Allow skill access";
        b.title = "Log this character in again with wallet permissions";
        b.addEventListener("click", () => login("journal"));
        row.appendChild(b);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "linkish";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        delete chars[c.charId];
        store.set("chars", chars);
        if (token && token.charId === c.charId) { token = null; store.del("token"); render(); }
        renderChars();
      });
      row.appendChild(rm);
      box.appendChild(row);
    });
    const sel = $("jCorpChar");
    const cur = settings.jCorpChar;
    sel.innerHTML = "";
    list.filter(hasWallet).forEach((c) => {
      const o = document.createElement("option");
      o.value = c.charId; o.textContent = c.name;
      sel.appendChild(o);
    });
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    else if (sel.options.length) { sel.value = sel.options[0].value; settings.jCorpChar = sel.value; }
    $("jRun").disabled = !(list.some((c) => hasWallet(c) && c.include !== false) || cloudAuth());
  }

  async function allPages(path, charId) {
    const first = await esi(path + (path.includes("?") ? "&" : "?") + "page=1", { auth: true, charId });
    let out = first.data;
    for (let p = 2; p <= (first.pages || 1) && p <= 50; p++) {
      out = out.concat((await esi(path + (path.includes("?") ? "&" : "?") + "page=" + p, { auth: true, charId })).data);
    }
    return out;
  }

  async function transactions(base, charId) {
    // Newest first; walk back with from_id until we pass the cost-basis window or run out.
    let out = [], fromId = null;
    const stop = Date.now() - 90 * 86400000;
    for (let i = 0; i < 10; i++) {
      const q = fromId ? `?from_id=${fromId}` : "";
      const batch = (await esi(base + q, { auth: true, charId })).data;
      const fresh = batch.filter((t) => !out.length || t.transaction_id < out[out.length - 1].transaction_id);
      if (!fresh.length) break;
      out = out.concat(fresh);
      const oldest = fresh[fresh.length - 1];
      if (Date.parse(oldest.date) < stop) break;
      fromId = oldest.transaction_id - 1;
    }
    return out;
  }

  // show=false: just fill jRows (used by the Sell prices tab) and throw on errors.
  async function runJournal(opts = {}) {
    const show = opts.show !== false;
    $("jRun").disabled = true;
    try {
      if (show && settings.jCorpWallet === "on") {
        status("Checking which corp wallet division your orders use…", "busy");
        showDivBanner(await detectDivision());
      }
      const period = Math.max(1, settings.jPeriod) * 86400000;
      const from = Math.max(PROJECT_START, settings.jFrom ? Date.parse(settings.jFrom) || 0 : 0);   // never before project start
      const since = Math.max(Date.now() - period, from);
      const txs = [], journal = [];
      const who = Object.values(chars).filter((c) => hasWallet(c) && c.include !== false);
      const haveCloud = !!cloudAuth();
      if (!who.length && !haveCloud) throw new Error("Add a character with wallet access, or turn on delivery alerts (which also keeps your history in the cloud).");
      if (settings.jCorpWallet === "on" && !settings.jCorpChar && !haveCloud) throw new Error("Pick which character reads the corp wallet (it needs the Accountant or Junior Accountant role).");
      for (const c of who) {
        status(`Reading ${c.name}'s wallet…`, "busy");
        txs.push(...(await transactions(`/characters/${c.charId}/wallet/transactions/`, c.charId)));
        journal.push(...(await allPages(`/characters/${c.charId}/wallet/journal/`, c.charId)));
      }
      let corpNote = "";
      if (settings.jCorpWallet === "on" && settings.jCorpChar && chars[settings.jCorpChar]) {
        const cid = settings.jCorpChar, div = Math.min(7, Math.max(1, Math.round(settings.jCorpDiv || 1)));
        status(`Reading corp wallet division ${div}…`, "busy");
        try {
          const corpId = (await esi(`/characters/${cid}/`)).data.corporation_id;
          const ctx = await transactions(`/corporations/${corpId}/wallets/${div}/transactions/`, cid);
          const cj = await allPages(`/corporations/${corpId}/wallets/${div}/journal/`, cid);
          // Everything in this division is treated as your trading (buys, sales, taxes and broker fees).
          txs.push(...ctx);
          journal.push(...cj);
        } catch (e) {
          corpNote = e.status === 403
            ? " The corp wallet was skipped: that character needs the Accountant or Junior Accountant role."
            : " The corp wallet couldn't be read (" + e.message + ").";
        }
      }

      // Cloud history (D1): everything the worker has copied since the project start, older than CCP keeps.
      let hauls = [], cloudNote = "";
      if (haveCloud) {
        status("Reading cloud history…", "busy");
        try {
          const c = await cloudTrades(from);
          txs.push(...c.transactions);
          journal.push(...c.journal);
          hauls = c.hauls || [];
          cloudNote = c.lastArchive ? ` Cloud history last copied ${new Date(c.lastArchive).toLocaleString()}.` : " Cloud history has no wallet copy yet.";
          if (c.archiveError) cloudNote += " Cloud problem: " + c.archiveError;
        } catch (e) {
          cloudNote = " Cloud history couldn't be read (" + e.message + ").";
        }
      }
      corpNote += cloudNote;

      // Unique transactions (corp + personal can overlap).
      const seen = new Set();
      const uniq = txs.filter((t) => (seen.has(t.transaction_id) ? false : (seen.add(t.transaction_id), true)));
      jRaw = { tx: uniq, hauls, journal };
      // What was actually read, so it's clear why something is or isn't in the journal.
      const inRange = uniq.filter((t) => Date.parse(t.date) >= from);
      const newest = inRange.reduce((m, t) => Math.max(m, Date.parse(t.date)), 0);
      const sales = inRange.filter((t) => !t.is_buy);
      const salesHub = hub ? sales.filter((t) => t.location_id === hub.id).length : sales.length;
      const diag = `Read ${intf(inRange.length)} wallet transactions since ${new Date(from).toLocaleString()}: ` +
        `${intf(inRange.length - sales.length)} buys, ${intf(sales.length)} sales` +
        (hub ? ` (${intf(salesHub)} at ${hub.system || "the hub"})` : "") +
        (newest ? `. Newest one: ${new Date(newest).toLocaleString()}.` : ".") +
        " CCP updates wallet data for apps about once an hour, so very recent sales can be missing for up to an hour. ";

      const onlyHub = settings.jWhere === "hub" && hub;
      const day24 = Date.now() - 86400000;
      const jitaOnly = settings.jSource === "jita";
      const byType = new Map();
      const get = (id) => { let r = byType.get(id); if (!r) { r = { typeId: id, buyQty: 0, buyIsk: 0, soldQty: 0, revenue: 0, allSold: 0, qty24: 0, rev24: 0, ids24: [] }; byType.set(id, r); } return r; };
      for (const t of uniq) {
        if (Date.parse(t.date) < from) continue;
        const r = get(t.type_id);
        if (t.is_buy) {
          if (jitaOnly && t.location_id !== JITA_STATION) continue;   // only Jita 4-4 purchases count as imports
          if (onlyHub && t.location_id === hub.id) continue;   // buying at the hub isn't an import
          r.buyQty += t.quantity; r.buyIsk += t.quantity * t.unit_price;
        } else {
          if (onlyHub && t.location_id !== hub.id) continue;
          r.allSold += t.quantity;
          if (Date.parse(t.date) >= since) {
            r.soldQty += t.quantity; r.revenue += t.quantity * t.unit_price;
            (r.saleIds || (r.saleIds = [])).push(t.transaction_id);
            if (Date.parse(t.date) >= day24) { r.qty24 += t.quantity; r.rev24 += t.quantity * t.unit_price; r.ids24.push(t.transaction_id); }
          }
        }
      }

      const rows = [...byType.values()].filter((r) => r.soldQty > 0 || r.buyQty > 0);
      await volumes(rows.map((r) => r.typeId));
      await names(rows.map((r) => r.typeId));

      const tax = salesTax(), bfH = hubBroker();
      const days = Math.max(1, settings.jPeriod);
      const tracker = new Map((doctrine || []).map((d) => [d.typeId, d]));
      rows.forEach((r) => {
        r.name = nameCache[r.typeId] || "Type " + r.typeId;
        r.avgBuy = r.buyQty ? r.buyIsk / r.buyQty : null;
        r.avgSell = r.soldQty ? r.revenue / r.soldQty : null;
        r.haulUnit = r.avgBuy !== null ? haulCost(volCache[r.typeId] || 0, r.avgBuy) : 0;
        r.cogs = r.avgBuy !== null ? r.soldQty * (r.avgBuy + r.haulUnit) : null;
        r.fees = r.revenue * (tax + bfH);
        r.profit = r.cogs !== null ? r.revenue - r.fees - r.cogs : null;
        r.roi = r.cogs ? r.profit / r.cogs : null;
        const spanDays = Math.max(1, Math.min(days, (Date.now() - since) / 86400000));
        r.perDay = r.soldQty / spanDays;
        const d = tracker.get(r.typeId);
        r.hubPerDay = d ? (d.a30 || d.a7) : null;
        r.left = Math.max(0, r.buyQty - r.allSold);
        r.leftIsk = r.avgBuy !== null ? r.left * (r.avgBuy + r.haulUnit) : 0;
      });
      // Jita-only: keep just the items you actually bought in Jita 4-4.
      jRows = rows.filter((r) => (r.soldQty > 0 || r.left > 0) && (!jitaOnly || r.buyQty > 0));

      // Fees actually charged in the period (wallet journal).
      const seenJ = new Set();
      const inP = journal.filter((e) => Date.parse(e.date) >= since && (seenJ.has(e.id) ? false : (seenJ.add(e.id), true)));
      const neg = (list) => -list.reduce((a, e) => a + (e.amount || 0), 0);
      const walletTax = neg(inP.filter((e) => e.ref_type === "transaction_tax"));
      const walletBroker = neg(inP.filter((e) => e.ref_type === "brokers_fee"));

      const sold = jRows.filter((r) => r.soldQty > 0);
      const revenue = sold.reduce((a, r) => a + r.revenue, 0);

      // Sales tax: match each tax entry to the sale it was charged on, so only the items shown count.
      const shownSales = new Set(sold.flatMap((r) => r.saleIds || []));
      const taxEntries = inP.filter((e) => e.ref_type === "transaction_tax");
      const linkable = taxEntries.some((e) => e.context_id_type === "market_transaction_id");
      const taxPaid = jitaOnly
        ? (linkable ? neg(taxEntries.filter((e) => shownSales.has(e.context_id))) : revenue * tax)
        : walletTax;
      // Broker fees are charged per order, not per sale, so they can't be tied to items reliably.
      // Jita-only view: estimate listing fees for what sold. Everything view: what the wallet was charged.
      const brokerPaid = jitaOnly ? revenue * bfH : walletBroker;

      // Last 24 hours: sales of the items shown, minus their Jita cost + hauling, sales tax and listing fee.
      const sold24 = jRows.filter((r) => r.qty24 > 0);
      const rev24 = sold24.reduce((a, r) => a + r.rev24, 0);
      const ids24 = new Set(sold24.flatMap((r) => r.ids24));
      const tax24 = linkable ? neg(taxEntries.filter((e) => ids24.has(e.context_id))) : rev24 * tax;
      const known24 = sold24.filter((r) => r.avgBuy !== null);
      const cost24 = known24.reduce((a, r) => a + r.qty24 * (r.avgBuy + r.haulUnit), 0);
      const profit24 = known24.reduce((a, r) => a + r.rev24, 0) - cost24 - tax24 - rev24 * bfH;
      $("j24").textContent = sold24.length ? isk(profit24) : "0.00";
      $("j24").className = "big " + (profit24 >= 0 ? "pos" : "neg");
      $("j24Note").textContent = sold24.length
        ? `${intf(sold24.reduce((a, r) => a + r.qty24, 0))} units of ${sold24.length} item${sold24.length === 1 ? "" : "s"} sold for ${isk(rev24)}. ` +
          `After Jita cost and hauling (${isk(cost24)}), sales tax (${isk(tax24)}) and listing fees (~${isk(rev24 * bfH)}).` +
          (known24.length < sold24.length ? ` ${sold24.length - known24.length} item(s) have no purchase on record and aren't counted.` : "") +
          " CCP's wallet data can lag up to an hour."
        : "No sales of your import items in the last 24 hours (CCP's wallet data can lag up to an hour).";
      const cogs = sold.reduce((a, r) => a + (r.cogs || 0), 0);
      const haul = sold.reduce((a, r) => a + r.soldQty * r.haulUnit, 0);
      const placeEst = revenue * bfH;
      const net = revenue - cogs - taxPaid - brokerPaid;
      $("jRev").textContent = isk(revenue);
      $("jCogs").textContent = isk(cogs - haul);
      $("jHaul").textContent = isk(haul);
      $("jTax").textContent = isk(taxPaid);
      $("jBroker").textContent = isk(brokerPaid);
      $("jNet").textContent = isk(net);
      $("jNet").className = "v " + (net >= 0 ? "pos" : "neg");
      $("jLeft").textContent = isk(jRows.reduce((a, r) => a + r.leftIsk, 0));
      $("jTaxK").textContent = jitaOnly && !linkable ? "Sales tax (est.)" : "Sales tax paid";
      $("jBrokerK").textContent = jitaOnly ? "Broker fees (est.)" : "Broker fees paid";
      const extra = walletBroker - placeEst;
      $("jFeeNote").textContent = walletBroker > 0
        ? `Across everything in these wallets, you were charged ${isk(walletBroker)} in broker fees and ${isk(walletTax)} in sales tax since ${new Date(since).toLocaleString()}. ` +
          `Listing the import units you sold would cost about ${isk(placeEst)} in broker fees; the other ${isk(Math.max(0, extra))} went on listings that haven't sold yet, order updates${jitaOnly ? " and any other orders in these wallets" : ""}.`
        : (walletTax > 0
          ? `No broker fees since ${new Date(since).toLocaleString()}. The wallets were charged ${isk(walletTax)} in sales tax in total${jitaOnly ? "; only the part on the items below counts in Net profit" : ""}.`
          : "No broker fees or sales tax in this period.");
      const missing = sold.filter((r) => r.avgBuy === null).length;
      $("jNote").textContent =
        (missing ? `${missing} item${missing === 1 ? " has" : "s have"} sales but no purchase in the wallets I read, so their profit is blank (bought with a character or corp division you didn't include, or more than 90 days ago). ` : "") +
        diag + "Hauling is estimated from your hauling settings (express fee not included). \"Left\" is bought minus sold across the wallet history read, so it's approximate." + corpNote;
      const myHauls = hauls.filter((h) => (!hub || h.end_location_id === hub.id) && h.start_location_id === JITA_STATION && h.status !== "deleted" && h.status !== "rejected");
      if (myHauls.length) {
        const paid = myHauls.reduce((a, h) => a + (h.reward || 0), 0);
        const est = jRows.reduce((a, r) => a + (r.buyQty || 0) * r.haulUnit, 0);
        $("jNote").textContent += ` Courier contracts Jita → hub since the start: ${myHauls.length}, actually paid ${isk(paid)} (the estimate for everything bought is ${isk(est)}).`;
      }

      if (show) { await whereIsk(hauls); await feeCheck(inP, uniq); }
      jSort = { key: "profit", dir: -1 };
      drawJournal();
      if (show) {
        $("jResults").classList.remove("hidden");
        status(`Journal ready (${intf(sales.length)} sales read, newest transaction ${newest ? new Date(newest).toLocaleString() : "none"}): ${sold.length} items sold in the last ${days} days, ${isk(net)} net after actual fees.${corpNote}`, "ok");
      }
      return true;
    } catch (e) {
      console.error(e);
      if (!show) throw e;
      if (e.status === 403) status("CCP refused the wallet read (403). Click \"Allow wallet access\" for that character, or check the EVE app has the wallet permissions (see README).", "err");
      else status(e.message || String(e), "err");
    } finally {
      renderChars();
    }
  }

  function clearJournal() {
    jRows = [];
    $("jTbody").innerHTML = "";
    $("jResults").classList.add("hidden");
    status("Journal cleared. Click \"Load my trades\" to read the wallets again.", "ok");
  }

  function setJournalFrom(value) {
    settings.jFrom = value;
    $("jFrom").value = value;
    store.set("settings", settings);
    markSettingsChanged();
    clearJournal();
    status(value
      ? `The journal now counts only trades from ${new Date(Math.max(PROJECT_START, Date.parse(value) || 0)).toLocaleString()} onward.`
      : `The journal now counts everything since the project started (${new Date(PROJECT_START).toLocaleString()}).`, "ok");
  }

  // ---------- sell prices ----------
  let sRows = [];
  let sSort = { key: "name", dir: 1 };

  // Market prices can only have 4 significant figures; one "tick" is the smallest step.
  const tick = (p) => (p > 0 ? Math.pow(10, Math.floor(Math.log10(p)) - 3) : 0.01);
  const floorTick = (p) => { const t = tick(p); return Math.floor(p / t) * t; };
  const ceilTick = (p) => { const t = tick(p); return Math.ceil(p / t - 1e-9) * t; };

  async function recentAvgPrice(typeId, regionId) {
    try {
      const h = (await esi(`/markets/${regionId}/history/?type_id=${typeId}`)).data;
      const last = h.slice(-7);
      const vol = last.reduce((a, d) => a + d.volume, 0);
      return vol ? last.reduce((a, d) => a + d.average * d.volume, 0) / vol : null;
    } catch { return null; }
  }

  async function runSell() {
    if (!hub) { status("Pick your hub first.", "err"); return; }
    $("sRun").disabled = true;
    try {
      status("Reading your wallets to see what you still hold…", "busy");
      await runJournal({ show: false });
      const held = jRows.filter((r) => r.left > 0 && r.avgBuy !== null);
      if (!held.length) { status("Nothing bought in Jita is waiting to be sold (since the project start / your journal date).", "ok"); sRows = []; drawSell(); return; }

      const agg = await loadHubAgg();
      const tax = salesTax(), bfH = hubBroker(), keep = 1 - tax - bfH;
      const minRoi = settings.dMinRoi / 100;
      let done = 0;
      sRows = await pool(held, 6, async (r) => {
        const h = agg.get(r.typeId);
        const lowest = h && h.sellMin < Infinity ? h.sellMin : null;
        const cost = r.avgBuy + r.haulUnit;
        const breakEven = ceilTick(cost / keep);
        const minPrice = ceilTick(cost * (1 + minRoi) / keep);
        let suggested, note, kind;
        if (lowest !== null) {
          const under = floorTick(lowest - tick(lowest) * 0.5);   // one tick under the lowest sell
          if (under >= minPrice) { suggested = under; note = `One tick under the lowest of ${h.sellOrders} seller${h.sellOrders === 1 ? "" : "s"}.`; kind = "good"; }
          else if (lowest >= breakEven) { suggested = minPrice; note = `The hub is selling below your ${settings.dMinRoi}% price. List at your minimum and wait, or match it for a smaller profit.`; kind = "warn"; }
          else { suggested = minPrice; note = "The hub price is below your break-even. Hold, or list at your minimum and wait for the cheap ones to sell."; kind = "bad"; }
        } else {
          const avg = await recentAvgPrice(r.typeId, hub.regionId);
          const est = Math.max(avg || 0, (r.avgBuy || 0) * settings.dMarkup / 100);
          suggested = Math.max(floorTick(est), minPrice);
          note = avg
            ? `Sold out: priced from the 7-day ${hub.region} average (${isk(avg)}) or your sold-out markup, whichever is higher.`
            : `Sold out, and no recent sales history: priced at your ${settings.dMarkup}% sold-out markup.`;
          kind = "sold";
        }
        status(`Pricing your stock: ${++done} of ${held.length}…`, "busy");
        const profitUnit = suggested * keep - cost;
        return {
          typeId: r.typeId, name: r.name, left: r.left, cost, breakEven, minPrice, lowest,
          sellers: h ? h.sellOrders : 0, suggested, note, kind,
          roi: profitUnit / cost, profit: profitUnit * r.left, value: suggested * r.left,
        };
      });
      sSort = { key: "name", dir: 1 };
      drawSell();
      $("sResults").classList.remove("hidden");
      const tot = sRows.reduce((a, r) => a + r.profit, 0);
      status(`Priced ${sRows.length} items. Listing everything at the suggested prices would make about ${isk(tot)} once it sells.`, "ok");
    } catch (e) {
      scanError(e);
    } finally {
      $("sRun").disabled = false;
    }
  }

  const S_COLS = [
    { k: "name", label: "Item" },
    { k: "left", label: "To sell", f: intf },
    { k: "cost", label: "Your cost", f: isk },
    { k: "breakEven", label: "Break-even", f: isk },
    { k: "minPrice", label: "Min price", f: isk },
    { k: "lowest", label: "Hub lowest", f: (v) => (v === null ? "SOLD OUT" : isk(v)) },
    { k: "suggested", label: "List at", f: isk },
    { k: "roi", label: "Return", f: pct },
    { k: "profit", label: "Profit (all)", f: isk },
    { k: "note", label: "Why" },
  ];

  function drawSell() {
    const tr = $("sThead"), tb = $("sTbody");
    tr.innerHTML = ""; tb.innerHTML = "";
    const v = sRows.reduce((a, r) => a + r.value, 0), p = sRows.reduce((a, r) => a + r.profit, 0);
    $("sItems").textContent = intf(sRows.length);
    $("sValue").textContent = isk(v);
    $("sProfit").textContent = isk(p);
    $("sWarn").textContent = intf(sRows.filter((r) => r.kind === "warn" || r.kind === "bad").length);
    S_COLS.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c.label;
      th.tabIndex = 0;
      if (c.k === "name" || c.k === "note") th.className = "name";
      if (c.k === sSort.key) th.setAttribute("aria-sort", sSort.dir < 0 ? "descending" : "ascending");
      const go = () => { if (sSort.key === c.k) sSort.dir = -sSort.dir; else sSort = { key: c.k, dir: c.k === "name" ? 1 : -1 }; drawSell(); };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      tr.appendChild(th);
    });
    const { key, dir } = sSort;
    const val = (x) => (x === null || !isFinite(x) ? -1 : x);
    const rows = [...sRows].sort((a, b) => (typeof a[key] === "string" ? dir * a[key].localeCompare(b[key]) : dir * (val(a[key]) - val(b[key]))));
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const row = document.createElement("tr");
      S_COLS.forEach((c) => {
        const td = document.createElement("td");
        if (c.k === "name") { td.className = "name"; td.textContent = r.name; }
        else if (c.k === "note") { td.className = "name note"; td.textContent = r.note; }
        else if (c.k === "lowest") {
          if (r.lowest === null) { const s = document.createElement("span"); s.className = "chip good"; s.textContent = "SOLD OUT"; td.appendChild(s); }
          else { td.textContent = `${isk(r.lowest)} (${r.sellers})`; td.title = `${r.sellers} seller${r.sellers === 1 ? "" : "s"}. If one of them is you, you may already be the lowest.`; }
        } else if (c.k === "suggested") {
          td.className = "pay";
          const b = document.createElement("button");
          b.type = "button"; b.className = "copy";
          b.textContent = Math.round(r.suggested).toLocaleString("en-US");
          b.title = "Copy this price";
          b.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(String(Math.round(r.suggested))); b.textContent = "Copied"; }
            catch { b.textContent = "Can't copy"; }
            setTimeout(() => (b.textContent = Math.round(r.suggested).toLocaleString("en-US")), 1200);
          });
          td.appendChild(b);
        } else if (c.k === "roi") {
          const s = document.createElement("span");
          s.className = "chip " + (r.kind === "bad" ? "bad" : r.kind === "warn" ? "warn" : "good");
          s.textContent = pct(r.roi);
          td.appendChild(s);
        } else {
          td.textContent = c.f(r[c.k]);
          if (c.k === "profit") td.className = r.profit >= 0 ? "pos" : "neg";
        }
        row.appendChild(td);
      });
      frag.appendChild(row);
    });
    tb.appendChild(frag);
  }

  // ---------- fee check from the wallet ----------
  // Works out the sales tax and hub broker fee CCP actually charged and compares them with your settings.
  async function feeCheck(entries, txs) {
    const box = $("feeBanner");
    box.classList.add("hidden");
    box.innerHTML = "";
    const parts = [], fixes = [];

    // Sales tax: each tax entry points at the sale it was charged on.
    const saleValue = new Map(txs.filter((t) => !t.is_buy).map((t) => [t.transaction_id, t.quantity * t.unit_price]));
    let taxIsk = 0, taxBase = 0;
    entries.filter((e) => e.ref_type === "transaction_tax" && saleValue.has(e.context_id)).forEach((e) => {
      taxIsk += -(e.amount || 0); taxBase += saleValue.get(e.context_id);
    });
    if (taxBase > 0) {
      const real = taxIsk / taxBase * 100, mine = salesTax() * 100;
      const ok = Math.abs(real - mine) < 0.1;
      parts.push(`sales tax ${real.toFixed(2)}% (settings ${mine.toFixed(2)}% ${ok ? "✓" : "✗"})`);
      if (!ok) {
        const acc = Math.max(0, Math.min(5, Math.round((1 - real / 7.5) / 0.11)));
        fixes.push({ label: `Set Accounting to ${acc}`, apply: () => { settings.acc = acc; } });
      }
    }

    // Hub broker fee: compare the fee charged on each open hub order with that order's value.
    const cid = settings.jCorpChar && chars[settings.jCorpChar] ? settings.jCorpChar : (Object.values(chars).find((c) => hasOrders(c)) || {}).charId;
    if (hub && cid && hasOrders(chars[cid])) {
      try {
        const corpId = (await esi(`/characters/${cid}/`)).data.corporation_id;
        let ords = await allPages(`/corporations/${corpId}/orders/`, cid);
        try { ords = ords.concat((await esi(`/characters/${cid}/orders/`, { auth: true, charId: cid })).data); } catch {}
        const hubSells = new Map(ords.filter((o) => !o.is_buy_order && o.location_id === hub.id).map((o) => [o.order_id, o]));
        // Add up fees charged on the same order at the same moment (broker fee + SCC surcharge may be
        // separate entries), then take each order's largest charge: that's the original listing fee.
        const byOrder = new Map();
        entries.filter((e) => (e.amount || 0) < 0 && hubSells.has(e.context_id) && /broker|scc|surcharge/i.test(e.ref_type || "")).forEach((e) => {
          const m = byOrder.get(e.context_id) || new Map();
          m.set(e.date, (m.get(e.date) || 0) - e.amount);
          byOrder.set(e.context_id, m);
        });
        const maxFee = new Map([...byOrder.entries()].map(([id, m]) => [id, Math.max(...m.values())]));
        const rates = [...maxFee.entries()].map(([id, fee]) => { const o = hubSells.get(id); return fee / (o.volume_total * o.price) * 100; })
          .filter((r) => r > 0.2 && r < 20).sort((a, b) => a - b);
        if (rates.length) {
          const real = Math.round(rates[Math.floor(rates.length / 2)] * 100) / 100;
          const ok = Math.abs(real - settings.hubFee) < 0.15;
          parts.push(`hub broker fee ${real.toFixed(2)}% from ${rates.length} order${rates.length === 1 ? "" : "s"} (settings ${settings.hubFee}% ${ok ? "✓" : "✗"})`);
          if (!ok) fixes.push({ label: `Set hub broker fee to ${real}%`, apply: () => { settings.hubFee = real; } });
        }
      } catch {}
    }
    if (!parts.length) return;
    const msg = document.createElement("span");
    msg.textContent = (fixes.length ? "Your wallet disagrees with your settings: " : "Fees check out against your wallet: ") + parts.join(" · ") + ".";
    box.appendChild(msg);
    fixes.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "primary"; b.textContent = f.label;
      b.addEventListener("click", () => {
        f.apply();
        SETTING_IDS.forEach((k) => { const el = $(k); if (el) el.value = settings[k]; });
        store.set("settings", settings);
        markSettingsChanged();
        feeLine();
        b.disabled = true; b.textContent = "Done";
        status("Settings updated from your wallet. Rebuild lists to use them.", "ok");
      });
      box.appendChild(b);
    });
    box.className = "banner" + (fixes.length ? "" : " okbanner");
  }

  // ---------- where's my ISK ----------
  async function whereIsk(hauls) {
    const div = Math.min(7, Math.max(1, Math.round(settings.jCorpDiv || 1)));
    const cid = settings.jCorpChar && chars[settings.jCorpChar] ? settings.jCorpChar
      : (Object.values(chars).find((c) => hasWallet(c)) || {}).charId;
    const costOf = new Map(jRows.filter((r) => r.avgBuy !== null).map((r) => [r.typeId, r.avgBuy + r.haulUnit]));
    let wallet = null, listedCost = 0, listedValue = 0, listedOrders = 0, note = [];
    if (cid && hasWallet(chars[cid])) {
      try {
        const corpId = (await esi(`/characters/${cid}/`)).data.corporation_id;
        try {
          const w = (await esi(`/corporations/${corpId}/wallets/`, { auth: true, charId: cid })).data;
          const d = w.find((x) => x.division === div);
          wallet = d ? d.balance : null;
        } catch (e) { note.push(e.status === 403 ? "Wallet balance needs the Accountant role." : "Wallet balance: " + e.message); }
        if (hasOrders(chars[cid])) {
          try {
            const ords = await allPages(`/corporations/${corpId}/orders/`, cid);
            ords.filter((o) => !o.is_buy_order && hub && o.location_id === hub.id && (!o.wallet_division || o.wallet_division === div)).forEach((o) => {
              listedOrders++;
              listedValue += o.volume_remain * o.price;
              listedCost += o.volume_remain * (costOf.get(o.type_id) || 0);
            });
          } catch (e) { note.push("Orders: " + e.message); }
        } else note.push("Allow order access to see what's listed.");
      } catch (e) { note.push(e.message); }
    } else note.push("Add a character with wallet access to see the wallet balance.");

    const stock = jRows.reduce((a, r) => a + r.leftIsk, 0);
    const transit = (hauls || []).filter((h) => h.status === "outstanding" || h.status === "in_progress").reduce((a, h) => a + (h.collateral || 0), 0);
    const hangar = Math.max(0, stock - listedCost - transit);
    const keep = 1 - salesTax() - hubBroker();
    $("iWallet").textContent = wallet === null ? "–" : isk(wallet);
    $("iWalletK").textContent = `Wallet (division ${div})`;
    $("iListed").textContent = isk(listedCost);
    $("iListedNote").textContent = listedOrders ? `${listedOrders} orders · worth ${isk(listedValue * keep)} after fees if they all sell` : "no orders listed";
    $("iTransit").textContent = isk(transit);
    $("iHangar").textContent = isk(hangar);
    $("iTotal").textContent = isk((wallet || 0) + stock);
    $("iNote").textContent = "Stock is valued at what it cost you (Jita price + hauling); \"in transit\" uses the courier collateral; " +
      "\"not listed yet\" is what's left after those, so it's approximate." + (note.length ? " " + note.join(" ") : "");
  }

  // ---------- corp wallet division auto-detect ----------
  // Looks at which division your corp market orders (hub sells, Jita buys) actually use.
  async function detectDivision() {
    const cid = settings.jCorpChar && chars[settings.jCorpChar] ? settings.jCorpChar
      : (Object.values(chars).find((c) => hasOrders(c)) || {}).charId;
    if (!cid || !hasOrders(chars[cid])) return null;
    try {
      const corpId = (await esi(`/characters/${cid}/`)).data.corporation_id;
      const ords = await allPages(`/corporations/${corpId}/orders/`, cid);
      const count = {};
      ords.forEach((o) => {
        if (!o.wallet_division) return;
        const relevant = (!o.is_buy_order && hub && o.location_id === hub.id) || (o.is_buy_order && o.location_id === JITA_STATION);
        if (relevant) count[o.wallet_division] = (count[o.wallet_division] || 0) + 1;
      });
      const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
      return best ? { div: Number(best[0]), orders: best[1], all: count } : null;
    } catch { return null; }
  }

  function showDivBanner(found) {
    const box = $("divBanner");
    const cur = Math.round(settings.jCorpDiv || 1);
    if (!found || found.div === cur || settings.jCorpWallet !== "on") { box.classList.add("hidden"); return false; }
    box.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = `Your corp market orders use wallet division ${found.div} (${found.orders} order${found.orders === 1 ? "" : "s"}), but the journal is reading division ${cur}. Sales in division ${found.div} won't show until you switch.`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "primary";
    b.textContent = `Use division ${found.div}`;
    b.addEventListener("click", () => {
      settings.jCorpDiv = found.div;
      $("jCorpDiv").value = found.div;
      store.set("settings", settings);
      markSettingsChanged();
      box.classList.add("hidden");
      status(`Now reading corp wallet division ${found.div}. Click "Load my trades" again. The cloud copy switches on its next hourly run.`, "ok");
    });
    box.append(msg, b);
    box.classList.remove("hidden");
    return true;
  }

  // ---------- reports ----------
  let rRows = [], rChart = null;

  function reportRange() {
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let a, b = now.getTime();
    const p = settings.rPreset;
    if (/^\d+$/.test(p)) a = b - Number(p) * 86400000;
    else if (p === "week") { const d = startOfDay(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); a = d.getTime(); }
    else if (p === "month") a = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    else if (p === "lastmonth") { a = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(); b = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); }
    else { // custom
      a = settings.rFrom ? new Date(settings.rFrom + "T00:00:00").getTime() : PROJECT_START;
      b = settings.rTo ? new Date(settings.rTo + "T00:00:00").getTime() + 86400000 : now.getTime();
    }
    return [Math.max(a, PROJECT_START), Math.min(b, now.getTime())];
  }

  function bucketKey(ms, group) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    if (group === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    if (group === "week") {
      const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      return `Week of ${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Profit for sales in [a, b): revenue - (Jita cost + hauling) - sales tax - broker fees charged in the range.
  function reportFor(a, b, ctx) {
    const { tx, costOf, taxBySale, feeEntries, jitaOnly, tax, group, bf } = ctx;
    const items = new Map(), buckets = new Map();
    const bucket = (k) => { let x = buckets.get(k); if (!x) { x = { key: k, revenue: 0, profit: 0, fees: 0 }; buckets.set(k, x); } return x; };
    let revenue = 0, cogs = 0, taxPaid = 0, units = 0, unknown = 0;
    for (const t of tx) {
      if (t.is_buy || !hub || t.location_id !== hub.id) continue;
      const ms = Date.parse(t.date);
      if (ms < a || ms >= b) continue;
      const c = costOf.get(t.type_id);
      if (jitaOnly && c === undefined) continue;
      const rev = t.quantity * t.unit_price;
      const tx$ = taxBySale.has(t.transaction_id) ? taxBySale.get(t.transaction_id) : rev * tax;
      const cg = c !== undefined ? t.quantity * c : 0;
      if (c === undefined) unknown++;
      revenue += rev; cogs += cg; taxPaid += tx$; units += t.quantity;
      const it = items.get(t.type_id) || { typeId: t.type_id, units: 0, revenue: 0, cogs: 0, tax: 0 };
      it.units += t.quantity; it.revenue += rev; it.cogs += cg; it.tax += tx$;
      items.set(t.type_id, it);
      const bk = bucket(bucketKey(ms, group));
      bk.revenue += rev; bk.profit += rev - cg - tx$ - rev * bf;   // listing fee share for what sold
    }
    let broker = 0;
    for (const e of feeEntries) {
      const ms = Date.parse(e.date);
      if (ms < a || ms >= b) continue;
      broker += -(e.amount || 0);
    }
    const brokerSold = revenue * bf;   // listing fees on the units that sold
    return { revenue, cogs, taxPaid, broker, brokerSold, units, unknown, profit: revenue - cogs - taxPaid - brokerSold, cash: revenue - cogs - taxPaid - broker, items, buckets };
  }

  async function loadChartJs() {
    if (window.Chart) return;
    await new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
      sc.onload = res; sc.onerror = () => rej(new Error("Couldn't load the chart library."));
      document.head.appendChild(sc);
    });
  }

  async function runReport() {
    if (!hub) { status("Pick your hub first.", "err"); return; }
    $("rRun").disabled = true;
    try {
      status("Reading your trading history…", "busy");
      await runJournal({ show: false });
      const [a, b] = reportRange();
      const tx = jRaw.tx;
      // Cost per unit: average Jita 4-4 purchase price since the project start, plus estimated hauling.
      const buy = new Map();
      tx.forEach((t) => { if (t.is_buy && t.location_id === JITA_STATION && Date.parse(t.date) >= PROJECT_START) { const x = buy.get(t.type_id) || { q: 0, isk: 0 }; x.q += t.quantity; x.isk += t.quantity * t.unit_price; buy.set(t.type_id, x); } });
      await volumes([...buy.keys()]);
      const costOf = new Map([...buy.entries()].map(([id, x]) => { const avg = x.isk / x.q; return [id, avg + haulCost(volCache[id] || 0, avg)]; }));
      const seenJ = new Set();
      const jr = jRaw.journal.filter((e) => (seenJ.has(e.id) ? false : (seenJ.add(e.id), true)));
      const taxBySale = new Map(jr.filter((e) => e.ref_type === "transaction_tax" && e.context_id).map((e) => [e.context_id, -(e.amount || 0)]));
      const feeEntries = jr.filter((e) => (e.amount || 0) < 0 && /broker|scc|surcharge/i.test(e.ref_type || "") && Date.parse(e.date) >= PROJECT_START);
      const ctx = { tx, costOf, taxBySale, feeEntries, jitaOnly: settings.jSource === "jita", tax: salesTax(), group: settings.rGroup, bf: hubBroker() };
      const cur = reportFor(a, b, ctx);
      const prev = reportFor(a - (b - a), a, ctx);
      const hauls = (jRaw.hauls || []).filter((h) => h.start_location_id === JITA_STATION && h.end_location_id === hub.id && h.status !== "deleted" && h.status !== "rejected" && Date.parse(h.date_issued) >= a && Date.parse(h.date_issued) < b);
      const courier = hauls.reduce((x, h) => x + (h.reward || 0), 0);
      const days = Math.max(1, (b - a) / 86400000);

      $("rRangeLbl").textContent = `${new Date(a).toLocaleString()} → ${new Date(b).toLocaleString()} (${days.toFixed(days < 10 ? 1 : 0)} days)`;
      $("rProfit").textContent = isk(cur.profit);
      $("rProfit").className = "v " + (cur.profit >= 0 ? "pos" : "neg");
      const ch = prev.profit ? (cur.profit - prev.profit) / Math.abs(prev.profit) : null;
      $("rProfitNote").textContent = prev.revenue || prev.broker
        ? `${ch === null ? "" : (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch * 100).toFixed(0) + "% "}vs previous ${days.toFixed(0)} days (${isk(prev.profit)})`
        : "no earlier period to compare";
      $("rRevenue").textContent = isk(cur.revenue);
      $("rMargin").textContent = cur.revenue ? pct(cur.profit / cur.revenue) : "–";
      $("rPerDay").textContent = isk(cur.profit / days);
      $("rUnits").textContent = intf(cur.units);
      $("rTax").textContent = isk(cur.taxPaid);
      $("rBroker").textContent = isk(cur.broker);
      const prepaid = cur.broker - cur.brokerSold;
      $("rBrokerNote").textContent = prepaid > 0
        ? `${isk(cur.brokerSold)} on what sold; ${isk(prepaid)} paid upfront on listings still up (and any order updates)`
        : `all on what sold`;
      $("rCash").textContent = isk(cur.cash);
      $("rCash").className = "v " + (cur.cash >= 0 ? "pos" : "neg");
      $("rCourier").textContent = isk(courier);
      $("rCourierNote").textContent = `${hauls.length} contract${hauls.length === 1 ? "" : "s"} issued in range (already in item cost as an estimate)`;

      // Chart
      const keys = [...cur.buckets.keys()].sort();
      try {
        await loadChartJs();
        const css = getComputedStyle(document.documentElement);
        const col = (v) => css.getPropertyValue(v).trim();
        if (rChart) rChart.destroy();
        rChart = new Chart($("rCanvas"), {
          data: {
            labels: keys,
            datasets: [
              { type: "bar", label: "Profit", data: keys.map((k) => cur.buckets.get(k).profit / 1e6),
                backgroundColor: keys.map((k) => (cur.buckets.get(k).profit >= 0 ? col("--good") : col("--bad"))), borderRadius: 3 },
              { type: "line", label: "Revenue", data: keys.map((k) => cur.buckets.get(k).revenue / 1e6),
                borderColor: col("--accent"), backgroundColor: col("--accent"), tension: 0.25, pointRadius: 3, yAxisID: "y" },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: col("--muted") } },
              tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}M ISK` } } },
            scales: {
              x: { ticks: { color: col("--muted") }, grid: { color: col("--line") } },
              y: { ticks: { color: col("--muted"), callback: (v) => v + "M" }, grid: { color: col("--line") } },
            },
          },
        });
      } catch (e) { $("rChartNote").textContent = e.message; }

      // Items
      await names([...cur.items.keys()]);
      rRows = [...cur.items.values()].map((it) => ({
        ...it, name: nameCache[it.typeId] || "Type " + it.typeId,
        profit: it.revenue - it.cogs - it.tax - it.revenue * hubBroker(),
        roi: it.cogs ? (it.revenue - it.cogs - it.tax - it.revenue * hubBroker()) / it.cogs : null,
        share: cur.revenue ? it.revenue / cur.revenue : 0,
      })).sort((x, y) => y.profit - x.profit);
      const tb = $("rTbody");
      tb.innerHTML = "";
      rRows.forEach((r) => {
        const tr = document.createElement("tr");
        const add = (v, cls) => { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = v; tr.appendChild(td); return td; };
        add(r.name, "name"); add(intf(r.units)); add(isk(r.revenue)); add(isk(r.cogs));
        const p = add(isk(r.profit)); p.className = r.profit >= 0 ? "pos" : "neg";
        add(r.roi === null ? "–" : pct(r.roi)); add(pct(r.share));
        tb.appendChild(tr);
      });
      $("rNote").textContent = (cur.unknown ? `${cur.unknown} sale(s) have no Jita purchase on record and count at zero cost. ` : "") +
        "Profit includes the listing fee at your hub broker fee rate on what sold; the Broker fees tile shows everything actually charged in the range.";
      $("rResults").classList.remove("hidden");
      status(`Report ready: ${isk(cur.profit)} profit on ${isk(cur.revenue)} of sales.`, "ok");
    } catch (e) {
      scanError(e);
    } finally {
      $("rRun").disabled = false;
    }
  }

  function syncReportInputs() {
    const custom = settings.rPreset === "custom";
    $("rFrom").closest("label").classList.toggle("hidden", !custom);
    $("rTo").closest("label").classList.toggle("hidden", !custom);
  }

  // ---------- liquidation planner ----------
  let lRows = [];

  // EVE inventory copy (Ctrl+C) is tab-separated: Name, Quantity, Group, ... Also accepts "Name 123" or "Name x 123".
  function parseInventory(text) {
    const out = new Map();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let name, qty;
      const cols = line.split("\t");
      if (cols.length >= 2) { name = cols[0].trim(); qty = cols[1].replace(/[^0-9]/g, ""); }
      else {
        const m = line.match(/^(.*?)(?:\s+x)?\s+([0-9][0-9,.\s]*)$/i);
        if (m) { name = m[1].trim(); qty = m[2].replace(/[^0-9]/g, ""); } else { name = line; qty = "1"; }
      }
      const q = parseInt(qty || "1", 10) || 1;
      if (name) out.set(name, (out.get(name) || 0) + q);
    }
    return out;
  }

  async function resolveNames(list) {
    const ids = new Map();
    for (const c of chunk(list, 400)) {
      const r = await esi(`/universe/ids/`, { method: "POST", body: c });
      (r.data.inventory_types || []).forEach((t) => { ids.set(t.name.toLowerCase(), t.id); nameCache[t.id] = t.name; });
    }
    return ids;
  }

  // Walk buy orders (highest first) for qty units; returns { qty, isk }.
  // minPrice: stop at orders below this price (a better outlet exists below it).
  function walkBuys(orders, qty, minPrice = 0) {
    let left = qty, isk = 0, sold = 0;
    for (const o of [...orders].sort((a, b) => b.price - a.price)) {
      if (left <= 0 || o.price < minPrice) break;
      const take = Math.min(left, o.volume_remain);
      isk += take * o.price; sold += take; left -= take;
    }
    return { qty: sold, isk };
  }

  async function runLiquidate() {
    if (!hub) { status("Pick your hub first.", "err"); return; }
    if (!token) { status("Log in first (the hub market needs your login).", "err"); return; }
    const pasted = parseInventory($("lPaste").value);
    try { localStorage.setItem("liqPaste", $("lPaste").value); } catch {}
    if (!pasted.size) { status("Paste your items first: select them in your EVE hangar, Ctrl+C, then paste here.", "err"); return; }
    $("lRun").disabled = true;
    try {
      status("Looking up item names…", "busy");
      const ids = await resolveNames([...pasted.keys()]);
      const unknown = [...pasted.keys()].filter((n) => !ids.has(n.toLowerCase()));
      const items = [...pasted.entries()].filter(([n]) => ids.has(n.toLowerCase())).map(([n, q]) => ({ typeId: ids.get(n.toLowerCase()), name: nameCache[ids.get(n.toLowerCase())] || n, qty: q }));
      // merge same type typed twice with different casing
      const byId = new Map();
      items.forEach((i) => { const e = byId.get(i.typeId); if (e) e.qty += i.qty; else byId.set(i.typeId, { ...i }); });
      const list = [...byId.values()];

      status("Downloading hub orders…", "busy");
      const book = await hubOrders(hub.id);
      await volumes(list.map((i) => i.typeId));
      await groups(list.map((i) => i.typeId));
      const noBb = String(settings.lBbExclude || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      const bbRefuses = (t) => { const g = (groupName[groupOfType[t]] || "").toLowerCase(); return noBb.some((x) => g.includes(x)); };
      const tracker = new Map((doctrine || []).map((d) => [d.typeId, d]));
      const needHist = list.map((i) => i.typeId).filter((t) => !tracker.get(t));
      if (needHist.length) await dailyVolumes(needHist, hub.regionId);

      const tax = salesTax(), bf = hubBroker();
      const k = 1 - Math.min(100, Math.max(0, settings.haulDisc || 0)) / 100;
      const maxDays = Math.max(0.5, settings.lMaxDays || 7);
      let done = 0;
      lRows = await pool(list, 6, async (it) => {
        const t = it.typeId, q = it.qty, vol = volCache[t] || 0;
        const sells = book.filter((b) => b.type_id === t && !b.is_buy_order);
        const hubBuys = book.filter((b) => b.type_id === t && b.is_buy_order);
        let jitaBuys = [];
        try {
          jitaBuys = (await esi(`/markets/${JITA_REGION}/orders/?order_type=buy&type_id=${t}`)).data.filter((o) => o.location_id === JITA_STATION);
        } catch {}
        status(`Planning: ${++done} of ${list.length}…`, "busy");
        const d = tracker.get(t);
        const perDay = d ? (d.a30 || d.a7) : (histCache.data[t] || 0);
        const lowest = sells.length ? Math.min(...sells.map((b) => b.price)) : null;
        const bestJitaBuy = jitaBuys.length ? Math.max(...jitaBuys.map((o) => o.price)) : 0;

        // 1) List at the hub what will sell within maxDays (behind the cheaper units already listed).
        let listPrice = null, listQty = 0, aheadUnits = 0;
        if (lowest !== null) {
          listPrice = floorTick(lowest - tick(lowest) * 0.5);
          aheadUnits = sells.filter((b) => b.price <= listPrice).reduce((a, b) => a + b.volume_remain, 0);
        } else if (bestJitaBuy) {
          listPrice = floorTick(bestJitaBuy * 1.15);   // nobody selling at the hub: a bit over Jita
        }
        if (listPrice && perDay > 0) listQty = Math.max(0, Math.min(q, Math.floor(perDay * maxDays - aheadUnits)));
        const listNetUnit = listPrice ? listPrice * (1 - tax - bf) : 0;
        // Only list if it beats dumping instantly.
        const hubDumpUnit = hubBuys.length ? Math.max(...hubBuys.map((o) => o.price)) * (1 - tax) : 0;
        const jitaDumpUnit = bestJitaBuy ? bestJitaBuy * (1 - tax) - k * (settings.haulRate * vol + (settings.coll / 100) * bestJitaBuy) : 0;
        // Your buyback contact: % of Jita best buy, minus their fee; contract, so no sales tax or hauling.
        const refused = bbRefuses(t);
        const bbUnit = !refused && settings.lBbPct > 0 && bestJitaBuy ? bestJitaBuy * settings.lBbPct / 100 * (1 - (settings.lBbFeePct || 0) / 100) : 0;
        if (listNetUnit <= Math.max(hubDumpUnit, jitaDumpUnit, bbUnit)) listQty = 0;
        // Small stacks aren't worth the effort: send them all straight to the buyback.
        const stackValue = q * bestJitaBuy;
        if (bbUnit && settings.lBbUnder > 0 && stackValue < settings.lBbUnder) {
          return {
            typeId: t, name: it.name, qty: q, perDay, lowest, sellers: sells.length,
            listQty: 0, listPrice: null, listNet: 0, days: 0,
            dump: { route: "Buyback", qty: 0, net: 0, avg: 0, m3: 0 }, unsold: 0,
            net: q * bbUnit, bbQty: q, bbNet: q * bbUnit, small: true,
            plan: `Stack worth ${isk(stackValue)} (under ${isk(settings.lBbUnder)}): contract all ${intf(q)} to your buyback @ ${isk(bbUnit)} each`,
          };
        }

        // 2) Dump the rest. Each route uses buy orders only while they beat the buyback, then the buyback takes the remainder.
        const rest = q - listQty;
        const hubMin = bbUnit ? bbUnit / (1 - tax) : 0;
        const hubW = walkBuys(hubBuys, rest, hubMin);
        const hubNet = hubW.isk * (1 - tax);
        const haulPerUnit = (p) => k * (settings.haulRate * vol + (settings.coll / 100) * p);
        const jitaMin = bbUnit ? (bbUnit + k * settings.haulRate * vol) / (1 - tax - k * settings.coll / 100) : 0;
        const jitaW = walkBuys(jitaBuys, rest, jitaMin);
        const jitaHaul = k * (settings.haulRate * vol * jitaW.qty + (settings.coll / 100) * jitaW.isk);
        const jitaNet = jitaW.isk * (1 - tax) - jitaHaul;
        const options = [
          { route: "Hub buy orders", qty: hubW.qty, net: hubNet, avg: hubW.qty ? hubW.isk / hubW.qty : 0, m3: 0 },
          { route: "Jita buy orders", qty: jitaW.qty, net: jitaNet, avg: jitaW.qty ? jitaW.isk / jitaW.qty : 0, m3: vol * jitaW.qty },
        ].map((o) => {
          const bbQty = bbUnit ? rest - o.qty : 0;
          return { ...o, bbQty, bbNet: bbQty * bbUnit, total: o.net + bbQty * bbUnit };
        });
        if (bbUnit) options.push({ route: "Buyback", qty: 0, net: 0, avg: 0, m3: 0, bbQty: rest, bbNet: rest * bbUnit, total: rest * bbUnit });
        const dump = options.sort((a, b) => b.total - a.total || a.m3 - b.m3)[0];
        const unsold = Math.max(0, rest - dump.qty - dump.bbQty);
        const listNet = listQty * listNetUnit;
        const days = listQty && perDay > 0 ? (aheadUnits + listQty) / perDay : 0;
        let plan = [];
        if (listQty) plan.push(`List ${intf(listQty)} at the hub @ ${isk(listPrice)} (~${days.toFixed(1)} days)`);
        if (dump.qty) plan.push(`Sell ${intf(dump.qty)} into ${dump.route} @ ~${isk(dump.avg)} avg${dump.route.startsWith("Jita") ? " (haul to Jita first)" : " (instant)"}`);
        if (dump.bbQty) plan.push(`Contract ${intf(dump.bbQty)} to your buyback @ ${isk(bbUnit)} each`);
        if (unsold) plan.push(`${intf(unsold)} left over: not enough buyers. List at the hub @ ${listPrice ? isk(listPrice) : "your price"} and be patient, or try another market.`);
        return {
          typeId: t, name: it.name, qty: q, perDay, lowest, sellers: sells.length,
          listQty, listPrice, listNet, days, dump, unsold,
          net: listNet + dump.net + dump.bbNet, bbQty: dump.bbQty, bbNet: dump.bbNet, refused,
          plan: (refused ? `Buyback won't take ${groupName[groupOfType[t]] || "this item"}. ` : "") + plan.join(" · "),
        };
      });
      lRows.sort((a, b) => b.net - a.net);
      drawLiquidate(unknown);
      $("lResults").classList.remove("hidden");
      const tot = lRows.reduce((a, r) => a + r.net, 0);
      status(`Plan ready for ${lRows.length} items: about ${isk(tot)} after fees, tax and hauling.` + (unknown.length ? ` ${unknown.length} name(s) not recognised.` : ""), "ok");
    } catch (e) {
      scanError(e);
    } finally {
      $("lRun").disabled = false;
    }
  }

  function drawLiquidate(unknown = []) {
    const sum = (f) => lRows.reduce((a, r) => a + f(r), 0);
    const bbTotal = sum((r) => r.bbNet || 0);
    const bbFlat = bbTotal > 0 ? (settings.lBbFlat || 0) : 0;
    $("lTotal").textContent = isk(sum((r) => r.net) - bbFlat);
    $("lBb").textContent = isk(bbTotal - bbFlat);
    $("lBbNote").textContent = bbTotal > 0 ? `${intf(sum((r) => r.bbQty || 0))} units` + (bbFlat ? ` · after ${isk(bbFlat)} flat fee` : "") : "not used";
    $("lHubList").textContent = isk(sum((r) => r.listNet));
    $("lHubDump").textContent = isk(sum((r) => (r.dump.route.startsWith("Hub") ? r.dump.net : 0)));
    $("lJita").textContent = isk(sum((r) => (r.dump.route.startsWith("Jita") ? r.dump.net : 0)));
    const m3 = sum((r) => r.dump.m3 || 0);
    $("lJitaNote").textContent = m3 ? `${intf(m3)} m³ to haul to Jita (express fee not included)` : "nothing to haul";
    const tb = $("lTbody");
    tb.innerHTML = "";
    const frag = document.createDocumentFragment();
    lRows.forEach((r) => {
      const tr = document.createElement("tr");
      const add = (v, cls) => { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = v; tr.appendChild(td); return td; };
      const nm = add(r.name, "name");
      if (r.refused) { const c = document.createElement("span"); c.className = "chip bad"; c.style.marginLeft = "6px"; c.textContent = "NO BUYBACK"; nm.appendChild(c); }
      add(intf(r.qty));
      add(r.perDay ? (r.perDay >= 100 ? intf(r.perDay) : r.perDay.toFixed(1)) : "–");
      add(r.lowest === null ? "none" : `${isk(r.lowest)} (${r.sellers})`);
      const lp = document.createElement("td");
      lp.className = "pay";
      if (r.listQty && r.listPrice) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "copy";
        b.textContent = `${intf(r.listQty)} @ ${Math.round(r.listPrice).toLocaleString("en-US")}`;
        b.title = "Copy the list price";
        b.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(String(Math.round(r.listPrice))); b.textContent = "Copied"; } catch { b.textContent = "Can't copy"; }
          setTimeout(() => (b.textContent = `${intf(r.listQty)} @ ${Math.round(r.listPrice).toLocaleString("en-US")}`), 1200);
        });
        lp.appendChild(b);
      } else lp.textContent = "–";
      tr.appendChild(lp);
      add([r.dump.qty ? `${intf(r.dump.qty)} → ${r.dump.route.startsWith("Jita") ? "Jita" : "hub"} buys` : "", r.bbQty ? `${intf(r.bbQty)} → buyback` : ""].filter(Boolean).join(", ") || "–");
      const n = add(isk(r.net)); n.className = "pos";
      add(r.plan, "name note");
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
    $("lUnknown").textContent = unknown.length ? "Not recognised (check spelling or paste from the game): " + unknown.join(", ") : "";
  }

  // ---------- order check ----------
  let oRows = [];

  async function myOpenOrders() {
    const mine = [], notes = [];
    const who = Object.values(chars).filter((c) => hasOrders(c) && c.include !== false);
    for (const c of who) {
      try { mine.push(...(await esi(`/characters/${c.charId}/orders/`, { auth: true, charId: c.charId })).data); }
      catch (e) { notes.push(`${c.name}'s orders: ${e.message}`); }
    }
    const cid = settings.jCorpChar && chars[settings.jCorpChar] ? settings.jCorpChar : (who[0] && who[0].charId);
    if (cid && hasOrders(chars[cid])) {
      try {
        const corpId = (await esi(`/characters/${cid}/`)).data.corporation_id;
        mine.push(...(await allPages(`/corporations/${corpId}/orders/`, cid)));
      } catch (e) {
        notes.push(e.status === 403 ? "Corp orders: the character needs the Accountant or Trader role." : "Corp orders: " + e.message);
      }
    }
    const seen = new Set();
    return { orders: mine.filter((o) => (seen.has(o.order_id) ? false : (seen.add(o.order_id), true))), notes, who };
  }

  // What an update costs: relist charge on the new order value (+ full fee on any increase).
  function updateFee(oldPrice, newPrice, qty) {
    const bf = hubBroker();
    const rr = 1 - (0.5 + 0.06 * Math.min(5, Math.max(0, settings.abr)));
    return Math.max(100, rr * bf * newPrice * qty + bf * Math.max(0, newPrice - oldPrice) * qty);
  }

  async function runOrders() {
    if (!hub) { status("Pick your hub first.", "err"); return; }
    $("oRun").disabled = true;
    try {
      status("Reading your open orders…", "busy");
      const { orders, notes, who } = await myOpenOrders();
      if (!who.length) throw new Error("Add a character on the Trade journal tab (Add a character) — it now also asks for order access. Characters added before need \"Allow wallet access\" again.");
      const sells = orders.filter((o) => !o.is_buy_order && o.location_id === hub.id);
      const dc = {};
      sells.forEach((o) => { if (o.wallet_division) dc[o.wallet_division] = (dc[o.wallet_division] || 0) + 1; });
      const top = Object.entries(dc).sort((a, b) => b[1] - a[1])[0];
      if (top && showDivBanner({ div: Number(top[0]), orders: top[1] })) {
        notes.push(`Your hub sell orders pay into corp wallet division ${top[0]}, not the one the Trade journal reads. Use the button on the Trade journal tab to switch.`);
      }
      if (!sells.length) { oRows = []; drawOrders(); status("No open sell orders at the hub." + (notes.length ? " " + notes.join(" ") : ""), "ok"); return; }

      status("Downloading hub orders…", "busy");
      const book = await hubOrders(hub.id);
      const myIds = new Set(orders.map((o) => o.order_id));

      // Your cost per item (for the minimum price), from the journal's wallet data. Optional.
      const cost = new Map();
      try { await runJournal({ show: false }); jRows.forEach((r) => { if (r.avgBuy !== null) cost.set(r.typeId, r.avgBuy + r.haulUnit); }); } catch {}

      const types = [...new Set(sells.map((o) => o.type_id))];
      await names(types);
      const tracker = new Map((doctrine || []).map((d) => [d.typeId, d]));
      const needHist = types.filter((t) => !tracker.get(t));
      if (needHist.length) await dailyVolumes(needHist, hub.regionId);

      const keep = 1 - salesTax() - hubBroker();
      const minRoi = settings.dMinRoi / 100;
      const now = Date.now();
      oRows = sells.map((o) => {
        const others = book.filter((b) => b.type_id === o.type_id && !b.is_buy_order && !myIds.has(b.order_id));
        const lowest = others.length ? Math.min(...others.map((b) => b.price)) : null;
        const ahead = others.filter((b) => b.price < o.price).reduce((a, b) => a + b.volume_remain, 0);
        const sellers = new Set(others.map((b) => b.order_id)).size;
        const d = tracker.get(o.type_id);
        const perDay = d ? (d.a30 || d.a7) : (histCache.data[o.type_id] || 0);
        const aheadDays = perDay > 0 ? ahead / perDay : (ahead > 0 ? Infinity : 0);
        const c = cost.get(o.type_id);
        const minPrice = c ? ceilTick(c * (1 + minRoi) / keep) : null;
        const minutesSince = (now - Date.parse(o.issued)) / 60000;
        const r = {
          orderId: o.order_id, typeId: o.type_id, name: nameCache[o.type_id] || "Type " + o.type_id,
          remain: o.volume_remain, total: o.volume_total, price: o.price, lowest, sellers, ahead, perDay, aheadDays,
          minPrice, target: null, fee: 0, drop: 0, verdict: "", why: "", kind: "",
        };
        if (lowest === null || o.price <= lowest) {
          r.verdict = "Leave it"; r.kind = "good";
          r.why = lowest === null ? "No other sellers. You're the only one." : "You're already the lowest.";
          return r;
        }
        const target = floorTick(lowest - tick(lowest) * 0.5);
        r.target = target;
        r.fee = updateFee(o.price, target, o.volume_remain);
        r.drop = (o.price - target) * o.volume_remain;
        const gapPct = (o.price - lowest) / o.price * 100;
        if (minPrice && target < minPrice) {
          r.verdict = "Hold"; r.kind = "bad";
          r.why = `Matching (${isk(target)}) is below your minimum of ${isk(minPrice)}. Let the cheaper ones sell first.`;
        } else if (minutesSince < 5) {
          r.verdict = "Wait"; r.kind = "warn";
          r.why = "Changed less than 5 minutes ago. EVE won't allow another update yet.";
        } else if (aheadDays <= settings.oAheadDays) {
          r.verdict = "Leave it"; r.kind = "good";
          r.why = isFinite(aheadDays)
            ? `Only ${intf(ahead)} cheaper unit${ahead === 1 ? "" : "s"} ahead of you (~${aheadDays.toFixed(1)} day${aheadDays >= 1.05 ? "s" : ""} of sales). They'll sell first and then it's your turn. Not worth ${isk(r.fee)}.`
            : `${intf(ahead)} cheaper units ahead, but no sales history to judge by.`;
        } else if (gapPct < settings.oMinGap && aheadDays <= settings.oAheadDays * 3) {
          r.verdict = "Leave it"; r.kind = "good";
          r.why = `Undercut by only ${gapPct.toFixed(2)}%. Not worth ${isk(r.fee)} to chase.`;
        } else {
          r.verdict = "Update"; r.kind = "warn";
          r.why = `${intf(ahead)} cheaper unit${ahead === 1 ? "" : "s"} ahead of you` +
            (isFinite(aheadDays) ? ` (~${aheadDays.toFixed(1)} days of sales)` : "") +
            `. Updating costs ${isk(r.fee)} in fees, plus ${isk(r.drop)} less if it all sells at the new price.`;
        }
        return r;
      });
      const order = { Update: 0, Hold: 1, Wait: 2, "Leave it": 3 };
      oRows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name));
      drawOrders();
      $("oResults").classList.remove("hidden");
      const up = oRows.filter((r) => r.verdict === "Update");
      status(`${oRows.length} sell orders checked: ${up.length} worth updating (${isk(up.reduce((a, r) => a + r.fee, 0))} in fees), ${oRows.length - up.length} to leave alone.` + (notes.length ? " " + notes.join(" ") : ""), "ok");
    } catch (e) {
      scanError(e);
    } finally {
      $("oRun").disabled = false;
    }
  }

  function drawOrders() {
    const up = oRows.filter((r) => r.verdict === "Update");
    $("oCount").textContent = intf(oRows.length);
    $("oUp").textContent = intf(up.length);
    $("oLeave").textContent = intf(oRows.length - up.length);
    $("oFee").textContent = isk(up.reduce((a, r) => a + r.fee, 0));
    const tb = $("oTbody");
    tb.innerHTML = "";
    const frag = document.createDocumentFragment();
    oRows.forEach((r) => {
      const tr = document.createElement("tr");
      const add = (text, cls) => { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; };
      add(r.name, "name");
      const vd = document.createElement("td");
      const chip = document.createElement("span");
      chip.className = "chip " + (r.verdict === "Update" ? "warn" : r.verdict === "Hold" ? "bad" : r.verdict === "Wait" ? "orange" : "good");
      chip.textContent = r.verdict;
      vd.appendChild(chip);
      tr.appendChild(vd);
      add(`${intf(r.remain)} / ${intf(r.total)}`);
      add(isk(r.price));
      add(r.lowest === null ? "none" : `${isk(r.lowest)} (${r.sellers})`);
      add(r.ahead ? `${intf(r.ahead)}${isFinite(r.aheadDays) ? " · " + r.aheadDays.toFixed(1) + "d" : ""}` : "0");
      const nt = document.createElement("td");
      nt.className = "pay";
      if (r.verdict === "Update" && r.target) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "copy";
        b.textContent = Math.round(r.target).toLocaleString("en-US");
        b.title = "Copy this price";
        b.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(String(Math.round(r.target))); b.textContent = "Copied"; } catch { b.textContent = "Can't copy"; }
          setTimeout(() => (b.textContent = Math.round(r.target).toLocaleString("en-US")), 1200);
        });
        nt.appendChild(b);
      } else nt.textContent = "–";
      tr.appendChild(nt);
      add(r.verdict === "Update" ? isk(r.fee) : "–");
      add(r.minPrice ? isk(r.minPrice) : "–");
      add(r.why, "name note");
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
  }

  const J_COLS = [
    { k: "name", label: "Item" },
    { k: "soldQty", label: "Sold", f: intf },
    { k: "avgBuy", label: "Avg buy", f: isk },
    { k: "avgSell", label: "Avg sell", f: isk },
    { k: "revenue", label: "Revenue", f: isk },
    { k: "profit", label: "Profit", f: isk },
    { k: "roi", label: "Return", f: pct },
    { k: "perDay", label: "You sold / day", f: (v) => (v >= 100 ? intf(v) : v.toFixed(1)) },
    { k: "hubPerDay", label: "Hub sold / day", f: (v) => (v === null ? "–" : v >= 100 ? intf(v) : v.toFixed(1)) },
    { k: "left", label: "Left", f: intf },
  ];

  function drawJournal() {
    const tr = $("jThead");
    tr.innerHTML = "";
    J_COLS.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c.label;
      th.tabIndex = 0;
      if (c.k === "name") th.className = "name";
      if (c.k === jSort.key) th.setAttribute("aria-sort", jSort.dir < 0 ? "descending" : "ascending");
      const go = () => { if (jSort.key === c.k) jSort.dir = -jSort.dir; else jSort = { key: c.k, dir: c.k === "name" ? 1 : -1 }; drawJournal(); };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      tr.appendChild(th);
    });
    const { key, dir } = jSort;
    const val = (v) => (v === null || !isFinite(v) ? -1e18 * dir : v);
    const rows = [...jRows].sort((a, b) => (typeof a[key] === "string" ? dir * a[key].localeCompare(b[key]) : dir * (val(a[key]) - val(b[key]))));
    const tb = $("jTbody");
    tb.innerHTML = "";
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const row = document.createElement("tr");
      J_COLS.forEach((c) => {
        const td = document.createElement("td");
        if (c.k === "name") { td.className = "name"; td.textContent = r.name; }
        else if (c.k === "roi") {
          if (r.roi === null) td.textContent = "–";
          else { const sp = document.createElement("span"); sp.className = "chip " + (r.roi >= 0.2 ? "good" : r.roi >= 0.05 ? "warn" : "bad"); sp.textContent = pct(r.roi); td.appendChild(sp); }
        } else {
          td.textContent = c.f(r[c.k]);
          if (c.k === "profit" && r.profit !== null) td.className = r.profit >= 0 ? "pos" : "neg";
          if (c.k === "perDay" && r.hubPerDay) {
            const share = r.perDay / r.hubPerDay;
            td.title = `You sold ${(share * 100).toFixed(0)}% of what the hub uses per day.`;
          }
          if (c.k === "left" && r.left > 0) {
            const daysToClear = r.perDay > 0 ? r.left / r.perDay : Infinity;
            td.title = isFinite(daysToClear) ? `About ${daysToClear.toFixed(0)} days to sell at your current pace (${isk(r.leftIsk)} at cost).` : `Not selling yet (${isk(r.leftIsk)} at cost).`;
            if (!isFinite(daysToClear) || daysToClear > 30) td.className = "neg";
          }
        }
        row.appendChild(td);
      });
      frag.appendChild(row);
    });
    tb.appendChild(frag);
  }

  // ---------- table ----------
  const COLS = [
    { k: "name", label: "Item" },
    { k: "cost", label: "Jita cost", f: isk },
    { k: "sell", label: "Hub sell", f: isk },
    { k: "markup", label: "Markup", f: pct },
    { k: "profit", label: "Profit / unit", f: isk, color: true },
    { k: "roi", label: "Return", f: pct, chip: true },
    { k: "vol", label: "m³", f: (v) => (v >= 100 ? intf(v) : v.toFixed(2)) },
    { k: "daily", label: "Daily volume", f: (v) => (v < 10 ? v.toFixed(1) : intf(v)) },
    { k: "listed", label: "Listed in hub", f: intf },
    { k: "daysListed", label: "Days of stock", f: (v) => (isFinite(v) ? v.toFixed(1) : "no sales") },
    { k: "dayProfit", label: "Profit / day volume", f: isk, color: true },
  ];

  function drawTable() {
    const tr = $("thead");
    tr.innerHTML = "";
    COLS.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c.label;
      th.tabIndex = 0;
      if (c.k === sortKey) th.setAttribute("aria-sort", sortDir < 0 ? "descending" : "ascending");
      const go = () => { if (sortKey === c.k) sortDir = -sortDir; else { sortKey = c.k; sortDir = c.k === "name" ? 1 : -1; } drawTable(); };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      tr.appendChild(th);
    });

    const rows = [...results].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (typeof x === "string") return sortDir * x.localeCompare(y);
      return sortDir * ((isFinite(x) ? x : 1e18) - (isFinite(y) ? y : 1e18));
    });

    const tb = $("tbody");
    tb.innerHTML = "";
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const row = document.createElement("tr");
      COLS.forEach((c) => {
        const td = document.createElement("td");
        if (c.k === "name") {
          td.textContent = r.name;
          const b = document.createElement("button");
          b.type = "button"; b.className = "copy"; b.textContent = "Copy";
          b.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(r.name); b.textContent = "Copied"; } catch { b.textContent = "Can't copy"; }
            setTimeout(() => (b.textContent = "Copy"), 1200);
          });
          td.appendChild(b);
        } else if (c.chip) {
          const s = document.createElement("span");
          s.className = "chip " + (r.roi >= 0.2 ? "good" : r.roi >= 0.1 ? "warn" : "bad");
          s.textContent = c.f(r[c.k]);
          td.appendChild(s);
        } else {
          td.textContent = c.f(r[c.k]);
          if (c.color) td.className = r[c.k] >= 0 ? "pos" : "neg";
        }
        row.appendChild(td);
      });
      frag.appendChild(row);
    });
    tb.appendChild(frag);
  }

  function downloadCsv() {
    const head = ["type_id", ...COLS.map((c) => c.label)];
    const lines = [head.join(",")];
    results.forEach((r) => {
      lines.push([r.typeId, ...COLS.map((c) => {
        const v = r[c.k];
        if (typeof v === "string") return '"' + v.replace(/"/g, '""') + '"';
        return isFinite(v) ? (Math.round(v * 10000) / 10000) : "";
      })].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `imports-${hub ? hub.system : "hub"}-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- settings form ----------
  const SETTING_IDS = Object.keys(DEFAULTS);
  function bindSettings() {
    SETTING_IDS.forEach((k) => {
      const el = $(k);
      el.value = settings[k];
      el.addEventListener("change", () => {
        settings[k] = TEXT_SETTINGS.has(k) ? el.value : (parseFloat(el.value) || 0);
        store.set("settings", settings);
        markSettingsChanged();
        feeLine();
        if (k === "dShow") { if (docResults.length) drawDocTable(); return; }
        if (results.length || docResults.length) status("Settings changed. Run the list again to update it.", "");
      });
    });
    feeLine();
  }
  function feeLine() {
    $("feeLine").textContent =
      `Sales tax ${(salesTax() * 100).toFixed(3)}% · Jita broker fee ${(jitaBroker() * 100).toFixed(2)}% · Hub broker fee ${settings.hubFee}%${settings.haulDisc ? ` · Hauling discount ${settings.haulDisc}%` : ""}`;
    $("slotLine").textContent = `${orderSlots()} order slots, ${freeSlots()} free. The Doctrine list picks at most ${freeSlots()} items.`;
  }

  // ---------- render ----------
  function render() {
    const loggedIn = !!token;
    $("login").classList.toggle("hidden", loggedIn);
    $("who").classList.toggle("hidden", !loggedIn);
    $("loginPanel").classList.toggle("hidden", loggedIn);
    if (loggedIn) {
      $("charName").textContent = token.name;
      $("portrait").src = `https://images.evetech.net/characters/${token.charId}/portrait?size=64`;
      $("portrait").alt = token.name;
    }
    $("hubCard").classList.toggle("hidden", !hub);
    $("hubPicker").classList.toggle("hidden", !!hub || !loggedIn);
    if (hub) {
      $("hubName").textContent = hub.name;
      $("hubMeta").textContent = `${hub.system} · ${hub.region} · ID ${hub.id}`;
    }
    $("scan").disabled = !hub || !loggedIn;
    renderDocButtons();
  }

  function wire() {
    $("login").addEventListener("click", () => login("primary"));
    $("logout").addEventListener("click", logout);
    $("hubChange").addEventListener("click", () => { hub = null; store.del("hub"); render(); });
    $("hubSearchBtn").addEventListener("click", async () => {
      const q = $("hubSearch").value.trim();
      if (q.length < 3) { status("Type at least 3 letters of the structure name.", "err"); return; }
      status("Searching…", "busy");
      try {
        const list = await searchHub(q);
        const box = $("hubResults");
        box.innerHTML = "";
        list.forEach((s) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = s.name;
          b.addEventListener("click", () => setHubById(s.id).catch((e) => status(e.message, "err")));
          box.appendChild(b);
        });
        status(list.length ? "Pick your hub from the list." : "No structures found with that name for this character.", list.length ? "" : "err");
      } catch (e) { status(e.message, "err"); }
    });
    $("hubSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") $("hubSearchBtn").click(); });
    $("hubIdBtn").addEventListener("click", () => {
      const id = $("hubIdInput").value.trim();
      if (!/^\d{10,}$/.test(id)) { status("A structure ID is a long number, like 1035466617946.", "err"); return; }
      setHubById(id).catch((e) => status(e.message, "err"));
    });
    $("scan").addEventListener("click", scan);
    $("csv").addEventListener("click", downloadCsv);

    $("tabDoc").addEventListener("click", () => setTab("doc"));
    $("tabJournal").addEventListener("click", () => setTab("journal"));
    $("tabSell").addEventListener("click", () => setTab("sell"));
    $("tabOrders").addEventListener("click", () => setTab("orders"));
    $("syncBtn").addEventListener("click", () => syncFromGame(false).then((ok) => ok && status("Skills and open orders updated from the game.", "ok")));
    $("tabLiq").addEventListener("click", () => setTab("liq"));
    $("tabRep").addEventListener("click", () => setTab("rep"));
    $("rRun").addEventListener("click", runReport);
    $("rPreset").addEventListener("change", syncReportInputs);
    syncReportInputs();
    $("lRun").addEventListener("click", runLiquidate);
    try { $("lPaste").value = localStorage.getItem("liqPaste") || ""; } catch {}
    $("oRun").addEventListener("click", runOrders);
    $("sRun").addEventListener("click", runSell);
    $("jAdd").addEventListener("click", () => login("journal"));
    $("jRun").addEventListener("click", runJournal);
    $("jClear").addEventListener("click", clearJournal);
    $("aOn").addEventListener("click", () => alertsOn().catch((e) => status(e.message, "err")));
    $("aOff").addEventListener("click", alertsOff);
    $("aRefresh").addEventListener("click", renderAlerts);
    if (CFG.WATCHER_URL) $("aSummaryNow").href = CFG.WATCHER_URL + "/?summary=1";
    $("jFromNow").addEventListener("click", () => {
      const d = new Date();
      d.setSeconds(0, 0);
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      setJournalFrom(local);
    });
    $("jFromClear").addEventListener("click", () => setJournalFrom(""));
    $("tabScan").addEventListener("click", () => setTab("scan"));
    $("docFile").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { setDoctrine(await f.text(), f.name); } catch (err) { status(err.message, "err"); }
    });
    $("docUrlBtn").addEventListener("click", loadSheetUrl);
    $("docRun").addEventListener("click", runDoctrine);
    $("docMulti").addEventListener("click", copyMultibuy);
    $("docCsv").addEventListener("click", downloadDocCsv);
  }

  function restoreDoctrine() {
    $("docUrl").value = store.get("docUrl", "");
    let text = null;
    try { text = localStorage.getItem("doctrineCsv"); } catch {}
    if (!text) return;
    try { doctrine = parseDoctrine(text); showDocSource(store.get("doctrineSrc", null)); } catch { doctrine = null; }
  }

  // ---------- start ----------
  (async () => {
    const V = window.APP_VERSION;
    if (V) $("ver").textContent = `EveTrader v${V.number} · ${V.date}`;
    wire();
    bindSettings();
    restoreDoctrine();
    try {
      await handleCallback();
    } catch (e) {
      status(e.message, "err");
      render();
      renderChars();
      renderAlerts();
      setTab(store.get("tab", "doc"));
      return;
    }
    const synced = await pullSettings();
    render();
    renderChars();
    renderAlerts();
    setTab(store.get("tab", "doc"));
    syncFromGame(true);
    if (synced) { status("Settings and tracker updated from your other device.", "ok"); return; }
    if (!token) status("Log in with the character that can dock at your alliance hub.", "");
    else if (!hub) status(`Logged in as ${token.name}. Now find your hub structure.`, "ok");
    else status(`Ready. Click "Scan for imports" to compare ${hub.name} with Jita.`, "ok");
  })();
})();
