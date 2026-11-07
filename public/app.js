(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const ESI = "https://esi.evetech.net/latest";
  const JITA_REGION = 10000002;   // The Forge
  const JITA_STATION = 60003760;  // Jita IV - Moon 4 - Caldari Navy Assembly Plant
  const SSO_AUTHORIZE = "https://login.eveonline.com/v2/oauth/authorize/";
  const SCOPES = [
    "esi-markets.structure_markets.v1",
    "esi-search.search_structures.v1",
    "esi-universe.read_structures.v1",
  ].join(" ");

  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const DEFAULTS = {
    acc: 5, br: 5, abr: 4, jFac: 0, jCorp: 0, hubFee: 1.0,
    haulRate: 800, coll: 1, haulDisc: 0, buyHow: "instant", minRoi: 8, minPrice: 100000, maxRows: 100,
    dDays: 30, dDemand: "a30", dClasses: "seed", dMarkup: 130, dMinRoi: 20,
    dItemCap: 500000000, dBudget: 10000000000, dCargo: 0, dShow: "all", dMinProfit: 1000000, dPriority: "soldout", dTol: 2,
    trade: 4, retail: 0, wholesale: 0, tycoon: 0, openOrders: 0,
  };
  const TEXT_SETTINGS = new Set(["buyHow", "dDemand", "dClasses", "dShow", "dPriority"]);
  const settings = Object.assign({}, DEFAULTS, store.get("settings", {}));
  let token = store.get("token", null);
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

  async function login() {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith("PASTE")) {
      status("Add your EVE app's Client ID to config.js first (see README).", "err");
      return;
    }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));
    const p = new URLSearchParams({
      response_type: "code",
      redirect_uri: CFG.CALLBACK_URL,
      client_id: CFG.CLIENT_ID,
      scope: SCOPES,
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

  function saveToken(t) {
    const claims = decodeJwt(t.access_token);
    token = {
      access: t.access_token,
      refresh: t.refresh_token || (token && token.refresh),
      exp: Date.now() + (t.expires_in || 1199) * 1000,
      charId: String(claims.sub || "").split(":").pop(),
      name: claims.name || "",
    };
    store.set("token", token);
  }

  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem("pkce") || "null"); } catch {}
    sessionStorage.removeItem("pkce");
    if (!saved || saved.state !== q.get("state")) throw new Error("Login check failed (state mismatch). Please log in again.");
    status("Finishing login…", "busy");
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: CFG.CLIENT_ID,
      code_verifier: saved.verifier,
    });
    saveToken(t);
  }

  async function accessToken() {
    if (!token) throw new Error("You're not logged in.");
    if (Date.now() < token.exp - 60000) return token.access;
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh, client_id: CFG.CLIENT_ID });
    saveToken(t);
    return token.access;
  }

  function logout() {
    token = null;
    store.del("token");
    render();
    status("Logged out.", "ok");
  }

  // ---------- ESI ----------
  async function esi(path, { auth = false, method = "GET", body = null } = {}) {
    const headers = {};
    if (auth) headers.Authorization = "Bearer " + (await accessToken());
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
      if (!a) { a = { sellMin: Infinity, sellQty: 0, sellOrders: 0, buyMax: 0 }; agg.set(o.type_id, a); }
      if (o.is_buy_order) { if (o.price > a.buyMax) a.buyMax = o.price; }
      else { a.sellQty += o.volume_remain; a.sellOrders++; if (o.price < a.sellMin) a.sellMin = o.price; }
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
    const seed = doctrine.filter((d) => d.cls === "Seeding").length;
    const src = { label, at: new Date().toLocaleString(), count: doctrine.length, seed };
    try { localStorage.setItem("doctrineCsv", text); } catch {}
    store.set("doctrineSrc", src);
    showDocSource(src);
    renderDocButtons();
    status(`Loaded ${intf(doctrine.length)} tracker items (${intf(seed)} Seeding). Click "Build import list".`, "ok");
  }

  function showDocSource(src) {
    $("docSource").textContent = src
      ? `Loaded ${intf(src.count)} items (${intf(src.seed)} Seeding) from ${src.label} · ${src.at}`
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
      const pick = settings.dDemand;
      let items = doctrine
        .filter((d) => settings.dClasses === "all" || d.cls === "Seeding")
        .map((d) => {
          const demand = pick === "a7" ? d.a7 : pick === "max" ? Math.max(d.a7, d.a30) : (d.a30 || d.a7);
          const need = Math.ceil(settings.dDays * demand - d.stock);
          return { ...d, demand, need, daysLeft: demand > 0 ? d.stock / demand : Infinity };
        })
        .filter((d) => d.need > 0);

      if (!items.length) { status("Nothing on the tracker is short for that many days. Try more days to cover.", "ok"); return; }

      const agg = await loadHubAgg();
      status(`${intf(items.length)} tracker items are short. Pulling Jita prices…`, "busy");
      const jita = await loadJita(items.map((d) => d.typeId));
      await volumes(items.map((d) => d.typeId));

      const tax = salesTax(), bfH = hubBroker(), bfJ = jitaBroker();
      const minRoi = settings.dMinRoi / 100;
      const k = 1 - Math.min(100, Math.max(0, settings.haulDisc || 0)) / 100;   // hauling discount factor
      const priced = [], skipped = { noJita: 0, lowRoi: 0, thin: 0, lowProfit: 0, slots: 0, budget: 0 };

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
        const sell = hubSell !== null ? hubSell : jSell * settings.dMarkup / 100 || best * settings.dMarkup / 100;
        const vol = volCache[d.typeId] || 0;
        const buyFee = settings.buyHow === "order" ? bfJ * best : 0;
        const spend = best + buyFee + haulCost(vol, best);
        const profit = sell * (1 - bfH - tax) - spend;
        if (spend <= 0 || profit / spend < minRoi) { skipped.lowRoi++; continue; }
        screened.push({ d, h, hubSell, sell, vol, best });
      }

      // Pass 2: walk Jita 4-4's real sell orders (buy-now mode) so big quantities
      // are priced the way Multibuy prices them. Stop before any unit that would
      // drop below the minimum return.
      let doneBooks = 0;
      await pool(screened, 8, async (c) => {
        const { d, h, hubSell, sell, vol, best } = c;
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
          ...d, cost, best, worst, sell, est: hubSell === null, maxAvg, payMax,
          hubListed: h ? h.sellQty : 0, hubSellers: h ? h.sellOrders : 0,
          vol, unitSpend, profit, roi, qty, short: qty < d.need,
        });
      });

      // Fill best-first by total profit until budget / cargo runs out.
      const soldFirst = settings.dPriority === "soldout";
      priced.sort((a, b) => (soldFirst && a.est !== b.est ? (a.est ? -1 : 1) : 0) || (b.profit * b.qty - a.profit * a.qty));
      let budgetLeft = settings.dBudget > 0 ? settings.dBudget : Infinity;
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
      if (skipped.thin) bits.push(`${skipped.thin} have no Jita 4-4 sell orders cheap enough to clear ${settings.dMinRoi}%`);
      if (skipped.lowProfit) bits.push(`${skipped.lowProfit} would make under ${isk(settings.dMinProfit)} in total`);
      if (skipped.slots) bits.push(`${skipped.slots} more were cut because you have ${maxItems} free order slots`);
      if (skipped.budget) bits.push(`${skipped.budget} didn't fit the budget or cargo`);
      $("dSkipped").textContent = bits.length ? "Left out: " + bits.join(", ") + "." : "";
      $("docResults").classList.remove("hidden");
      docSort = { key: "rank", dir: 1 };
      drawDocTable();
      status(docResults.length
        ? `Buy list ready: ${docResults.length} items, ${isk(sum("totalSpend"))} to spend, about ${isk(sum("totalProfit"))} profit.`
        : "No short items cleared your minimum return. Try a lower minimum or a higher sold-out markup.", "ok");
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
    $("dItems").textContent = intf(rows.length);
    const jitaTotal = rows.reduce((t, r) => t + r.qty * r.cost, 0);
    $("dJita").textContent = isk(jitaTotal);
    $("dMaxJita").textContent = isk(rows.reduce((t, r) => t + r.qty * r.payMax, 0));
    $("dHaul").textContent = isk(sum("totalSpend") - jitaTotal);
    $("dSpend").textContent = isk(sum("totalSpend"));
    $("dM3").textContent = intf(sum("totalM3")) + " m³";
    $("dProfit").textContent = isk(sum("totalProfit"));
    const so = docResults.filter((r) => r.est);
    $("dSoldOut").textContent = so.length
      ? `${so.length} item${so.length === 1 ? " is" : "s are"} sold out at the Keepstar, so you'd be the only seller (${isk(so.reduce((a, r) => a + r.totalProfit, 0))} of the expected profit).`
      : "Nothing on this list is sold out at the Keepstar.";
  }

  const DOC_COLS = [
    { k: "rank", label: "#", f: intf },
    { k: "name", label: "Item" },
    { k: "cls", label: "Type" },
    { k: "hubListed", label: "Hub listings" },
    { k: "demand", label: "Sells / day", f: (v) => (v >= 100 ? intf(v) : v.toFixed(1)) },
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

  function drawDocTable() {
    const tr = $("dThead");
    tr.innerHTML = "";
    DOC_COLS.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c.label;
      th.tabIndex = 0;
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
      DOC_COLS.forEach((c) => {
        const td = document.createElement("td");
        if (c.k === "name") {
          td.textContent = r.name;
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
            td.textContent = `${intf(r.hubListed)} (${r.hubSellers} seller${r.hubSellers === 1 ? "" : "s"})`;
            if (r.hubSellers <= 2) td.className = "pos";
          }
        } else if (c.k === "roi") {
          const s = document.createElement("span");
          s.className = "chip " + (r.roi >= 0.2 ? "good" : r.roi >= 0.1 ? "warn" : "bad");
          s.textContent = pct(r.roi);
          td.appendChild(s);
        } else if (c.k === "sell") {
          td.textContent = isk(r.sell);
          if (r.est) { const e = document.createElement("span"); e.className = "est"; e.textContent = "EST"; td.appendChild(e); }
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
          if (c.k === "cost") td.title = `Average over the orders you'd buy. Cheapest ${isk(r.best)}, most expensive ${isk(r.worst)}.`;
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
    const doc = which === "doc";
    $("tabDoc").setAttribute("aria-pressed", String(doc));
    $("tabScan").setAttribute("aria-pressed", String(!doc));
    $("docPanel").classList.toggle("hidden", !doc);
    $("docResults").classList.toggle("hidden", !doc || !docResults.length);
    $("scanPanel").classList.toggle("hidden", doc);
    $("resultsPanel").classList.toggle("hidden", doc || !results.length);
    store.set("tab", which);
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
    $("login").addEventListener("click", login);
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
    wire();
    bindSettings();
    restoreDoctrine();
    setTab(store.get("tab", "doc"));
    try {
      await handleCallback();
    } catch (e) {
      status(e.message, "err");
      render();
      return;
    }
    render();
    if (!token) status("Log in with the character that can dock at your alliance hub.", "");
    else if (!hub) status(`Logged in as ${token.name}. Now find your hub structure.`, "ok");
    else status(`Ready. Click "Scan for imports" to compare ${hub.name} with Jita.`, "ok");
  })();
})();
