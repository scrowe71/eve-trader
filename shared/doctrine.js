// Doctrine Stock Tracker CSV parsing (shared with the watcher Worker).

export function parseNum(s) {
  s = String(s == null ? "" : s).trim().replace(/,/g, "").replace(/%$/, "");
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const v = parseFloat(s);
  return isFinite(v) ? (neg ? -v : v) : 0;
}

export function parseCsv(text) {
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

// Returns Map typeId -> { name, stock, a7, a30, cls }
export function parseDoctrine(text) {
  const out = new Map();
  if (!text) return out;
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const hi = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "type id"));
  if (hi < 0) return out;
  const h = rows[hi].map((c) => c.trim().toLowerCase());
  const col = (n) => h.indexOf(n);
  const c = { id: col("type id"), name: col("item"), stock: col("stock"), a7: col("7d avg"), a30: col("30d avg"), cls: col("classification") };
  for (const r of rows.slice(hi + 1)) {
    const id = parseInt(r[c.id], 10);
    if (!id) continue;
    out.set(id, {
      name: (r[c.name] || "").trim(), stock: parseNum(r[c.stock]),
      a7: parseNum(r[c.a7]), a30: parseNum(r[c.a30]), cls: c.cls >= 0 ? (r[c.cls] || "").trim() : "",
    });
  }
  return out;
}
