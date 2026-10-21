/**
 * The Salpicón! mark: a crossing-signal runner and a glass-shaped "!" with a bent
 * straw, drawn as LED beads that run along each stroke.
 *
 * It doubles as a stoplight. The pose and the glass carry the app's state:
 *   ready / arrived  runner, glass full of juice (the main logo)
 *   recording        runner stepping between two poses, glass filling
 *   paused / gps     upright "wait" figure in amber, glass holding its level
 *
 * Colours are not baked in. Every bead carries a class (figure, glass, juice,
 * straw, unlit) and ui.css paints them from tokens, so the same markup works on
 * the pastel ground, in dark mode and inside the dark signal box.
 *
 * Box: 120 × 100.
 */

const POSES = {
  run: {
    head: [44, 20.5],
    limbs: [
      [[41, 34], [32, 59]],                 // torso
      [[40, 38], [53, 47], [62, 37]],       // front arm
      [[38, 39], [24, 45], [17, 57]],       // back arm
      [[32, 59], [50, 67], [46, 89]],       // front leg
      [[32, 59], [23, 77], [8, 81]],        // back leg
    ],
  },
  pass: {                                   // the second frame of the stride
    head: [44, 20.5],
    limbs: [
      [[41, 34], [32, 59]],
      [[40, 38], [50, 49], [58, 44]],
      [[38, 39], [29, 50], [27, 61]],
      [[32, 59], [43, 74], [39, 89]],
      [[32, 59], [24, 76], [15, 88]],       // further back: at this weight a
    ],                                      // narrow stride closes into a blob
  },
  stand: {                                  // the "wait" figure: upright, arms down
    head: [40.5, 20.5],
    limbs: [
      [[40.5, 34], [40.5, 59]],
      [[37, 38], [31, 50], [30, 62]],
      [[44, 38], [50, 50], [51, 62]],
      [[40.5, 59], [34, 74], [34, 89]],
      [[40.5, 59], [47, 74], [47, 89]],
    ],
  },
};
const HEAD_R = 10.2;
const DOT = [95, 84.5], DOT_R = 7.6;
const STRAW = [[99, 24], [99, 6.5], [105.5, 1.5]];
const GLASS_TOP = 12, GLASS_BOTTOM = 62;

function beadsAlong(line, gap) {
  const out = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / gap));
    for (let k = i ? 1 : 0; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
function discBeads(cx, cy, R, gap) {
  const out = [[cx, cy]];
  for (let rr = gap; rr <= R + 0.01; rr += gap) {
    const n = Math.round(2 * Math.PI * rr / gap);
    for (let k = 0; k < n; k++) out.push([cx + rr * Math.cos(2 * Math.PI * k / n), cy + rr * Math.sin(2 * Math.PI * k / n)]);
  }
  return out;
}
const bead = ([x, y], cls, r) => `<circle class="${cls}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r}"/>`;

/**
 * The beads, as SVG markup for a 120 × 100 box.
 * @param {object} o
 * @param {'run'|'pass'|'stand'} [o.pose]
 * @param {number|null} [o.juice]  0..1 how full the glass is; null draws it solid
 * @param {boolean} [o.unlit]      draw the grid of unlit LEDs behind the mark
 */
export function ledMark({ pose = 'run', juice = 1, unlit = true } = {}) {
  const P = POSES[pose] || POSES.run;
  let out = '';
  if (unlit) for (let y = 1; y < 98; y += 3.4) for (let x = 1; x < 120; x += 3.4) out += bead([x, y], 'o', 0.8);
  // Chunky on purpose, the way a pedestrian on a crossing sign is chunky: at
  // the size this mark is actually used — 56 to 76 px across a header — a thin
  // stick figure reads as a scribble, and the thing that makes a crossing
  // light legible at a hundred metres is the weight of the limbs. Beads of
  // 4.3 laid every 2.4 overlap into a solid stroke rather than a dotted one.
  for (const l of P.limbs) for (const p of beadsAlong(l, 2.4)) out += bead(p, 'f', 4.3);
  for (const p of discBeads(P.head[0], P.head[1], HEAD_R - 2.8, 2.6)) out += bead(p, 'f', 3.0);
  // the glass: rows of beads narrowing toward the base, juice from the bottom up
  const level = juice == null ? null : GLASS_BOTTOM - (GLASS_BOTTOM - GLASS_TOP) * Math.max(0, Math.min(1, juice));
  for (let y = 15; y <= 59; y += 3.4) {
    const t = (y - GLASS_TOP) / (GLASS_BOTTOM - GLASS_TOP), x0 = 80 + 4.8 * t + 2.2, x1 = 110 - 4.8 * t - 2.2;
    const n = Math.max(1, Math.round((x1 - x0) / 2.9));
    const cls = level == null ? 'g' : y >= level ? 'j' : 'g empty';
    for (let k = 0; k <= n; k++) out += bead([x0 + (x1 - x0) * k / n, y], cls, 2.3);
  }
  for (const p of discBeads(DOT[0], DOT[1], DOT_R - 2.4, 3.0)) out += bead(p, 'g', 2.3);
  for (const p of beadsAlong(STRAW, 2.6)) out += bead(p, 's', 1.5);
  return out;
}

/** The whole mark as an `<svg>`; `cls` adds state classes such as `wait` or `blink`. */
export function markSVG(opts = {}, { cls = '', label = 'Salpicón!' } = {}) {
  return `<svg class="mk ${cls}" viewBox="-2 -2 124 102" role="img" aria-label="${label}">${ledMark(opts)}</svg>`;
}

/**
 * The stoplight: what the mark shows for a recorder state.
 * @param {'ready'|'gps'|'recording'|'paused'|'arrived'} state
 * @param {number} frame   ticks since the state began; odd frames are the other stride
 * @param {number} juice   0..1, how full the glass is while recording
 * @param {boolean} still  reduced motion: no stepping, no blinking
 */
export function signalFor(state, frame = 0, juice = 0, still = false) {
  switch (state) {
    case 'recording':
      return { opts: { pose: !still && frame % 2 ? 'pass' : 'run', juice }, cls: '', label: 'Recording' };
    case 'paused':
      return { opts: { pose: 'stand', juice }, cls: 'wait' + (still ? '' : ' blink'), label: 'Paused' };
    case 'gps':
      return { opts: { pose: 'stand', juice: 0 }, cls: 'wait' + (still ? '' : ' blink'), label: 'Waiting for GPS' };
    case 'arrived':
    case 'ready':
    default:
      return { opts: { pose: 'run', juice: 1 }, cls: '', label: state === 'arrived' ? 'Arrived' : 'Salpicón!' };
  }
}
