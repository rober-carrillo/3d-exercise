/**
 * The crowd in the background.
 *
 * A canvas behind the page where a handful of figures wander across, each
 * leaving a few footprints that fade behind them, with a cyclist through every
 * so often. It is scenery and nothing else: no state, nothing to read, nothing
 * that breaks if it never runs.
 *
 * Which is why it is drawn rather than animated in CSS — a dozen moving
 * elements in the document would land on top of real layout, take the clicks
 * meant for the buttons underneath, and relayout the page sixty times a
 * second. On a canvas they cost one composite, and the one interaction they do
 * have (tap a figure and it turns round) is a hit test rather than a listener
 * each.
 *
 * Nothing here runs under `prefers-reduced-motion`, and nothing runs while the
 * tab is in the background.
 */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * Read the colour tokens once, so the figures sit in whichever theme is on.
 *
 * Four of them rather than one: a crowd in a single grey reads as a smudge,
 * and these were too faint against the pale ground to be seen at all. Each
 * figure keeps one for its life, which is what makes it look like several
 * people out rather than one sprite drawn five times.
 */
function ink() {
  const cs = getComputedStyle(document.documentElement);
  const grab = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    palette: [
      grab('--accent', '#138a4a'),
      grab('--tag-brown', '#7a2e6b'),
      grab('--ink-2', '#4b5a52'),
      grab('--juice', '#e4233f'),
    ],
    step: grab('--ink-2', '#4b5a52'),
  };
}

/**
 * One wanderer.
 *
 * Headings drift slowly rather than holding a perfect line, which is the
 * difference between somebody out for a walk and a sprite on a rail.
 */
function spawn(w, h, { edge = true, palette = ['#138a4a'] } = {}) {
  const kind = Math.random() < 0.28 ? 'ride' : 'walk';
  const scale = kind === 'ride' ? rand(1.5, 2.0) : rand(1.3, 1.85);
  let x, y, dir;
  if (edge) {
    // come in from off-screen, aimed roughly across the page
    const side = pick(['t', 'r', 'b', 'l']);
    const m = 80;
    if (side === 't') { x = rand(0, w); y = -m; dir = rand(0.15, 0.85) * Math.PI; }
    else if (side === 'b') { x = rand(0, w); y = h + m; dir = -rand(0.15, 0.85) * Math.PI; }
    else if (side === 'l') { x = -m; y = rand(0, h); dir = rand(-0.4, 0.4) * Math.PI; }
    else { x = w + m; y = rand(0, h); dir = Math.PI + rand(-0.4, 0.4) * Math.PI; }
  } else {
    x = rand(0, w); y = rand(0, h); dir = rand(0, TAU);
  }
  return {
    kind, scale, x, y, dir,
    speed: kind === 'ride' ? rand(62, 92) : rand(26, 42),   // px per second
    drift: rand(-0.12, 0.12),
    phase: rand(0, TAU),
    colour: pick(palette),
    // A ponytail and a slighter build, or not. It is the whole difference at
    // this size — anything more detailed is four pixels of guesswork — and a
    // crowd of one silhouette repeated is the thing worth avoiding.
    ponytail: Math.random() < 0.5,
    steps: [],
    sinceStep: 0,
    fade: 0,                                 // eases in so nobody pops into view
    turned: 0,                               // counts down after a tap, for a flash of attention
  };
}

const STEP_LIFE = 9;                         // seconds a footprint stays visible
const STEP_MAX = 46;                         // and how many of them trail behind one figure

