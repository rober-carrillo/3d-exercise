/**
 * Terrain assembly: web-mercator helpers, map/elevation tile loading, and the
 * geometry the renderer draws. Pure data — no WebGL calls live in here.
 */

export const R = 6378137, D2R = Math.PI / 180;
export const mercX = lon => R * lon * D2R;
export const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
export const invLon = x => x / R / D2R;
export const invLat = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / D2R;
export const lon2tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
export const lat2ty = (lat, z) => {
  const r = lat * D2R;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The Esri API key, when the build was given one.
 *
 * Without a key the tiles come from the open ArcGIS endpoint, which is what
 * this has always done and is fine for a project nobody has heard of. With
 * one, the same imagery comes from the licensed host instead — same pictures,
 * same zoom levels, just accounted for. Switching is an environment variable
 * at build time and nothing else, so the day the key arrives is a one-line day.
 */
let esriToken = null;
export const setEsriToken = token => { esriToken = token || null; };
export const esriLicensed = () => !!esriToken;

/** Tile services. Esri = /{z}/{row}/{col}; the others = /{z}/{x}/{y}. */
export const TILES = {
  esri: {
    label: 'Esri World Imagery',
    url: (z, x, y) => esriToken
      ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?token=${esriToken}`
      : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  },
  /**
   * Esri's two transparent reference layers, from the same service as the
   * imagery and under the same terms — which is the reason to prefer them over
   * anybody else's labels. Places is neighbourhoods, parks and districts, and
   * belongs on the ground picture at any distance. Transportation is street
   * names, which are worth reading only from close up, so it is kept as its own
   * layer for the renderer to fade.
   */
  esriPlaces: {
    label: 'Esri place names',
    url: (z, x, y) => esriToken
      ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}?token=${esriToken}`
      : `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
  },
  esriStreets: {
    label: 'Esri street names',
    url: (z, x, y) => esriToken
      ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}?token=${esriToken}`
      : `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
  },
  osm: {
    label: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
  terrarium: {
    label: 'AWS Terrain Tiles',
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  },
};

/** The square patch of world the scene covers, in mercator metres. */
export function sceneFrame(track, pad = 1.28) {
  const b = track.bbox;
  const lat0 = (b.minLat + b.maxLat) / 2, lon0 = (b.minLon + b.maxLon) / 2;
  const dx = mercX(b.maxLon) - mercX(b.minLon), dy = mercY(b.maxLat) - mercY(b.minLat);
  const half = Math.max(dx, dy) / 2 * pad;
  const cx = mercX(lon0), cy = mercY(lat0), K = Math.cos(lat0 * D2R);
  return {
    lat0, lon0, cx, cy, half, K,
    ext: half * 2 * K,                       // scene width in real ground metres
    minLon: invLon(cx - half), maxLon: invLon(cx + half),
    minLat: invLat(cy - half), maxLat: invLat(cy + half),
  };
}

/** Highest zoom whose tile grid still fits inside `maxTiles` in both axes. */
export function pickZoom(frame, zHi, zLo, maxTiles) {
  for (let z = zHi; z >= zLo; z--) {
    const x0 = Math.floor(lon2tx(frame.minLon, z)), x1 = Math.floor(lon2tx(frame.maxLon, z));
    const y0 = Math.floor(lat2ty(frame.maxLat, z)), y1 = Math.floor(lat2ty(frame.minLat, z));
    if (x1 - x0 + 1 <= maxTiles && y1 - y0 + 1 <= maxTiles)
      return { z, x0, x1, y0, y1, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
  }
  return null;
}

/**
 * Stitch a tile grid into one canvas.
 *
 * Tiles are retried before being given up on. A phone that has just come off
 * wifi onto a weak cell signal drops requests in bursts, and a single failure
 * used to mean that tile was simply absent for the life of the scene — which
 * is how a route gets drawn over a coloured gradient instead of a map. The
 * result reports how many arrived so the caller can decide whether that is
 * good enough to show.
 */
export function loadTiles(spec, url, onTick, timeout = 20000, attempts = 3) {
  const cv = document.createElement('canvas');
  cv.width = spec.nx * 256; cv.height = spec.ny * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let ok = 0;
  const jobs = [];
  for (let x = spec.x0; x <= spec.x1; x++) for (let y = spec.y0; y <= spec.y1; y++) {
    jobs.push(new Promise(res => {
      let tries = 0;
      const attempt = () => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        let settled = false;
        const done = good => {
          if (settled) return; settled = true;
          if (good) {
            try { ctx.drawImage(im, (x - spec.x0) * 256, (y - spec.y0) * 256); ok++; } catch {}
            onTick && onTick(); res();
            return;
          }
          if (++tries < attempts) {
            // back off a little; a burst of failures usually means the radio
            // is busy rather than the tile being missing
            setTimeout(attempt, 400 * tries);
          } else { onTick && onTick(); res(); }
        };
        im.onload = () => done(true);
        im.onerror = () => done(false);
        setTimeout(() => done(false), timeout);
        im.src = url(spec.z, x, y) + (tries ? `${url(spec.z, x, y).includes('?') ? '&' : '?'}retry=${tries}` : '');
      };
      attempt();
    }));
  }
  return Promise.all(jobs).then(() => ({ cv, ctx, ok, total: spec.nx * spec.ny, spec, w: cv.width, h: cv.height }));
}

/**
 * Decode a terrarium mosaic into a field of metres, repairing what cannot be.
 *
 *     height = R * 256 + G + B / 256 - 32768      metres
 *
 * Read that formula again before changing anything here, because it is the
 * whole reason this function is not three lines long: the red channel is worth
 * 256 metres a step. Elevation delivered as an image is elevation with no
 * tolerance for a wrong byte. Everything that can put a wrong byte in front of
 * us does so in a way that looks like a mountain:
 *
 *   a tile that never arrived   The mosaic canvas starts out transparent
 *                               black, and black decodes to -32768 m. One
 *                               missing tile is a 32 km hole, and it takes the
 *                               scene's reference height and colour range down
 *                               with it, so the other fifteen tiles' worth of
 *                               real relief flattens into nothing.
 *
 *   a canvas that is not        A large canvas may be backed by five or six
 *   eight bits a channel        bits a channel on a device that is short of
 *                               memory. Five bits of red is a two-kilometre
 *                               step in the elevation it reports.
 *
 *   colour management           A profile applied on the way in moves red by
 *                               one, which is 256 m, in patches.
 *
 * None of those can be prevented from here, so they are measured and then
 * mended. Measured first and in detail — the audit is the only evidence that
 * ever reaches anybody, see src/scenelog.js — and then mended, because a user
 * looking at a spike does not want to be told it has been written down.
 *
 * Mending is a pyramid fill rather than a neighbourhood average: a whole
 * missing tile is 65,536 contiguous pixels, and averaging inwards from its
 * edge would need hundreds of passes. Averages are taken over the good pixels
 * at each halving, and a hole takes its value from the first level that has
 * one. A big hole comes back smooth and slightly wrong, which is the correct
 * outcome: it is honest about having no data, and it is not a mountain.
 */
export function demField(dem, { spike = 120, lo = -500, hi = 9000 } = {}) {
  let px;
  try { px = dem.ctx.getImageData(0, 0, dem.w, dem.h).data; }
  catch { return null; }                       // canvas tainted → caller falls back
  const w = dem.w, h = dem.h, n = w * h;
  const z = new Float32Array(n);
  const bad = new Uint8Array(n);
  let voidPx = 0, oor = 0, rawLo = Infinity, rawHi = -Infinity;
  // Which values actually occur in each channel. A device that quantised them
  // leaves its fingerprint here — every value a multiple of 8, say — and that
  // is a statement about the device made from the route's own data rather than
  // from a synthetic probe.
  //
  // All three channels, not just red, and the reason is worth keeping. Red is
  // the channel that matters: it is worth 256 m a step, so it is where the
  // damage shows. But red is also nearly constant across one scene — a town at
  // 1,300 m uses two or three values of it — and two values quantised into one
  // leave nothing to measure. Green runs through all 256 of its values every
  // 256 metres of relief, so green is where quantisation is *visible*. One
  // channel says how bad it is and another says whether it happened.
  const seen = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];

  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const v = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
    z[i] = v;
    seen[0][px[k]] = 1; seen[1][px[k + 1]] = 1; seen[2][px[k + 2]] = 1;
    if (px[k + 3] < 255) { bad[i] = 1; voidPx++; continue; }
    if (!(v > lo && v < hi)) { bad[i] = 1; oor++; continue; }
    if (v < rawLo) rawLo = v;
    if (v > rawHi) rawHi = v;
  }

  // Lone pixels that disagree violently with their surroundings. Judged
  // against the median of the four neighbours rather than their mean, so one
  // bad neighbour cannot drag the comparison far enough to hide a spike.
  const worst = [];
  let spikes = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (bad[i]) continue;
      const a = z[i - 1], b = z[i + 1], c = z[i - w], d = z[i + w];
      if (bad[i - 1] || bad[i + 1] || bad[i - w] || bad[i + w]) continue;
      const s = [a, b, c, d].sort((p, q) => p - q);
      const med = (s[1] + s[2]) / 2;
      const dev = z[i] - med;
      if (Math.abs(dev) > spike) {
        bad[i] = 1; spikes++;
        if (worst.length < 8) {
          const raw = o => [px[o * 4], px[o * 4 + 1], px[o * 4 + 2], px[o * 4 + 3]];
          worst.push({
            // where in the mosaic, and which tile that is — so a tile can be
            // fetched again by hand and compared byte for byte
            px: [x, y],
            tile: [dem.spec.z, dem.spec.x0 + ((x / 256) | 0), dem.spec.y0 + ((y / 256) | 0)],
            in_tile: [x % 256, y % 256],
            m: +z[i].toFixed(1), neighbour_median_m: +med.toFixed(1), off_by_m: +dev.toFixed(1),
            rgba: raw(i), west: raw(i - 1), east: raw(i + 1), north: raw(i - w), south: raw(i + w),
          });
        }
      }
    }
  }

  // Pyramid of the good data, each level half the size of the last, all the
  // way down to a single pixel.
  //
  // The last level is not a flourish. A hole aligned with the pyramid — a
  // missing tile is exactly one quadrant of a 2x2 grid — is entirely bad at
  // every level above the one that mixes it with its siblings, so stopping at
  // 2x2 leaves precisely the commonest case unrepaired. Carry on to 1x1 and
  // there is always a value to fall back on, which at worst is the mean height
  // of everything that did arrive.
  const levels = [{ z, bad, w, h }];
  for (let lw = w, lh = h, src = levels[0]; lw > 1 || lh > 1;) {
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nz = new Float32Array(nw * nh), nb = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sum = 0, cnt = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sy = y * 2 + dy, sx = x * 2 + dx;
        if (sy >= lh || sx >= lw) continue;         // an odd level has a short edge
        const k = sy * lw + sx;
        if (!src.bad[k]) { sum += src.z[k]; cnt++; }
      }
      if (cnt) nz[y * nw + x] = sum / cnt; else nb[y * nw + x] = 1;
    }
    levels.push(src = { z: nz, bad: nb, w: nw, h: nh });
    lw = nw; lh = nh;
  }

  // The height to use when even the top of the pyramid has nothing: the mean
  // of what did arrive. Zero would be a sea-level plateau in the middle of a
  // mountain scene, which is a worse lie than a flat average.
  let goodSum = 0, goodN = 0;
  for (let i = 0; i < n; i++) if (!bad[i]) { goodSum += z[i]; goodN++; }
  const fallback = goodN ? goodSum / goodN : 0;

  let repaired = 0, unrepairable = 0;
  for (let i = 0; i < n; i++) {
    if (!bad[i]) continue;
    const x = i % w, y = (i / w) | 0;
    let got = false;
    for (let L = 1; L < levels.length; L++) {
      const lv = levels[L], lx = Math.min(lv.w - 1, x >> L), ly = Math.min(lv.h - 1, y >> L);
      const k = ly * lv.w + lx;
      if (!lv.bad[k]) { z[i] = lv.z[k]; got = true; break; }
    }
    repaired++;
    if (!got) { z[i] = fallback; unrepairable++; }
  }

  let zLo = Infinity, zHi = -Infinity, sum = 0;
  for (let i = 0; i < n; i++) { const v = z[i]; if (v < zLo) zLo = v; if (v > zHi) zHi = v; sum += v; }

  /**
   * How far apart the values in one channel are.
   *
   * The greatest common divisor of the gaps between the values that occur. One
   * means every value was available, which is a healthy eight-bit channel.
   * Eight means only every eighth value came back, which is five bits.
   *
   * Null when there is nothing to measure — a channel with one value in it has
   * no gaps — and that matters: a channel so narrow that quantisation collapses
   * it to a single value cannot report its own damage, which is why this is
   * measured on all three and read off the one that varies.
   */
  const strideOf = flags => {
    const present = [];
    for (let v = 0; v < 256; v++) if (flags[v]) present.push(v);
    let g = 0;
    for (let i = 1; i < present.length; i++) {
      let a = present[i] - present[i - 1], b = g;
      while (b) { const t = a % b; a = b; b = t; }
      g = a;
    }
    return { values: present.length, stride: present.length > 1 ? g : null };
  };
  const chan = { r: strideOf(seen[0]), g: strideOf(seen[1]), b: strideOf(seen[2]) };
  // The one number to read: the finest elevation step this device could have
  // reported. Red is worth 256 m a step, green 1 m, so whichever channel can
  // still be measured gives the answer.
  const step_m = chan.r.stride > 1 ? chan.r.stride * 256
    : chan.g.stride > 1 ? chan.g.stride
    : chan.b.stride > 1 ? chan.b.stride / 256
    : null;

  const audit = {
    canvas: `${w}x${h}`, tiles: `${dem.spec.nx}x${dem.spec.ny}@z${dem.spec.z}`,
    px: n,
    void_px: voidPx,                         // never drawn: a tile that did not arrive
    out_of_range: oor,                       // decoded to somewhere that is not Earth
    spikes,                                  // disagreed with its neighbours by > spike m
    repaired_px: repaired,
    unrepairable_px: unrepairable,
    raw_min_m: isFinite(rawLo) ? +rawLo.toFixed(1) : null,
    raw_max_m: isFinite(rawHi) ? +rawHi.toFixed(1) : null,
    min_m: +zLo.toFixed(1), max_m: +zHi.toFixed(1), mean_m: +(sum / n).toFixed(1),
    // How many of the 256 values each channel actually produced, and the gap
    // between them. Anything but a stride of 1 is a device that cannot hold
    // the data it was given.
    channels: {
      r: chan.r.values, g: chan.g.values, b: chan.b.values,
      r_stride: chan.r.stride, g_stride: chan.g.stride, b_stride: chan.b.stride,
    },
    quantised: !!(chan.r.stride > 1 || chan.g.stride > 1 || chan.b.stride > 1),
    step_m,
    spike_threshold_m: spike,
    worst,
  };
  return { z, w, h, spec: dem.spec, audit };
}

/**
 * Heights in metres from a terrarium mosaic, bilinearly.
 *
 * The repaired field is what gets sampled; `sample.audit` carries what had to
 * be repaired to get it, for whoever is keeping the log.
 */
export function demSampler(dem, opts) {
  const f = demField(dem, opts);
  if (!f) return null;
  const { z, w, h, spec: s } = f;
  const sample = (lat, lon) => {
    const x = clamp((lon2tx(lon, s.z) - s.x0) * 256, 0, w - 1.001);
    const y = clamp((lat2ty(lat, s.z) - s.y0) * 256, 0, h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), ux = x - x0, uy = y - y0;
    const at = (a, b) => z[b * w + a];
    return lerp(lerp(at(x0, y0), at(x0 + 1, y0), ux), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), ux), uy);
  };
  sample.audit = f.audit;
  return sample;
}

/** Offline fallback: infer a plausible surface from the track's own elevations. */
export function idwSampler(track, frame) {
  const step = Math.max(1, Math.round(track.lat.length / 170));
  const px = [], py = [], pe = [];
  for (let i = 0; i < track.lat.length; i += step) {
    px.push(mercX(track.lon[i]) * frame.K); py.push(mercY(track.lat[i]) * frame.K); pe.push(track.ele[i]);
  }
  const mean = pe.reduce((a, b) => a + b, 0) / pe.length;
  return (lat, lon) => {
    const X = mercX(lon) * frame.K, Y = mercY(lat) * frame.K;
    let sw = 0, sv = 0;
    for (let i = 0; i < px.length; i++) {
      const d = (X - px[i]) ** 2 + (Y - py[i]) ** 2 + 900, w = 1 / (d * d);
      sw += w; sv += w * pe[i];
    }
    return lerp(sv / sw, mean, 0.25);
  };
}

/**
 * Elevation colours shared by the ribbon, the profile and the legend: five flat
 * fruit bands, like the tints on a printed map. Bands, not a blend, because
 * blending mango into watermelon passes through a muddy orange of its own.
 *
 * It used to end on plum. Purple reads as "off the end of the scale" rather
 * than as "high", so the top of every route looked like an error — and the
 * eye has no idea whether plum is above or below watermelon. Climbing from
 * green through mango to a bright red is a gradient everybody already knows.
 *
 * Keep in step with RAMP_GLSL in renderer.js and .rv-ramp in ui.css.
 */
const BANDS = [[46, 138, 80], [124, 192, 106], [245, 183, 0], [240, 118, 26], [232, 22, 46]];
export function ramp(t) {
  const c = BANDS[Math.min(BANDS.length - 1, Math.floor(clamp(t, 0, 1) * BANDS.length))];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}
export const rampCss = t => `rgb(${ramp(t).map(v => Math.round(v * 255)).join(',')})`;

/**
 * Build every vertex array the renderer needs.
 * Heights come from `sample(lat, lon)`; the track is snapped to the *rendered*
 * mesh rather than the raw sampler so the ribbon can never sink into a slope.
 */
export function buildGeometry({ track, frame, sample, sat, N, uint }) {
  const { cx, cy, half, K, ext } = frame;
  /**
   * Cap an absolute size at a fraction of the scene.
   *
   * The ribbon width, its clearance above the ground and the depth of the
   * terrain block all carry a floor in metres so that a long route still reads
   * on screen. On a scene a hundred metres across — a lap of a soccer field —
   * those floors are the scene: a 16 m ribbon buries the pitch it is drawn on.
   * Capping each one proportionally leaves anything bigger than about two
   * kilometres exactly as it was and shrinks the rest to match the ground.
   */
  const fit = (v, frac) => Math.min(v, ext * frac);
  const H = new Float32Array(N * N), pos = new Float32Array(N * N * 3);
  const slope = new Float32Array(N * N * 2), uv = new Float32Array(N * N * 2);
  const s = sat && sat.ok ? sat.spec : null;

  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const mx = cx + (i / (N - 1) - 0.5) * 2 * half, my = cy + (j / (N - 1) - 0.5) * 2 * half;
    const lat = invLat(my), lon = invLon(mx);
    H[k] = sample(lat, lon);
    pos[k * 3] = (mx - cx) * K; pos[k * 3 + 1] = (my - cy) * K;
    if (s) { uv[k * 2] = (lon2tx(lon, s.z) - s.x0) * 256 / sat.w; uv[k * 2 + 1] = (lat2ty(lat, s.z) - s.y0) * 256 / sat.h; }
  }

  let hMin = Infinity, hMax = -Infinity;
  for (const h of H) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  const zRef = hMin, hSpan = Math.max(1, hMax - hMin), cell = ext / (N - 1);

  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    pos[k * 3 + 2] = H[k] - zRef;
    slope[k * 2] = (H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)]) / (2 * cell);
    slope[k * 2 + 1] = (H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i]) / (2 * cell);
  }

  const idx = new (uint ? Uint32Array : Uint16Array)((N - 1) * (N - 1) * 6);
  let o = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }

  // side walls, so the terrain reads as a solid block rather than paper
  const sp = [], sc = [], base = -fit(Math.max(120, hSpan * 0.35), 0.06);
  const top = [0.36, 0.20, 0.22], bot = [0.17, 0.10, 0.11];      // dark seed-brown, like the cut edge of a relief model
  const put = (x, y, z, c) => { sp.push(x, y, z); sc.push(c[0], c[1], c[2], 1); };
  const edge = (k1, k2) => {
    const x1 = pos[k1 * 3], y1 = pos[k1 * 3 + 1], z1 = pos[k1 * 3 + 2];
    const x2 = pos[k2 * 3], y2 = pos[k2 * 3 + 1], z2 = pos[k2 * 3 + 2];
    put(x1, y1, z1, top); put(x2, y2, z2, top); put(x1, y1, base, bot);
    put(x2, y2, z2, top); put(x2, y2, base, bot); put(x1, y1, base, bot);
  };
  for (let i = 0; i < N - 1; i++) { edge(i + 1, i); edge((N - 1) * N + i, (N - 1) * N + i + 1); }
  for (let j = 0; j < N - 1; j++) { edge(j * N, (j + 1) * N); edge((j + 1) * N + N - 1, j * N + N - 1); }

  // Height of the *rendered* surface: interpolated across the same two triangles
  // the GPU draws (a,c,b) and (b,c,d), not bilinearly. Bilinear would differ from
  // the drawn mesh by up to half a cell's relief, which is exactly how a route
  // ribbon ends up sunk into a hillside on steep ground.
  const meshH = (wx, wy) => {                       // wx/wy are scene metres
    const x = clamp((wx / K / (2 * half) + 0.5) * (N - 1), 0, N - 1.001);
    const y = clamp((wy / K / (2 * half) + 0.5) * (N - 1), 0, N - 1.001);
    const i0 = Math.floor(x), j0 = Math.floor(y), ux = x - i0, uy = y - j0;
    const a = H[j0 * N + i0], b = H[j0 * N + i0 + 1], c = H[(j0 + 1) * N + i0], d = H[(j0 + 1) * N + i0 + 1];
    return ux + uy <= 1
      ? a + ux * (b - a) + uy * (c - a)
      : d + (1 - ux) * (c - d) + (1 - uy) * (b - d);
  };

  const M = track.lat.length;

  // Where the recording stopped and started again. Nothing may be drawn across
  // one of these: the straight line from where you paused to where you resumed
  // is not a path anybody took, and drawing it would put a kilometre of road
  // through the side of a hill. The ribbon is cut into one strip per segment
  // and the figure simply appears at the far side, which is what a pause is.
  const breaks = (track.breaks || []).filter(b => b > 0 && b < M);
  const strips = [];
  for (let s0 = 0, k = 0; s0 < M;) {
    const end = k < breaks.length ? breaks[k++] : M;
    if (end - s0 >= 2) strips.push({ first: s0 * 2, count: (end - s0) * 2 });
    s0 = end;
  }
  /** first and last index of the segment containing i, so nothing reaches over a gap */
  const segBounds = i => {
    let lo = 0, hi = M - 1;
    for (const b of breaks) { if (b <= i) lo = b; else { hi = b - 1; break; } }
    return [lo, hi];
  };

  const tx = new Float32Array(M), ty = new Float32Array(M), tz = new Float32Array(M);
  const head = new Float32Array(M), course = new Float32Array(M);
  const lift = fit(Math.max(9, hSpan * 0.02), 0.005);
  for (let i = 0; i < M; i++) {
    tx[i] = (mercX(track.lon[i]) - cx) * K;
    ty[i] = (mercY(track.lat[i]) - cy) * K;
    tz[i] = meshH(tx[i], ty[i]) - zRef + lift;
  }
  // Two bearings per point:
  //   head[]   — local facing, averaged over ~±10 samples so GPS jitter cannot
  //              make the direction marker twitch
  //   course[] — where the route is *going*, taken from a look-ahead point a few
  //              hundred metres up the track. This is what the chase camera aims
  //              down, so the road ahead runs away up the screen instead of
  //              swinging through every switchback.
  const totalD = track.dist[M - 1] || 1;
  // …and on a small pitch the look-ahead has to shrink too, or the chase
  // camera aims at a point on the far side of the field the whole time.
  const AHEAD = fit(clamp(totalD * 0.04, 120, 500), 0.12), BEHIND = fit(40, 0.04);
  for (let i = 0; i < M; i++) {
    const [slo, shi] = segBounds(i);
    const a = Math.max(slo, i - 10), b = Math.min(shi, i + 10);
    head[i] = Math.atan2(ty[b] - ty[a], tx[b] - tx[a]);

    let j = i; while (j < shi && track.dist[j] - track.dist[i] < AHEAD) j++;
    let k = i; while (k > slo && track.dist[i] - track.dist[k] < BEHIND) k--;
    if (j === k) { course[i] = head[i]; continue; }
    const fx = tx[j] - tx[k], fy = ty[j] - ty[k], fl = Math.hypot(fx, fy) || 1;
    // blend the long look-ahead with the local tangent so tight bends still register
    course[i] = Math.atan2(fy / fl + Math.sin(head[i]) * 0.3, fx / fl + Math.cos(head[i]) * 0.3);
  }
  // near the finish there is nothing ahead to aim at — hold the last real bearing
  for (let i = M - 1; i > 0; i--) if (totalD - track.dist[i] < AHEAD * 0.5) course[i] = course[i - 1];

  // Overall orientation of the route, used as the default/reset camera bearing so
  // the track reads start-near → end-far. On a loop (start and finish close
  // together) that bearing is meaningless, so aim at the farthest point instead.
  let bearing = Math.atan2(ty[M - 1] - ty[0], tx[M - 1] - tx[0]);
  const gap = Math.hypot(tx[M - 1] - tx[0], ty[M - 1] - ty[0]);
  if (gap < totalD * 0.15) {
    let far = 0, fd = -1;
    for (let i = 0; i < M; i++) {
      const d = (tx[i] - tx[0]) ** 2 + (ty[i] - ty[0]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    bearing = Math.atan2(ty[far] - ty[0], tx[far] - tx[0]);
  }

  // A lightly smoothed copy of the track for the walking figure to travel along.
  // The raw trace is ~10 m between samples, so at playback speed the figure would
  // step from point to point about 30 times a second and pick up every GPS
  // wobble — it reads as trembling. A binomial 5-tap (roughly a 40 m window)
  // removes that without moving the line the ribbon is drawn from.
  const sx = new Float32Array(M), sy = new Float32Array(M), sz = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    let wx = 0, wy = 0, wz = 0, ws = 0;
    const [lo, hi] = segBounds(i);
    for (let k = -2; k <= 2; k++) {
      const j = clamp(i + k, lo, hi), w = [1, 4, 6, 4, 1][k + 2];
      wx += tx[j] * w; wy += ty[j] * w; wz += tz[j] * w; ws += w;
    }
    sx[i] = wx / ws; sy[i] = wy / ws; sz[i] = wz / ws;
  }

  const eMin = track.stats.ele_min, eSpan = Math.max(1, track.stats.ele_max - eMin);
  const w = fit(Math.max(16, ext * 0.0042), 0.008), wo = w * 2.1;
  const rp = new Float32Array(M * 6), rc = new Float32Array(M * 8);
  const op = new Float32Array(M * 6), oc = new Float32Array(M * 8);
  const wp = new Float32Array(M * 6), wc = new Float32Array(M * 8);
  for (let i = 0; i < M; i++) {
    const a = Math.max(0, i - 1), b = Math.min(M - 1, i + 1);
    let dx = tx[b] - tx[a], dy = ty[b] - ty[a];
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const c = ramp((track.ele[i] - eMin) / eSpan);
    // each edge vertex takes the surface height *under itself*, so the ribbon
    // drapes across a cross-slope instead of lying flat and cutting into the hill
    const edgeZ = (ex, ey) => Math.max(meshH(ex, ey) - zRef + lift, tz[i] - lift * 0.5);
    const l = [tx[i] - dy * w / 2, ty[i] + dx * w / 2], rr = [tx[i] + dy * w / 2, ty[i] - dx * w / 2];
    const lo2 = [tx[i] - dy * wo / 2, ty[i] + dx * wo / 2], ro = [tx[i] + dy * wo / 2, ty[i] - dx * wo / 2];
    rp[i * 6] = l[0]; rp[i * 6 + 1] = l[1]; rp[i * 6 + 2] = edgeZ(l[0], l[1]);
    rp[i * 6 + 3] = rr[0]; rp[i * 6 + 4] = rr[1]; rp[i * 6 + 5] = edgeZ(rr[0], rr[1]);
    // the dark halo always rides *under* the ribbon, never in front of it
    const haloZ = (ex, ey) => Math.min(edgeZ(ex, ey), tz[i]) - lift * 0.25;
    op[i * 6] = lo2[0]; op[i * 6 + 1] = lo2[1]; op[i * 6 + 2] = haloZ(lo2[0], lo2[1]);
    op[i * 6 + 3] = ro[0]; op[i * 6 + 4] = ro[1]; op[i * 6 + 5] = haloZ(ro[0], ro[1]);
    wp[i * 6] = tx[i]; wp[i * 6 + 1] = ty[i]; wp[i * 6 + 2] = tz[i];
    wp[i * 6 + 3] = tx[i]; wp[i * 6 + 4] = ty[i]; wp[i * 6 + 5] = 0;
    for (const k of [0, 4]) {
      rc[i * 8 + k] = c[0]; rc[i * 8 + k + 1] = c[1]; rc[i * 8 + k + 2] = c[2]; rc[i * 8 + k + 3] = 1;
      oc[i * 8 + k] = 0.09; oc[i * 8 + k + 1] = 0.125; oc[i * 8 + k + 2] = 0.105; oc[i * 8 + k + 3] = 1;
    }
    wc[i * 8] = c[0]; wc[i * 8 + 1] = c[1]; wc[i * 8 + 2] = c[2]; wc[i * 8 + 3] = 0.42;
    wc[i * 8 + 4] = c[0]; wc[i * 8 + 5] = c[1]; wc[i * 8 + 6] = c[2]; wc[i * 8 + 7] = 0.02;
  }

  return {
    N, ext, zRef, hSpan, indexType: uint ? 'uint32' : 'uint16',
    terrain: { pos, slope, uv, idx },
    skirt: { pos: new Float32Array(sp), col: new Float32Array(sc) },
    ribbon: { pos: rp, col: rc }, outline: { pos: op, col: oc }, curtain: { pos: wp, col: wc },
    track: { tx, ty, tz, sx, sy, sz, head, course, bearing, n: M, width: w, lift, strips, breaks },
  };
}
