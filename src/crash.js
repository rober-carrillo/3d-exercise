/**
 * A recording that outlives the app.
 *
 * Every point of a recording used to live in one JavaScript array and nowhere
 * else, from the first fix until somebody pressed Finish. That array belongs
 * to the web view, and Android reclaims web views — a long walk with the
 * screen off and the phone in a pocket is exactly the situation the system
 * looks at when it wants memory back. The foreground service survives that,
 * because it is what the notification is attached to, so the recording went
 * on looking alive while the only copy of the track had already been thrown
 * away. Pressing Finish then saved nothing, and there was nothing left to
 * save it from: no signal, no account and no error, just a walk that never
 * happened.
 *
 * So accepted points go to disk as they arrive, and the app looks for them
 * when it starts.
 *
 * What is kept is deliberately only the points, the breaks and the activity.
 * The recorder's other state — the smoothed position, the movement window,
 * the segment clocks — is working memory for deciding which fix to accept
 * next, and none of it is needed afterwards: a route is rebuilt from accepted
 * points alone, down the same toGPX → analyze path a normal finish uses. Less
 * to write, less to keep in step, and no second way of building a route that
 * could drift away from the first.
 */

const KEY = 'salpicon.recording.v1';

/** How often the track is written out, at most. */
const EVERY_MS = 5000;

let lastWrite = 0;
let refused = false;

/**
 * Write the track so far, at most once every few seconds.
 *
 * The throttle is the whole design. Writing on every fix would serialise the
 * entire track once a second for the length of a walk; writing only at the
 * end is what this exists to fix. Five seconds means the worst a kill can
 * cost is five seconds of walking, which is a few metres.
 *
 * Returns false if storage refused it — the caller may want to say so, since
 * from here on the recording is only as safe as it used to be.
 */
export function checkpoint(rec, { force = false } = {}) {
  if (!rec || !rec.points.length) return true;
  const now = Date.now();
  if (!force && now - lastWrite < EVERY_MS) return !refused;
  lastWrite = now;
  const blob = {
    v: 1,
    activity: rec.activity ?? null,
    startedAt: rec.startedAt ?? null,
    at: now,
    breaks: [...rec.breaks],
    // Six decimals is about 11 cm. Phones do not know where they are to
    // anything like that, and the rounding takes roughly a fifth off a long
    // walk — worth having when this is rewritten every few seconds.
    pts: rec.points.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6), +p.ele.toFixed(1), p.t]),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(blob));
    refused = false;
  } catch {
    // Out of room, or storage blocked. Nothing useful to do from here except
    // stop pretending it worked; the recording carries on in memory.
    refused = true;
  }
  return !refused;
}

/** The track left behind by a recording that never finished, or null. */
export function readCheckpoint() {
  let blob;
  try { blob = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  if (!blob || !Array.isArray(blob.pts)) return null;
  return {
    activity: blob.activity ?? 'run',
    startedAt: blob.startedAt ?? (blob.pts[0]?.[3] ?? null),
    at: blob.at ?? null,
    breaks: Array.isArray(blob.breaks) ? blob.breaks : [],
    points: blob.pts.map(([lat, lon, ele, t]) => ({ lat, lon, ele, t })),
  };
}

/**
 * Forget it — the recording has been turned into a route and stored.
 *
 * Only ever called once the route is safely in the library. Clearing it any
 * earlier would hand back exactly the gap this module exists to close.
 */
export function clearCheckpoint() {
  try { localStorage.removeItem(KEY); } catch {}
  lastWrite = 0;
  refused = false;
}
