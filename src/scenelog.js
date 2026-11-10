/**
 * A flight recorder for one visualisation.
 *
 * The companion to src/diag.js, which records a *recording*. This one records
 * a *viewing*: what the scene was built from, what arrived, what the numbers
 * looked like afterwards, and anything about them that cannot be true.
 *
 * It exists because of a specific class of bug. A route drawn on one phone can
 * come out with spikes in the terrain that the same route on the same build
 * does not have anywhere else, and there is nothing to argue about afterwards:
 * the screen is gone, the tiles are gone, and "it looked wrong" is where the
 * conversation ends. Everything here is aimed at ending it somewhere else.
 *
 * Why spikes in particular are worth this much trouble. Elevation arrives as
 * a picture — Mapzen terrarium, where a pixel's height is
 *
 *     R * 256 + G + B / 256 - 32768      metres
 *
 * so one unit of error in the red channel is 256 metres of mountain. That
 * makes the format unforgiving in a very specific way: it does not degrade, it
 * explodes. A tile that never arrived leaves the mosaic at transparent black
 * and decodes to -32768 m. A canvas that gives back slightly different bytes
 * than the PNG held — a 16-bit backing store on a low-memory device, a colour
 * profile applied on the way in — turns ±1 of red into ±256 m of spike. Both
 * are invisible on the machine the code was written on, and both depend on the
 * device rather than on the route, which is exactly why they need a log.
 *
 * So the record carries three kinds of thing:
 *
 *   what happened   tiles asked for and tiles arrived, timings, the build, the
 *                   device, the GL driver
 *   what the data   the decoded elevation field's own statistics, a census of
 *   looks like      pixels that disagree violently with their neighbours, and
 *                   the raw bytes of the worst offenders
 *   whether the     a probe: known values written into a canvas the same size
 *   device can even as the real mosaic and read straight back. If they come
 *   hold the data   back changed, nothing downstream can be trusted and the
 *                   diagnosis is finished before the route is even looked at.
 *
 * Kept locally always — it costs a few kilobytes — and sent only when
 * something in it is wrong or somebody presses the button.
 */

const KEY = 'salpicon.scene.v1';
/** Keep the last few viewings. Each record is a couple of kilobytes. */
const MAX_KEPT = 12;
/** A height this far from its neighbours is not terrain. */
export const SPIKE_M = 120;
/** Heights outside this are not places on Earth. */
export const PLAUSIBLE = { lo: -500, hi: 9000 };

let rec = null;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** What the browser will admit about itself. */
function deviceFacts() {
  const n = typeof navigator !== 'undefined' ? navigator : {};
  const s = typeof screen !== 'undefined' ? screen : {};
  return {
    ua: n.userAgent ?? null,
    platform: n.userAgentData?.platform ?? n.platform ?? null,
    mobile: n.userAgentData?.mobile ?? null,
    lang: n.language ?? null,
    // The two numbers that decide whether a canvas gets a cheap backing store.
    memory_gb: n.deviceMemory ?? null,
    cores: n.hardwareConcurrency ?? null,
    screen: s.width ? `${s.width}x${s.height}` : null,
    dpr: typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : null,
    native: !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()),
    // A phone on a weak signal and a phone with no signal fail differently.
    net: n.connection ? {
      type: n.connection.effectiveType ?? null,
      downlink: n.connection.downlink ?? null,
      saveData: n.connection.saveData ?? null,
    } : null,
  };
}

/** What the GL driver will admit about itself. */
function glFacts(gl) {
  if (!gl) return null;
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      max_texture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      // uint indices decide the mesh resolution, so they belong in the record
      uint_indices: !!(gl.getExtension('OES_element_index_uint')
        || (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)),
    };
  } catch { return null; }
}

/**
 * Can this device hold eight bits per channel in a canvas this big?
 *
 * The question is not rhetorical and it is not the same question as "does
 * canvas work". A browser may back a small canvas with eight bits a channel
 * and a large one with five or six, quietly, because the large one is on the
 * GPU and memory is short; it may also convert colours on the way in from an
 * image. Either rewrites the red channel, and in terrarium the red channel is
 * kilometres.
 *
 * Two round trips, because they fail separately:
 *
 *   put   putImageData -> getImageData. Tests the backing store alone.
 *   draw  a PNG of the same values, through drawImage. Tests the image decode
 *         path as well — colour management lives here.
 *
 * Both are run at the real mosaic's size, because size is the thing under
 * suspicion. The values written are every red from 0 to 255 and every green
 * from 0 to 255, which is what makes quantisation legible: if only every
 * eighth red comes back, the device is giving five bits and the elevation it
 * can report moves in two-kilometre steps.
 *
 * Note which numbers are counted over what. The census of how many distinct
 * values survived is taken over the whole buffer, because it is a property of
 * the device; the hunt for individual wrong pixels is taken over a sampled
 * grid, because it only needs examples. Counting the census on the sample
 * instead is a trap worth naming: the sample's own stride then sets the
 * answer, and a perfectly healthy browser reports itself as six-bit.
 */
