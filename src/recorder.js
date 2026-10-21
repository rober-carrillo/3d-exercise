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
  walk:  { smooth: 0.12, stillFactor: 1.5, minMove: 3, windowMs: 24000 },
  run:   { smooth: 0.12, stillFactor: 1.5, minMove: 3, windowMs: 24000 },
  ride:  { smooth: 0.12, stillFactor: 1.5, minMove: 4, windowMs: 24000 },
  // A game is played inside a few dozen metres, so a long window would decide
  // you were going nowhere — which, in the sense the window means, you are.
  field: { smooth: 0.55, stillFactor: 0.9, minMove: 2, windowMs: 12000 },
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
    const { maxAccuracy = 35, windowMs = preset.windowMs,
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
    /**
     * A second, much lighter time constant, for fixes that have already been
     * smoothed before they reach us.
     *
     * The raw GPS provider hands over what the chip computed and nothing more,
     * and that needs the full easing below or distance accumulates scatter on
     * every step. Google's fused provider does not: it runs its own motion
     * model over the satellites using the accelerometer and gyroscope, and
     * what comes out has already had the jitter taken off it. Easing that
     * again is not filtering, it is lag — and lag is what rounds the corners
     * off a route and loses its length.
     *
     * Measured on a 2.87 km run with both phones in the same pocket: at the
     * full time constant our track came out 132 m short of Strava's, and
     * noticeably smoother than Strava's own, which is the giveaway. At this
     * one it is 69 m short and still smoother — half the loss recovered with
     * the scatter still below what Strava ships.
     *
     * It costs very little of the drift protection, because almost none of
     * that comes from here. Standing still is caught by the windowed centroid
     * further down, which compares raw fixes and never sees the smoothing at
     * all; across this whole range of time constants a stationary phone moves
     * the needle by about a third, while the distance recovered is half the
     * error. The window is the defence, not the easing.
     */
    this.tauSmoothed = opts.tauSmoothed ?? -1 / Math.log(1 - 0.45);
    this._pos = null;          // the smoothed position everything is measured from
    this.maxSpeed = LIMITS[activity] ?? LIMITS.run;
    this._win = [];            // recent raw fixes, for telling walking from wandering
    this.points = [];          // the track as written: {lat, lon, ele, t}
    this.breaks = [];          // indices where the recording resumed after a pause
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
    this._elapsedClosed = 0;     // segments already finished, in ms
    this._segStart = null;       // first fix of the segment running now
    this._segLast = null;        // most recent fix of it, kept or not
  }
  pause(now = Date.now()) {
    if (this.state !== 'recording') return;
    // Close the segment on the fix clock, not the wall clock: the stopwatch
    // has to agree with the timestamps that end up in the file.
    if (this._segStart != null && this._segLast != null) {
      this._elapsedClosed += Math.max(0, this._segLast - this._segStart);
    }
    this._segStart = this._segLast = null;
    this.state = 'paused';
    this._pauseBegan = now;
  }
  resume(now = Date.now()) {
    if (this.state !== 'paused') return;
    this.pausedFor += now - this._pauseBegan;
    this._pauseBegan = null;
    this.state = 'recording';
    // Everything that remembers where you were has to forget. The distance
    // anchor, or the walk across the pause is counted; the smoothed position,
    // or it eases over from the old place and drags a tail behind it; and the
    // movement window, or the first fixes back get judged against fixes from
    // before you stopped. The next point recorded starts a new segment, which
    // is how the file says the pen came off the paper.
    this._last = null;
    this._pos = null;
    this._win = [];
    this._segStart = this._segLast = null;   // the next fix opens a new one
    this._resumed = this.points.length > 0;
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

    // The stopwatch runs on every fix that arrives, whatever is decided about
    // it below. Standing at a crossing is part of the outing: the person did
    // not press pause, so the clock does not stop, and the pace they see is
    // the pace they ran — minutes per kilometre over the time it took, not
    // over some subset of it the filter happened to approve of.
    //
    // This used to advance only when a fix was kept, so a wait at a light
    // froze the display, and the pace then quietly improved while somebody
    // stood still.
    if (this._segStart == null) this._segStart = t;
    this._segLast = Math.max(this._segLast ?? t, t);
    if (acc > this.maxAccuracy) { this.rejected.accuracy++; return 'accuracy'; }

    // A window of raw fixes, kept whatever we decide about them. Drift is
    // a random walk: it wanders but it does not *go* anywhere, so over ten-odd
    // seconds it stays within a few metres of where it started while even a
    // slow walk has plainly left. Net displacement across the window separates
    // the two; comparing each fix with the one before it cannot, because single
    // steps of drift are the same size as single steps of walking.
    //
    // Its length is the thing to get right. Half the window of travel has to
    // stand clearly above the scatter, and a stroll covers very little: at
    // 0.8 m/s a sixteen second window separates the halves by six metres,
    // which a phone reporting six metres of accuracy cannot be distinguished
    // from. Twenty-four seconds is what it takes for a slow walk to be
    // obviously going somewhere.
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
    // Providers that have already run a motion model get the light touch.
    // A browser reports no provider at all, and gets the careful one.
    const preSmoothed = fix.provider && fix.provider !== 'gps';
    const tau = preSmoothed ? this.tauSmoothed : this.tau;
    const a = this._pos ? 1 - Math.exp(-gapS / tau) : 1;
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

      // Once the window has filled, it decides whether you are going anywhere,
      // by comparing where the older half of it sits against the newer half.
      // Before it has filled there are fewer fixes to average, but the
      // question is the same one and it is asked the same way: how far has
      // this person actually got, net, since the window began?
      //
      // It used to ask something quite different — whether one single step
      // exceeded the fix's own accuracy — and that is a gate a runner cannot
      // pass. At 1 Hz a person running covers about three metres between
      // fixes, while the gate demanded at least the accuracy figure, six
      // metres on a good day and forty on a cold receiver. So the opening of
      // every recording was discarded: measured against a real run, every fix
      // in the first eleven seconds, and far more than that before the GPS had
      // settled.
      //
      // Worse than the loss itself is the shape of it. Rejected fixes do not
      // advance `_last`, so when one finally passes, the distance is measured
      // from wherever the person was standing when they pressed Record — and
      // the track jumps there in a straight line, cutting off whatever they
      // actually ran in between. That is the corner cut across a whole block.
      // Both halves of this compare raw fixes, never the smoothed position.
      // The smoothing is deliberately slow — it moves about a eighth of the
      // way towards each new fix — so at the start of a recording the smoothed
      // point has barely left the first one however fast the person is
      // actually going. Measuring movement with it asks whether the filter has
      // caught up, not whether anybody has moved.
      const raw = { lat: fix.lat, lon: fix.lon };
      const going = span_s >= this.windowMs / 2000
        ? distance(this._mean(0), this._mean(1)) >= stillGate
        : distance(this._win[0], raw) >= stillGate;
      if (!going) { this.rejected.still++; return 'still'; }

      // There used to be a second gate here, dropping any individual step
      // shorter than minMove even when the window had just established that
      // you were plainly going somewhere. It was there to stop drift
      // accumulating while stationary, which is a real problem — but the
      // window above already answers that question, and far better, because
      // it looks at net displacement over twenty-four seconds instead of at
      // one step.
      //
      // What the second gate actually did was throw away two thirds of the
      // track. At a 1.35 m/s walk a 3 m floor means no point is kept until
      // nearly three seconds have passed, which is exactly the spacing a real
      // recording came back with: 1 Hz in, 0.37 Hz out, minimum step 2.97 m.
      // Fed the same 1 Hz track with and without it, the recorder produces
      // 114 points and 463 m, or 335 points and 463 m. Identical distance,
      // three times the resolution.
      //
      // The smoothing is unaffected either way: its weight comes from the
      // time since the last fix, not from how many fixes there have been, so
      // it is the same strength in seconds whichever way this goes.

      this.distance_m += d;
      this.moving_ms += Math.min(dt, 10) * 1000;   // a long gap is a pause, not a sprint
    }

    if (this._resumed) { this.breaks.push(this.points.length); this._resumed = false; }
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
    // Elapsed is the sum of the recorded segments: within each one, the last
    // fix minus the first. Nothing needs to be subtracted afterwards, because
    // a pause is simply a span that no segment covers.
    //
    // The arithmetic it replaces kept a running total of paused milliseconds
    // and took it off the overall span. That double-counted whenever the fixes
    // had not resumed — stopping while still paused subtracted a pause that
    // the fix clock had never included, and a ten minute run that ended on a
    // twenty minute pause reported an elapsed time of zero.
    const open = this._segStart != null && this._segLast != null
      ? Math.max(0, this._segLast - this._segStart) : 0;
    const elapsed_s = Math.max(0, (this._elapsedClosed + open) / 1000);
    // How much of that was spent actually covering ground. Reported because it
    // is interesting, and deliberately not what pace is divided by.
    const moving_s = this.moving_ms / 1000;
    return {
      distance_m: this.distance_m,
      elapsed_s,
      moving_s,
      points: this.points.length,
      // Pace over elapsed time, which is the number on everybody else's watch:
      // distance divided by how long the outing took, with only a deliberate
      // pause taken off.
      pace_s_per_km: this.distance_m > 20 && elapsed_s > 0 ? elapsed_s / (this.distance_m / 1000) : null,
      speed_kmh: elapsed_s > 0 ? this.distance_m / elapsed_s * 3.6 : 0,
    };
  }

  /** The recorded track, in the shape parseGPX would have produced. */
  track(name = 'Recorded route') {
    return {
      name,
      time: this.points.length ? new Date(this.points[0].t).toISOString() : null,
      points: this.points.map(p => [p.lat, p.lon, p.ele, p.t]),
      breaks: [...this.breaks],
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
    const brk = new Set(this.breaks);
    const body = this.points.map((p, i) =>
      (brk.has(i) && i > 0 ? `  </trkseg>\n  <trkseg>\n` : '') +
      `   <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n` +
      `    <ele>${p.ele.toFixed(1)}</ele>\n` +
      `    <time>${iso(p.t)}</time>\n` +
      `   </trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Salpicón!" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
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
