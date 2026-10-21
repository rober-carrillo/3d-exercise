#!/usr/bin/env node
/**
 * Build step: scan routes/ for .gpx files, derive a manifest, copy the static
 * site into dist/.
 *
 * The repository stores only GPX tracks — every statistic, profile and 3D
 * surface is derived, here or in the browser. Adding a route means adding a
 * file; this script is what makes it show up.
 */
import { readdir, readFile, writeFile, rm, mkdir, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { parseGPX, analyze, profileSamples } from '../src/gpx.js';
import { sceneFrame, pickZoom } from '../src/terrain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'dist');
const STATIC = ['index.html', 'routes.html', 'library.html', 'view.html', 'r.html',
                'src', 'brand'];

/**
 * Which of the recordings in routes/ the platform actually shows.
 *
 * Everything in that folder is still parsed and checked on every build, so a
 * broken file is caught whether it is published or not — but only these reach
 * the manifest, the library, the standalone copies and dist/. The rest stay in
 * the repository as what they are: a personal archive, not a shop window.
 *
 * Keeping the unpublished ones out of dist/ is the difference between an 8 MB
 * folder of GPX travelling inside the Android app and the four files it
 * actually draws.
 */
const PUBLISHED = new Set([
  'caminata-alto-del-toro',     // the landing page's replay: 601 m of climb
  'unicentro-las-pinas-oct-4',
  'ciclismo-exterior',
  'carrera-por-la-manana',
]);

const run = promisify(execFile);

/**
 * When a route without its own timestamp joined the library.
 *
 * The commit that added the file is the honest answer, so ask git first. A
 * file that is not committed yet — one just dropped into routes/ — has no
 * commit to point at, and a checkout on a build machine rewrites every
 * mtime, so the filesystem date is only a fallback, never the first choice.
 */
async function addedDate(file) {
  const path = join(root, 'routes', file);
  try {
    const { stdout } = await run('git', ['log', '--diff-filter=A', '--format=%aI', '-1', '--', path], { cwd: root });
    const iso = stdout.trim().split('\n')[0];
    if (iso) return new Date(iso).toISOString();
  } catch {}                                   // no git, no history, not a repo
  try { return (await stat(path)).mtime.toISOString(); } catch { return null; }
}

/**
 * The route's shape, flattened to a unit box, for a thumbnail.
 *
 * A preview of a route ought to look like that route — a lap of a park is not
 * a mountain traverse, and the elevation sparkline cannot tell you which it
 * was. Sixty-four points is plenty at thumbnail size, longitudes are squeezed
 * by cos(latitude) so nothing comes out stretched, and the aspect ratio is
 * kept by scaling both axes by the larger span rather than fitting each.
 */
function shapeSamples(track, n = 64) {
  const b = track.bbox, N = track.lat.length;
  if (!N) return [];
  const k = Math.cos((b.minLat + b.maxLat) / 2 * Math.PI / 180);
  const w = Math.max(1e-9, (b.maxLon - b.minLon) * k);
  const h = Math.max(1e-9, b.maxLat - b.minLat);
  const span = Math.max(w, h);
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = Math.round(i / (n - 1) * (N - 1));
    const x = ((track.lon[j] - b.minLon) * k - w / 2) / span + 0.5;
    const y = ((track.lat[j] - b.minLat) - h / 2) / span + 0.5;
    out.push([+x.toFixed(4), +(1 - y).toFixed(4)]);     // SVG counts y downwards
  }
  return out;
}

const slugify = s => basename(s, extname(s)).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const files = (await readdir(join(root, 'routes')))
  .filter(f => extname(f).toLowerCase() === '.gpx').sort();

if (!files.length) console.warn('! no .gpx files found in routes/');

