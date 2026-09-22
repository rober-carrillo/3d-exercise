/**
 * RouteViewer — mounts the whole 3D route experience into one element.
 *
 *   import { RouteViewer } from './src/viewer.js';
 *   new RouteViewer({ mount: document.body, gpxUrl: 'routes/my-walk.gpx' });
 *
 * Everything is derived from the GPX at runtime: nothing about a route is baked
 * into the build, so adding a track means adding a .gpx file and nothing else.
 */

import { loadTrack, parseGPX, analyze, formatDate } from './gpx.js';
import { Renderer } from './renderer.js';
import {
  TILES, sceneFrame, pickZoom, loadTiles, demSampler, idwSampler, buildGeometry, rampCss, clamp,
} from './terrain.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** first index whose value reaches `v`, in a non-decreasing array */
const bisect = (arr, v) => {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
};

const TEMPLATE = `
<canvas class="rv-gl"></canvas>

<div class="rv-panel rv-title" data-open="1">
  <a class="rv-back" hidden>← All routes</a>
  <button class="rv-titlebtn" aria-expanded="true">
    <h1 class="rv-name">—</h1><span class="rv-caret">▾</span>
  </button>
  <div class="rv-fold">
  <div class="rv-sub">3D route</div>
  <div class="rv-stats">
    <div><span class="rv-k">Distance</span><span class="rv-v rv-s-dist">—</span></div>
    <div><span class="rv-k">Ascent</span><span class="rv-v rv-s-gain">—</span></div>
    <div><span class="rv-k">Descent</span><span class="rv-v rv-s-loss">—</span></div>
    <div><span class="rv-k">High point</span><span class="rv-v rv-s-max">—</span></div>
  </div>
  </div>
</div>

<div class="rv-panel rv-ctrl">
  <div class="rv-row"><span class="rv-lab">Vertical scale</span><span class="rv-val rv-vex-v">1.0×</span></div>
  <input type="range" class="rv-vex" min="1" max="5" step="0.1" value="1">
  <div class="rv-row rv-mt"><span class="rv-lab">Satellite imagery</span><div class="rv-sw on" data-key="texture"></div></div>
  <div class="rv-row"><span class="rv-lab">Elevation curtain</span><div class="rv-sw on" data-key="curtain"></div></div>
  <div class="rv-row"><span class="rv-lab">Chase camera</span><div class="rv-sw" data-key="chase"></div></div>
  <div class="rv-row"><span class="rv-lab">Recorded pace</span><div class="rv-sw" data-key="pace"></div></div>
  <div class="rv-btns">
    <button class="rv-play rv-pri">▶ Fly route</button>
    <button class="rv-speed" title="Playback speed">1×</button>
    <button class="rv-reset">Reset</button>
  </div>
</div>

<div class="rv-fabs">
  <button class="rv-fab rv-fab-play" title="Fly route" aria-label="Fly route">▶</button>
  <button class="rv-fab rv-fab-set" title="Settings" aria-label="Settings" aria-expanded="false">☰</button>
</div>

<div class="rv-panel rv-legend">
  Elevation
  <div class="rv-ramp"></div>
  <div class="rv-lgrow"><span class="rv-lg-lo">—</span><span class="rv-lg-hi">—</span></div>
</div>

<div class="rv-panel rv-status"><span class="rv-dot"></span><span class="rv-st-txt">loading…</span></div>

<div class="rv-panel rv-profile">
  <div class="rv-cap">Elevation profile</div>
  <div class="rv-readout"></div>
  <svg class="rv-prof" preserveAspectRatio="none"></svg>
</div>

<div class="rv-hint">drag to orbit · scroll to zoom · shift-drag to pan</div>

<div class="rv-load">
  <div class="rv-ttl">Building 3D terrain</div>
  <div class="rv-bar"><i></i></div>
  <div class="rv-msg">reading track…</div>
</div>`;

export const VERSION = '1.5.1';

export class RouteViewer {
  constructor(opts) {
    this.opts = Object.assign({
      imagery: 'esri',        // 'esri' | 'osm' | false
      flyDuration: 45,        // seconds for the full route at 1×
      satMaxTiles: 8,
      demMaxTiles: 4,
      vex: 1,
      date: null,             // fallback date for a track with no time of its own
    }, opts);
    this.mount = opts.mount;
    this.mount.classList.add('rv-root');
    this.mount.innerHTML = TEMPLATE;
    this.mount.querySelector('.rv-ttl').textContent = `Building 3D terrain · v${VERSION}`;
    console.info(`route3d v${VERSION}`);
    this.$ = sel => this.mount.querySelector('.rv-' + sel);
    this.play = false;
    this.playT = 0;
    this.speed = 1;
    this.progress = { done: 0, total: 1 };
    this.boot().catch(err => this.fail(err));
  }

