/**
 * Getting routes off this device and into the account.
 *
 * A route is written to localStorage the moment recording stops, before any
 * upload is attempted, because the end of a run is exactly where there is no
 * signal: at the top of a hill, in a car park, underground. That part was
 * right. What was missing is everything after it — the app said "it will
 * upload when you are back online" and then nothing ever did, so a route
 * recorded out of range stayed on one phone for ever while the person who
 * recorded it had been told otherwise.
 *
 * This is that missing half. While somebody is signed in, anything still held
 * locally is uploaded at the first opportunity, and the local copy is dropped
 * once the database has confirmed it. Opportunities are: the app opening, the
 * network coming back, the app returning to the foreground, signing in, and a
 * backoff timer for the case where the first four have all been and gone.
 *
 * The one failure it cannot rule out is a crash in the gap between a
 * successful save and the local delete, which would upload that route twice on
 * the next run. That is the right way round: a duplicate can be deleted by
 * hand, a route that exists in neither place cannot be recovered by anyone.
 */

import * as account from './account.js';
import { listLocalRoutes, removeLocalRoute } from './library.js';

/** Wait this long before trying again, growing with each failed round. */
const BACKOFF_MS = [15_000, 60_000, 180_000, 600_000];
/** Give up on one particular route after this many non-network refusals. */
const MAX_REFUSALS = 3;

let timer = null;
let round = 0;                 // how many times in a row the whole batch has failed
let busy = false;
const refusals = new Map();    // slug -> how many times the server has said no
const listeners = new Set();

/** Subscribe to progress: `{ state, done, total, failed, error }`. */
export function onSync(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = s => { for (const fn of listeners) { try { fn(s); } catch {} } };

/** How many routes are still only on this device. */
export const pendingCount = () => listLocalRoutes().length;

/**
 * Is this worth trying again, or is the server telling us no?
 *
 * A dropped connection is temporary and deserves another go in a minute. A
 * row the database rejects will be rejected identically for ever, and retrying
 * it every minute until the end of time is how an app burns a phone's battery
 * achieving nothing.
 */
const looksTemporary = err => {
  // `??`, not `||`: an Error with an empty message is exactly the case this
  // wants to treat as unknown-and-therefore-worth-retrying, and `||` would
  // skip past it to String(err) — "Error" — which matches nothing and so gets
  // written off as a refusal.
  const m = String(err?.message ?? err ?? '').toLowerCase();
  return !m || /failed to fetch|networkerror|network error|load failed|timeout|timed out|offline|503|502|504|429/.test(m);
};

function schedule() {
  clearTimeout(timer);
  const wait = BACKOFF_MS[Math.min(round, BACKOFF_MS.length - 1)];
  timer = setTimeout(() => syncNow(), wait);
}

/**
 * Move everything held locally into the account, one route at a time.
 *
 * Sequentially on purpose. These are large rows — a long walk is tens of
 * thousands of points — and a phone that has just come back into signal on a
 * single bar is the worst possible moment to open six uploads at once.
 */
export async function syncNow() {
  if (busy) return { skipped: 'already running' };
  if (!account.enabled() || !account.user()) return { skipped: 'not signed in' };

  const pending = listLocalRoutes().filter(e => (refusals.get(e.slug) ?? 0) < MAX_REFUSALS);
  if (!pending.length) { round = 0; clearTimeout(timer); return { skipped: 'nothing pending' }; }

  // `onLine` false is reliable — the device knows it has no interface. `true`
  // only means something is plugged in, which is why the attempt still happens.
  if (navigator.onLine === false) { schedule(); emit({ state: 'waiting', total: pending.length }); return { skipped: 'offline' }; }

  busy = true;
  emit({ state: 'uploading', done: 0, total: pending.length });
  let done = 0, failed = 0, lastError = null;

  for (const [i, entry] of pending.entries()) {
    try {
      await account.routes().save(entry.track, {
        name: entry.name,
        activity: entry.activity ?? entry.track?.activity ?? 'run',
        source: entry.source ?? 'recorded',
        profile: entry.profile ?? null,
      });
      // Only now. The database has the route; this copy is a duplicate, and
      // leaving it is what made a synced route keep saying "this browser".
      removeLocalRoute(entry.slug);
      refusals.delete(entry.slug);
      done++;
    } catch (err) {
      failed++;
      lastError = err;
      if (!looksTemporary(err)) refusals.set(entry.slug, (refusals.get(entry.slug) ?? 0) + 1);
    }
    emit({ state: 'uploading', done: i + 1, total: pending.length });
  }

  busy = false;
  if (failed) {
    round++;
    schedule();
    emit({ state: 'failed', done, failed, error: lastError });
  } else {
    round = 0;
    clearTimeout(timer);
    emit({ state: 'done', done });
  }
  return { done, failed };
}

/**
 * Watch for every moment worth trying again.
 *
 * `online` is the obvious one and the least reliable: Android fires it as the
 * radio attaches, which can be a second or two before anything will actually
 * resolve, so the first attempt after it may still fail and fall into the
 * backoff. `visibilitychange` is the one that does the real work — a phone
 * coming out of a pocket is how most of these finally go up.
 */
export function startSync() {
  const go = () => syncNow();
  addEventListener('online', go);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
  account.onChange(user => { if (user) go(); else { clearTimeout(timer); round = 0; } });
  go();
  return {
    stop() { clearTimeout(timer); removeEventListener('online', go); },
    now: syncNow,
  };
}
