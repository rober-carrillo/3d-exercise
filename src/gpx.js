/**
 * GPX parsing and track analysis.
 * Runs unchanged in the browser and in Node (used by scripts/build.mjs),
 * so route statistics are computed exactly the same way in both places.
 */

const R = 6378137;                    // earth radius, metres
const D2R = Math.PI / 180;

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  return m ? parseFloat(m[1]) : NaN;
};

/**
 * When the activity happened, as an ISO string, or null.
 *
 * Recorders differ: some write a <time> in <metadata>, some only stamp each
 * <trkpt>, and plenty of files — anything drawn by hand on a map, or exported
 * with privacy settings on — carry no time at all. Prefer the metadata stamp,
 * fall back to the first trackpoint, and let the caller decide what to show
 * when there is nothing.
 */
function parseTime(text) {
  const m = text.match(/<metadata>[\s\S]*?<time>\s*([^<\s]+)\s*<\/time>/)
        || text.match(/<trkpt[\s\S]*?<time>\s*([^<\s]+)\s*<\/time>/);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Month names, so a date reads the same for every visitor. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An ISO timestamp as `30 Aug 2026`, in UTC.
 *
 * UTC rather than the reader's zone: the same route should not appear to have
 * happened on different days depending on who opens the page.
 */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Parse a GPX document into { name, time, points: [[lat, lon, ele], …] }. */
export function parseGPX(text) {
  const nameMatch = text.match(/<trk>[\s\S]*?<name>([\s\S]*?)<\/name>/) || text.match(/<name>([\s\S]*?)<\/name>/);
  const name = nameMatch ? nameMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : 'Untitled route';
  const time = parseTime(text);
  const points = [];
  const re = /<trkpt\b([^>]*?)(\/>|>([\s\S]*?)<\/trkpt>)/g;
  let m;
  while ((m = re.exec(text))) {
    const lat = attr(m[1], 'lat'), lon = attr(m[1], 'lon');
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const body = m[3] || '';
    const e = body.match(/<ele>([^<]*)<\/ele>/);
    points.push([lat, lon, e ? parseFloat(e[1]) : 0]);
  }
  return { name, time, points };
}

const haversine = (a, b) => {
  const dLat = (b[0] - a[0]) * D2R, dLon = (b[1] - a[1]) * D2R;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Turn raw points into everything the viewer needs: smoothed elevations,
 * cumulative distance, ascent/descent, bounding box, and a distance-decimated
 * copy of the track (full-resolution GPS traces are far denser than any screen).
 */
export function analyze({ name, time = null, points }, { targetPoints = 1400, smoothWindow = 9, gainThreshold = 1 } = {}) {
  if (points.length < 2) throw new Error('track has fewer than two points');

  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  const total = cum[cum.length - 1];

  // light moving average — raw barometric/GPS elevation is far too noisy to sum
  const raw = points.map(p => p[2]);
  const sm = raw.map((_, i) => {
    const lo = Math.max(0, i - (smoothWindow >> 1)), hi = Math.min(raw.length, i + (smoothWindow >> 1) + 1);
    let s = 0; for (let k = lo; k < hi; k++) s += raw[k];
    return s / (hi - lo);
  });

  let gain = 0, loss = 0, ref = sm[0];
  for (const v of sm) {
    const d = v - ref;
    if (Math.abs(d) >= gainThreshold) { d > 0 ? gain += d : loss -= d; ref = v; }
  }

  const step = total / targetPoints;
  const lat = [], lon = [], ele = [], dist = [];
  let next = 0;
  for (let i = 0; i < points.length; i++) {
    if (i === 0 || i === points.length - 1 || cum[i] >= next) {
      lat.push(+points[i][0].toFixed(6)); lon.push(+points[i][1].toFixed(6));
      ele.push(+sm[i].toFixed(1)); dist.push(+cum[i].toFixed(1));
      next = cum[i] + step;
    }
  }

  return {
    name,
    time,
    stats: {
      points: points.length,
      distance_m: total,
      gain_m: gain,
      loss_m: loss,
      ele_min: Math.min(...raw),
      ele_max: Math.max(...raw),
      start: [points[0][0], points[0][1]],
      end: [points[points.length - 1][0], points[points.length - 1][1]],
    },
    bbox: {
      minLat: Math.min(...lat), maxLat: Math.max(...lat),
      minLon: Math.min(...lon), maxLon: Math.max(...lon),
    },
    lat, lon, ele, dist,
  };
}

/** Small evenly-spaced elevation series, used for the cards on the index page. */
export function profileSamples(track, n = 96) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = Math.round(i / (n - 1) * (track.ele.length - 1));
    out.push(+track.ele[k].toFixed(1));
  }
  return out;
}

export async function loadTrack(url, opts) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url} (${res.status})`);
  return analyze(parseGPX(await res.text()), opts);
}