export async function probeCanvas(w, h) {
  const out = { w, h, put: null, draw: null };
  /** The value every pixel is supposed to come back as. */
  const expect = (x, y) => [x & 255, y & 255, (x * 7 + y * 13) & 255];

  /**
   * @param px      the bytes that came back
   * @param pw/ph   the region of them that was written
   */
  const judge = (px, pw, ph) => {
    const seen = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
    for (let i = 0; i < pw * ph; i++) {
      seen[0][px[i * 4]] = 1; seen[1][px[i * 4 + 1]] = 1; seen[2][px[i * 4 + 2]] = 1;
    }
    const count = f => { let n = 0; for (let v = 0; v < 256; v++) if (f[v]) n++; return n; };
    const stepX = Math.max(1, pw >> 6), stepY = Math.max(1, ph >> 6);
    let worst = 0, bad = 0, sampled = 0;
    const cases = [];
    for (let y = 0; y < ph; y += stepY) for (let x = 0; x < pw; x += stepX) {
      const i = (y * pw + x) * 4, e = expect(x, y);
      sampled++;
      const d = Math.max(Math.abs(px[i] - e[0]), Math.abs(px[i + 1] - e[1]), Math.abs(px[i + 2] - e[2]));
      if (!d) continue;
      bad++;
      if (d > worst) worst = d;
      if (cases.length < 6) cases.push({ x, y, want: e, got: [px[i], px[i + 1], px[i + 2]] });
    }
    return {
      region: `${pw}x${ph}`,
      sampled, wrong: bad, worst_channel_delta: worst,
      // over the whole region, not the sample: this is about the device
      distinct: { r: count(seen[0]), g: count(seen[1]), b: count(seen[2]) },
      cases,
    };
  };

  try {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const img = cx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, e = expect(x, y);
      img.data[i] = e[0]; img.data[i + 1] = e[1]; img.data[i + 2] = e[2]; img.data[i + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    out.put = judge(cx.getImageData(0, 0, w, h).data, w, h);
  } catch (e) { out.put = { error: String(e?.message || e) }; }

  try {
    // The same values as a PNG, so the decode path is in the test too. Drawn
    // at its own size into the corner of a canvas as large as the mosaic:
    // scaling it would resample, and then every pixel would differ for an
    // honest reason and the test would say nothing.
    const src = document.createElement('canvas');
    src.width = 256; src.height = 256;
    const sc = src.getContext('2d');
    const im = sc.createImageData(256, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4, e = expect(x, y);
      im.data[i] = e[0]; im.data[i + 1] = e[1]; im.data[i + 2] = e[2]; im.data[i + 3] = 255;
    }
    sc.putImageData(im, 0, 0);
    const url = src.toDataURL('image/png');
    const png = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = () => rej(new Error('the probe png would not decode'));
      i.src = url;
    });
    const cv = document.createElement('canvas');
    cv.width = Math.max(256, w); cv.height = Math.max(256, h);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(png, 0, 0);
    out.draw = judge(cx.getImageData(0, 0, 256, 256).data, 256, 256);
  } catch (e) { out.draw = { error: String(e?.message || e) }; }

  return out;
}

/** Start a record. Anything held from the previous scene is already saved. */
export function beginScene({ app, route, where } = {}) {
  rec = {
    version: 1,
    kind: 'scene',
    started: new Date().toISOString(),
    t0: now(),
    app: app ?? null,
    where: where ?? (typeof location !== 'undefined' ? location.pathname + location.search : null),
    route: route ?? null,
    device: deviceFacts(),
    gl: null,
    tiles: {},
    dem: null,
    mesh: null,
    probe: null,
    steps: [],
    errors: [],
  };
  listen();
  return rec;
}

export const scening = () => !!rec;
export const sceneRecord = () => rec;

/** A milestone, with the clock on it. Timings are half of a device report. */
export function step(name, extra) {
  if (!rec) return;
  rec.steps.push({ at_ms: Math.round(now() - rec.t0), name, ...(extra ? { extra } : {}) });
}

export function noteGl(gl) { if (rec) rec.gl = glFacts(gl); }

