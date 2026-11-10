/**
 * Street and place names as text, from OpenStreetMap's own data.
 *
 * The names on the ground used to be a picture: a transparent raster of
 * somebody else's labels, draped over the terrain and faded by distance. On a
 * flat map that is exactly right. On a hillside seen in perspective it is not,
 * because the picture was drawn for a camera looking straight down from one
 * fixed height, and anything else stretches it. Names came out soft at the
 * distance they were meant to be read at, and there was nothing to be done
 * about it from this side: the glyphs were pixels by the time they arrived.
 *
 * So the names arrive as words and are drawn here, at whatever size the camera
 * asks for. That means asking for the data rather than the picture, which
 * means Overpass, which has consequences worth stating plainly:
 *
 *   It is slow.    Thirty seconds is a good day; ninety is not unusual, and a
 *                  502 "all query workers are busy" is common enough to plan
 *                  for. So this is never awaited by anything the scene needs:
 *                  the route is drawn, and the names land on it when they
 *                  land. A failure is silent and the scene keeps the raster
 *                  labels it already had.
 *
 *   It is a shared  The public endpoints are for human-operated tools, and a
 *   resource.       viewer that re-asked on every page view would be abusing
 *                   them. Every answer is kept, keyed by the exact tile grid
 *                   the scene was built from, so a route asks once and never
 *                   again — and the build can bake the answer in beside the
 *                   tiles for a route it ships.
 *
 * The data is ODbL. Produced works — a picture of a map with these names on
 * it — need credit, which the footer carries.
 */

const KEY = 'salpicon.names.v1';
/** Four areas' worth. Each is 50–250 kB of JSON; localStorage holds about 5 MB. */
const MAX_KEPT = 4;
/** Names move slowly. A month is a long time to be wrong about a street. */
const TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The grid the server works in, and it has to match api/names.js exactly.
 *
 * One cell per request, one cache entry per cell, shared by every route and
 * every person who ever looks at that part of the world. Asking for a scene's
 * own bounding box instead would be a cache entry nobody else could ever use.
 */
const Z = 13;
/** A long ride can cross a lot of ground; past this the names are not worth the wait. */
const MAX_CELLS = 16;
/** How many to have in the air at once. Each miss is a query on a shared service. */
const AT_ONCE = 3;

const lon2tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2ty = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};

/**
 * Which roads are worth a name, in the order they deserve one.
 *
 * The rank decides who wins when two names want the same piece of screen, and
 * it is the road classification rather than anything about the label: an
 * avenue's name is more use than the name of the cul-de-sac crossing it, at
 * every zoom and in every town.
 */
const ROAD_RANK = {
  motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5,
  unclassified: 3, residential: 3, living_street: 2, pedestrian: 2,
  motorway_link: 4, trunk_link: 4, primary_link: 4, secondary_link: 3, tertiary_link: 3,
};
/** And which places, likewise: a city outranks the barrio inside it. */
const PLACE_RANK = {
  city: 9, town: 8, borough: 7, suburb: 6, quarter: 5,
  village: 5, neighbourhood: 4, hamlet: 3, locality: 2, isolated_dwelling: 1,
};

/**
 * One query for both kinds of name.
 *
 * Deliberately broad — every named highway, every named place — and filtered
 * afterwards. Overpass answers a plain tag test far faster than a regexp over
 * values, and the filtering is free once the data has arrived.
 */
const query = b => `[out:json][timeout:30];
(way["highway"]["name"](${b});node["place"]["name"](${b}););
out geom;`;

function readCache(key) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}');
    const hit = all[key];
    if (!hit || Date.now() - hit.at > TTL_MS) return null;
    return hit.data;
  } catch { return null; }
}

function writeCache(key, data) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}');
    all[key] = { at: Date.now(), data };
    // Oldest out first when there are too many, and again if the quota says
    // no. Names are a convenience; losing a cached set costs one slow fetch.
    const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
    while (keys.length > MAX_KEPT) delete all[keys.shift()];
    for (;;) {
      try { localStorage.setItem(KEY, JSON.stringify(all)); return; }
      catch {
        if (!keys.length) return;
        delete all[keys.shift()];
      }
    }
  } catch { /* private mode, or no room: the names simply are not kept */ }
}

/** A way's geometry, flattened and thinned to five decimals (about a metre). */
const geom = g => {
  const out = new Array(g.length * 2);
  for (let i = 0; i < g.length; i++) {
    out[i * 2] = +g[i].lon.toFixed(5);
    out[i * 2 + 1] = +g[i].lat.toFixed(5);
  }
  return out;
};

