#!/usr/bin/env node
/**
 * Build step: scan routes/ for .gpx files, derive a manifest, copy the static
 * site into dist/.
 *
 * The repository stores only GPX tracks — every statistic, profile and 3D
 * surface is derived, here or in the browser. Adding a route means adding a
 * file; this script is what makes it show up.
 */
import { readdir, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { parseGPX, analyze, profileSamples } from '../src/gpx.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'dist');
const STATIC = ['index.html', 'view.html', 'src', 'routes', 'exercise-QR-code.png'];

const slugify = s => basename(s, extname(s)).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const files = (await readdir(join(root, 'routes')))
  .filter(f => extname(f).toLowerCase() === '.gpx').sort();

if (!files.length) console.warn('! no .gpx files found in routes/');

const routes = [];
for (const file of files) {
  const text = await readFile(join(root, 'routes', file), 'utf8');
  try {
    const track = analyze(parseGPX(text));
    const b = track.bbox;
    routes.push({
      slug: slugify(file),
      file,
      name: track.name,
      stats: {
        points: track.stats.points,
        distance_m: +track.stats.distance_m.toFixed(1),
        gain_m: +track.stats.gain_m.toFixed(1),
        loss_m: +track.stats.loss_m.toFixed(1),
        ele_min: track.stats.ele_min,
        ele_max: track.stats.ele_max,
      },
      bbox: b,
      center: [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2],
      profile: profileSamples(track, 96),
    });
    console.log(`  ✓ ${file} — ${(track.stats.distance_m / 1000).toFixed(2)} km, +${Math.round(track.stats.gain_m)} m`);
  } catch (err) {
    console.error(`  ✗ ${file} — ${err.message}`);
    process.exitCode = 1;
  }
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
  const bundle = await bundleModules(['gpx', 'terrain', 'renderer', 'viewer']);   // library.js is browser-storage only
  const css = await readFile(join(root, 'src', 'ui.css'), 'utf8');
  const data = {
    name: track.name, stats: track.stats, bbox: track.bbox,
    lat: track.lat, lon: track.lon, ele: track.ele, dist: track.dist,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${route.name} · 3D route</title>
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
});
<\/script>
</body>
</html>
`;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const item of STATIC) {
  if (existsSync(join(root, item))) await cp(join(root, item), join(OUT, item), { recursive: true });
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