let routes = [];
for (const file of files) {
  const text = await readFile(join(root, 'routes', file), 'utf8');
  try {
    const track = analyze(parseGPX(text));
    const b = track.bbox;
    // the day it was done if the recorder wrote one down, else the day it landed here
    const date = track.time || await addedDate(file);
    routes.push({
      slug: slugify(file),
      file,
      // a file with no <name> of its own is better called by its filename
      // than "Untitled route", which is what the parser falls back to
      name: track.name && track.name !== 'Untitled route'
        ? track.name : basename(file, extname(file)).replace(/[_-]+/g, ' '),
      activity: track.activity,
      date,
      dateSource: track.time ? 'recorded' : 'added',
      pace: !!track.secs,               // per-point times → the replay can follow them
      stats: {
        points: track.stats.points,
        distance_m: +track.stats.distance_m.toFixed(1),
        gain_m: +track.stats.gain_m.toFixed(1),
        loss_m: +track.stats.loss_m.toFixed(1),
        ele_min: track.stats.ele_min,
        ele_max: track.stats.ele_max,
        // the clock, without which no total and no best effort can be shown
        duration_s: track.stats.duration_s,
        moving_s: track.stats.moving_s,
      },
      bbox: b,
      center: [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2],
      profile: profileSamples(track, 96),
      shape: shapeSamples(track, 64),
    });
    console.log(`  ✓ ${file} — ${(track.stats.distance_m / 1000).toFixed(2)} km, +${Math.round(track.stats.gain_m)} m`);
  } catch (err) {
    console.error(`  ✗ ${file} — ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Ship the map for the route the landing page replays.
 *
 * That one route is drawn every time anybody opens the site, and every single
 * one of those draws was eight fresh requests to a metered imagery API for
 * exactly the same eight pictures. Fetching them once here and serving them
 * from our own origin turns thousands of billable requests a month into one
 * per deploy, and it makes the landing page work with no imagery key at all —
 * including inside the Android app, which carries dist/ with it and is now the
 * only copy of this route anybody needs.
 *
 * The zoom is chosen with the same arithmetic the viewer uses, so the tiles it
 * asks for are the tiles that are here.
 */
async function cacheTiles(route, track, outDir) {
  const frame = sceneFrame(track);
  // These two must match the viewer's own call for the showcase exactly.
  const specs = {
    sat: { spec: pickZoom(frame, 19, 11, 6), ext: 'jpg', url: (z, x, y) => (process.env.ESRI_API_KEY
      ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?token=${process.env.ESRI_API_KEY}`
      : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`) },
    dem: { spec: pickZoom(frame, 14, 10, 4), ext: 'png',
      url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png` },
  };

  const out = {};
  for (const [kind, { spec, ext, url }] of Object.entries(specs)) {
    const dir = join(outDir, 'tiles', route.slug, kind);
    await mkdir(dir, { recursive: true });
    let ok = 0, total = 0;
    for (let x = spec.x0; x <= spec.x1; x++) {
      for (let y = spec.y0; y <= spec.y1; y++) {
        total++;
        const file = join(dir, `${spec.z}-${x}-${y}.${ext}`);
        if (existsSync(file)) { ok++; continue; }
        try {
          const res = await fetch(url(spec.z, x, y));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await writeFile(file, Buffer.from(await res.arrayBuffer()));
          ok++;
        } catch (err) {
          console.warn(`  ! ${kind} tile ${spec.z}/${x}/${y}: ${err.message}`);
        }
      }
    }
    // Only claim a cache that is complete. A partial one would have the viewer
    // skip the network for tiles that are not here, and draw holes.
    if (ok === total) out[kind] = { z: spec.z, x0: spec.x0, y0: spec.y0, x1: spec.x1, y1: spec.y1, ext };
    console.log(`  · tiles/${route.slug}/${kind}: ${ok}/${total}${ok === total ? '' : ' — incomplete, will fetch live'}`);
  }

  // The analysed track, as the viewer would have derived it anyway.
  //
  // This route is 23,233 GPS points, and parsing that XML and reducing it is
  // a second and a half of unbroken arithmetic on a phone — which is a second
  // and a half with no animation frames, no scrolling and no buttons. The
  // build has already done exactly this work, so it writes down the answer:
  // the same 1,400-point track, as JSON, about a twentieth of the download
  // and none of the parsing.
  const data = {
    name: track.name, time: track.time ?? null, activity: track.activity ?? null,
    stats: track.stats, bbox: track.bbox, breaks: track.breaks ?? [],
    lat: Array.from(track.lat), lon: Array.from(track.lon),
    ele: Array.from(track.ele), dist: Array.from(track.dist),
    secs: track.secs ? Array.from(track.secs) : null,
  };
  const trackPath = join(outDir, 'tiles', route.slug, 'track.json');
  await writeFile(trackPath, JSON.stringify(data));
  const kb = Math.round((await stat(trackPath)).size / 1024);
  console.log(`  · tiles/${route.slug}/track.json: ${track.lat.length} points, ${kb} kB (from ${track.stats.points.toLocaleString()} raw)`);
  out.track = `./tiles/${route.slug}/track.json`;

  return out.sat && out.dem ? out : null;
}

