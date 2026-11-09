/**
 * Writing on the ground, set as type rather than fetched as a picture.
 *
 * Two kinds, and they are different objects with different rules, which is the
 * whole design:
 *
 *   a street name   lies on its street, turned to run along it, and belongs to
 *                   the ground. It is sized in metres, so it grows as you come
 *                   down to it the way the street does, and it is drawn above
 *                   the route ribbon so that the line of the run never hides
 *                   the name of the road it was run on.
 *
 *   a region name   floats in the air over the place it names and always faces
 *                   the camera, because a barrio is not a thing lying on the
 *                   ground at an angle — it is a label on an area, and the one
 *                   thing it must do is stay readable from wherever you are
 *                   looking. It is sized in pixels, not metres, so it neither
 *                   swells nor vanishes as the camera moves.
 *
 * Everything here is arithmetic and canvas: no WebGL, so the placement can be
 * reasoned about and tested without a context. The renderer takes what comes
 * out of this and turns it into quads every frame.
 */

/**
 * The size the glyphs are drawn at in the atlas.
 *
 * This is the ceiling on sharpness: a name shown larger than this on screen is
 * being magnified and will soften. 44 px covers the sizes anything is actually
 * read at here — street names are clamped to 40 px on screen and region names
 * to 30 — while leaving a 2048-wide sheet enough room for a few hundred names.
 */
const FONT_PX = 44;
const PAD = 6;
const ATLAS_W = 2048;
const MAX_ATLAS_H = 2048;

const FACE = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/**
 * Ink and halo.
 *
 * A name has to survive a photograph underneath it, which may be a white roof
 * or a black shadow and is often both within the same word. A heavy halo in
 * the opposite tone is what makes that survivable, and it is drawn under the
 * fill rather than around it so the letterforms keep their shape.
 */
const INK = {
  light: { fill: '#1b2420', halo: 'rgba(255,255,255,0.92)' },
  dark: { fill: '#f4efe9', halo: 'rgba(14,18,16,0.88)' },
};

/**
 * Every distinct name, drawn once, packed into one sheet.
 *
 * One texture rather than one per name: a scene has a few hundred names, and
 * binding a texture for each would cost more than drawing them. Rows of a
 * fixed height, filled left to right — a proper packer would waste less space
 * and there is no shortage of space.
 *
 * @returns {{canvas, rects: Map<string, object>, dropped: string[]}}
 */
export function makeAtlas(strings, { theme = 'light', fontPx = FONT_PX } = {}) {
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = 64;
  const cx = cv.getContext('2d');
  const font = `650 ${fontPx}px ${FACE}`;
  cx.font = font;

  const rowH = Math.ceil(fontPx * 1.34) + PAD * 2;
  const measured = [];
  for (const s of strings) {
    const w = Math.min(ATLAS_W - PAD * 2, Math.ceil(cx.measureText(s).width) + PAD * 2);
    measured.push({ s, w });
  }

  // Lay out first, then size the canvas once: resizing a canvas clears it, so
  // growing it as we go would mean drawing everything twice.
  let x = 0, y = 0, rows = 1;
  const spots = [];
  const dropped = [];
  for (const m of measured) {
    if (x + m.w > ATLAS_W) { x = 0; y += rowH; rows++; }
    if (y + rowH > MAX_ATLAS_H) { dropped.push(m.s); continue; }
    spots.push({ ...m, x, y });
    x += m.w;
  }
  // Rounded up to a power of two, and not for tidiness: WebGL1 refuses to
  // build mipmaps for a texture that is not, and without mipmaps a name seen
  // from far off sparkles as the camera moves. The waste is a few hundred
  // kilobytes of transparent sheet.
  const pot = v => { let p = 64; while (p < v) p *= 2; return p; };
  cv.width = ATLAS_W;
  cv.height = Math.max(64, Math.min(MAX_ATLAS_H, pot(rows * rowH)));

  const ink = INK[theme] || INK.light;
  cx.font = font;
  cx.textBaseline = 'middle';
  cx.textAlign = 'left';
  cx.lineJoin = 'round';
  cx.miterLimit = 2;
  cx.strokeStyle = ink.halo;
  cx.lineWidth = Math.max(3, fontPx * 0.26);
  cx.fillStyle = ink.fill;

  const rects = new Map();
  for (const sp of spots) {
    const cy = sp.y + rowH / 2;
    cx.strokeText(sp.s, sp.x + PAD, cy);
    cx.fillText(sp.s, sp.x + PAD, cy);
    rects.set(sp.s, {
      u0: sp.x / cv.width, v0: sp.y / cv.height,
      u1: (sp.x + sp.w) / cv.width, v1: (sp.y + rowH) / cv.height,
      // what the quad's proportions have to be for the text not to stretch
      aspect: sp.w / rowH,
    });
  }
  return { canvas: cv, rects, dropped, rowH, fontPx };
}