/**
 * Listen for everything the page complains about while a scene is being built.
 *
 * The record already holds what this module was told; this holds what nobody
 * thought to tell it. A tile decoder that warns, a shader that compiles with a
 * message, a promise nobody caught — all of it lands in the console, where it
 * is seen by whoever has the console open, which on somebody else's phone is
 * nobody at all.
 *
 * console.warn and console.error are wrapped rather than replaced: they still
 * do exactly what they did, and the wrapper comes off when the record closes.
 * Capped, because a warning inside the draw loop is a warning sixty times a
 * second and the point is to carry the log in a message, not to fill a disk.
 */
const CAUGHT_MAX = 60;
let release = null;

function listen() {
  if (release) return;
  const native = { warn: console.warn, error: console.error };
  const take = (level, args) => {
    if (!rec || rec.errors.length >= CAUGHT_MAX) return;
    const text = args.map(a => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'object') { try { return JSON.stringify(a).slice(0, 300); } catch { return '[object]'; } }
      return String(a);
    }).join(' ').slice(0, 500);
    // Our own repair notice is already in the record in full; keeping the
    // console copy as well would say the same thing twice and crowd out
    // whatever else went wrong.
    if (text.startsWith('Salpicón!')) return;
    rec.errors.push({ at_ms: Math.round(now() - rec.t0), where: `console.${level}`, message: text, stack: null });
  };
  console.warn = (...a) => { take('warn', a); return native.warn.apply(console, a); };
  console.error = (...a) => { take('error', a); return native.error.apply(console, a); };
  const onErr = e => noteError('window.onerror', e.error || new Error(e.message || 'script error'));
  const onRej = e => noteError('unhandledrejection', e.reason || new Error('promise rejected'));
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);
  release = () => {
    console.warn = native.warn; console.error = native.error;
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onRej);
    release = null;
  };
}

export function noteError(where, err) {
  if (!rec) return;
  rec.errors.push({
    at_ms: Math.round(now() - rec.t0), where,
    message: String(err?.message ?? err),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null,
  });
}

/**
 * What a tile grid was asked for and what came back.
 *
 * `missing` is the field that matters. Every tile that did not arrive is a
 * 256-pixel square of the mosaic still at its initial transparent black, and
 * in a terrarium mosaic that is a 32-kilometre hole in the ground.
 */
export function noteTiles(kind, spec, result, source) {
  if (!rec || !spec) return;
  rec.tiles[kind] = {
    source: source ?? null,
    z: spec.z, x0: spec.x0, x1: spec.x1, y0: spec.y0, y1: spec.y1,
    asked: (result?.total ?? spec.nx * spec.ny),
    arrived: result?.ok ?? 0,
    missing: (result?.total ?? spec.nx * spec.ny) - (result?.ok ?? 0),
    canvas: result?.w ? `${result.w}x${result.h}` : null,
    at_ms: Math.round(now() - rec.t0),
  };
}

export function noteDem(audit) { if (rec) rec.dem = audit ?? null; }
export function noteProbe(p) { if (rec) rec.probe = p ?? null; }

/**
 * The finished mesh, in numbers.
 *
 * Taken from the vertices the card is actually given rather than from the
 * sampler, because everything in between — the repair pass, the reference
 * height, the vertical scale — is also capable of being the bug.
 */
export function noteMesh(g) {
  if (!rec || !g) return;
  const pos = g.terrain?.pos, N = g.N;
  if (!pos || !N) return;
  let lo = Infinity, hi = -Infinity, worst = 0, at = null;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const z = pos[(j * N + i) * 3 + 2];
    if (z < lo) lo = z; if (z > hi) hi = z;
    // against the neighbour to the west and to the south, which between them
    // cover every edge in the grid exactly once
    if (i) { const d = Math.abs(z - pos[(j * N + i - 1) * 3 + 2]); if (d > worst) { worst = d; at = [i, j]; } }
    if (j) { const d = Math.abs(z - pos[((j - 1) * N + i) * 3 + 2]); if (d > worst) { worst = d; at = [i, j]; } }
  }
  rec.mesh = {
    N, ext_m: Math.round(g.ext), cell_m: +(g.ext / (N - 1)).toFixed(1),
    zRef_m: +(g.zRef ?? 0).toFixed(1), hSpan_m: +(g.hSpan ?? 0).toFixed(1),
    z_min: +lo.toFixed(1), z_max: +hi.toFixed(1),
    // one cell's rise, in metres. Over a 12 m cell, 400 m is a spike.
    worst_step_m: +worst.toFixed(1), worst_step_at: at,
    worst_step_per_m: +(worst / Math.max(1, g.ext / (N - 1))).toFixed(2),
    track_points: g.track?.n ?? null,
  };
}

