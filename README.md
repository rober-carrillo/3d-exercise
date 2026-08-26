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

- **drag** orbit · **scroll** zoom · **shift-drag** or right-drag pan
- **Chase camera** rides behind the moving point and swings to face the
  direction of travel — third-person follow view. While chasing, dragging looks
  around the runner and scrolling changes follow distance.
- **Fly route** replays the track; the speed button cycles 0.5×–4×.
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
