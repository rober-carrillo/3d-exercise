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
/** Four scenes' worth. Each is 50–250 kB of JSON; localStorage holds ~5 MB. */
const MAX_KEPT = 4;
/** Names move slowly. A month is a long time to be wrong about a street. */
const TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The endpoints, tried in order.
 *
 * Mirrors rather than one address because the main instance refuses outright
 * when it is busy, and the refusal is instant — so a second try costs almost
 * nothing and quite often works.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

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
 * here rather than in the query. Overpass answers a plain tag test far faster
 * than a regexp over values, and the filtering is free once the data has
 * arrived; asking for less and waiting longer is the wrong trade when the
 * waiting is the problem.
 */
const query = b => `[out:json][timeout:30];
(way["highway"]["name"](${b});node["place"]["name"](${b}););
out geom;`;

const cacheKey = spec => `${KEY}:${spec.z}:${spec.x0},${spec.y0}-${spec.x1},${spec.y1}`;

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

/** Overpass's answer, reduced to what gets drawn. */
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

/**
 * Names for the ground a scene covers.
 *
 * @param spec   the tile grid the scene was built from; it is the cache key
 * @param frame  the scene's own bounds, which is what gets asked for
 * @param opts.local  a URL to try first — the build bakes names in beside the
 *                    tiles for routes it ships, and a baked answer means the
 *                    landing page never waits on anybody's public endpoint
 * @returns {Promise<{streets, places}|null>}  null if nothing could be had
 */
export async function loadNames(spec, frame, { local = null, timeout = 35000 } = {}) {
  const key = cacheKey(spec);
  const cached = readCache(key);
  if (cached) return cached;

  if (local) {
    try {
      const r = await fetch(local);
      if (r.ok) {
        const data = await r.json();
        if (data?.streets) { writeCache(key, data); return data; }
      }
    } catch { /* not baked for this route; ask the network */ }
  }

  const b = [frame.minLat, frame.minLon, frame.maxLat, frame.maxLon]
    .map(v => v.toFixed(5)).join(',');
  const body = 'data=' + encodeURIComponent(query(b));
  for (const url of ENDPOINTS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, {
        method: 'POST', body, signal: ctl.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;                   // busy, almost always: try the next
      const json = await res.json();
      const data = condense(json.elements);
      if (!data.streets.length && !data.places.length) return data;
      writeCache(key, data);
      return data;
    } catch { /* timed out, aborted, offline: try the next, then give up */ }
  }
  return null;
}

/** For the build, which writes the answer out beside the tiles. */
export { condense, query, PLACE_RANK, ROAD_RANK };
