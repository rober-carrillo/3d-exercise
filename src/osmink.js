/**
 * Turning an OpenStreetMap sheet into something you can lay over a photograph.
 *
 * The standard OSM raster is a complete map: it paints the ground as well as
 * what is on it. Dropped straight onto satellite imagery at any strength that
 * makes the street names legible, the photograph is half gone — the roofs, the
 * trees and the river all disappear under a flat wash of colour that carries no
 * information the picture underneath did not already have.
 *
 * So the wash is taken out and the ink is kept. Two of OSM Carto's fills do
 * nearly all of the covering, and they are exact colours rather than ranges:
 *
 *   #f2efe9  the map background — "nothing is tagged here". 27% of a sheet.
 *   #e0dfdf  residential landuse — "people live here". 6% more.
 *
 * Both are dropped to transparent and the satellite shows through, which is the
 * whole point: the photograph already says what the ground is.
 *
 * The catch is that antialiasing puts those same two tones in thousands of
 * places they do not belong — one or two pixels at a time, around every letter
 * and along every thin lane. Keying them by colour alone leaves the sheet
 * speckled. Measured on one Pereira scene: 23,059 separate patches of #e0dfdf,
 * of which 97% were under twenty pixels and the median was a single pixel.
 *
 * Hence the area filter. A patch of the wash is only treated as wash when it is
 * genuinely a patch — a run of connected pixels at least `minPatch` across.
 * Anything smaller is antialiasing wearing the colour of a landuse, and is left
 * alone. That one rule is the difference between a clean overlay and a dirty
 * one, and it is cheap: two passes and a union-find.
 */

/** The two fills that stand for ground rather than for anything on it. */
const WASH = [[242, 239, 233], [224, 223, 223]];

/**
 * OSM Carto's road palette, fill then casing, motorway down to residential.
 *
 * Used the other way round from the wash: for "roads only" these are the
 * colours worth *keeping* and everything else goes. Taking the roads out of a
 * rendered sheet by colour is a compromise — a vector source would simply draw
 * the roads and nothing else — but it needs no second tile service and no
 * second licence, and at overlay strength the result is a street network with
 * the ground left showing.
 */
const ROADS = [
  [232, 146, 162], [220, 42, 103],      // motorway
  [249, 178, 156], [200, 78, 47],       // trunk
  [252, 214, 164], [160, 107, 0],       // primary
  [247, 250, 191], [112, 125, 5],       // secondary
  [255, 255, 255], [143, 143, 143],     // tertiary
  [187, 187, 187],                      // residential casing
];

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Squared distance in RGB, which is all the comparing here needs. */
function nearest(px, i, palette) {
  let best = Infinity;
  for (let k = 0; k < palette.length; k++) {
    const c = palette[k];
    const dr = px[i] - c[0], dg = px[i + 1] - c[1], db = px[i + 2] - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * Label connected runs of a boolean mask, eight-connected.
 *
 * A two-pass union-find rather than a flood fill: a flood fill of a 2048-square
 * canvas recurses deep enough to matter and is slower besides. Returns the
 * label image and the size of each label, so a caller can judge a patch by how
 * big it is or by what share of it sits somewhere.
 */
function components(mask, w, h) {
  const lab = new Int32Array(w * h);
  const parent = [0];                                  // 0 is "no label"
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  let next = 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      // the four already-visited neighbours: W, NW, N, NE
      let best = 0;
      for (const [dx, dy] of [[-1, 0], [-1, -1], [0, -1], [1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0) continue;
        const n = lab[ny * w + nx];
        if (!n) continue;
        if (!best) best = n; else union(best, n);
      }
      if (!best) { best = next; parent[next] = next; next++; }
      lab[i] = best;
    }
  }
  const sizes = new Int32Array(next);
  for (let i = 0; i < lab.length; i++) {
    if (!lab[i]) continue;
    lab[i] = find(lab[i]);
    sizes[lab[i]]++;
  }
  return { lab, sizes };
}

/** Grow a mask by `r` in each direction, as two cheap one-dimensional passes. */
function dilate(mask, w, h, r) {
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let d = -r; d <= r && !on; d++) {
        const nx = x + d;
        if (nx >= 0 && nx < w && mask[y * w + nx]) on = 1;
      }
      a[y * w + x] = on;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let on = 0;
      for (let d = -r; d <= r && !on; d++) {
        const ny = y + d;
        if (ny >= 0 && ny < h && a[ny * w + x]) on = 1;
      }
      b[y * w + x] = on;
    }
  }
  return b;
}

/**
 * Rewrite an OSM tile canvas in place as a transparent overlay.
 *
 * @param {HTMLCanvasElement} cv   a canvas holding a drawn OSM tile grid
 * @param {object} [o]
 * @param {'full'|'roads'} [o.mode]  the whole sheet minus its ground washes, or
 *   the road network alone
 * @param {number} [o.minPatch]   how many connected pixels of a wash colour it
 *   takes before it counts as ground rather than as antialiasing
 * @param {number} [o.saturate]   colour pushed, to survive being laid on faintly
 * @returns the same canvas
 */
export function osmInk(cv, { mode = 'full', minPatch = 20, saturate = 1.55 } = {}) {
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const px = img.data, w = cv.width, h = cv.height, n = w * h;
  const alpha = new Float32Array(n);

  if (mode === 'roads') {
    // Keep what is a road colour, drop the rest.
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = clamp01(1 - (nearest(px, i * 4, ROADS) - 2) / 22);
      alpha[i] = a;
      solid[i] = a > 0.5 ? 1 : 0;
    }
    // A label's white halo is the same white as a minor road. It is told apart
    // by where it sits: a halo hugs its letters, a road only brushes past one.
    // Judged per patch, so a street running under its own name stays whole
    // instead of being cut into pieces wherever it is labelled.
    const dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const L = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      dark[i] = L < 90 ? 1 : 0;
    }
    const halo = dilate(dark, w, h, 3);
    const { lab, sizes } = components(solid, w, h);
    const inHalo = new Int32Array(sizes.length);
    for (let i = 0; i < n; i++) if (lab[i] && halo[i]) inHalo[lab[i]]++;
    for (let i = 0; i < n; i++) {
      const l = lab[i];
      if (!l) continue;
      if (sizes[l] < 60 || inHalo[l] / sizes[l] > 0.55) alpha[i] = 0;
    }
  } else {
    // Drop the background everywhere; drop the built-up wash only where it is
    // really a patch of it.
    const bg = [WASH[0]], res = [WASH[1]];
    const grey = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      alpha[i] = clamp01((nearest(px, i * 4, bg) - 3) / 27);
      grey[i] = nearest(px, i * 4, res) <= 10 ? 1 : 0;
    }
    const { lab, sizes } = components(grey, w, h);
    for (let i = 0; i < n; i++) {
      const l = lab[i];
      if (l && sizes[l] < minPatch) alpha[i] = 0;       // antialiasing, not landuse
    }
  }

  // Pushed, because it is about to be laid on at well under full strength.
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const L = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
    for (let k = 0; k < 3; k++) {
      px[j + k] = Math.max(0, Math.min(255, L + (px[j + k] - L) * saturate));
    }
    px[j + 3] = alpha[i] * 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
