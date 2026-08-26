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

/** Tile services. Esri = /{z}/{row}/{col}; the others = /{z}/{x}/{y}. */
export const TILES = {
  esri: {
    label: 'Esri World Imagery',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
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

/** Stitch a tile grid into one canvas. Missing tiles are skipped, never fatal. */
export function loadTiles(spec, url, onTick, timeout = 20000) {
  const cv = document.createElement('canvas');
  cv.width = spec.nx * 256; cv.height = spec.ny * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let ok = 0;
  const jobs = [];
  for (let x = spec.x0; x <= spec.x1; x++) for (let y = spec.y0; y <= spec.y1; y++) {
    jobs.push(new Promise(res => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      let settled = false;
      const done = good => {
        if (settled) return; settled = true;
        if (good) { try { ctx.drawImage(im, (x - spec.x0) * 256, (y - spec.y0) * 256); ok++; } catch {} }
        onTick && onTick(); res();
      };
      im.onload = () => done(true);
      im.onerror = () => done(false);
      setTimeout(() => done(false), timeout);
      im.src = url(spec.z, x, y);
    }));
  }
  return Promise.all(jobs).then(() => ({ cv, ctx, ok, total: spec.nx * spec.ny, spec, w: cv.width, h: cv.height }));
}

/** Decode Mapzen/AWS terrarium RGB into metres, bilinearly. */
export function demSampler(dem) {
  let px;
  try { px = dem.ctx.getImageData(0, 0, dem.w, dem.h).data; }
  catch { return null; }                       // canvas tainted → caller falls back
  const s = dem.spec;
  return (lat, lon) => {
    const x = clamp((lon2tx(lon, s.z) - s.x0) * 256, 0, dem.w - 1.001);
    const y = clamp((lat2ty(lat, s.z) - s.y0) * 256, 0, dem.h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), ux = x - x0, uy = y - y0;
    const at = (a, b) => { const i = (b * dem.w + a) * 4; return px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768; };
    return lerp(lerp(at(x0, y0), at(x0 + 1, y0), ux), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), ux), uy);
  };
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

/** Elevation ramp shared by the ribbon, the profile and the legend. */
const STOPS = [[0, 34, 211, 238], [0.35, 163, 230, 53], [0.70, 251, 191, 36], [1, 244, 63, 94]];
export function ramp(t) {
  t = clamp(t, 0, 1);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i], b = STOPS[i + 1];
    if (t <= b[0]) {
      const u = (t - a[0]) / (b[0] - a[0]);
      return [lerp(a[1], b[1], u) / 255, lerp(a[2], b[2], u) / 255, lerp(a[3], b[3], u) / 255];
    }
  }
  const l = STOPS[STOPS.length - 1];
  return [l[1] / 255, l[2] / 255, l[3] / 255];
}
export const rampCss = t => `rgb(${ramp(t).map(v => Math.round(v * 255)).join(',')})`;

/**
 * Build every vertex array the renderer needs.
 * Heights come from `sample(lat, lon)`; the track is snapped to the *rendered*
 * mesh rather than the raw sampler so the ribbon can never sink into a slope.
 */
export function buildGeometry({ track, frame, sample, sat, N, uint }) {
  const { cx, cy, half, K, ext } = frame;
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
  const sp = [], sc = [], base = -Math.max(120, hSpan * 0.35);
  const top = [0.055, 0.075, 0.10], bot = [0.016, 0.024, 0.035];
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
  const tx = new Float32Array(M), ty = new Float32Array(M), tz = new Float32Array(M), head = new Float32Array(M);
  const lift = Math.max(9, hSpan * 0.02);
  for (let i = 0; i < M; i++) {
    tx[i] = (mercX(track.lon[i]) - cx) * K;
    ty[i] = (mercY(track.lat[i]) - cy) * K;
    tz[i] = meshH(tx[i], ty[i]) - zRef + lift;
  }
  // heading, averaged over ~±10 samples so GPS jitter can't spin a chase camera
  for (let i = 0; i < M; i++) {
    const a = Math.max(0, i - 10), b = Math.min(M - 1, i + 10);
    head[i] = Math.atan2(ty[b] - ty[a], tx[b] - tx[a]);
  }

  const eMin = track.stats.ele_min, eSpan = Math.max(1, track.stats.ele_max - eMin);
  const w = Math.max(20, ext * 0.0055), wo = w * 2.1;
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
      oc[i * 8 + k] = 0.03; oc[i * 8 + k + 1] = 0.045; oc[i * 8 + k + 2] = 0.07; oc[i * 8 + k + 3] = 1;
    }
    wc[i * 8] = c[0]; wc[i * 8 + 1] = c[1]; wc[i * 8 + 2] = c[2]; wc[i * 8 + 3] = 0.42;
    wc[i * 8 + 4] = c[0]; wc[i * 8 + 5] = c[1]; wc[i * 8 + 6] = c[2]; wc[i * 8 + 7] = 0.02;
  }

  return {
    N, ext, zRef, hSpan, indexType: uint ? 'uint32' : 'uint16',
    terrain: { pos, slope, uv, idx },
    skirt: { pos: new Float32Array(sp), col: new Float32Array(sc) },
    ribbon: { pos: rp, col: rc }, outline: { pos: op, col: oc }, curtain: { pos: wp, col: wc },
    track: { tx, ty, tz, head, n: M, width: w },
  };
}