export function startAmbient({
  mount = document.body,
  max = 11,
} = {}) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return { stop() {} };

  const cv = document.createElement('canvas');
  cv.className = 'amb';
  cv.setAttribute('aria-hidden', 'true');
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  if (!ctx) { cv.remove(); return { stop() {} }; }

  let w = 0, h = 0, dpr = 1, colours = ink();
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  // A phone does not want eleven of these; the count follows the area so a
  // wide desktop looks populated and a small screen stays calm.
  const want = () => Math.max(3, Math.min(max, Math.round(w * h / 115000)));
  const agents = Array.from({ length: want() },
    () => spawn(w, h, { edge: false, palette: colours.palette }));
  for (const a of agents) a.fade = 1;

  const onResize = () => { resize(); };
  const onTheme = () => { colours = ink(); };
  addEventListener('resize', onResize, { passive: true });
  addEventListener('salpicon:theme', onTheme);

  /**
   * A tap turns somebody round.
   *
   * Listening on the document rather than the canvas, because the canvas is
   * underneath the page: a figure wandering behind the hero text would be
   * visible and unclickable, which is worse than not being clickable at all.
   * Anything that was aimed at a control is left alone, and a tap that lands
   * on nobody does nothing rather than the page feeling like it swallowed it.
   */
  const onClick = e => {
    if (e.target.closest?.('a,button,input,label,select,textarea,summary,[role="button"]')) return;
    if (!document.getSelection()?.isCollapsed) return;        // they were selecting text
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bestD = 46 * 46;
    for (const a of agents) {
      const dx = a.x - px, dy = a.y - py - 14 * a.scale;
      const d = dx * dx + dy * dy;
      if (d < bestD) { best = a; bestD = d; }
    }
    // Somewhere else, not simply back the way they came: turning each figure
    // exactly 180° makes a tap feel like flipping a switch, and the crowd ends
    // up retracing its own lines. A new heading at least a quarter turn away
    // reads as somebody changing their mind.
    if (best) {
      const away = rand(Math.PI / 4, TAU - Math.PI / 4);
      best.dir += away;
      best.drift = rand(-0.12, 0.12);
      best.steps.length = 0;
      best.turned = 0.5;
    }
  };
  document.addEventListener('click', onClick);

  let raf = 0, last = performance.now();

  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (now - last) / 1000);     // a long pause must not teleport anyone
    last = now;
    if (document.hidden) return;

    ctx.clearRect(0, 0, w, h);

    while (agents.length < want()) agents.push(spawn(w, h, { palette: colours.palette }));
    while (agents.length > want()) agents.pop();

    for (const [i, a] of agents.entries()) {
      a.dir += a.drift * dt;
      a.x += Math.cos(a.dir) * a.speed * dt;
      a.y += Math.sin(a.dir) * a.speed * dt * 0.55;      // flatter than it is wide: a ground plane
      a.phase += dt * (a.kind === 'ride' ? 9 : 5.2) * a.scale;
      a.fade = Math.min(1, a.fade + dt * 0.8);
      // a brief flare on the one you just turned, so the tap clearly did something
      if (a.turned > 0) a.turned = Math.max(0, a.turned - dt);

      // footprints, every so many pixels rather than every so many frames
      a.sinceStep += a.speed * dt;
      const gap = a.kind === 'ride' ? 9 : 15;
      if (a.sinceStep > gap) {
        a.sinceStep = 0;
        // On foot the marks step left and right of the line walked. A bicycle
        // does not: it leaves one continuous tyre track, so its points sit on
        // the path itself and are joined up rather than dotted.
        const side = a.kind === 'ride' ? 0 : (a.steps.length % 2 ? 1 : -1) * 3.2 * a.scale;
        a.steps.push({
          x: a.x + Math.cos(a.dir + Math.PI / 2) * side,
          y: a.y + Math.sin(a.dir + Math.PI / 2) * side * 0.55,
          t: 0, dir: a.dir,
        });
      }
      for (const s of a.steps) s.t += dt;
      while (a.steps.length && (a.steps[0].t > STEP_LIFE || a.steps.length > STEP_MAX)) a.steps.shift();

      const m = 110;
      if (a.x < -m || a.x > w + m || a.y < -m || a.y > h + m) {
        agents[i] = spawn(w, h, { palette: colours.palette });
        continue;
      }

      drawSteps(ctx, a);
      if (a.kind === 'ride') drawBike(ctx, a, colours);
      else drawWalker(ctx, a, colours);
    }
  }
  raf = requestAnimationFrame(step);

  return {
    stop() {
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
      removeEventListener('salpicon:theme', onTheme);
      document.removeEventListener('click', onClick);
      cv.remove();
    },
  };
}