/**
 * Overpass's answer, reduced to what gets drawn.
 *
 * Shared with api/names.js, which is the only thing that calls Overpass now —
 * and with scripts/build.mjs, which bakes an answer in for the route the site
 * ships. Three callers, one definition of what a name is.
 */
function condense(elements) {
  const streets = [], places = [];
  for (const e of elements || []) {
    const name = e.tags?.name;
    if (!name) continue;
    if (e.type === 'way' && e.geometry?.length > 1) {
      const rank = ROAD_RANK[e.tags.highway];
      if (!rank) continue;                     // a service road or a footpath
      streets.push({ n: name, r: rank, g: geom(e.geometry) });
    } else if (e.type === 'node') {
      const rank = PLACE_RANK[e.tags.place];
      if (!rank) continue;
      places.push({ n: name, r: rank, lon: +e.lon.toFixed(5), lat: +e.lat.toFixed(5) });
    }
  }
  return { v: 1, streets, places };
}

/** The cells of the fixed grid that cover a scene. */
function cellsFor(frame) {
  const x0 = Math.floor(lon2tx(frame.minLon, Z)), x1 = Math.floor(lon2tx(frame.maxLon, Z));
  const y0 = Math.floor(lat2ty(frame.maxLat, Z)), y1 = Math.floor(lat2ty(frame.minLat, Z));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  // Nearest the middle first, so a route too long to cover entirely is at
  // least named where somebody is looking when it opens.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  out.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  return out.slice(0, MAX_CELLS);
}

/** Run jobs a few at a time, keeping whatever succeeds. */
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out.push(await fn(items[k])); } catch { /* this cell has no names today */ }
    }
  }));
  return out;
}

/**
 * Names for the ground a scene covers.
 *
 * Nothing here talks to Overpass. The browser asks our own endpoint, one
 * request per cell of a fixed grid, and that endpoint is the only thing in
 * the system with a right to a public service's time — see api/names.js for
 * why that matters and what it costs when it is done the other way.
 *
 * Partial answers are kept. Nine cells where two refused is a scene with most
 * of its names on it, which is worth a great deal more than none.
 *
 * @param spec   the tile grid the scene was built from; only a cache key here
 * @param frame  the scene's own bounds, which decides the cells
 * @param opts.local  a URL to try first — the build bakes names in beside the
 *                    tiles for routes it ships, so the landing page never
 *                    waits for anything
 * @param opts.origin where the endpoint lives, for a build whose own origin is
 *                    not on the internet (the Android app serves from
 *                    https://localhost)
 * @returns {Promise<{streets, places}|null>}  null if nothing could be had
 */
async function loadNames(spec, frame, { local = null, origin = '', timeout = 70000 } = {}) {
  const cells = cellsFor(frame);
  const key = `${KEY}:${Z}:` + cells.map(c => c.join(',')).join(';');
  const cached = readCache(key);
  if (cached) return cached;

  if (local) {
    try {
      const r = await fetch(local);
      if (r.ok) {
        const data = await r.json();
        if (data?.streets) { writeCache(key, data); return data; }
      }
    } catch { /* not baked for this route; ask the endpoint */ }
  }

  const base = String(origin || '').replace(/\/+$/, '');
  const got = await pool(cells, AT_ONCE, async ([x, y]) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(`${base}/api/names?z=${Z}&x=${x}&y=${y}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  });
  if (!got.length) return null;

  // A way that crosses a cell boundary comes back from both of them.
  const streets = [], places = [];
  const seenWay = new Set(), seenPlace = new Set();
  for (const part of got) {
    for (const s of part.streets || []) {
      const k = `${s.n}@${s.g[0]},${s.g[1]}`;
      if (seenWay.has(k)) continue;
      seenWay.add(k); streets.push(s);
    }
    for (const p of part.places || []) {
      const k = `${p.n}@${p.lon},${p.lat}`;
      if (seenPlace.has(k)) continue;
      seenPlace.add(k); places.push(p);
    }
  }
  const data = { v: 1, streets, places, cells: got.length, asked: cells.length };
  if (streets.length || places.length) writeCache(key, data);
  return data;
}

export { loadNames, cellsFor, Z as NAME_CELL_Z };

/** For the build, which writes the answer out beside the tiles. */
export { condense, query, PLACE_RANK, ROAD_RANK };
