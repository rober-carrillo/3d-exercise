/**
 * RouteViewer — mounts the whole 3D route experience into one element.
 *
 *   import { RouteViewer } from './src/viewer.js';
 *   new RouteViewer({ mount: document.body, gpxUrl: 'routes/my-walk.gpx' });
 *
 * Everything is derived from the GPX at runtime: nothing about a route is baked
 * into the build, so adding a track means adding a .gpx file and nothing else.
 */

import { loadTrack } from './gpx.js';
import { Renderer } from './renderer.js';
import {
  TILES, sceneFrame, pickZoom, loadTiles, demSampler, idwSampler, buildGeometry, rampCss, clamp,
} from './terrain.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const TEMPLATE = `
<canvas class="rv-gl"></canvas>

<div class="rv-panel rv-title">
  <a class="rv-back" hidden>← All routes</a>
  <h1 class="rv-name">—</h1>
  <div class="rv-sub">3D route</div>
  <div class="rv-stats">
    <div><span class="rv-k">Distance</span><span class="rv-v rv-s-dist">—</span></div>
    <div><span class="rv-k">Ascent</span><span class="rv-v rv-s-gain">—</span></div>
    <div><span class="rv-k">Descent</span><span class="rv-v rv-s-loss">—</span></div>
    <div><span class="rv-k">High point</span><span class="rv-v rv-s-max">—</span></div>
  </div>
</div>

<div class="rv-panel rv-ctrl">
  <div class="rv-row"><span class="rv-lab">Vertical scale</span><span class="rv-val rv-vex-v">1.8×</span></div>
  <input type="range" class="rv-vex" min="1" max="5" step="0.1" value="1.8">
  <div class="rv-row rv-mt"><span class="rv-lab">Satellite imagery</span><div class="rv-sw on" data-key="texture"></div></div>
  <div class="rv-row"><span class="rv-lab">Elevation curtain</span><div class="rv-sw on" data-key="curtain"></div></div>
  <div class="rv-row"><span class="rv-lab">Chase camera</span><div class="rv-sw" data-key="chase"></div></div>
  <div class="rv-btns">
    <button class="rv-play rv-pri">▶ Fly route</button>
    <button class="rv-speed" title="Playback speed">1×</button>
    <button class="rv-reset">Reset</button>
  </div>
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

export class RouteViewer {
  constructor(opts) {
    this.opts = Object.assign({
      imagery: 'esri',        // 'esri' | 'osm' | false
      flyDuration: 45,        // seconds for the full route at 1×
      satMaxTiles: 8,
      demMaxTiles: 4,
      vex: 1.8,
    }, opts);
    this.mount = opts.mount;
    this.mount.classList.add('rv-root');
    this.mount.innerHTML = TEMPLATE;
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
    const track = this.track = await loadTrack(o.gpxUrl);
    const s = track.stats;
    this.$('name').textContent = o.name || track.name;
    this.$('sub').textContent =
      `${s.points.toLocaleString()} GPS points · ${((track.bbox.minLat + track.bbox.maxLat) / 2).toFixed(3)}°, ${((track.bbox.minLon + track.bbox.maxLon) / 2).toFixed(3)}°`;
    this.$('s-dist').innerHTML = (s.distance_m / 1000).toFixed(2) + '<small>km</small>';
    this.$('s-gain').innerHTML = fmt(s.gain_m) + '<small>m</small>';
    this.$('s-loss').innerHTML = fmt(s.loss_m) + '<small>m</small>';
    this.$('s-max').innerHTML = fmt(s.ele_max) + '<small>m</small>';
    this.$('lg-lo').textContent = fmt(s.ele_min) + ' m';
    this.$('lg-hi').textContent = fmt(s.ele_max) + ' m';
    if (o.backHref) { const b = this.$('back'); b.href = o.backHref; b.hidden = false; }
    this.buildProfile();

    const renderer = this.renderer = new Renderer(this.$('gl'));
    renderer.state.vex = o.vex;

    const frame = sceneFrame(track);
    const satSpec = o.imagery ? pickZoom(frame, 16, 11, o.satMaxTiles) : null;
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

    const okTex = renderer.hasTexture;
    this.$('dot').className = 'rv-dot ' + (okTex && demReal ? 'ok' : 'warn');
    this.$('st-txt').textContent = okTex && demReal
      ? `${imageryLabel} · ${TILES.terrarium.label}`
      : !okTex && !demReal ? 'Offline — terrain modelled from the GPX track itself'
      : !okTex ? 'Imagery unavailable — shaded relief from real elevation data'
      : `${imageryLabel} · terrain modelled from the GPX track`;

    this.wire();
    this.scrub(0);
    renderer.start();
    this.$('load').classList.add('gone');
    setTimeout(() => { const l = this.$('load'); l && l.remove(); }, 700);
    setTimeout(() => this.$('hint').classList.add('gone'), 7000);
  }

