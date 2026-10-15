/**
 * Turning a stream of GPS fixes into a track.
 *
 * This is the half of "record a route" that has nothing to do with Android,
 * permissions or plugins: fixes arrive, and something has to decide which are
 * real, how far you have actually gone, and what to write out. It is plain
 * JavaScript over plain objects, so it runs in a browser, in a WebView, in
 * Node, and against a recorded file replayed at a thousand times speed — which
 * is the only practical way to test a thing like this.
 *
 * Where the fixes come from is somebody else's problem: see geo.js.
 */

const R = 6378137, D2R = Math.PI / 180;

/** Metres between two fixes. */
export function distance(a, b) {
  const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * How fast a fix has to claim you moved before we call it nonsense, in m/s.
 * Generous on purpose — these reject teleports, not personal bests.
 */
export const LIMITS = {
  walk: 7,        // 25 km/h
  run: 12,        // 43 km/h
  ride: 30,       // 108 km/h
  field: 12,      // sprints on a pitch reach running speed
};

/**
 * Filtering settings per activity, because one set cannot serve both kinds of
 * movement. Going somewhere — a run, a ride, a walk — is steady and
 * directional, so it can be smoothed hard and gated firmly, which is what
 * stops a phone on a table logging kilometres.
 *
 * A game on a pitch is the opposite: constant short jinks inside a few dozen
 * metres, which is precisely what hard smoothing erases. Measured against two
 * recorded five-a-side sessions, the travelling settings threw away half the
 * distance. So field play gets light smoothing and a small gate, and in
 * exchange it keeps more of the drift. That is the right way round: a
 * stationary phone is not a thing that happens mid-match.
 */
export const PRESETS = {
  walk:  { smooth: 0.20, stillFactor: 2.2, minMove: 3 },
  run:   { smooth: 0.20, stillFactor: 2.2, minMove: 3 },
  ride:  { smooth: 0.25, stillFactor: 2.2, minMove: 4 },
  field: { smooth: 0.55, stillFactor: 0.9, minMove: 2 },
};

export class TrackRecorder {
  /**
   * @param {object} opts
   *   activity      walk | run | ride — only sets the speed sanity limit
   *   maxAccuracy   drop fixes less certain than this many metres
   *   minMove       never count a move smaller than this, whatever the accuracy
   */
  constructor(opts = {}) {
    const activity = opts.activity ?? 'run';
    const preset = PRESETS[activity] ?? PRESETS.run;
    const { maxAccuracy = 35, windowMs = 16000,
            minMove = preset.minMove, stillFactor = preset.stillFactor, smooth = preset.smooth } = opts;
    this.activity = activity;
    this.maxAccuracy = maxAccuracy;
    this.minMove = minMove;
    this.windowMs = windowMs;
    this.stillFactor = stillFactor;
    this.smooth = smooth;      // kept for callers that tune by hand
    // the per-fix fraction the presets were tuned with, expressed as the time
    // constant that reproduces it at the 1 Hz they were tuned at
    this.tau = opts.tau ?? -1 / Math.log(1 - Math.min(0.999, smooth));
    this._pos = null;          // the smoothed position everything is measured from
    this.maxSpeed = LIMITS[activity] ?? LIMITS.run;
    this._win = [];            // recent raw fixes, for telling walking from wandering
    this.points = [];          // the track as written: {lat, lon, ele, t}
    this.distance_m = 0;
    this.moving_ms = 0;
    this.rejected = { accuracy: 0, teleport: 0, still: 0, stale: 0 };
    this.state = 'idle';       // idle | recording | paused | stopped
    this.startedAt = null;
    this.pausedFor = 0;        // ms spent paused, so elapsed stays honest
    this._pauseBegan = null;
    this._last = null;         // last fix we accepted as a real position
  }

  start(now = Date.now()) {
    if (this.state === 'recording') return;
    if (this.state === 'paused') return this.resume(now);
    this.state = 'recording';
    this.startedAt = now;
  }
  pause(now = Date.now()) {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    this._pauseBegan = now;
  }
  resume(now = Date.now()) {
    if (this.state !== 'paused') return;
    this.pausedFor += now - this._pauseBegan;
    this._pauseBegan = null;
    this.state = 'recording';
    this._last = null;         // don't draw a line across wherever you went
  }
  stop(now = Date.now()) {
    if (this.state === 'paused') this.pausedFor += now - this._pauseBegan;
    this.state = 'stopped';
    return this.points.length >= 2 ? this.track() : null;
  }

  /**
   * Offer one fix: `{ lat, lon, ele, accuracy, t }`, accuracy in metres and
   * `t` in epoch milliseconds. Returns why it was turned away, or null if it
   * became part of the track.
   *
   * Three things get a fix rejected, and the third is the one that matters.
   * A fix can be too uncertain to use, or claim a speed nobody reaches. But
   * mostly it is simply you, standing still, while the receiver wanders: left
   * alone that wander accumulates into real-looking kilometres, and it is why
   * a phone left on a table can record a 5 km walk. A fix only counts as
   * movement once it exceeds the uncertainty in its own position, so the
   * noisier the signal, the further you must really go to register.
   */
  addFix(fix) {
    if (this.state !== 'recording') return 'not recording';
    const t = fix.t ?? Date.now();
    const acc = fix.accuracy ?? 0;

    const prevFixT = this._lastFixT;          // captured before the clock moves on
    this._lastFixT = Math.max(this._lastFixT ?? 0, t);
    if (acc > this.maxAccuracy) { this.rejected.accuracy++; return 'accuracy'; }

    // A short window of raw fixes, kept whatever we decide about them. Drift is
    // a random walk: it wanders but it does not *go* anywhere, so over ten-odd
    // seconds it stays within a few metres of where it started while even a
    // slow walk has plainly left. Net displacement across the window separates
    // the two; comparing each fix with the one before it cannot, because single
    // steps of drift are the same size as single steps of walking.
    this._win.push({ lat: fix.lat, lon: fix.lon, t });
    while (this._win.length > 1 && t - this._win[0].t > this.windowMs) this._win.shift();
    const span_s = (t - this._win[0].t) / 1000;
    const stillGate = Math.max(this.minMove * 0.8, acc * this.stillFactor);

    // Smooth the position before measuring anything from it. Every fix carries
    // several metres of scatter, and distance summed from raw fixes adds that
    // scatter on every single step: a 10 m walk sampled ten times with 5 m
    // noise measures nearer 70 m. Easing towards each new fix instead of
    // jumping to it costs a little lag and removes most of that.
    //
    // The easing is per second, not per fix. Fixes arrive about once a second
    // in the foreground but far more slowly when Android is in a mood, and a
    // fixed fraction per fix means the smoothed position falls further and
    // further behind as the gaps grow — at half a minute between fixes it is
    // lagging minutes, and the route shrinks to the chords of its own corners.
    // Converting a time constant into a per-gap weight keeps the smoothing the
    // same strength in seconds however often the fixes come, and a long gap
    // ends up trusting its fix almost completely, which is the right answer.
    const gapS = this._pos && prevFixT ? Math.max(0.05, (t - prevFixT) / 1000) : 0;
    const a = this._pos ? 1 - Math.exp(-gapS / this.tau) : 1;
    const pos = this._pos
      ? { lat: this._pos.lat + (fix.lat - this._pos.lat) * a,
          lon: this._pos.lon + (fix.lon - this._pos.lon) * a }
      : { lat: fix.lat, lon: fix.lon };
    this._pos = pos;

    const last = this._last;
    if (last) {
      const dt = (t - last.t) / 1000;
      if (dt <= 0) { this.rejected.stale++; return 'stale'; }
      const d = distance(last, pos);
      if (d / dt > this.maxSpeed) { this.rejected.teleport++; return 'teleport'; }

      // Once the window has filled, it decides whether you are going anywhere.
      // Before that there is nothing to judge by, so fall back to the fix's own
      // uncertainty and let the window take over a few seconds in.
      const going = span_s >= this.windowMs / 2000
        ? distance(this._mean(0), this._mean(1)) >= stillGate
        : d >= Math.max(this.minMove, acc);
      if (!going) { this.rejected.still++; return 'still'; }
      if (d < this.minMove) { this.rejected.still++; return 'still'; }

      this.distance_m += d;
      this.moving_ms += Math.min(dt, 10) * 1000;   // a long gap is a pause, not a sprint
    }

    this.points.push({ lat: pos.lat, lon: pos.lon, ele: fix.ele ?? 0, t });
    this._lastFixT = t;
    this._last = { lat: pos.lat, lon: pos.lon, accuracy: acc, t };
    return null;
  }

  /**
   * Centre of the older (`half` 0) or newer (`half` 1) half of the window.
   *
   * Averaging is what makes the comparison work. One fix against one fix is
   * two noisy numbers subtracted, and the noise wins; the centre of six fixes
   * is steady to about a metre, so what is left between the two halves is
   * movement rather than scatter.
   */
  _mean(half) {
    const w = this._win, mid = Math.floor(w.length / 2);
    const part = half === 0 ? w.slice(0, Math.max(1, mid)) : w.slice(mid);
    let lat = 0, lon = 0;
    for (const p of part) { lat += p.lat; lon += p.lon; }
    return { lat: lat / part.length, lon: lon / part.length };
  }

  /** Live numbers for the recording screen. */
  get stats() {
    // Elapsed is measured between fixes rather than off the wall clock. Live
    // they are the same thing, since fixes arrive about once a second; but a
    // track replayed through the recorder for testing carries its own clock,
    // and the numbers should describe the outing, not the test harness.
    const first = this.points.length ? this.points[0].t : null;
    const elapsed_ms = first === null ? 0
      : Math.max(0, (this._lastFixT ?? first) - first - this.pausedFor);
    const moving_s = this.moving_ms / 1000;
    return {
      distance_m: this.distance_m,
      elapsed_s: Math.max(0, elapsed_ms / 1000),
      moving_s,
      points: this.points.length,
      // pace in seconds per kilometre, the unit runners actually read
      pace_s_per_km: this.distance_m > 20 ? moving_s / (this.distance_m / 1000) : null,
      speed_kmh: moving_s > 0 ? this.distance_m / moving_s * 3.6 : 0,
    };
  }

  /** The recorded track, in the shape parseGPX would have produced. */
  track(name = 'Recorded route') {
    return {
      name,
      time: this.points.length ? new Date(this.points[0].t).toISOString() : null,
      points: this.points.map(p => [p.lat, p.lon, p.ele, p.t]),
    };
  }

  /**
   * GPX 1.1, with a <time> on every point — which is what makes a recorded
   * route play back at the pace it was run.
   */
  toGPX(name = 'Recorded route', { activity = this.activity } = {}) {
    const esc = s => String(s).replace(/[<>&'"]/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body = this.points.map(p =>
      `   <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n` +
      `    <ele>${p.ele.toFixed(1)}</ele>\n` +
      `    <time>${iso(p.t)}</time>\n` +
      `   </trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="route3d" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata>
  <time>${this.points.length ? iso(this.points[0].t) : iso(Date.now())}</time>
 </metadata>
 <trk>
  <name>${esc(name)}</name>
  <type>${esc(activity)}</type>
  <trkseg>
${body}
  </trkseg>
 </trk>
</gpx>
`;
  }
}
