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
const STATIC = ['index.html', 'view.html', 'src', 'routes'];

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

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const item of STATIC) {
  if (existsSync(join(root, item))) await cp(join(root, item), join(OUT, item), { recursive: true });
}
await writeFile(join(OUT, 'routes.json'),
  JSON.stringify({ generated: new Date().toISOString(), routes }, null, 2));

console.log(`\nbuilt ${routes.length} route${routes.length === 1 ? '' : 's'} → dist/`);
