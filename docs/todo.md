# Things worth doing next

Kept here rather than in an issue tracker because most of them are decisions
about this codebase, and the reasoning is worth more than the task.

## Cache the imagery tiles we keep asking for

Every route view fetches Esri World Imagery tiles afresh. Zoom is picked per
route, so two routes around the same town pull overlapping tiles, and reopening
one route pulls the same tiles again. The browser cache helps a single reader
on a single device and does nothing across people.

A small shared cache would cut almost all of it. Most of this library sits in
two or three towns, and the published routes never move, so their tiles could
be fetched once at build time and served from our own origin — the standalone
pages already bundle theirs, which is proof the approach works. For account
routes, which can be anywhere, a store keyed by `z/x/y` filled on first request
would collapse the repeats without predicting anything.

Worth settling before it is built: Esri's terms on caching their imagery, and
for how long. That answer decides whether this is a build-time bundle, a
short-lived cache, or not allowed at all.

## A street-names layer

The satellite imagery shows where you ran and never says what the road was
called, which is most of what somebody wants when reading back a route through
a town they know. OpenStreetMap carries the names and its licence permits this
with attribution.

Probably a toggle beside "Satellite imagery" rather than a replacement: names
are useful in a city and clutter in the mountains. Open questions are which
raster style to use (or whether to draw vector tiles ourselves, which would let
the labels stay upright as the camera turns), and where the attribution goes —
the status bar already names Esri and AWS, so it has a place to live.
