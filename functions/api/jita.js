// Cloudflare Pages Function: GET /api/jita?types=34,35,36
// Fetches Jita 4-4 buy/sell aggregates from Fuzzwork and caches them for 5 minutes.
// Optional: &station=<station id> to price another NPC station.

const JITA_44 = "60003760";
const MAX_TYPES = 250;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const types = (url.searchParams.get("types") || "")
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!types.length) return json({ error: "No type IDs given." }, 400);
  if (types.length > MAX_TYPES) return json({ error: `At most ${MAX_TYPES} type IDs per request.` }, 400);

  const station = url.searchParams.get("station") || JITA_44;
  if (!/^\d+$/.test(station)) return json({ error: "Bad station id." }, 400);

  const target = `https://market.fuzzwork.co.uk/aggregates/?station=${station}&types=${types.join(",")}`;
  const cache = caches.default;
  const key = new Request(target);

  let res = await cache.match(key);
  if (!res) {
    const up = await fetch(target, { headers: { "User-Agent": "eve-trade-finder (Cloudflare Pages)" } });
    if (!up.ok) return json({ error: `Fuzzwork returned ${up.status}` }, 502);
    res = new Response(await up.text(), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });
    waitUntil(cache.put(key, res.clone()));
  }
  return res;
}