/**
 * A small picture of what she is looking at.
 *
 * Numbers say what is wrong with the data; they do not say what the screen
 * looked like, and the screen is what was reported. Downscaled hard and sent
 * as JPEG — around 20 kB, which is worth it once per faulty scene.
 */
export function noteShot(canvas, width = 420) {
  if (!rec || !canvas?.width) return;
  try {
    const sc = Math.min(1, width / canvas.width);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(canvas.width * sc));
    cv.height = Math.max(1, Math.round(canvas.height * sc));
    cv.getContext('2d').drawImage(canvas, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/jpeg', 0.62);
    if (url.length < 240000) rec.shot = url;
  } catch (e) { noteError('shot', e); }
}

/**
 * Everything in the record that cannot be true.
 *
 * Returned as a list of short slugs rather than a boolean, so a report can be
 * filed under what is wrong with it and a list of them can be read at a
 * glance. This is also what decides whether a record is worth sending: a scene
 * with an empty verdict list is a scene that worked.
 */
export function faults(r = rec) {
  if (!r) return [];
  const f = [];
  // A probe fails if any pixel came back changed, or if a channel lost values
  // it was given: both mean the device cannot hold what it is handed, and the
  // second is the one that turns into mountains.
  const probeBad = p => p && !p.error
    && (p.wrong > 0 || p.distinct?.r < 250 || p.distinct?.g < 250 || p.distinct?.b < 250);
  if (probeBad(r.probe?.put)) f.push('canvas-not-8-bit');
  if (probeBad(r.probe?.draw)) f.push('image-decode-shifts-bytes');
  for (const [kind, t] of Object.entries(r.tiles || {})) if (t.missing > 0) f.push(`tiles-missing:${kind}`);
  if (r.dem?.void_px > 0) f.push('dem-holes');
  if (r.dem?.spikes > 0) f.push('dem-spikes');
  if (r.dem?.out_of_range > 0) f.push('dem-impossible-heights');
  if (r.dem?.quantised) f.push('dem-channel-quantised');
  if (r.mesh && (r.mesh.z_min < -1000 || r.mesh.z_max > 9000)) f.push('mesh-impossible-heights');
  if (r.mesh && r.mesh.worst_step_per_m > 4) f.push('mesh-cliff');
  if (r.errors?.length) f.push('errors');
  return f;
}

/** The record, closed, with its verdict attached. */
export function finishScene() {
  release?.();
  if (!rec) return null;
  const done = { ...rec, finished: new Date().toISOString(), build_ms: Math.round(now() - rec.t0), faults: faults(rec) };
  delete done.t0;
  rec = null;
  keep(done);
  return done;
}

/* ---------- what is kept on the device ---------- */

export function sceneLogs() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

/**
 * Keep a record, newest first, dropping the oldest and then the heaviest
 * parts of the oldest when the quota says no. A screenshot is the first thing
 * to go: it is the largest field and the least diagnostic.
 */
function keep(r) {
  try {
    const all = [r, ...sceneLogs()].slice(0, MAX_KEPT);
    for (let trim = 0; trim <= all.length; trim++) {
      const body = all.map((x, i) => (i >= all.length - trim ? { ...x, shot: undefined } : x));
      try { localStorage.setItem(KEY, JSON.stringify(body)); return; } catch {}
    }
    localStorage.setItem(KEY, JSON.stringify([{ ...r, shot: undefined }]));
  } catch { /* no room and nothing to be done; the record is still returned */ }
}

export function clearSceneLogs() {
  try { localStorage.removeItem(KEY); } catch {}
}

/**
 * One viewing as a file, ready to be sent in a message.
 *
 * The verdict goes first and the route's name is in the filename, because the
 * person receiving this has to be able to tell at a glance which route it is
 * about and whether it is worth opening — they may well be looking at a dozen
 * of them from different people.
 */
export function sceneFileFor(record) {
  if (!record) return null;
  const safe = String(record.route?.name || 'route')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'route';
  const stamp = (record.started || '').replace(/[:.]/g, '-').slice(0, 19);
  return {
    name: `salpicon-${safe}-${stamp}.json`,
    text: JSON.stringify({
      kind: 'salpicon-scene-log',
      faults: record.faults ?? faults(record),
      route: record.route?.name ?? null,
      app: record.app,
      when: record.started,
      log: record,
    }, null, 1),
  };
}

/** The whole shelf as a file, for a device that cannot reach the database. */
export function sceneFile(name = 'salpicon-scenes') {
  return { name: `${name}.json`, text: JSON.stringify({ kind: 'salpicon-scene-logs', version: 1, logs: sceneLogs() }, null, 1) };
}
