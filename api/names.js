/**
 * Street and region names for one cell of the world.
 *
 *   GET /api/names?z=13&x=2345&y=3210
 *
 * Why this exists at all. The names are OpenStreetMap data, and the obvious
 * way to get them is to ask Overpass from the browser — which is what this
 * app did, and it does not work. Three reasons, and only the first is obvious:
 *
 *   It is slow and often refuses.  Thirty seconds is a good day, ninety is
 *     normal, and "all query workers are busy" comes back instantly and often.
 *     From a browser that is a route with no names on it.
 *
 *   The quota is per application.  Overpass counts usage towards the app, not
 *     the IP — the sum of every request made by all of its users. So a viewer
 *     that asks once per page view spends one shared allowance on the same
 *     answer over and over, and the refusals are self-inflicted.
 *
 *   Their guidance for regular use is about a hundredth of the one-off limits.
 *     A design that asks once per *place* and keeps the answer forever fits
 *     inside that. One that asks once per *view* never will.
 *
 * So: a fixed grid, one cell per URL, and a year of cache headers. The first
 * person to look at a corner of the world pays for it; everybody after is
 * served by the CDN, including the next route through the same streets and
 * the next person on a shared link. Street names and region names come back
 * together because they are one query — asking twice would double the cost of
 * the only expensive thing here.
 *
 * Eviction proved to matter, so there is a durable copy behind this same URL,
 * exactly where the first version of this file said it would go if it ever
 * did. The edge cache turned out not to be storage: it holds what is being
 * used and drops the rest, and five quiet cells over Pereira fell out of it
 * within half an hour. What that means for a person is that a link shared
 * last week opens cold today, and whoever follows it waits a minute a cell —
 * which is what sharing a San Francisco route showed, 16 cold cells of it.
 *
 * So the answer from Overpass is written to a table, one row per cell, and
 * read back before anybody is asked for it again. The first person to look at
 * a corner of the world still pays; nobody pays for it twice, ever, and the
 * cache in front of it goes back to being what a cache is for.
 *
 * The store is optional on purpose. Without SUPABASE_URL and a service key in
 * the environment, or with the table missing, every path here still works and
 * the only difference is that the edge cache is on its own again — which is
 * what a fork, a preview deployment or a laptop gets.
 *
 * Licensing: the data is OpenStreetMap's, under ODbL. A produced work needs
 * attribution, which the app carries; this response is a plain subset of the
 * database, served under the same licence, which the headers say.
 */

import { condense, query } from '../src/placenames.js';

/**
 * The durable copy.
 *
 * Read and written with the *service* key, which bypasses row-level security,
 * and so is only ever used here — on the server, in a function the browser
 * cannot reach except through this endpoint. The table carries no policy at
 * all, which means no browser key can touch it in either direction: the one
 * door is this file. That is deliberate. A cache of street names that anybody
 * may write to is a cache of whatever anybody feels like printing across
 * everyone else's map.
 */
const STORE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const STORE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STORE_ON = !!(STORE_URL && STORE_KEY);
const TABLE = 'name_cells';
/** Long enough for a healthy round trip, short enough to leave Overpass its budget. */
const STORE_MS = 6000;

const storeHeaders = () => ({
  apikey: STORE_KEY,
  authorization: `Bearer ${STORE_KEY}`,
  'content-type': 'application/json',
});

