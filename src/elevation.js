/**
 * Where the ground actually is, as opposed to where the GPS thought it was.
 *
 * A phone's altitude is the worst number it reports. Two separate faults, both
 * visible in a 494 m walk along flat ground in San Francisco:
 *
 *   1. It is not height above sea level. `Location.getAltitude()` returns
 *      height above the WGS84 ellipsoid, and the two differ by the geoid
 *      separation — about −32 m in San Francisco. That walk, at a true 15 m,
 *      recorded −14 to −21 m. The offset is the whole explanation.
 *
 *   2. Vertical GNSS error is two to three times the horizontal error. The
 *      same walk wandered across 44 m of altitude while Strava, with a
 *      barometer and a terrain model, reported a 9 m spread and no climb at
 *      all. Ours claimed 33 m of ascent on ground that does not rise.
 *
 * Neither is fixable by filtering, because neither is noise in the sense a
 * filter understands — one is a constant offset and the other is larger than
 * the signal. The answer is to stop asking the phone. The app already
 * downloads a terrain model for every route it draws, at roughly 10 m a pixel;
 * reading the track's elevation straight off that is both far more accurate
 * and free, since the tiles are being fetched anyway.
 *
 * This is what Strava calls elevation correction and it is the same idea.
 *
 * The one thing a terrain model cannot know is which floor of a building you
 * are on, or that you crossed a bridge rather than the river under it. For
 * running, walking and riding outdoors that trade is overwhelmingly worth it.
 */

import { TILES, sceneFrame, pickZoom, loadTiles, demSampler } from './terrain.js';

/**
 * Recompute ascent and descent over a set of elevations.
 *
 * Give it RAW elevations. analyze() stores the smoothed series in `track.ele`,
 * so passing that back in here smooths a second time and reports about half
 * the climb — a real measurement on a flat run came out 10.1 m one way and
 * 5.0 m the other, which looks exactly like something being double-counted
 * and is the opposite.
 *
 * Deliberately the same arithmetic as `analyze()` in gpx.js — thirty-one
 * samples of smoothing and a five metre threshold — so a corrected route and
 * an uncorrected one are measured the same way and the numbers can be
 * compared. Pauses reset the reference, since the ground either side of a
 * break has nothing to do with a climb.
 */
export function gainLoss(ele, breaks = [], { smoothWindow = 31, gainThreshold = 5 } = {}) {
  const isBreak = new Set(breaks);
  const sm = ele.map((_, i) => {
    const lo = Math.max(0, i - (smoothWindow >> 1)), hi = Math.min(ele.length, i + (smoothWindow >> 1) + 1);
    let s = 0; for (let k = lo; k < hi; k++) s += ele[k];
    return s / (hi - lo);
  });
  let gain = 0, loss = 0, ref = sm[0] ?? 0;
  for (let i = 0; i < sm.length; i++) {
    if (isBreak.has(i)) { ref = sm[i]; continue; }
    const d = sm[i] - ref;
    if (Math.abs(d) >= gainThreshold) { d > 0 ? gain += d : loss -= d; ref = sm[i]; }
  }
  // The smoothed series comes back too: it is what the caller should store,
  // and recomputing it there would be the same work done twice and a second
  // place for the window size to drift.
  return { gain, loss, smoothed: sm };
}

/**
 * Replace a track's elevations with the ground beneath it.
 *
 * Mutates nothing: returns a new track, so a caller can show the corrected
 * one and still have the recorded numbers to compare against or fall back to.
 *
 * @param {object} track   an analysed track
 * @param {(lat:number, lon:number) => number} sample  metres above sea level
 */
export function applyGround(track, sample) {
  const raw = new Array(track.lat.length);
  for (let i = 0; i < track.lat.length; i++) raw[i] = sample(track.lat[i], track.lon[i]);

  const { gain, loss, smoothed } = gainLoss(raw, track.breaks ?? []);
  // Stored smoothed, because that is what analyze() stores and what the
  // profile, the ribbon colours and the legend are all drawn from. Handing
  // back the raw samples instead would make a corrected route's profile a
  // slightly different kind of line from every other route's — and would make
  // its ascent incomparable with the figure it replaced, which is measured
  // over the smoothed series.
  const ele = Float32Array.from(smoothed);
  let min = Infinity, max = -Infinity;
  for (const e of smoothed) { if (e < min) min = e; if (e > max) max = e; }

  return {
    ...track,
    ele,
    elevationSource: 'terrain',
    stats: {
      ...track.stats,
      gain_m: gain,
      loss_m: loss,
      ele_min: min,
      ele_max: max,
      // kept so the difference can be shown, and so nothing is silently lost
      gps_gain_m: track.stats.gain_m,
      gps_ele_min: track.stats.ele_min,
      gps_ele_max: track.stats.ele_max,
    },
  };
}

/**
 * Fetch a terrain model for this track and correct it.
 *
 * Returns the corrected track, or null if the tiles did not arrive — offline,
 * usually, which is not an error and must not stop a route being shown. The
 * caller keeps what it had.
 *
 * `sample` can be passed in by a caller that has already loaded a terrain
 * model for its own reasons, which is the viewer's case: it has one in hand by
 * the time it draws anything, so correcting costs it nothing at all.
 */
export async function correctElevation(track, { sample = null, maxTiles = 4 } = {}) {
  try {
    let fn = sample;
    if (!fn) {
      const frame = sceneFrame(track);
      const spec = pickZoom(frame, 14, 10, maxTiles);
      const dem = await loadTiles(spec, TILES.terrarium.url, null);
      if (!dem?.ok) return null;
      fn = demSampler(dem);
    }
    if (!fn) return null;
    return applyGround(track, fn);
  } catch {
    return null;                  // no terrain is a reason to show the route as recorded
  }
}
