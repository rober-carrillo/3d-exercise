/**
 * Routes a person added through the browser.
 *
 * Vercel serves this site from a read-only filesystem, so an uploaded GPX
 * cannot be written back to `routes/` — and it shouldn't be: the repository is
 * the source of truth for what everyone sees. Uploads are therefore parsed in
 * the browser and kept in localStorage, private to that browser, and marked as
 * such in the library. To publish a route for real, commit the .gpx.
 */

const KEY = 'salpicon.local.v1';
const LEGACY_KEYS = ['route3d.local.v1'];

/**
 * Carry routes over from a key an earlier name used.
 *
 * The browser's storage is the only copy of anything recorded before there was
 * a database: changing the key without moving the contents would leave every
 * one of those routes sitting in storage, invisible, with no way back. The old
 * key is read once and left in place rather than deleted — if this goes wrong,
 * the data should still be there to try again with.
 */
function migrate() {
  try {
    if (localStorage.getItem(KEY)) return;
    for (const old of LEGACY_KEYS) {
      const found = localStorage.getItem(old);
      if (found) { localStorage.setItem(KEY, found); return; }
    }
  } catch {}                                 // blocked storage: nothing to move
}
migrate();

const slugify = name => name.replace(/\.gpx$/i, '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }                       // private mode, blocked storage, corrupt value
}
function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); return true; }
  catch { return false; }
}

/** Store an analyzed track; returns the library entry. */
export function addLocalRoute(fileName, track, profile) {
  const all = readAll();
  let slug = slugify(fileName), n = 2;
  while (all[slug]) slug = `${slugify(fileName)}-${n++}`;
  const b = track.bbox;
  const entry = {
    slug,
    local: true,
    name: track.name && track.name !== 'Untitled route' ? track.name : fileName.replace(/\.gpx$/i, ''),
    added: new Date().toISOString(),
    // the day it was recorded, or — for a file that never carried a time —
    // the day it was dropped in here
    date: track.time || new Date().toISOString(),
    dateSource: track.time ? 'recorded' : 'added',
    pace: !!track.secs,
    stats: track.stats,
    bbox: b,
    center: [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2],
    profile,
    track: { name: track.name, time: track.time, stats: track.stats, bbox: b, lat: track.lat, lon: track.lon, ele: track.ele, dist: track.dist, secs: track.secs },
  };
  all[slug] = entry;
  if (!writeAll(all)) {
    // out of quota (or storage unavailable) — keep it for this tab at least
    try { sessionStorage.setItem(KEY + ':' + slug, JSON.stringify(entry)); } catch {}
  }
  return entry;
}

export function listLocalRoutes() {
  return Object.values(readAll()).sort((a, b) => (a.added < b.added ? -1 : 1));
}

export function getLocalRoute(slug) {
  const all = readAll();
  if (all[slug]) return all[slug];
  try { return JSON.parse(sessionStorage.getItem(KEY + ':' + slug) || 'null'); }
  catch { return null; }
}

export function removeLocalRoute(slug) {
  const all = readAll();
  delete all[slug];
  writeAll(all);
  try { sessionStorage.removeItem(KEY + ':' + slug); } catch {}
}
