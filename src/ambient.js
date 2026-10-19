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

/** Read a colour token once, so the figures sit in whichever theme is on. */
function ink(el) {
  const cs = getComputedStyle(document.documentElement);
  const grab = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    body: grab('--ink-3', '#7d8a83'),
    step: grab('--ink-3', '#7d8a83'),
    bike: grab('--accent', '#138a4a'),
  };
}

/**
 * One wanderer.
 *
 * Headings drift slowly rather than holding a perfect line, which is the
 * difference between somebody out for a walk and a sprite on a rail.
 */
function spawn(w, h, { edge = true } = {}) {
  const kind = Math.random() < 0.22 ? 'ride' : 'walk';
  const scale = kind === 'ride' ? rand(0.9, 1.25) : rand(0.75, 1.15);
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
    speed: kind === 'ride' ? rand(52, 78) : rand(15, 27),   // px per second
    drift: rand(-0.12, 0.12),
    phase: rand(0, TAU),
    steps: [],
    sinceStep: 0,
    fade: 0,                                 // eases in so nobody pops into view
    turned: 0,                               // counts down after a tap, for a flash of attention
  };
}

const STEP_LIFE = 3.4;                       // seconds a footprint stays visible

export function startAmbient({
  mount = document.body,
  max = 6,
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

  // A phone does not want six of these; the count follows the area so a wide
  // desktop looks populated and a small screen stays calm.
  const want = () => Math.max(2, Math.min(max, Math.round(w * h / 230000)));
  const agents = Array.from({ length: want() }, () => spawn(w, h, { edge: false }));
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
    if (best) { best.dir += Math.PI; best.steps.length = 0; best.turned = 0.5; }
  };
  document.addEventListener('click', onClick);

  let raf = 0, last = performance.now();

  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (now - last) / 1000);     // a long pause must not teleport anyone
    last = now;
    if (document.hidden) return;

    ctx.clearRect(0, 0, w, h);

    while (agents.length < want()) agents.push(spawn(w, h));
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
      const gap = a.kind === 'ride' ? 26 : 15;
      if (a.sinceStep > gap) {
        a.sinceStep = 0;
        const side = (a.steps.length % 2 ? 1 : -1) * 3.2 * a.scale;
        a.steps.push({
          x: a.x + Math.cos(a.dir + Math.PI / 2) * side,
          y: a.y + Math.sin(a.dir + Math.PI / 2) * side * 0.55,
          t: 0, dir: a.dir,
        });
      }
      for (const s of a.steps) s.t += dt;
      while (a.steps.length && a.steps[0].t > STEP_LIFE) a.steps.shift();

      const m = 110;
      if (a.x < -m || a.x > w + m || a.y < -m || a.y > h + m) { agents[i] = spawn(w, h); continue; }

      drawSteps(ctx, a, colours);
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

function drawSteps(ctx, a, c) {
  ctx.save();
  ctx.fillStyle = c.step;
  for (const s of a.steps) {
    const life = 1 - s.t / STEP_LIFE;
    ctx.globalAlpha = 0.2 * life * life * a.fade;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.dir);
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.6 * a.scale, 1.3 * a.scale, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * A walker, about 26px tall at scale 1.
 *
 * Facing is the sign of the heading only — a stick figure seen from the side
 * reads as walking; the same figure rotated to a true bearing reads as falling
 * over.
 */
function drawWalker(ctx, a, c) {
  const s = a.scale, swing = Math.sin(a.phase), lift = Math.abs(Math.cos(a.phase));
  const face = Math.cos(a.dir) >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(face * s, s);
  ctx.globalAlpha = (0.36 + a.turned * 0.5) * a.fade;
  ctx.strokeStyle = c.body;
  ctx.fillStyle = c.body;
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';

  const hip = -11, shoulder = -20, head = -24.5;
  ctx.beginPath();                                    // head
  ctx.arc(0, head, 3.1, 0, TAU);
  ctx.fill();
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

/** The same rider, on a bike. Wheels turn with the phase so it is not sliding. */
function drawBike(ctx, a, c) {
  const s = a.scale, face = Math.cos(a.dir) >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(face * s, s);
  ctx.globalAlpha = (0.36 + a.turned * 0.5) * a.fade;
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  ctx.strokeStyle = c.bike;

  const R = 5.2, back = -7.5, front = 7.5, axle = -R;
  for (const cx of [back, front]) {                   // wheels, with one spoke to show the spin
    ctx.beginPath(); ctx.arc(cx, axle, R, 0, TAU); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a.phase) * R * 0.85, axle + Math.sin(a.phase) * R * 0.85);
    ctx.lineTo(cx - Math.cos(a.phase) * R * 0.85, axle - Math.sin(a.phase) * R * 0.85);
    ctx.globalAlpha = 0.15 * a.fade; ctx.stroke(); ctx.globalAlpha = (0.36 + a.turned * 0.5) * a.fade;
  }
  ctx.beginPath();                                    // frame and bars
  ctx.moveTo(back, axle); ctx.lineTo(-1, axle - 1); ctx.lineTo(1.5, axle - 7);
  ctx.lineTo(front, axle); ctx.moveTo(1.5, axle - 7); ctx.lineTo(4.5, axle - 7.5);
  ctx.moveTo(-1, axle - 1); ctx.lineTo(-4, axle - 7);
  ctx.stroke();

  ctx.strokeStyle = c.body;                           // the rider, folded over the bars
  ctx.fillStyle = c.body;
  ctx.beginPath(); ctx.arc(0.5, axle - 16.5, 2.9, 0, TAU); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-3.5, axle - 8.5); ctx.lineTo(1, axle - 14);
  ctx.lineTo(4.6, axle - 8);                          // arm to the bars
  ctx.stroke();
  const ped = a.phase;                                // legs on the cranks
  ctx.beginPath();
  ctx.moveTo(-3.5, axle - 8.5); ctx.lineTo(-1.5 + Math.cos(ped) * 2.2, axle - 4 + Math.sin(ped) * 2.2);
  ctx.moveTo(-3.5, axle - 8.5); ctx.lineTo(-1.5 - Math.cos(ped) * 2.2, axle - 4 - Math.sin(ped) * 2.2);
  ctx.stroke();
  ctx.restore();
}