/**
 * Tiny bundler for the standalone build.
 *
 * The site itself loads ES modules, which browsers refuse over file://. To keep
 * a double-clickable copy of every route working, each module is wrapped in an
 * IIFE that returns its exports, and imports become destructuring from the
 * module object. No dependencies, no transpiling — the modules are plain
 * modern JS that any current browser runs as-is.
 */
async function bundleModules(names) {
  const parts = [];
  for (const name of names) {
    let code = await readFile(join(root, 'src', name + '.js'), 'utf8');
    const imports = [...code.matchAll(/^import\s+\{([\s\S]*?)\}\s+from\s+'\.\/(\w+)\.js';/gm)];
    code = code.replace(/^import\s+[\s\S]*?from\s+'[^']+';\s*$/gm, '');
    const exported = [...code.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map(m => m[1]);
    if (!exported.length) throw new Error(`${name}.js exports nothing the bundler can see`);
    code = code.replace(/^export\s+/gm, '');
    const head = imports
      .map(m => `const {${m[1].replace(/\s+/g, ' ').trim()}} = __m_${m[2]};`)
      .join('\n');
    parts.push(`const __m_${name} = (function () {\n${head}\n${code}\nreturn { ${exported.join(', ')} };\n})();`);
  }
  return parts.join('\n');
}

const esc = s => JSON.stringify(s).replace(/</g, '\\u003c');

async function writeStandalone(route, track) {
  const bundle = await bundleModules(['i18n', 'gpx', 'terrain', 'renderer', 'viewer']);   // library.js is browser-storage only
  const css = await readFile(join(root, 'src', 'ui.css'), 'utf8');
  const favicon = await readFile(join(root, 'brand', 'favicon.svg'), 'utf8');   // inlined: a single file can't load it
  const data = {
    name: track.name, time: track.time, stats: track.stats, bbox: track.bbox,
    lat: track.lat, lon: track.lon, ele: track.ele, dist: track.dist, secs: track.secs,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${route.name} · Salpicón!</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon.trim())}">
<!-- A single file has no header and so no switch to change its mind with, so
     this one follows the system rather than insisting on light. ui.css keys its
     dark block to the attribute either way. -->
<script>try{var t=localStorage.getItem('salpicon.theme.v1');document.documentElement.dataset.theme=
t==='dark'?'dark':t==='light'?'light':matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
catch(e){document.documentElement.dataset.theme='light'}</script>
<style>
${css}
html,body{height:100%;overflow:hidden}
</style>
</head>
<body>
<script>
${bundle}
window.viewer = new __m_viewer.RouteViewer({
  mount: document.body,
  track: JSON.parse(${esc(JSON.stringify(data))}),
  name: ${esc(route.name)},
  date: ${route.date ? esc(route.date) : 'null'},
});
<\/script>
</body>
</html>
`;
}

/**
 * Syntax-check the module scripts written inline in the pages.
 *
 * A SyntaxError in one of these does not break a line, it breaks the page:
 * the browser refuses the whole module, so nothing runs and the result is a
 * blank list with no error anyone would see without opening a console. That
 * shipped once — an await inside a handler that was not async — and only the
 * deployed site showed it, which is far too late for something a parser can
 * answer in milliseconds.
 */
async function checkInlineModules(files) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { writeFile: write, mkdtemp, rm: remove } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    const html = await readFile(join(root, file), 'utf8');
    const blocks = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
    for (const [i, m] of blocks.entries()) {
      const dir = await mkdtemp(join(tmpdir(), 'salpicon-'));
      const tmp = join(dir, 'check.mjs');
      await write(tmp, m[1]);
      try {
        await run(process.execPath, ['--check', tmp]);
      } catch (err) {
        const why = String(err.stderr || err.message).split('\n').slice(0, 4).join('\n');
        throw new Error(`${file}: the inline module (block ${i + 1}) will not parse, so the page would do nothing:\n${why}`);
      } finally { await remove(dir, { recursive: true, force: true }); }
    }
  }
}

await checkInlineModules(['index.html', 'routes.html', 'library.html', 'view.html', 'r.html']);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const item of STATIC) {
  if (existsSync(join(root, item))) await cp(join(root, item), join(OUT, item), { recursive: true });
}
// Published only, from here on. Parsing above has already had its say about
// every file in the folder.
const unpublished = routes.filter(r => !PUBLISHED.has(r.slug));
const routesAll = routes;
routes = routes.filter(r => PUBLISHED.has(r.slug));
for (const name of PUBLISHED) {
  if (!routes.some(r => r.slug === name)) console.warn(`  ! published route "${name}" is not in routes/`);
}
console.log(`\n  publishing ${routes.length} of ${routesAll.length} routes`
  + (unpublished.length ? ` · keeping back ${unpublished.map(r => r.slug).join(', ')}` : ''));

// the GPX the viewer will ask for, and only those
await mkdir(join(OUT, 'routes'), { recursive: true });
for (const r of routes) await cp(join(root, 'routes', r.file), join(OUT, 'routes', r.file));

// newest first, by the day it happened — the same order the library shows
routes.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

// Runtime config. The key is injected from the environment at build time
// (Vercel → Settings → Environment Variables) so it never sits in a public
// repository; with none set the viewer stays on the open tile endpoint.
/** The first of these environment variables that is actually set. */
const firstOf = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
};

/**
 * A publishable key is safe in a browser; a service-role key is not — it
 * bypasses row-level security completely. They are easy to confuse because
 * both are long strings in the same settings page, so the build refuses
 * rather than shipping one to every visitor.
 */
const guard = firstOf('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
                      'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
if (guard && (guard.startsWith('sb_secret_') || guard.includes('service_role'))) {
  throw new Error('That looks like a Supabase SECRET key. It bypasses row-level security and must never '
    + 'reach the browser — use the publishable key instead.');
}

await writeFile(join(OUT, 'config.json'), JSON.stringify({
  esriKey: process.env.ESRI_API_KEY ?? null,
  // Both are meant to be public: the publishable key names the project, and
  // row-level security decides what any request may see. They come from the
  // environment so the repository, which is public, never carries them.
  // Vercel's Supabase integration injects a whole set of variables under
  // several names, so take the first that turns up. The service-role key is
  // deliberately not among them and never will be: it bypasses row-level
  // security entirely, and this file is served to every browser that opens
  // the app.
  supabaseUrl: firstOf('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL'),
  supabaseKey: firstOf('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
                       'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
}));
if (process.env.ESRI_API_KEY) console.log('  · imagery: licensed Esri endpoint (key from ESRI_API_KEY)');
if (process.env.SUPABASE_URL) console.log('  · accounts: Supabase configured');

/**
 * The route the landing page shows, whose map travels with the build.
 *
 * One route, deliberately: this is about the one that is drawn on every visit,
 * not about shipping an offline atlas.
 */
const CACHE_TILES_FOR = ['caminata-alto-del-toro'];
for (const slug of CACHE_TILES_FOR) {
  const route = routes.find(r => r.slug === slug);
  if (!route) { console.warn(`  ! no route ${slug} to cache tiles for`); continue; }
  const track = analyze(parseGPX(await readFile(join(root, 'routes', route.file), 'utf8')));
  route.tiles = await cacheTiles(route, track, OUT);
}

await writeFile(join(OUT, 'routes.json'),
  JSON.stringify({ generated: new Date().toISOString(), routes }, null, 2));

// double-clickable single-file copy of each route (no server, no modules)
await mkdir(join(OUT, 'standalone'), { recursive: true });
for (const route of routes) {
  const track = analyze(parseGPX(await readFile(join(root, 'routes', route.file), 'utf8')));
  const html = await writeStandalone(route, track);
  await writeFile(join(OUT, 'standalone', route.slug + '.html'), html);
  console.log(`  · standalone/${route.slug}.html (${Math.round(html.length / 1024)} kB)`);
}

console.log(`\nbuilt ${routes.length} route${routes.length === 1 ? '' : 's'} → dist/`);
