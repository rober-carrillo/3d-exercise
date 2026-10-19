/**
 * Personal bests, and the totals that go beside them.
 *
 * A "fastest 5k" is not the first five kilometres of a route, nor the whole
 * route divided down. It is the quickest five kilometres *anywhere* in it: the
 * best window, wherever it happened to fall. That is the number people care
 * about, and the only one that compares honestly between a five kilometre race
 * and the good stretch in the middle of a long slow run.
 */

/** The distances worth chasing, in metres. */
export const EFFORTS = [
  { key: '1k',       label: '1 km',       metres: 1000 },
  { key: '5k',       label: '5 km',       metres: 5000 },
  { key: '10k',      label: '10 km',      metres: 10000 },
  { key: 'half',     label: 'Half',       metres: 21097.5 },
  { key: 'marathon', label: 'Marathon',   metres: 42195 },
];

/**
 * The quickest window of `metres` inside one track, or null if the route is
 * shorter than that or was never timed.
 *
 * Two pointers rather than every pair: the track is already sorted by
 * distance, so the left edge only ever moves forward, and a route of a few
 * thousand samples is measured in a single pass.
 *
 * Windows never span a pause. A route recorded either side of a lift home
 * would otherwise show a five kilometre split containing a car.
 */
export function bestEffort(track, metres) {
  const { dist, secs } = track;
  if (!secs || !dist || dist.length < 2) return null;
  const breaks = new Set(track.breaks || []);

  let best = null, lo = 0;
  for (let hi = 1; hi < dist.length; hi++) {
    if (breaks.has(hi)) { lo = hi; continue; }     // a new segment starts here
    while (lo < hi && dist[hi] - dist[lo + 1] >= metres) lo++;
    if (dist[hi] - dist[lo] < metres) continue;

    // the window overshoots; charge only the fraction of the first step needed
    const over = (dist[hi] - dist[lo]) - metres;
    const step = dist[lo + 1] - dist[lo];
    const skip = step > 0 ? Math.min(1, over / step) : 0;
    const seconds = (secs[hi] - secs[lo]) - skip * (secs[lo + 1] - secs[lo]);
    if (seconds > 0 && (!best || seconds < best.seconds)) {
      best = { metres, seconds, from: lo, to: hi };
    }
  }
  return best;
}

/** Every effort in EFFORTS for one track, keyed by effort. */
export function effortsFor(track) {
  const out = {};
  for (const e of EFFORTS) {
    const b = bestEffort(track, e.metres);
    if (b) out[e.key] = b;
  }
  return out;
}

/**
 * The best of each effort across a whole library, with the route it came from.
 *
 * `routes` are library entries: `{ name, slug, date, activity, track }`. A
 * route with no per-point times contributes nothing, which is most imported
 * files — a personal best needs a clock.
 */
/** What counts towards a running best: covered on foot, honestly measured. */
export const ON_FOOT = new Set(['run', 'walk', null, undefined]);

export function personalBests(routes, { activities = ON_FOOT } = {}) {
  const best = {};
  for (const r of routes) {
    const track = r.track;
    if (!track?.secs) continue;
    const act = r.activity ?? track.activity ?? null;
    if (!activities.has(act)) continue;
    for (const [key, effort] of Object.entries(effortsFor(track))) {
      if (!best[key] || effort.seconds < best[key].seconds) {
        best[key] = { ...effort, route: r.name, slug: r.slug, date: r.date ?? null };
      }
    }
  }
  return best;
}

/** Totals across a library: how much, how far, how long, how high. */
export function totals(routes) {
  let distance_m = 0, moving_s = 0, gain_m = 0, timed = 0;
  for (const r of routes) {
    const s = r.stats || {};
    distance_m += s.distance_m || 0;
    gain_m += s.gain_m || 0;
    const t = s.moving_s ?? s.duration_s;
    if (t) { moving_s += t; timed++; }
  }
  return { routes: routes.length, distance_m, moving_s, gain_m, timed };
}

/* ---------- formatting ---------- */

/** `48:12` or `1:12:04` — a duration as somebody would say it. */
export function clock(seconds) {
  if (seconds == null || !isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Pace as minutes and seconds per kilometre. */
export function pace(seconds, metres) {
  if (!seconds || !metres) return '—';
  const perKm = seconds / (metres / 1000);
  return `${Math.floor(perKm / 60)}:${String(Math.round(perKm % 60)).padStart(2, '0')}`;
}
