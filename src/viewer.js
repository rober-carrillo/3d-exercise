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
import { t, lang, applyI18n } from './i18n.js';
import { correctElevation } from './elevation.js';
import {
  TILES, sceneFrame, pickZoom, loadTiles, demSampler, idwSampler, buildGeometry, ramp, rampCss, clamp, setEsriToken,
} from './terrain.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** How long the replay should last, in seconds at 1x. */
const FLY = { min: 7.5, max: 45, short_s: 5 * 60, long_s: 60 * 60 };

/**
 * How hard the replay leans on pace.
 *
 * The flight's seconds are spent where the outing's seconds were spent, but
 * spending them in exact proportion under-sells the difference: a stretch run
 * at twice the speed of another only passes twice as fast, and against a
 * moving camera and changing ground that is hard to see. Raising each speed to
 * this power widens every ratio between them by the same 30% — a stretch twice
 * as fast now passes 2^1.3 ≈ 2.46 times as fast — without changing the order
 * of anything or the length of the flight, which is still normalised to
 * `flyDuration`.
 */
const PACE_EMPHASIS = 1.3;

/**
 * A fixed forty-five seconds suited a long hike and made nonsense of a short
 * one: twenty minutes round a park took as long to watch as a day in the
 * mountains, so the figure crawled. The replay now lasts somewhere between
 * seven and a half and forty-five seconds depending on how long the outing
 * took — the floor for anything under five minutes, the ceiling for anything
 * over an hour, and a straight line between. The floor started at five, which
 * flicked a lap of a park past before there was anything to look at.
 *
 * It is the *moving* time that counts where there is one, since the replay
 * skips pauses rather than sitting through them. A track with no timestamps
 * has no duration to go on and keeps the full forty-five seconds.
 */
function flyDurationFor(track) {
  const s = track.stats || {};
  const recorded = s.moving_s ?? s.duration_s;
  if (!recorded || !isFinite(recorded)) return FLY.max;
  if (recorded <= FLY.short_s) return FLY.min;
  if (recorded >= FLY.long_s) return FLY.max;
  const t = (recorded - FLY.short_s) / (FLY.long_s - FLY.short_s);
  return FLY.min + (FLY.max - FLY.min) * t;
}
const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * A speed as minutes per kilometre, which is how a pace is read on foot.
 *
 * Standing still has no pace — dividing by it gives an hour per kilometre and
 * a readout full of nonsense — so anything slower than a crawl says so instead.
 */
function paceLabel(ms) {
  if (!(ms > 0.35)) return '—';
  const secPerKm = 1000 / ms;
  const m = Math.floor(secPerKm / 60), sec = Math.round(secPerKm % 60);
  return `${sec === 60 ? m + 1 : m}:${String(sec === 60 ? 0 : sec).padStart(2, '0')} /km`;
}
/** first index whose value reaches `v`, in a non-decreasing array */
const bisect = (arr, v) => {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
};

