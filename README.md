# Route 3D

GPX tracks rendered as interactive 3D terrain, entirely in the browser.

Each route is draped over real satellite imagery and elevation data fetched at
view time, drawn with hand-written WebGL — no 3D library, no build-time asset
baking, no server. **The repository stores only `.gpx` files**; every statistic,
elevation profile and terrain surface is derived from them.

```
routes/*.gpx      ← the only data in this repo
src/gpx.js        ← parsing + track analysis (runs in the browser and in Node)
src/terrain.js    ← mercator maths, tile loading, mesh + ribbon geometry
src/renderer.js   ← WebGL programs, orbit camera, chase camera
src/viewer.js     ← RouteViewer: the mountable component
src/ui.css        ← design tokens + viewer chrome
index.html        ← the route library
view.html         ← single-route viewer (?route=<slug>)
scripts/build.mjs ← scans routes/, writes dist/ + routes.json
```

## Adding a route

Drop a `.gpx` file into `routes/`, commit, push. That's the whole workflow —
the build scans the folder, derives name, distance, ascent, bounding box and a
profile for each track, and writes `routes.json` next to the copied site. A new
card appears on the index page and the viewer picks it up by slug.

```bash
cp ~/Downloads/my-hike.gpx routes/
git add routes/my-hike.gpx && git commit -m "add my-hike" && git push
```

## Viewing it

**The hosted site is the product** — `index.html` + `view.html` served from
`dist/`. Three ways to look at it, in order of how close they are to production:

| | how | needs |
|---|---|---|
| Local dev | `npm run dev` → http://localhost:5173 | Node, nothing else |
| Production | push to GitHub, import in Vercel | GitHub + Vercel account |
| Single file | open `dist/standalone/<slug>.html` | just a browser |

You do **not** need GitHub or Vercel to work locally — `npm run dev` builds and
serves the real site on your machine, and that is exactly what Vercel serves. A
plain `open index.html` will *not* work: the viewer is ES modules, which browsers
refuse over `file://`. That is the only reason the standalone build exists.

## Standalone files

A convenience artifact, not the main deliverable. `npm run build` also writes
`dist/standalone/<slug>.html` for every route: one self-contained file, no server
and no modules, that you can double-click or mail to someone. It still fetches imagery and elevation at view time (and degrades the
same way when offline), but the code, styles and track data are all inlined.
Every card on the index page links to its own.

That build is what `scripts/build.mjs` bundles by hand — each module wrapped in an
IIFE returning its exports, since browsers refuse ES modules over `file://`.

## Local development

```bash
npm run dev      # build + serve on http://localhost:5173
npm run build    # write dist/ only
```

A static server is required — the viewer is ES modules, which browsers refuse to
load over `file://`.

## Deploying to Vercel

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project** and import it.
3. Framework preset **Other**. Everything else is already in `vercel.json`:
   build command `node scripts/build.mjs`, output directory `dist`, no install
   step (there are no dependencies).
4. Deploy. Every later push to `main` redeploys automatically; pull requests get
   their own preview URL.

`.github/workflows/build.yml` runs the same build on push and PR, so a malformed
GPX fails the check before it reaches production.

## How it renders

At view time the browser fetches two tile sets covering the route's bounding box:

| Layer | Source | Zoom | Roughly |
|---|---|---|---|
| Imagery | Esri World Imagery (OpenStreetMap as fallback) | ≤16, ≤8×8 tiles | 2048² texture |
| Elevation | AWS Terrain Tiles (`terrarium` RGB encoding) | ≤14, ≤4×4 tiles | ~10 m per sample |

Those become a 352×352 vertex mesh (~247k triangles, four draw calls per frame)
with the imagery draped over it as a single texture. The track is snapped to the
*rendered* triangles rather than the raw elevation samples, and each ribbon edge
takes the surface height beneath itself, so it drapes across cross-slopes instead
of cutting into them.

It is a light workload — any GPU from the last decade holds 60 fps, phones
included. The server does nothing but serve static files.

**If the tile services are unreachable** (offline, blocked, CORS), nothing
breaks: imagery falls back to OpenStreetMap, then to a shaded elevation ramp, and
if elevation data is unavailable too the terrain is modelled from the track's own
recorded elevations. The status chip in the viewer always names what actually
loaded.

## Camera

The default view is oriented to the route itself: the camera sits on the start
side looking down the track, so the route reads start-near → finish-far rather
than at some arbitrary angle. (On a loop, where start and finish coincide, it
aims at the farthest point on the track instead.)

- **drag** orbit · **scroll** zoom · **shift-drag** or right-drag pan
- **Fly route** replays the track and drops you straight into the chase view,
  directly behind the marker and aimed down the route — the way ahead runs away
  up the screen. The speed button cycles 0.5×–4×.
- **Chase camera** can also be toggled on its own. It aims down `course[]`, a
  bearing taken from a look-ahead point a few hundred metres up the track, so
  the camera follows where the route is *going* instead of yawing through every
  switchback.
- The moving point is a **low-poly walking figure** — the restroom-sign woman,
  about 70 triangles — facing along `head[]`, the local bearing. Her legs and
  arms swing only while the route is replaying and freeze mid-stride when you
  pause. She is rebuilt on the CPU each frame, which is free at that triangle
  count and keeps the walk cycle, the terrain snapping and the
  vertical-exaggeration compensation in one place (the ground is stretched by
  the vertical scale; she is not).
- While chasing, dragging looks around the runner and scrolling changes follow
  distance; both reset the next time you press Fly route.
- Hovering the elevation profile scrubs to any point on the route.
- Keyboard: `space` play/pause · `c` chase camera · `r` reset view.

## Attribution

Imagery © Esri and its contributors. Elevation from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, 3DEP and
others). Map fallback © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors.

Esri's basemaps are served here without an API key, which is fine for personal
and evaluation use but is **not** a production licence. For a public site, either
sign up for an ArcGIS developer key, switch `imagery` to a service you have
rights to (Mapbox, MapTiler), or pre-bake a single imagery snapshot per route and
serve that instead.