  wire() {
    const r = this.renderer;
    this.mount.querySelectorAll('.rv-sw').forEach(sw => {
      sw.addEventListener('click', () => {
        const key = sw.dataset.key;
        r.state[key] = !r.state[key];
        sw.classList.toggle('on', r.state[key]);
        if (key === 'chase' && !r.state.chase) r.resetView();
        if (key === 'chase' && r.state.chase) this.$('hint').classList.remove('gone'),
          this.$('hint').textContent = 'chase camera · drag to look around the runner · scroll to change follow distance',
          setTimeout(() => this.$('hint').classList.add('gone'), 6000);
      });
    });
    this.$('vex').addEventListener('input', e => {
      r.state.vex = parseFloat(e.target.value);
      this.$('vex-v').textContent = r.state.vex.toFixed(1) + '×';
    });
    this.$('play').addEventListener('click', () => {
      if (!this.play && this.playT >= 1) this.playT = 0;
      this.setPlay(!this.play);
    });
    this.$('speed').addEventListener('click', () => {
      const steps = [0.5, 1, 2, 4];
      this.speed = steps[(steps.indexOf(this.speed) + 1) % steps.length];
      this.$('speed').textContent = this.speed + '×';
    });
    this.$('reset').addEventListener('click', () => r.resetView());
    window.addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); this.$('play').click(); }
      if (e.key === 'r' || e.key === 'R') this.$('reset').click();
      if (e.key === 'c' || e.key === 'C') this.mount.querySelector('.rv-sw[data-key="chase"]').click();
    });
  }

  setPlay(on) {
    this.play = on;
    const b = this.$('play');
    b.textContent = on ? '❚❚ Pause' : '▶ Fly route';
    b.classList.toggle('rv-pri', !on);
  }

  frame(dt) {
    if (!this.play) return;
    this.playT += dt * this.speed / this.opts.flyDuration;
    if (this.playT >= 1) { this.playT = 1; this.setPlay(false); }
    this.scrub(this.playT);
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

  /** Move to a fraction of the route; drives markers, chase camera and readout. */
  scrub(f) {
    const t = this.track, p = this._prof;
    this.playT = f;
    const d = f * p.total;
    let lo = 0, hi = t.dist.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t.dist[m] < d) lo = m + 1; else hi = m; }
    const i = lo;
    this.renderer.setCursor(i);
    const x = t.dist[i] / p.total * p.W;
    const y = p.H - p.pad - ((t.ele[i] - p.eMin) / p.eSpan) * (p.H - p.pad * 2 - 8);
    this._cursorLine.setAttribute('x1', x); this._cursorLine.setAttribute('x2', x);
    this._cursorDot.setAttribute('cx', x); this._cursorDot.setAttribute('cy', y);
    this.$('readout').innerHTML =
      `<b>${(t.dist[i] / 1000).toFixed(2)}</b> km &nbsp;·&nbsp; <b>${fmt(t.ele[i])}</b> m`;
  }
}