/**
 * What somebody leaves behind them.
 *
 * Footprints for anyone on foot, and for a cyclist one tyre line instead —
 * drawn a segment at a time because a single stroke can only have one alpha,
 * and the whole point of the trail is that the far end of it has nearly faded.
 */
function drawSteps(ctx, a) {
  ctx.save();
  if (a.kind === 'ride') {
    ctx.strokeStyle = a.colour;
    ctx.lineWidth = 1.6 * a.scale;
    ctx.lineCap = 'round';
    for (let i = 1; i < a.steps.length; i++) {
      const p = a.steps[i - 1], q = a.steps[i];
      const life = 1 - q.t / STEP_LIFE;
      ctx.globalAlpha = 0.26 * life * life * a.fade;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    // and the last stretch, from the newest mark up to the wheels themselves
    const last = a.steps[a.steps.length - 1];
    if (last) {
      ctx.globalAlpha = 0.26 * a.fade;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y); ctx.lineTo(a.x, a.y);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = a.colour;
    for (const s of a.steps) {
      const life = 1 - s.t / STEP_LIFE;
      ctx.globalAlpha = 0.3 * life * life * a.fade;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.dir);
      ctx.beginPath();
      ctx.ellipse(0, 0, 3.1 * a.scale, 1.5 * a.scale, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

/** How solid a figure is right now: a tap brightens the one you tapped. */
const strength = a => (0.52 + a.turned * 0.5) * a.fade;

/**
 * Somebody on foot, about 34px tall at scale 1.
 *
 * Facing is the sign of the heading and nothing more — a stick figure seen
 * from the side reads as walking, and the same figure rotated to a true
 * bearing reads as falling over.
 */
function drawWalker(ctx, a, c) {
  const s = a.scale, swing = Math.sin(a.phase), lift = Math.abs(Math.cos(a.phase));
  const face = Math.cos(a.dir) >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(face * s, s);
  ctx.globalAlpha = strength(a);
  ctx.strokeStyle = a.colour;
  ctx.fillStyle = a.colour;
  ctx.lineWidth = 2.1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const hip = -11, shoulder = -20, head = -24.5;
  ctx.beginPath();                                    // head
  ctx.arc(0, head, 3.2, 0, TAU);
  ctx.fill();
  if (a.ponytail) {                                   // and the hair that goes with it
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-2.7, head - 0.7);
    ctx.quadraticCurveTo(-5.1, head + 0.9, -4.2 - swing * 0.7, head + 4.1);
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();                                    // torso
  ctx.moveTo(0, shoulder + 1); ctx.lineTo(0, hip);
  ctx.stroke();
  ctx.beginPath();                                    // legs
  ctx.moveTo(0, hip); ctx.lineTo(swing * 4.6, hip + 6 - lift); ctx.lineTo(swing * 6.4, 0);
  ctx.moveTo(0, hip); ctx.lineTo(-swing * 4.6, hip + 6 - lift); ctx.lineTo(-swing * 6.4, 0);
  ctx.stroke();
  ctx.beginPath();                                    // arms
  ctx.moveTo(0, shoulder + 2); ctx.lineTo(-swing * 3.6, shoulder + 7); ctx.lineTo(-swing * 5.2, hip + 1);
  ctx.moveTo(0, shoulder + 2); ctx.lineTo(swing * 3.6, shoulder + 7); ctx.lineTo(swing * 5.2, hip + 1);
  ctx.stroke();
  ctx.restore();
}

/**
 * The same rider, on a bike.
 *
 * The saddle sits high and the cranks sit low, because that is what a leg on a
 * bicycle looks like: the first version had the two almost level and the rider
 * appeared to be pedalling with its shins. Wheels carry one spoke each so the
 * bike is turning rather than sliding.
 */
function drawBike(ctx, a, c) {
  const s = a.scale, face = Math.cos(a.dir) >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(face * s, s);
  ctx.globalAlpha = strength(a);
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = a.colour;

  const R = 6.2, back = -8.5, front = 8.5, axle = -R;
  const crank = [-1.4, axle - 1.2], CR = 3.1;         // bottom bracket and crank length
  const saddle = [-5.6, axle - 13.5];                 // hip height: a leg's worth above the cranks
  const bars = [6.4, axle - 11];

  for (const cx of [back, front]) {
    ctx.beginPath(); ctx.arc(cx, axle, R, 0, TAU); ctx.stroke();
    ctx.save();
    ctx.globalAlpha = strength(a) * 0.45;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a.phase) * R * 0.86, axle + Math.sin(a.phase) * R * 0.86);
    ctx.lineTo(cx - Math.cos(a.phase) * R * 0.86, axle - Math.sin(a.phase) * R * 0.86);
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();                                    // frame
  ctx.moveTo(back, axle); ctx.lineTo(crank[0], crank[1]); ctx.lineTo(front, axle);
  ctx.moveTo(crank[0], crank[1]); ctx.lineTo(saddle[0], saddle[1]); ctx.lineTo(bars[0] - 1.4, bars[1] + 1);
  ctx.lineTo(front, axle);
  ctx.moveTo(saddle[0], saddle[1]); ctx.lineTo(bars[0] - 1.4, bars[1] + 1);
  ctx.stroke();
  ctx.beginPath();                                    // bars
  ctx.moveTo(bars[0] - 2.6, bars[1] + 0.4); ctx.lineTo(bars[0], bars[1]);
  ctx.stroke();

  const hip = [saddle[0] + 0.6, saddle[1] - 0.8];
  const shoulder = [hip[0] + 4.6, hip[1] - 7.4];
  ctx.beginPath();                                    // back, from saddle to shoulders
  ctx.moveTo(hip[0], hip[1]); ctx.lineTo(shoulder[0], shoulder[1]);
  ctx.stroke();
  ctx.fillStyle = a.colour;
  ctx.beginPath();                                    // head, up and forward of the shoulders
  ctx.arc(shoulder[0] + 2.4, shoulder[1] - 2.6, 3.1, 0, TAU);
  ctx.fill();
  if (a.ponytail) {
    ctx.beginPath();
    ctx.moveTo(shoulder[0] + 0.4, shoulder[1] - 3.4);
    ctx.quadraticCurveTo(shoulder[0] - 3.4, shoulder[1] - 3.2, shoulder[0] - 4.6, shoulder[1] + 0.4);
    ctx.lineWidth = 1.6; ctx.stroke(); ctx.lineWidth = 1.9;
  }
  ctx.beginPath();                                    // arm, shoulder to bars
  ctx.moveTo(shoulder[0], shoulder[1]); ctx.lineTo(bars[0], bars[1]);
  ctx.stroke();

  // legs: hip to pedal, with a knee where the two bones meet
  for (const side of [0, Math.PI]) {
    const ped = [crank[0] + Math.cos(a.phase + side) * CR, crank[1] + Math.sin(a.phase + side) * CR];
    const knee = [(hip[0] + ped[0]) / 2 + 3.2, (hip[1] + ped[1]) / 2];
    ctx.save();
    if (side) ctx.globalAlpha = strength(a) * 0.6;    // the far leg, behind the frame
    ctx.beginPath();
    ctx.moveTo(hip[0], hip[1]); ctx.lineTo(knee[0], knee[1]); ctx.lineTo(ped[0], ped[1]);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