/** Distance along a polyline, and the point and heading partway along it. */
function walk(pts) {
  const n = pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  }
  return { n, cum, total: cum[n - 1] || 0 };
}

/** The point at distance `d` along a polyline, plus the way it is heading. */
function at(pts, cum, n, d) {
  let i = 1;
  while (i < n - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
  const x0 = pts[i * 2 - 2], y0 = pts[i * 2 - 1], x1 = pts[i * 2], y1 = pts[i * 2 + 1];
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, dir: Math.atan2(y1 - y0, x1 - x0) };
}

/**
 * Where each street name goes.
 *
 * OpenStreetMap does not hold a street, it holds the pieces a street was drawn
 * in: 1,763 ways carried 280 names in one scene over Pereira, so labelling
 * every way would print "Calle 14" two dozen times down one road. Names are
 * therefore grouped, the longest pieces preferred, and a second label for the
 * same name allowed only when it is far enough from the first to be about a
 * different part of town.
 *
 * @param project  (lon, lat) -> [x, y] in scene metres
 */
export function placeStreets(streets, project, { ext, maxPerName = 3, minLen = null, minSep = null } = {}) {
  const floor = minLen ?? ext * 0.03;          // shorter than this and the name will not fit on it
  const apart = minSep ?? ext * 0.12;          // two labels for one name have to be about different places
  const byName = new Map();

  for (const st of streets) {
    const g = st.g;
    const pts = new Float64Array(g.length);
    for (let i = 0; i < g.length; i += 2) {
      const p = project(g[i], g[i + 1]);
      pts[i] = p[0]; pts[i + 1] = p[1];
    }
    const { n, cum, total } = walk(pts);
    if (n < 2 || total < floor) continue;
    const m = at(pts, cum, n, total / 2);
    const list = byName.get(st.n) || [];
    list.push({ text: st.n, rank: st.r, len: total, x: m.x, y: m.y, dir: m.dir });
    byName.set(st.n, list);
  }

  const out = [];
  for (const list of byName.values()) {
    list.sort((a, b) => b.len - a.len);        // the longest piece is the best place for the name
    const taken = [];
    for (const c of list) {
      if (taken.length >= maxPerName) break;
      if (taken.some(t => Math.hypot(t.x - c.x, t.y - c.y) < apart)) continue;
      taken.push(c);
    }
    out.push(...taken);
  }
  // The heading is left exactly as the street runs. Which of its two
  // directions the words read in is not decided here: it depends on where the
  // camera is, it changes the moment anybody orbits, and the renderer settles
  // it every frame.
  return out;
}

/**
 * Where each region name floats. One per name: a barrio has one centre.
 *
 * `place=locality` and below are left out. They are real tags and they are not
 * regions — a bend in a road, a cattle market, the entrance to somewhere —
 * and floating them in the air beside the name of the city claims a
 * significance they do not have.
 */
export function placePlaces(places, project, { ext, minRank = 3 } = {}) {
  const seen = new Map();
  for (const p of places) {
    if (p.r < minRank) continue;
    const prev = seen.get(p.n);
    if (prev && prev.rank >= p.r) continue;
    const [x, y] = project(p.lon, p.lat);
    // Outside the ground that was built there is no terrain to float over.
    const half = ext / 2;
    if (Math.abs(x) > half || Math.abs(y) > half) continue;
    seen.set(p.n, { text: p.n, rank: p.r, x, y });
  }
  return [...seen.values()];
}

/**
 * Everything the renderer needs, from what the network gave us.
 *
 * @param names   {streets, places} from src/placenames.js
 * @param project (lon, lat) -> [x, y] scene metres
 * @param groundZ (x, y) -> height of the drawn surface there
 */
export function buildNameSet(names, project, { ext, groundZ, theme = 'light' } = {}) {
  const streets = placeStreets(names.streets || [], project, { ext });
  const places = placePlaces(names.places || [], project, { ext });
  // The atlas is built from the names that survived placement, not from
  // everything that arrived: a sheet of words nothing points at is pure waste,
  // and the sheet has a ceiling.
  const order = [...places, ...streets].sort((a, b) => b.rank - a.rank);
  const atlas = makeAtlas([...new Set(order.map(o => o.text))], { theme });

  const items = [];
  for (const p of places) {
    const r = atlas.rects.get(p.text);
    if (!r) continue;
    items.push({ kind: 'place', ...p, ...r, z: groundZ(p.x, p.y) });
  }
  for (const s of streets) {
    const r = atlas.rects.get(s.text);
    if (!r) continue;
    items.push({ kind: 'street', ...s, ...r, z: groundZ(s.x, s.y) });
  }
  return { atlas: atlas.canvas, items, dropped: atlas.dropped.length };
}