  msg(t) { const n = this.$('msg'); if (n) n.textContent = t; }
  tick() {
    this.progress.done++;
    const i = this.mount.querySelector('.rv-bar i');
    if (i) i.style.width = Math.min(100, this.progress.done / this.progress.total * 100) + '%';
  }
  fail(err) {
    console.error(err);
    this.msg(err.message || String(err));
    this.mount.querySelector('.rv-bar').style.display = 'none';
  }

  async boot() {
    const o = this.opts;
    const track = this.track = o.track ? o.track
      : o.gpxText ? analyze(parseGPX(o.gpxText))
      : await loadTrack(o.gpxUrl);
    const s = track.stats;
    this.$('name').textContent = o.name || track.name;
    // the track's own timestamp if it has one, otherwise whatever date the
    // caller knows the route by (the manifest carries the day it was added)
    const stamp = track.time ? formatDate(track.time)
      : o.date ? `added ${formatDate(o.date)}` : '';
    this.$('sub').textContent =
      `${stamp ? stamp + ' · ' : ''}${s.points.toLocaleString()} GPS points · ${((track.bbox.minLat + track.bbox.maxLat) / 2).toFixed(3)}°, ${((track.bbox.minLon + track.bbox.maxLon) / 2).toFixed(3)}°`;
    this.$('s-dist').innerHTML = (s.distance_m / 1000).toFixed(2) + '<small>km</small>';
    this.$('s-gain').innerHTML = fmt(s.gain_m) + '<small>m</small>';
    this.$('s-loss').innerHTML = fmt(s.loss_m) + '<small>m</small>';
    this.$('s-max').innerHTML = fmt(s.ele_max) + '<small>m</small>';
    this.$('lg-lo').textContent = fmt(s.ele_min) + ' m';
    this.$('lg-hi').textContent = fmt(s.ele_max) + ' m';
    if (o.backHref) { const b = this.$('back'); b.href = o.backHref; b.hidden = false; }
    this.buildProfile();
    this.buildPace();

    const renderer = this.renderer = new Renderer(this.$('gl'));
    renderer.onChaseRelease = () =>
      this.mount.querySelector('.rv-sw[data-key="chase"]').classList.remove('on');
    renderer.state.vex = o.vex;

    const frame = sceneFrame(track);
    // The imagery ceiling was 16 — about 2 m a pixel, so a soccer pitch drew
    // as a green smudge roughly 30 px across. Nothing changes for a route
    // that already fills the tile budget at a lower zoom.
    const satSpec = o.imagery ? pickZoom(frame, 19, 11, o.satMaxTiles) : null;
    const demSpec = pickZoom(frame, 14, 10, o.demMaxTiles);
    this.progress.total = (satSpec ? satSpec.nx * satSpec.ny : 0) + (demSpec ? demSpec.nx * demSpec.ny : 0) || 1;
    this.msg('fetching satellite imagery and elevation data…');

    let [sat, dem] = await Promise.all([
      satSpec ? loadTiles(satSpec, TILES[o.imagery].url, () => this.tick()) : Promise.resolve({ ok: 0 }),
      demSpec ? loadTiles(demSpec, TILES.terrarium.url, () => this.tick()) : Promise.resolve({ ok: 0 }),
    ]);
    let imageryLabel = o.imagery ? TILES[o.imagery].label : null;
    if (satSpec && !sat.ok && o.imagery !== 'osm') {          // imagery blocked → plain map drape
      this.msg('imagery unavailable — trying map tiles…');
      const alt = await loadTiles(satSpec, TILES.osm.url, null);
      if (alt.ok) { sat = alt; imageryLabel = TILES.osm.label; }
    }

    this.msg('shaping terrain…');
    await new Promise(r => setTimeout(r, 30));
    let sample = null, demReal = false;
    if (dem.ok) { const fn = demSampler(dem); if (fn) { sample = fn; demReal = true; } }
    if (!sample) sample = idwSampler(track, frame);

    const g = buildGeometry({
      track, frame, sample, sat,
      N: renderer.caps.uint ? 352 : 224,
      uint: renderer.caps.uint,
    });
    renderer.setGeometry(g);
    if (sat.ok) renderer.setTexture(sat.cv);
    renderer.cam.tz = (s.ele_min + s.ele_max) / 2 - g.zRef;
    renderer.onFrame = dt => this.frame(dt);

    this.$('status').title = `route3d v${VERSION}`;
    const okTex = renderer.hasTexture;
    this.$('dot').className = 'rv-dot ' + (okTex && demReal ? 'ok' : 'warn');
    this.$('st-txt').textContent = okTex && demReal
      ? `${imageryLabel} · ${TILES.terrarium.label}`
      : !okTex && !demReal ? 'Offline — terrain modelled from the GPX track itself'
      : !okTex ? 'Imagery unavailable — shaded relief from real elevation data'
      : `${imageryLabel} · terrain modelled from the GPX track`;
    this.$('st-txt').insertAdjacentHTML('afterend', `<span class="rv-ver">v${VERSION}</span>`);

    this.wire();
    this.scrub(0);
    renderer.start();
    this.$('load').classList.add('gone');
    setTimeout(() => { const l = this.$('load'); l && l.remove(); }, 700);
    setTimeout(() => this.$('hint').classList.add('gone'), 7000);
  }

