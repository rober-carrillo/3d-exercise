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
 * Nothing is stored in a database. The edge cache is enough for a layer that
 * is a convenience rather than a record, and it needs no schema, no keys and
 * no migration. If eviction ever proves to matter, the place to put a durable
 * copy is behind this same URL and nothing else has to change.
 *
 * Licensing: the data is OpenStreetMap's, under ODbL. A produced work needs
 * attribution, which the app carries; this response is a plain subset of the
 * database, served under the same licence, which the headers say.
 */

import { condense, query } from '../src/placenames.js';

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
    // A year at the edge, a day in the browser. Street names change on the
    // scale of years, and a stale name is a smaller problem than no name.
    res.setHeader('cache-control', 'public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800');
    res.setHeader('x-licence', 'ODbL; data © OpenStreetMap contributors');
    return res.status(200).json(body);
  } catch (err) {
    // Never cache a refusal: the next request should go and ask again, since
    // "busy" is a statement about this second and nothing else.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('retry-after', '60');
    return res.status(503).json({ error: String(err.message || err), cell: [Z, x, y] });
  }
}
