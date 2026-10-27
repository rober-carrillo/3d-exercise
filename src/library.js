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

/**
 * Whose routes these are.
 *
 * Browser storage belongs to the browser, not to the person signed into it,
 * and nothing here used to record which of them had put a route in. On a
 * shared laptop that was enough to move somebody else's run into your account:
 * one person signs in and drops in a GPX, signs out; the next person signs in;
 * the upload queue finds a route sitting in storage and sends it to whoever is
 * signed in now, because that was the only account it knew about.
 *
 * Every entry now carries the id of the account that was signed in when it was
 * made, or null for one made while signed out. A route made by somebody else
 * is neither shown nor uploaded.
 *
 * Null is deliberately claimable. Recording before making an account and
 * keeping those routes when you finally do is the whole point of working
 * signed out, and a route made by nobody has no one else to belong to.
 */
/**
 * Who that is, which has to be answerable without waiting for anything.
 *
 * It was set by account.js on sign-in, which made it depend on account.js
 * having loaded — and view.html opens a local route without importing
 * account.js at all. So the owner was still null there while the entry
 * carried a real id, every route saved while signed in failed the test, and
 * the viewer told people their own route was "not in this browser any more".
 *
 * The session is already in localStorage and can simply be read. That makes
 * the answer correct on the first call from any page, in any order, with no
 * rule for future pages to remember. setLocalOwner still overrides it, because
 * on a sign-in or sign-out account.js knows before storage does.
 */
const SESSION_KEY = 'salpicon.session.v1';    // written by src/supabase.js

let owner;                                    // undefined until first asked

function currentOwner() {
  if (owner !== undefined) return owner;
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Called by account.js whenever the signed-in person changes. */
export function setLocalOwner(id) { owner = id ?? null; }
export const localOwner = () => currentOwner();

/** Is this entry ours to show, upload and delete? */
const mine = e => {
  const o = e?.owner ?? null;
  return o === null || o === currentOwner();
};
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
    // Who was signed in when this arrived. Null means nobody was, and a route
    // that belongs to nobody is claimable by whoever signs in next.
    owner: currentOwner(),
    name: track.name && track.name !== 'Untitled route' ? track.name : fileName.replace(/\.gpx$/i, ''),
    added: new Date().toISOString(),
    // the day it was recorded, or — for a file that never carried a time —
    // the day it was dropped in here
    date: track.time || new Date().toISOString(),
    dateSource: track.time ? 'recorded' : 'added',
    pace: !!track.secs,
    // carried so an upload can say what the outing was. Without it every
    // synced route arrives in the account as a run, football included.
    activity: track.activity ?? null,
    stats: track.stats,
    bbox: b,
    center: [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2],
    profile,
    track: {
      name: track.name, time: track.time, activity: track.activity ?? null,
      stats: track.stats, bbox: b,
      lat: track.lat, lon: track.lon, ele: track.ele, dist: track.dist, secs: track.secs,
    },
  };
  all[slug] = entry;
  if (!writeAll(all)) {
    // out of quota (or storage unavailable) — keep it for this tab at least
    try { sessionStorage.setItem(KEY + ':' + slug, JSON.stringify(entry)); } catch {}
  }
  return entry;
}

/**
 * Replace a stored route's track and figures in place.
 *
 * For the ground correction, which arrives a moment after a recording is
 * saved: the route has to be on disk before any network call is made, so the
 * corrected elevations land on an entry that already exists rather than
 * gating the save on a tile fetch that may never complete.
 *
 * Returns the updated entry, or null if the slug has gone — which happens
 * when an upload finished first and removed the local copy. That is not a
 * failure; the account has the route.
 */
export function updateLocalRoute(slug, track, profile) {
  const all = readAll();
  const entry = all[slug];
  if (!entry || !mine(entry)) return null;
  const b = track.bbox ?? entry.bbox;
  all[slug] = {
    ...entry,
    stats: track.stats,
    bbox: b,
    center: [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2],
    profile: profile ?? entry.profile,
    track: { ...entry.track, stats: track.stats, bbox: b, ele: track.ele },
  };
  writeAll(all);
  return all[slug];
}

/**
 * The routes in this browser that belong to the person using it.
 *
 * Entries written before this field existed have no owner and read as
 * claimable, which is the same way they behaved before — the alternative is
 * hiding routes somebody can already see, to fix a problem they may not have.
 */
export function listLocalRoutes() {
  return Object.values(readAll()).filter(mine).sort((a, b) => (a.added < b.added ? -1 : 1));
}

/** Every entry, whoever it belongs to. For counting and housekeeping only. */
export function listAllLocalRoutes() {
  return Object.values(readAll()).sort((a, b) => (a.added < b.added ? -1 : 1));
}

export function getLocalRoute(slug) {
  const all = readAll();
  if (all[slug]) return mine(all[slug]) ? all[slug] : null;
  try { return JSON.parse(sessionStorage.getItem(KEY + ':' + slug) || 'null'); }
  catch { return null; }
}

/**
 * Is this route still held here — right now, on disk?
 *
 * Deliberately not `getLocalRoute`, which falls back to the sessionStorage
 * copy a viewer tab leaves behind and so answers yes for a route that has
 * been deleted. The upload loop needs the strict question: has somebody
 * removed this since I picked it up?
 */
export function hasLocalRoute(slug) {
  const e = readAll()[slug];
  return !!e && mine(e);
}

export function removeLocalRoute(slug) {
  const all = readAll();
  if (all[slug] && !mine(all[slug])) return;       // not ours to delete
  delete all[slug];
  writeAll(all);
  try { sessionStorage.removeItem(KEY + ':' + slug); } catch {}
}