const TEMPLATE = `
<canvas class="rv-gl"></canvas>

<div class="rv-panel rv-title" data-open="1">
  <a class="rv-back" hidden data-i18n="nav.back">Volver</a>
  <button class="rv-titlebtn" aria-expanded="true">
    <h1 class="rv-name">—</h1><span class="rv-caret">▾</span>
  </button>
  <div class="rv-fold">
  <div class="rv-sub">Salpicón!</div>
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
  <div class="rv-row"><span class="rv-lab">Figure</span>
    <div class="rv-seg">
      <button type="button" data-mode="foot" class="on">On foot</button>
      <button type="button" data-mode="bike">Bike</button>
    </div>
  </div>
  <div class="rv-btns">
    <button class="rv-play rv-pri">▶ Fly route</button>
    <button class="rv-speed" title="Playback speed">1×</button>
    <button class="rv-reset">Reset</button>
  </div>
  <div class="rv-sharerow" hidden>
    <button type="button" class="rv-share" data-i18n="share.viewer">Copiar enlace a esta ruta</button>
  </div>
</div>

<div class="rv-fabs">
  <button class="rv-fab rv-fab-play" title="Fly route" aria-label="Fly route">▶</button>
  <button class="rv-fab rv-fab-pan" title="Grab and move" aria-label="Grab and move"
    aria-pressed="false">✋</button>
  <button class="rv-fab rv-fab-set" title="Settings" aria-label="Settings" aria-expanded="false">☰</button>
</div>

<div class="rv-panel rv-legend">
  <span class="rv-lg-cap">Elevation</span>
  <div class="rv-ramp"></div>
  <div class="rv-lgrow"><span class="rv-lg-lo">—</span><span class="rv-lg-hi">—</span></div>
</div>

<div class="rv-panel rv-status"><span class="rv-dot"></span><span class="rv-st-txt">loading…</span></div>

<div class="rv-panel rv-profile">
  <div class="rv-cap">Elevation profile</div>
  <button type="button" class="rv-metric" hidden aria-pressed="false"
    title="Colour by pace instead">pace</button>
  <div class="rv-readout"></div>
  <svg class="rv-prof" preserveAspectRatio="none"></svg>
</div>

<div class="rv-hint">drag to orbit · scroll to zoom · shift-drag or ✋ to move</div>

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
      flyDuration: null,      // seconds for the full route at 1×; derived below
      satMaxTiles: 8,
      demMaxTiles: 4,
      vex: 1,
      date: null,             // fallback date for a track with no time of its own
      meshN: null,            // terrain grid resolution; null picks by capability
      tiles: null,            // { sat, dem } specs for tiles shipped with the build
      tileSlug: null,         // the folder those tiles live in
      inline: false,          // mounted in a box rather than over the window
      showcase: false,        // no controls: the route, flying itself, as a sample
      loop: false,            // start again at the end instead of stopping
      onShare: null,          // async () => ({ok, why}); shows "Copy link" when given
    }, opts);
    this.mount = opts.mount;
    this.mount.classList.add('rv-root');
    // A showcase is inline by definition — there is no such thing as a
    // full-window page element with no controls on it.
    if (this.opts.showcase) this.opts.inline = true;
    this.mount.classList.toggle('rv-inline', !!this.opts.inline);
    this.mount.classList.toggle('rv-showcase', !!this.opts.showcase);
    this.mount.innerHTML = TEMPLATE;
    applyI18n(this.mount);        // the chrome arrives after the page was painted
    this.mount.querySelector('.rv-ttl').textContent = `Building 3D terrain · v${VERSION}`;
    console.info(`Salpicón! v${VERSION}`);
    this.$ = sel => this.mount.querySelector('.rv-' + sel);
    this.play = false;
    this.playT = 0;
    this.speed = 1;
    this.metric = 'ele';       // 'ele' | 'pace' — what the colours stand for
    this.progress = { done: 0, total: 1 };
    this.boot().catch(err => this.fail(err));
  }

  msg(t) { const n = this.$('msg'); if (n) n.textContent = t; }

  /**
   * Hand the browser a frame.
   *
   * Building a route is several hundred milliseconds of solid arithmetic, and
   * JavaScript has one thread: while it runs, nothing else does — no animation
   * frame, no button, no scroll. On the landing page that showed up as the
   * crowd in the background freezing solid, which is a worse first impression
   * than no crowd at all, and it is the same stall that makes a tap feel
   * ignored.
   *
   * A frame plus a macrotask, not just a microtask: awaiting a resolved
   * promise yields to nothing, since microtasks run before the browser gets
   * its turn back.
   */
  breathe() {
    return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  /**
   * Hold the loading screen and let the person choose. Resolves true if they
   * want another go at the imagery, false to carry on without it.
   */
  offerRetry(share) {
    const msg = this.$('msg'), bar = this.mount.querySelector('.rv-bar');
    if (!msg) return Promise.resolve(false);
    if (bar) bar.style.display = 'none';
    // Being offline is not the same as the imagery failing, and saying so
    // matters: the first is nobody's fault, it is temporary, and the thing to
    // do about it is come back later. The route itself is already drawn from
    // the track and the elevation data, so there is something to look at
    // meanwhile — which is worth saying too, or it reads as a broken app.
    const offline = navigator.onLine === false;
    msg.innerHTML = (offline ? t('map.offline')
        : share > 0 ? t('map.partial', { pct: Math.round(share * 100) })
        : t('map.none'))
      + `<span class="rv-choice"><button type="button" class="rv-again">${t('map.retry')}</button>`
      + `<button type="button" class="rv-skip">${t('map.skip')}</button></span>`;
    return new Promise(resolve => {
      const done = v => { if (bar) bar.style.display = ''; resolve(v); };
      msg.querySelector('.rv-again').addEventListener('click', () => done(true), { once: true });
      msg.querySelector('.rv-skip').addEventListener('click', () => done(false), { once: true });
    });
  }
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
    // `let`, because the elevations are replaced from the terrain model a few
    // steps down and the geometry built after that has to see the new ones.
    let track = this.track = o.track ? o.track
      : o.gpxText ? analyze(parseGPX(o.gpxText))
      : await loadTrack(o.gpxUrl);
    const s = track.stats;
    this.$('name').textContent = o.name || track.name;
    // the track's own timestamp if it has one, otherwise whatever date the
    // caller knows the route by (the manifest carries the day it was added)
    // The line under the route name. It is the one piece of viewer chrome
    // assembled from a date and a count rather than from a key, so applyI18n
    // cannot put it right on its own and it repaints itself instead.
    //
    // A showcase gets the date and nothing else: the sample count and the
    // centre coordinate are worth having on a route you opened on purpose, and
    // are pure noise on a panel somebody is seeing for the first time with no
    // idea yet what any of it is.
    const paintSub = () => {
      const loc = lang() === 'es' ? 'es-ES' : 'en-US';
      const stamp = track.time ? formatDate(track.time, loc)
        : o.date ? `${t('row.added')} ${formatDate(o.date, loc)}` : '';
      this.$('sub').textContent = o.showcase ? stamp
        : `${stamp ? stamp + ' · ' : ''}${s.points.toLocaleString(loc)} GPS points · ${((track.bbox.minLat + track.bbox.maxLat) / 2).toFixed(3)}°, ${((track.bbox.minLon + track.bbox.maxLon) / 2).toFixed(3)}°`;
    };
    paintSub();
    window.addEventListener('salpicon:lang', () => { paintSub(); applyI18n(this.mount); });
    // Painted from whatever the track says now; called again once the terrain
    // model has arrived and the elevations have been corrected against it.
    const paintStats = () => {
      const st = this.track.stats;
      this.$('s-dist').innerHTML = (st.distance_m / 1000).toFixed(2) + '<small>km</small>';
      this.$('s-gain').innerHTML = fmt(st.gain_m) + '<small>m</small>';
      this.$('s-loss').innerHTML = fmt(st.loss_m) + '<small>m</small>';
      this.$('s-max').innerHTML = fmt(st.ele_max) + '<small>m</small>';
      this.paintLegend();
    };
    paintStats();
    if (o.backHref) { const b = this.$('back'); b.href = o.backHref; b.hidden = false; }
    this.flyDuration = o.flyDuration ?? flyDurationFor(track);
    this.buildProfile();
    this.buildPace();
    this.buildSpeed();

    const renderer = this.renderer = new Renderer(this.$('gl'));
    renderer.onChaseRelease = () =>
      this.mount.querySelector('.rv-sw[data-key="chase"]').classList.remove('on');
    renderer.state.vex = o.vex;

    // config.json carries the imagery key when the build had one. It is absent
    // from a standalone file and from a plain checkout, and both of those keep
    // working on the open endpoint — so this never becomes a reason the app
    // will not start.
    try {
      const cfg = await fetch('./config.json').then(r => r.ok ? r.json() : null);
      if (cfg?.esriKey) setEsriToken(cfg.esriKey);
    } catch {}

    await this.breathe();                 // the track is parsed; let the page move
    const frame = sceneFrame(track);
    // The imagery ceiling was 16 — about 2 m a pixel, so a soccer pitch drew
    // as a green smudge roughly 30 px across. Nothing changes for a route
    // that already fills the tile budget at a lower zoom.
    // Tiles that came with the build, if this route has them. They are our
    // own files on our own origin: no key, no third-party request, and no
    // reason for the landing page's one route to bill an imagery API on every
    // single visit. The spec was written by the build using this same
    // arithmetic, so what is asked for is what is there.
    const cached = o.tiles;
    const localUrl = (kind, spec) => (z, x, y) =>
      `./tiles/${o.tileSlug}/${kind}/${z}-${x}-${y}.${spec.ext}`;
    const satSpec = o.imagery
      ? (cached?.sat ? { ...cached.sat, nx: cached.sat.x1 - cached.sat.x0 + 1, ny: cached.sat.y1 - cached.sat.y0 + 1 }
                     : pickZoom(frame, 19, 11, o.satMaxTiles))
      : null;
    const demSpec = cached?.dem
      ? { ...cached.dem, nx: cached.dem.x1 - cached.dem.x0 + 1, ny: cached.dem.y1 - cached.dem.y0 + 1 }
      : pickZoom(frame, 14, 10, o.demMaxTiles);
    const satUrl = cached?.sat ? localUrl('sat', cached.sat) : (o.imagery ? TILES[o.imagery].url : null);
    const demUrl = cached?.dem ? localUrl('dem', cached.dem) : TILES.terrarium.url;
    this.progress.total = (satSpec ? satSpec.nx * satSpec.ny : 0) + (demSpec ? demSpec.nx * demSpec.ny : 0) || 1;
    this.msg('fetching satellite imagery and elevation data…');

    let [sat, dem] = await Promise.all([
      satSpec ? loadTiles(satSpec, satUrl, () => this.tick()) : Promise.resolve({ ok: 0 }),
      demSpec ? loadTiles(demSpec, demUrl, () => this.tick()) : Promise.resolve({ ok: 0 }),
    ]);
    let imageryLabel = o.imagery ? TILES[o.imagery].label : null;
    if (satSpec && !sat.ok && o.imagery !== 'osm') {          // imagery blocked → plain map drape
      this.msg('imagery unavailable — trying map tiles…');
      const alt = await loadTiles(satSpec, TILES.osm.url, null);
      if (alt.ok) { sat = alt; imageryLabel = TILES.osm.label; }
    }

    // Enough of the map, or none of it? A scene with no imagery falls back to
    // a coloured gradient, which looks like a rendering fault rather than a
    // network one — and on a phone that has just walked out of wifi it is
    // always a network one. Rather than present that as the finished article,
    // stop and offer the two things worth offering: try again, or go on
    // without it. Waiting forever on a train with no signal is not a kindness.
    if (satSpec) {
      const share = sat.total ? sat.ok / sat.total : 0;
      if (share < 0.5) {
        const again = await this.offerRetry(share);
        if (again) {
          this.msg('fetching satellite imagery…');
          this.progress = { done: 0, total: satSpec.nx * satSpec.ny };
          const retry = await loadTiles(satSpec, satUrl, () => this.tick(), 25000, 4);
          if (retry.ok > sat.ok) sat = retry;
        }
      }
    }

    this.msg('shaping terrain…');
    await this.breathe();
    let sample = null, demReal = false;
    if (dem.ok) { const fn = demSampler(dem); if (fn) { sample = fn; demReal = true; } }
    if (!sample) sample = idwSampler(track, frame);

    // Take the route's own heights off the terrain rather than off the phone.
    // A GPS altitude is wrong by the geoid separation before any noise is
    // added — tens of metres — and that error is what paints a flat walk as a
    // climb, fills the elevation profile with hills that are not there, and
    // leaves the colour ramp spending its whole range on nothing. The model is
    // already here; this costs one pass over the track.
    if (demReal) {
      const fixed = await correctElevation(track, { sample });
      if (fixed) {
        track = this.track = fixed;
        this.buildProfile();
        if (this.metric === 'pace') this.setMetric('pace');
        paintStats();
      }
    }

    // A showcase is a few hundred pixels across and nobody is going to orbit
    // it, so it does not need the full grid — and the grid is the expensive
    // part. Halving it quarters the arithmetic, which is the difference
    // between a stutter and a stall.
    const N = o.meshN ?? (o.showcase ? 176 : renderer.caps.uint ? 352 : 224);
    const g = buildGeometry({ track, frame, sample, sat, N, uint: renderer.caps.uint });
    await this.breathe();
    renderer.setGeometry(g);
    await this.breathe();
    if (sat.ok) renderer.setTexture(sat.cv);
    renderer.cam.tz = (s.ele_min + s.ele_max) / 2 - g.zRef;
    renderer.onFrame = dt => this.frame(dt);

    this.$('status').title = `Salpicón! v${VERSION}`;
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
    // A showcase has no play button to press, so it presses its own: the point
    // is that somebody arriving on the page sees a route being flown without
    // having worked out that they were meant to ask for it.
    if (o.showcase) {
      this.renderer.beginChase();
      this.setPlay(true);
    }
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
    // the figure swap: she is the same rider either way, on her feet or on a bike
    this.mount.querySelectorAll('.rv-seg button').forEach(btn => {
      btn.addEventListener('click', () => {
        r.state.bike = btn.dataset.mode === 'bike';
        this.mount.querySelectorAll('.rv-seg button')
          .forEach(other => other.classList.toggle('on', other === btn));
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
      // Starts where it is and offers the two anybody reaches for: slower to
      // watch a corner, faster to get on with it. 4x was in the cycle and
      // nowhere near useful — at that rate a route is a blur, and its only
      // real effect was standing between 2x and getting back to 1x.
      const steps = [1, 0.5, 2];
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
    // A showcase starts folded to the route's name. The four statistics are
    // worth reading on a route you went looking for, and on a landing page
    // they are a panel covering the thing the panel is describing — which is
    // the terrain, which is the entire argument. One tap still opens them.
    setTitle(!this.narrow() && !this.opts.showcase);

    const panel = this.mount.querySelector('.rv-ctrl');
    const setBtn = this.$('fab-set');
    const setPanel = open => {
      panel.classList.toggle('rv-open', open);
      setBtn.setAttribute('aria-expanded', String(open));
    };
    setBtn.addEventListener('click', () => setPanel(!panel.classList.contains('rv-open')));
    this.$('fab-play').addEventListener('click', () => this.$('play').click());

    /**
     * Grab and move.
     *
     * A mode rather than a modifier, because the modifiers that already panned
     * — a right button, a held shift — are things a phone does not have. On it
     * the whole of panning was unreachable, so zooming into one corner of a
     * route meant orbiting until that corner happened to come round.
     *
     * Chase is turned off when it goes on: chase decides where the camera
     * looks every frame, so panning under it slides the ground back under
     * itself and nothing appears to happen.
     */
    const panBtn = this.$('fab-pan');
    const setPan = on => {
      this.renderer.panMode = on;
      panBtn.classList.toggle('on', on);
      panBtn.setAttribute('aria-pressed', String(on));
      this.$('gl').classList.toggle('panning', on);
      const chase = this.mount.querySelector('.rv-sw[data-key="chase"]');
      if (on && this.renderer.state.chase) chase?.click();
    };
    panBtn.addEventListener('click', () => setPan(!this.renderer.panMode));
    this._setPan = setPan;

    // Colour by pace. Offered only where there is pace to colour by: a .gpx
    // with no timestamps has no speed, and a button that explains why it
    // cannot do anything is worse than no button.
    const metricBtn = this.$('metric');
    metricBtn.hidden = !this.hasSpeed;
    metricBtn.textContent = t('rv.metric.pace');
    metricBtn.addEventListener('click', () =>
      this.setMetric(this.metric === 'pace' ? 'ele' : 'pace'));
    // touching the scene puts the settings away again
    this.$('gl').addEventListener('pointerdown', () => { if (this.narrow()) setPanel(false); });
    // Only the viewer that *is* the page may claim the keyboard. One embedded
    // in a landing page would otherwise eat the space bar from whatever the
    // reader was actually doing — scrolling, usually.
    if (!this.opts.inline) window.addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); this.$('play').click(); }
      if (e.key === 'r' || e.key === 'R') this.$('reset').click();
      if (e.key === 'c' || e.key === 'C') this.mount.querySelector('.rv-sw[data-key="chase"]').click();
      if (e.key === 'p' || e.key === 'P') this.mount.querySelector('.rv-sw[data-key="pace"]').click();
      if (e.key === 'b' || e.key === 'B')
        this.mount.querySelector(`.rv-seg button[data-mode="${r.state.bike ? 'foot' : 'bike'}"]`).click();
    });

    this.wireShare();
  }

  /**
   * "Copy link to this route", for the page that knows what the link is.
   *
   * The viewer has no idea whether this route lives in an account, in the
   * build or only in this browser, and should not: it is handed a function
   * that does the work and reports back in a sentence, and all it does is show
   * the button and say what happened.
   */
  wireShare() {
    const row = this.mount.querySelector('.rv-sharerow');
    const btn = this.$('share');
    if (!row || !btn || !this.opts.onShare) return;
    row.hidden = false;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = t('share.copying');
      let res;
      try { res = await this.opts.onShare(); }
      catch (err) { res = { ok: false, why: err?.message || 'Could not copy that link.' }; }
      btn.classList.toggle('done', !!res?.ok);
      btn.textContent = res?.why || (res?.ok ? 'Link copied' : 'Could not copy');
      btn.disabled = false;
      setTimeout(() => { btn.classList.remove('done'); btn.textContent = label; }, 4000);
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
    this.playT += dt * this.speed / this.flyDuration;
    if (this.playT >= 1) {
      // a showcase runs the route over and over; everywhere else the flight
      // ends where the route does and waits to be asked again
      if (this.opts.loop) this.playT = 0;
      else { this.playT = 1; this.setPlay(false); }
    }
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
      clock[i] = clock[i - 1] + ds / Math.pow(Math.max(v, STILL), PACE_EMPHASIS);
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
    // The same emphasis the clock uses. Her legs have to agree with the ground
    // going past her: exaggerate one and not the other and she moonwalks
    // through the quick stretches.
    r.walkRate = this.speed * clamp(Math.pow(v / pc.ref, PACE_EMPHASIS), 0, 3);
  }

  /**
   * The scale's caption and its two ends, for whichever metric is showing.
   *
   * Pace is deliberately written the way the ramp reads rather than the way a
   * clock does: green is the slow end and red the fast one, matching low and
   * high ground, so the colours keep one meaning across both modes — the
   * bright end is always "more of it".
   */
  paintLegend() {
    const st = this.track.stats, pace = this.metric === 'pace' && this.hasSpeed;
    this.$('lg-cap').textContent = t(pace ? 'rv.pace' : 'rv.elevation');
    this.$('cap').textContent = t(pace ? 'rv.paceprof' : 'rv.eleprof');
    if (pace) {
      this.$('lg-lo').textContent = paceLabel(this._speed.lo);
      this.$('lg-hi').textContent = paceLabel(this._speed.hi);
    } else {
      this.$('lg-lo').textContent = fmt(st.ele_min) + ' m';
      this.$('lg-hi').textContent = fmt(st.ele_max) + ' m';
    }
  }

  /**
   * Switch what the colours mean, everywhere at once.
   *
   * The ribbon, the curtain, the profile curve, the scale and the readout all
   * have to change together or the picture contradicts itself, so they are all
   * driven from this one place rather than each watching the flag.
   */
  setMetric(which) {
    const pace = which === 'pace' && this.hasSpeed;
    this.metric = pace ? 'pace' : 'ele';
    const t2 = this.track;
    const eMin = t2.stats.ele_min, eSpan = Math.max(1, t2.stats.ele_max - eMin);
    const norm = new Float32Array(t2.lat.length);
    for (let i = 0; i < norm.length; i++) {
      norm[i] = pace ? this.speedNorm(i) : clamp((t2.ele[i] - eMin) / eSpan, 0, 1);
    }
    this.renderer.recolourRoute(norm, ramp);
    this.buildProfile();
    this.paintLegend();
    const btn = this.$('metric');
    btn.classList.toggle('on', pace);
    btn.setAttribute('aria-pressed', String(pace));
    btn.textContent = t(pace ? 'rv.metric.ele' : 'rv.metric.pace');
    this.scrub(this.distFrac(this.playT), true);
  }

  /**
   * Speed along the route, and the band of it worth colouring.
   *
   * Three decisions, and the first is not to cut the route into segments at
   * all. Fixed segments — every 400 m, every minute — have to put their edges
   * somewhere, and wherever they go they will sooner or later fall across the
   * middle of a sprint and average half of it away with the jog either side.
   * There is no segment length that cannot be defeated by an effort shorter
   * than it. Colouring is per sample, so nothing has an edge to be cut by;
   * picking out *named* efforts ("fastest kilometre") is a different question
   * and already has its own answer in stats.js.
   *
   * Second: the smoothing window is in **seconds**, not samples and not
   * metres. Samples would make the window mean different things on a phone
   * recording at 1 Hz and one dropping to 0.3 Hz. Metres would make it mean
   * different things at different speeds — 50 m is eight seconds of jogging
   * and four of sprinting, so the faster you went the less the window would
   * smooth, which is backwards. Ten seconds is short enough that a twenty
   * second sprint still reads as a sprint and long enough to flatten the
   * second-to-second noise in GPS speed.
   *
   * Third: the ends of the scale are percentiles of this route, not absolute
   * speeds. A scale running from nothing to world record would paint every
   * ordinary run the same shade of middling. Taking the 5th and 95th
   * percentile spends the whole ramp on the range actually covered, and
   * ignores the one bad fix at either end that would otherwise own it.
   */
  buildSpeed() {
    const t = this.track;
    this._speed = null;
    const n = t.secs ? t.secs.length : 0;
    if (n < 3 || n !== t.dist.length) return;          // no timing in this file

    const WINDOW_S = 10;
    const v = new Float32Array(n);
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      // widen a window centred on i until it spans WINDOW_S, then read the
      // average speed across it: distance over time, both measured, no
      // assumptions about how evenly the samples are spaced
      while (a < i && t.secs[i] - t.secs[a] > WINDOW_S / 2) a++;
      while (b < n - 1 && t.secs[b] - t.secs[i] < WINDOW_S / 2) b++;
      const dt = t.secs[b] - t.secs[a];
      v[i] = dt > 0 ? (t.dist[b] - t.dist[a]) / dt : 0;
    }
    const sorted = Float32Array.from(v).sort();
    const at = q => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    const lo = at(0.05), hi = at(0.95);
    if (!(hi > lo)) return;                            // stood still throughout
    this._speed = { v, lo, hi, span: hi - lo };
  }

  /** Is there pace to colour by? */
  get hasSpeed() { return !!this._speed; }

  /** Sample i as 0…1 across this route's own range of speed. */
  speedNorm(i) {
    const s = this._speed;
    return s ? clamp((s.v[i] - s.lo) / s.span, 0, 1) : 0;
  }

  buildProfile() {
    const t = this.track, svg = this.$('prof');
    // Start from an empty one. This is called twice on every route now — once
    // from the recorded elevations and again once the terrain model has
    // replaced them — and appending to what is already there drew the profile
    // on top of itself, which is the two lines. The pointer handler is bound
    // once for the same reason: a second one would scrub twice per move.
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = 1000, H = 100, pad = 6;
    const eMin = t.stats.ele_min, eSpan = Math.max(1, t.stats.ele_max - eMin);
    const total = t.stats.distance_m;
    this._prof = { W, H, pad, eMin, eSpan, total };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    // Whichever metric is on, the curve and the colours come from the same
    // number — so the shape and the shading can never tell different stories.
    const pace = this.metric === 'pace' && this.hasSpeed;
    const val = i => pace ? this.speedNorm(i) : (t.ele[i] - eMin) / eSpan;
    const X = i => t.dist[i] / total * W;
    const Y = i => H - pad - val(i) * (H - pad * 2 - 8);
    let d = '';
    for (let i = 0; i < t.lat.length; i++) d += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(i).toFixed(1);
    let stops = '';
    for (let s = 0; s <= 20; s++) {
      const i = Math.round(s / 20 * (t.lat.length - 1));
      stops += `<stop offset="${s * 5}%" stop-color="${rampCss(val(i))}"/>`;
    }
    const defs = document.createElementNS(SVGNS, 'defs');
    defs.innerHTML = `<linearGradient id="rv-pg" x1="0" x2="1">${stops}</linearGradient>
      <linearGradient id="rv-pf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(19,138,74,.25)"/><stop offset="100%" stop-color="rgba(19,138,74,0)"/></linearGradient>`;
    svg.appendChild(defs);
    const mk = (tag, at) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in at) n.setAttribute(k, at[k]);
      svg.appendChild(n); return n;
    };
    mk('path', { d: d + `L${W} ${H} L0 ${H} Z`, fill: 'url(#rv-pf)' });
    mk('path', { d, fill: 'none', stroke: 'url(#rv-pg)', 'stroke-width': 2, 'stroke-linejoin': 'round' });
    this._cursorLine = mk('line', { x1: 0, y1: 0, x2: 0, y2: H, style: 'stroke:var(--ink-3)', 'stroke-width': 1 });
    this._cursorDot = mk('circle', { cx: 0, cy: 0, r: 3.6, fill: '#fff', stroke: '#138a4a', 'stroke-width': 2 });
    svg.style.cursor = 'crosshair';
    if (!this._profWired) {
      this._profWired = true;
      /**
       * Dragging the profile.
       *
       * A mouse scrubs on hover, which is the nicest thing about this control
       * on a laptop and costs nothing. A finger cannot hover, so touch has to
       * press first — and then the pointer is captured, so the scrub carries
       * on when the finger wanders off the strip instead of stopping dead at
       * the edge, which is most of what "it moves in big steps" was.
       *
       * The rest of it was the browser: see touch-action on .rv-prof. With the
       * gesture ours, `getCoalescedEvents` hands back the positions the OS
       * sampled between frames, so a fast drag follows the finger instead of
       * skipping to wherever it was when the frame landed.
       */
      let held = false;
      const at = e => {
        const box = svg.getBoundingClientRect();
        this.scrub(clamp((e.clientX - box.left) / box.width, 0, 1));
      };
      svg.addEventListener('pointerdown', e => {
        held = true;
        try { svg.setPointerCapture(e.pointerId); } catch {}
        this.setPlay(false);
        at(e);
      });
      svg.addEventListener('pointermove', e => {
        if (!held && e.pointerType !== 'mouse') return;
        this.setPlay(false);
        const fine = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
        at(fine && fine.length ? fine[fine.length - 1] : e);
      });
      const release = e => {
        held = false;
        try { svg.releasePointerCapture(e.pointerId); } catch {}
      };
      svg.addEventListener('pointerup', release);
      svg.addEventListener('pointercancel', release);
    }
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
    const yv = this.metric === 'pace' && this.hasSpeed
      ? this.speedNorm(Math.round(idx)) : (ele - p.eMin) / p.eSpan;
    const y = p.H - p.pad - yv * (p.H - p.pad * 2 - 8);
    this._cursorLine.setAttribute('x1', x); this._cursorLine.setAttribute('x2', x);
    this._cursorDot.setAttribute('cx', x); this._cursorDot.setAttribute('cy', y);
    const tail = this.metric === 'pace' && this.hasSpeed
      ? `<b>${paceLabel(this._speed.v[Math.round(idx)])}</b>`
      : `<b>${fmt(ele)}</b> m`;
    this.$('readout').innerHTML = `<b>${(d / 1000).toFixed(2)}</b> km &nbsp;·&nbsp; ${tail}`;
  }
}