/** The stored answer for a cell, or null if there is none. Never throws. */
async function readCell(z, x, y) {
  if (!STORE_ON) return null;
  const url = `${STORE_URL}/rest/v1/${TABLE}`
    + `?select=data,fetched_at&z=eq.${z}&x=eq.${x}&y=eq.${y}&limit=1`;
  const res = await fetch(url, { headers: storeHeaders(), signal: AbortSignal.timeout(STORE_MS) });
  if (!res.ok) throw new Error(`store read HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Keep an answer. `merge-duplicates` because two people can open the same new
 * corner of the world at the same time and both will have asked Overpass:
 * the second write is the same data and should be a no-op, not an error.
 */
async function writeCell(z, x, y, data) {
  if (!STORE_ON) return false;
  const url = `${STORE_URL}/rest/v1/${TABLE}?on_conflict=z,x,y`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...storeHeaders(), prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ z, x, y, data, fetched_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(STORE_MS),
  });
  if (!res.ok) throw new Error(`store write HTTP ${res.status}`);
  return true;
}

/** The grid. z13 is about five kilometres a side at this latitude. */
const Z = 13;
/**
 * A cell is roughly 24 km², against a scene's 10–20 km². Coarser cells would
 * share better between routes and make every request heavier; finer ones
 * would mean a dozen requests to draw one scene. This is the size at which a
 * typical route needs two to nine cells and each is a couple of hundred
 * kilobytes before compression.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
/**
 * The whole budget, against the function's own ceiling of sixty seconds.
 *
 * Divided by a deadline rather than handed out in fixed slices, because the
 * two ways an endpoint fails cost wildly different amounts. "All query
 * workers are busy" comes back in half a second; a queue that never reaches
 * us costs the entire timeout. Fixed slices spend the budget as though every
 * failure were the expensive kind: measured on the first live cells, two
 * slices of 26 s meant the first endpoint timed out, the second got 26 s and
 * timed out too, and a cell that one endpoint could have served in 25 s came
 * back as a refusal.
 *
 * With a deadline, an instant refusal costs nothing and hands almost the
 * whole budget to the next one.
 */
const BUDGET_MS = 54000;
/** No single attempt gets everything; something has to be left for the next. */
const ATTEMPT_CAP_MS = 40000;
/** Shorter than this and no label will fit along it anyway. */
const MIN_WAY_M = 45;

const tileBounds = (z, x, y) => {
  const n = 2 ** z;
  const lon0 = x / n * 360 - 180, lon1 = (x + 1) / n * 360 - 180;
  const lat = yy => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * 180 / Math.PI;
  return { south: lat(y + 1), west: lon0, north: lat(y), east: lon1 };
};

/** Metres along a flattened lon/lat list; good enough to throw away stubs. */
function lengthOf(g) {
  let m = 0;
  for (let i = 2; i < g.length; i += 2) {
    const lat = (g[i + 1] + g[i - 1]) / 2;
    const dx = (g[i] - g[i - 2]) * 111320 * Math.cos(lat * Math.PI / 180);
    const dy = (g[i + 1] - g[i - 1]) * 110540;
    m += Math.hypot(dx, dy);
  }
  return m;
}

async function askOverpass(bbox) {
  const b = [bbox.south, bbox.west, bbox.north, bbox.east].map(v => v.toFixed(5)).join(',');
  const body = 'data=' + encodeURIComponent(query(b));
  const until = Date.now() + BUDGET_MS;
  let last = null;
  for (const url of ENDPOINTS) {
    const left = until - Date.now();
    if (left < 4000) break;                 // not enough left to be worth asking
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(left, ATTEMPT_CAP_MS));
    try {
      const res = await fetch(url, {
        method: 'POST', body, signal: ctl.signal,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // A bare name and version. Their front end answers 406 to no user
          // agent at all, and 406 again to any user agent with a URL in it,
          // however politely the URL is offered.
          'user-agent': 'salpicon/1.0',
        },
      });
      if (res.status === 429 || res.status === 504 || res.status === 502) {
        last = `${new URL(url).host}: HTTP ${res.status}`;
        continue;                       // busy; the other one may not be
      }
      if (!res.ok) { last = `${new URL(url).host}: HTTP ${res.status}`; continue; }
      return { data: await res.json(), from: new URL(url).host };
    } catch (err) {
      last = `${new URL(url).host}: ${err.name === 'AbortError' ? 'timed out' : err.message}`;
    } finally { clearTimeout(timer); }
  }
  throw new Error(last || 'no answer');
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q = req.query || {};
  const z = Number(q.z), x = Number(q.x), y = Number(q.y);
  const n = 2 ** Z;
  if (z !== Z || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
    // One grid, one cell size. Anything else would fragment the cache into
    // entries nobody shares, which is the whole value of doing this here.
    return res.status(400).json({ error: `expected z=${Z} and a cell inside it` });
  }

  const bounds = tileBounds(Z, x, y);
  // A year at the edge, a day in the browser. Street names change on the
  // scale of years, and a stale name is a smaller problem than no name.
  const keep = 'public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800';

  // Asked once already, by somebody, at some point: that is the whole trick.
  // A failure to reach the store is not a failure to answer — it costs a
  // round trip and then the question is put to Overpass as it always was.
  // What became of the store on this request, for whoever is reading the
  // headers to find out why a cell is slow. Everything that happens to it is
  // kept rather than only the last thing: a read that failed and a write that
  // then succeeded are two different facts and both are worth having.
  const note = [];
  if (!STORE_ON) note.push('off');
  try {
    const row = await readCell(Z, x, y);
    if (row && row.data) {
      res.setHeader('cache-control', keep);
      res.setHeader('x-licence', 'ODbL; data © OpenStreetMap contributors');
      res.setHeader('x-salpicon-store', 'hit');
      return res.status(200).json({ ...row.data, stored_at: row.fetched_at });
    }
  } catch (err) {
    note.push(`unread: ${err.message || err}`);
  }

  try {
    const { data, from } = await askOverpass(bounds);
    const out = condense(data.elements);
    const before = out.streets.length;
    out.streets = out.streets.filter(s => lengthOf(s.g) >= MIN_WAY_M);
    const body = {
      v: 1,
      cell: [Z, x, y],
      bounds,
      attribution: '© OpenStreetMap contributors',
      licence: 'ODbL 1.0 — https://opendatacommons.org/licenses/odbl/',
      source: from,
      streets: out.streets,
      places: out.places,
      dropped_short_ways: before - out.streets.length,
    };
    // Written before the answer goes out, not after. A serverless function is
    // allowed to stop the moment it has responded, so work left running past
    // the response is work that may simply not happen — and the one thing
    // this endpoint must not lose is the answer it just spent a minute on.
    try {
      if (await writeCell(Z, x, y, body)) note.push('saved');
    } catch (err) {
      note.push(`unsaved: ${err.message || err}`);
    }
    res.setHeader('cache-control', keep);
    res.setHeader('x-licence', 'ODbL; data © OpenStreetMap contributors');
    res.setHeader('x-salpicon-store', note.join('; ') || 'miss');
    return res.status(200).json(body);
  } catch (err) {
    // Never cache a refusal: the next request should go and ask again, since
    // "busy" is a statement about this second and nothing else.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('retry-after', '60');
    res.setHeader('x-salpicon-store', note.join('; ') || 'miss');
    return res.status(503).json({ error: String(err.message || err), cell: [Z, x, y] });
  }
}
