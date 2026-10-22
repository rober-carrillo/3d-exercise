#!/usr/bin/env node
/**
 * Draw every icon the app needs, from one description of the mark.
 *
 * The launcher icon, the round legacy variant, the adaptive foreground and
 * monochrome layers at five densities, the browser tab's favicon and the
 * Apple touch icon are all the same drawing at different sizes with different
 * parts switched on. Keeping them in a script rather than in twenty exported
 * files means changing the figure is one edit, and means they can never drift
 * apart — which is how the app ended up shipping a thin runner in the launcher
 * long after the header had a heavy one.
 *
 *   node scripts/make-icons.mjs
 *
 * PNGs are rendered by headless Chrome, which is already on any machine that
 * can test this app, rather than by adding an image library to a project that
 * deliberately has no dependencies.
 */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GREEN = '#138A4A', JUICE = '#E4233F', SHEET = '#FCF1EE';

/**
 * The heavy run pose, exactly as src/mark.js draws it, with the glass moved
 * from beside the figure into the hand at the end of the leading arm.
 */
const POSE = {
  head: [44, 20.5],
  limbs: [
    [[41, 34], [32, 59]],                 // torso
    [[40, 38], [53, 47], [62, 37]],       // leading arm — the hand that carries
    [[38, 39], [24, 45], [17, 57]],       // trailing arm
    [[32, 59], [50, 67], [46, 89]],       // leading leg
    [[32, 59], [23, 77], [8, 81]],        // trailing leg
  ],
};
const GLASS = { dx: 9, dy: -1, s: 0.86 };   // offset from the hand, and its scale
const STROKE = 8.6, HEAD_R = 10.2;

/** The glass, gripped at its waist by the hand at (hx, hy). */
function glass(hx, hy, s, colour) {
  const w = 17 * s, h = 26 * s, taper = w * 0.16;
  const x0 = hx - w / 2, yTop = hy - h * 0.62, yBot = yTop + h;
  return `<path d="M${x0} ${yTop} L${x0 + w} ${yTop} L${x0 + w - taper} ${yBot} L${x0 + taper} ${yBot} Z" fill="${colour}"/>`
    + `<path d="M${hx + w * 0.22} ${yTop} L${hx + w * 0.30} ${yTop - h * 0.42} L${hx + w * 0.62} ${yTop - h * 0.52}"`
    + ` fill="none" stroke="${colour}" stroke-width="${(2.6 * s).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** The whole mark in pose units: figure in one colour, glass in another. */
function mark(figure, drink) {
  const hand = POSE.limbs[1].at(-1);
  return POSE.limbs.map(l =>
      `<path d="M${l.map(p => p.join(' ')).join(' L')}" fill="none" stroke="${figure}"`
      + ` stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
    + `<circle cx="${POSE.head[0]}" cy="${POSE.head[1]}" r="${HEAD_R}" fill="${figure}"/>`
    + glass(hand[0] + GLASS.dx, hand[1] + GLASS.dy, GLASS.s, drink);
}

/**
 * The drawing's extent, measured rather than guessed.
 *
 * Every joint, the top of the straw, the foot furthest back, and half a stroke
 * on each side. Guessing this is how artwork ends up with its heel clipped by
 * a launcher's circular mask on one phone in ten.
 */
function bounds() {
  const pts = [...POSE.limbs.flat(), POSE.head];
  const hand = POSE.limbs[1].at(-1);
  const gx = hand[0] + GLASS.dx, gy = hand[1] + GLASS.dy;
  const w = 17 * GLASS.s, h = 26 * GLASS.s;
  pts.push([gx - w / 2, gy - h * 0.62 - h * 0.52], [gx + w * 0.62, gy - h * 0.62], [gx + w / 2, gy - h * 0.62 + h]);
  const pad = STROKE / 2 + 1.1;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/**
 * One SVG.
 * @param {object} o
 * @param {number} o.box    viewBox size: 108 for an adaptive layer, 100 otherwise
 * @param {number} o.fit    the square the drawing is fitted into
 * @param {string|null} o.bg  background colour, or null to leave it transparent
 * @param {string} o.figure
 * @param {string} o.drink
 * @param {number} [o.radius] rounded corners on the background
 * @param {boolean} [o.circle] clip the background to a circle instead
 */
function svg({ box, fit, bg, figure, drink, radius = 0, circle = false }) {
  const B = bounds();
  const k = fit / Math.max(B.w, B.h);
  const tx = box / 2 - (B.x + B.w / 2) * k, ty = box / 2 - (B.y + B.h / 2) * k;
  const ground = !bg ? ''
    : circle ? `<circle cx="${box / 2}" cy="${box / 2}" r="${box / 2}" fill="${bg}"/>`
    : `<rect width="${box}" height="${box}" rx="${radius}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${box}" height="${box}">`
    + ground
    + `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(5)})">${mark(figure, drink)}</g>`
    + `</svg>`;
}

/* ---------- what each file is ---------- */

// An adaptive layer is 108 units with only the middle 72 guaranteed to
// survive the launcher's mask, so the drawing is fitted to those 72.
const FOREGROUND = { box: 108, fit: 72, bg: null, figure: GREEN, drink: JUICE };
// Themed icons on Android 13 recolour this, so it is one colour and no ground.
const MONOCHROME = { box: 108, fit: 72, bg: null, figure: '#FFFFFF', drink: '#FFFFFF' };
// Legacy, for Android 7 and older: full bleed, no transparency anywhere, so
// there is no corner left over for a launcher to show as a pale margin.
const LEGACY = { box: 100, fit: 78, bg: SHEET, figure: GREEN, drink: JUICE, radius: 0 };
const LEGACY_ROUND = { ...LEGACY, circle: true };
// The browser tab and the iOS home screen.
const FAVICON = { box: 100, fit: 80, bg: SHEET, figure: GREEN, drink: JUICE, radius: 0 };
const TOUCH = { box: 100, fit: 72, bg: SHEET, figure: GREEN, drink: JUICE, radius: 0 };

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/* ---------- rendering ---------- */

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => existsSync(p));