  wire() {
    const r = this.renderer;
    // A file with no per-point times has no pace to follow: show the switch
    // off and inert rather than letting it promise something it cannot do.
    const paceSw = this.mount.querySelector('.rv-sw[data-key="pace"]');
    r.state.pace = !!this._pace;
    paceSw.classList.toggle('on', !!this._pace);
    if (!this._pace) {
      paceSw.classList.add('rv-dis');
      paceSw.closest('.rv-row').title =
        'This GPX has no timestamps on its points, so there is no pace to replay';
    }
    this.mount.querySelectorAll('.rv-sw').forEach(sw => {
      sw.addEventListener('click', () => {
        const key = sw.dataset.key;
        if (sw.classList.contains('rv-dis')) return;     // nothing to switch to
        // Flipping the clock must not teleport her: note where she is on the
        // route, then wind the new clock to that same place.
        const held = key === 'pace' ? this.distFrac(this.playT) : 0;
        r.state[key] = !r.state[key];
        sw.classList.toggle('on', r.state[key]);
        if (key === 'pace') { this.playT = this.playFrac(held); this.cadence(); }
        if (key === 'chase' && !r.state.chase) r.resetView();
        if (key === 'chase' && r.state.chase) this.$('hint').classList.remove('gone'),
          this.$('hint').textContent = 'chase camera · drag while paused to orbit her freely · Fly route re-centres',
          setTimeout(() => this.$('hint').classList.add('gone'), 6000);
      });
    });
    this.$('vex').addEventListener('input', e => {
      r.state.vex = parseFloat(e.target.value);
      this.$('vex-v').textContent = r.state.vex.toFixed(1) + '×';
    });
    this.$('play').addEventListener('click', () => {
      const starting = !this.play;
      if (starting && this.playT >= 1) this.playT = 0;
      if (starting) {
        // flying the route always begins from directly behind the marker
        r.beginChase();
        this.mount.querySelector('.rv-sw[data-key="chase"]').classList.add('on');
      }
      this.setPlay(starting);
    });
    this.$('speed').addEventListener('click', () => {
      const steps = [0.5, 1, 2, 4];
      this.speed = steps[(steps.indexOf(this.speed) + 1) % steps.length];
      this.$('speed').textContent = this.speed + '×';
      r.walkRate = this.speed;
    });
    this.$('reset').addEventListener('click', () => r.resetView());

    // The stats fold away behind the route name, and on a phone the whole
    // control panel folds behind two buttons — a 6" screen has no room for
    // three permanent panels plus the thing they are describing.
    const title = this.mount.querySelector('.rv-title');
    const titleBtn = this.$('titlebtn');
    const setTitle = open => {
      title.dataset.open = open ? '1' : '0';
      titleBtn.setAttribute('aria-expanded', String(open));
    };
    titleBtn.addEventListener('click', () => setTitle(title.dataset.open !== '1'));
    setTitle(!this.narrow());

    const panel = this.mount.querySelector('.rv-ctrl');
    const setBtn = this.$('fab-set');
    const setPanel = open => {
      panel.classList.toggle('rv-open', open);
      setBtn.setAttribute('aria-expanded', String(open));
    };
    setBtn.addEventListener('click', () => setPanel(!panel.classList.contains('rv-open')));
    this.$('fab-play').addEventListener('click', () => this.$('play').click());
    // touching the scene puts the settings away again
    this.$('gl').addEventListener('pointerdown', () => { if (this.narrow()) setPanel(false); });
    window.addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); this.$('play').click(); }
      if (e.key === 'r' || e.key === 'R') this.$('reset').click();
      if (e.key === 'c' || e.key === 'C') this.mount.querySelector('.rv-sw[data-key="chase"]').click();
      if (e.key === 'p' || e.key === 'P') this.mount.querySelector('.rv-sw[data-key="pace"]').click();
    });
  }

  narrow() { return window.matchMedia('(max-width: 820px)').matches; }

  setPlay(on) {
    this.play = on;
    this.$('fab-play').textContent = on ? '❚❚' : '▶';
    this.$('fab-play').title = on ? 'Pause' : 'Fly route';
    this.renderer.walking = on;            // the figure walks only while replaying
    this.renderer.walkRate = this.speed;
    const b = this.$('play');
    b.textContent = on ? '❚❚ Pause' : '▶ Fly route';
    b.classList.toggle('rv-pri', !on);
  }

  frame(dt) {
    if (!this.play) return;
    // the clock always runs evenly — the flight lasts flyDuration whichever
    // pace is on; what changes is where along the route that clock points
    this.playT += dt * this.speed / this.opts.flyDuration;
    if (this.playT >= 1) { this.playT = 1; this.setPlay(false); }
    this.scrub(this.distFrac(this.playT), true);
    this.cadence();
  }

  /**
   * The clock the replay runs on when "Recorded pace" is on.
   *
   * Played back evenly, a route is only a shape. But the GPS also recorded
   * where you pushed and where you laboured, and that is half of what the
   * outing was. So build a second clock in which every stretch takes as long
   * as it really took, normalised to the same total: the flight still lasts
   * `flyDuration` either way, but the seconds inside it get spent where they
   * were actually spent — long over the climb you walked, brief over the
   * stretch you ran.
   *
   * Idling is the one thing that cannot be taken literally. A third to two
   * thirds of a recorded session is spent standing still — lights, halftime,
   * catching breath — and replayed faithfully that is most of the flight
   * spent watching a motionless figure. So anything slower than a stroll is
   * charged at that stroll, which costs almost nothing because standing still
   * covers no ground: stops read as a beat of a second or two and the rest of
   * the flight is spent moving. Every speed above the floor keeps its real
   * duration exactly, which is the part that matters.
   */
  buildPace() {
    const t = this.track;
    this._pace = null;
    const n = t.secs ? t.secs.length : 0;
    if (n < 2 || n !== t.dist.length) return;            // no per-point times in the file
    const T = t.secs[n - 1], total = t.stats.distance_m;
    if (!(T > 0) || !(total > 0)) return;

    const STILL = Math.max(0.5, total / T * 0.12);       // m/s, well under walking
    const clock = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const ds = t.dist[i] - t.dist[i - 1], dt = t.secs[i] - t.secs[i - 1];
      const v = dt > 0 ? ds / dt : 0;
      clock[i] = clock[i - 1] + ds / Math.max(v, STILL);
    }
    const span = clock[n - 1];                           // ≈ time spent actually moving
    if (!(span > 0)) return;
    for (let i = 0; i < n; i++) clock[i] /= span;

    // Speed per sample, for the walk cycle. Smoothed over ~7 samples because a
    // single bad fix reads as 130 km/h on foot, and her legs would blur.
    const vel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      const dt = t.secs[b] - t.secs[a];
      vel[i] = dt > 0 ? (t.dist[b] - t.dist[a]) / dt : 0;
    }
    this._pace = { clock, vel, total, ref: total / span };
  }

  /** Playback fraction → how far along the route she has got, 0…1. */
  distFrac(p) {
    const pc = this._pace;
    if (!pc || !this.renderer.state.pace) return clamp(p, 0, 1);
    const t = this.track, c = clamp(p, 0, 1), i = bisect(pc.clock, c);
    if (i === 0) return 0;
    const a = pc.clock[i - 1], b = pc.clock[i];
    const u = b > a ? (c - a) / (b - a) : 0;
    return (t.dist[i - 1] + (t.dist[i] - t.dist[i - 1]) * u) / pc.total;
  }

  /** The inverse: dropping her at a point on the route also sets the clock. */
  playFrac(d) {
    const pc = this._pace;
    if (!pc || !this.renderer.state.pace) return clamp(d, 0, 1);
    const t = this.track, m = clamp(d, 0, 1) * pc.total, i = bisect(t.dist, m);
    if (i === 0) return 0;
    const a = t.dist[i - 1], b = t.dist[i];
    const u = b > a ? (m - a) / (b - a) : 0;
    return pc.clock[i - 1] + (pc.clock[i] - pc.clock[i - 1]) * u;
  }

  /**
   * How fast her legs turn. On recorded pace they follow the speed under her
   * feet — still when she is standing, quick when she is running — and the
   * ratio is capped so a GPS spike cannot spin them.
   */
  cadence() {
    const r = this.renderer, pc = this._pace;
    if (!pc || !r.state.pace) { r.walkRate = this.speed; return; }
    const v = pc.vel[clamp(Math.round(this._idx || 0), 0, pc.vel.length - 1)];
    r.walkRate = this.speed * clamp(v / pc.ref, 0, 3);
  }

  buildProfile() {
    const t = this.track, svg = this.$('prof');
    const W = 1000, H = 100, pad = 6;
    const eMin = t.stats.ele_min, eSpan = Math.max(1, t.stats.ele_max - eMin);
    const total = t.stats.distance_m;
    this._prof = { W, H, pad, eMin, eSpan, total };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const X = i => t.dist[i] / total * W;
    const Y = i => H - pad - ((t.ele[i] - eMin) / eSpan) * (H - pad * 2 - 8);
    let d = '';
    for (let i = 0; i < t.lat.length; i++) d += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(i).toFixed(1);
    let stops = '';
    for (let s = 0; s <= 20; s++) {
      const i = Math.round(s / 20 * (t.lat.length - 1));
      stops += `<stop offset="${s * 5}%" stop-color="${rampCss((t.ele[i] - eMin) / eSpan)}"/>`;
    }
    const defs = document.createElementNS(SVGNS, 'defs');
    defs.innerHTML = `<linearGradient id="rv-pg" x1="0" x2="1">${stops}</linearGradient>
      <linearGradient id="rv-pf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(34,211,238,.30)"/><stop offset="100%" stop-color="rgba(34,211,238,0)"/></linearGradient>`;
    svg.appendChild(defs);
    const mk = (tag, at) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in at) n.setAttribute(k, at[k]);
      svg.appendChild(n); return n;
    };
    mk('path', { d: d + `L${W} ${H} L0 ${H} Z`, fill: 'url(#rv-pf)' });
    mk('path', { d, fill: 'none', stroke: 'url(#rv-pg)', 'stroke-width': 2, 'stroke-linejoin': 'round' });
    this._cursorLine = mk('line', { x1: 0, y1: 0, x2: 0, y2: H, stroke: 'rgba(255,255,255,.45)', 'stroke-width': 1 });
    this._cursorDot = mk('circle', { cx: 0, cy: 0, r: 3.6, fill: '#fff', stroke: '#22d3ee', 'stroke-width': 2 });
    svg.style.cursor = 'crosshair';
    svg.addEventListener('pointermove', e => {
      const box = svg.getBoundingClientRect();
      this.setPlay(false);
      this.scrub(clamp((e.clientX - box.left) / box.width, 0, 1));
    });
  }

  /**
   * Move to a fraction of the *route*; drives markers, chase camera and readout.
   *
   * Playback has already advanced its own clock and passes `fromPlayback`, so
   * it is not thrown back by a round trip through the map. Anything else —
   * dragging the elevation profile — is setting the position directly, and the
   * playback clock has to be wound to wherever that lands.
   */
  scrub(f, fromPlayback = false) {
    const t = this.track, p = this._prof;
    if (!fromPlayback) this.playT = this.playFrac(f);
    const d = f * p.total;
    // fractional index: how far *between* two samples we are, so the walker and
    // the profile cursor move continuously instead of hopping sample to sample
    const i = bisect(t.dist, d);
    let idx = i, ele = t.ele[i];
    if (i > 0) {
      const d0 = t.dist[i - 1], d1 = t.dist[i];
      const u = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
      idx = i - 1 + u;
      ele = t.ele[i - 1] + (t.ele[i] - t.ele[i - 1]) * u;
    }
    this.renderer.setCursor(idx);
    this._idx = idx;                       // the cadence reads the speed here
    const x = d / p.total * p.W;
    const y = p.H - p.pad - ((ele - p.eMin) / p.eSpan) * (p.H - p.pad * 2 - 8);
    this._cursorLine.setAttribute('x1', x); this._cursorLine.setAttribute('x2', x);
    this._cursorDot.setAttribute('cx', x); this._cursorDot.setAttribute('cy', y);
    this.$('readout').innerHTML =
      `<b>${(d / 1000).toFixed(2)}</b> km &nbsp;·&nbsp; <b>${fmt(ele)}</b> m`;
  }
}