/** Render a batch of {svg, size, out} through one headless Chrome. */
async function renderPNGs(jobs) {
  if (!CHROME) throw new Error('no Chrome found to render PNGs with');
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = join(root, '.icon-render-' + port);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await wait(200);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
        target = list.find(t => t.webSocketDebuggerUrl);
      } catch {}
    }
    if (!target) throw new Error('Chrome never came up');
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); sock.send(JSON.stringify({ id, method, params })); });
    sock.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    await new Promise(r => { sock.onopen = r; });
    await send('Page.enable');
    // Transparent, so a layer with no background really has none.
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    for (const job of jobs) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: job.size, height: job.size, deviceScaleFactor: 1, mobile: false,
      });
      const html = `<!doctype html><meta charset="utf-8">`
        + `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${job.size}px;height:${job.size}px}</style>`
        + job.svg;
      await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
      await wait(120);
      // An explicit clip rather than "whatever the viewport happens to be".
      // Setting device metrics and screenshotting straight after is a race:
      // the first image came out 429 px wide because the resize had not
      // landed, and a 429x108 launcher icon is the kind of thing that ships.
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: job.size, height: job.size, scale: 1 },
        captureBeyondViewport: true,
      });
      await mkdir(dirname(job.out), { recursive: true });
      await writeFile(job.out, Buffer.from(shot.data, 'base64'));
    }
    sock.close();
  } finally {
    chrome.kill();
    // Chrome is still flushing its profile as it dies; a failed tidy-up is not
    // a reason to lose the icons that were just drawn.
    for (let i = 0; i < 5; i++) {
      try { await rm(profile, { recursive: true, force: true }); break; }
      catch { await wait(300); }
    }
  }
}

/* ---------- go ---------- */

const jobs = [];
for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = join(root, 'android/app/src/main/res', `mipmap-${density}`);
  jobs.push(
    { svg: svg(FOREGROUND),   size: Math.round(108 * scale), out: join(dir, 'ic_launcher_foreground.png') },
    { svg: svg(MONOCHROME),   size: Math.round(108 * scale), out: join(dir, 'ic_launcher_monochrome.png') },
    { svg: svg(LEGACY),       size: Math.round(48 * scale),  out: join(dir, 'ic_launcher.png') },
    { svg: svg(LEGACY_ROUND), size: Math.round(48 * scale),  out: join(dir, 'ic_launcher_round.png') },
  );
}
jobs.push({ svg: svg(TOUCH), size: 180, out: join(root, 'brand/apple-touch-icon.png') });

await writeFile(join(root, 'brand/favicon.svg'), svg(FAVICON) + '\n');
await renderPNGs(jobs);

// Every PNG is the size it claims to be, or the build that bundles it is wrong
// in a way nobody notices until it is on a phone.
const { readFile } = await import('node:fs/promises');
for (const job of jobs) {
  const buf = await readFile(job.out);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== job.size || h !== job.size) {
    throw new Error(`${job.out} came out ${w}x${h}, expected ${job.size}x${job.size}`);
  }
}

const B = bounds();
console.log(`  drawing extent ${B.w.toFixed(1)} x ${B.h.toFixed(1)} pose units, fitted to the safe square`);
console.log(`  ${jobs.length} PNGs across ${Object.keys(DENSITIES).length} densities, plus brand/favicon.svg`);
