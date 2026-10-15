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

/**
 * Parse a GPX document into { name, time, points: [[lat, lon, ele, epoch_ms], …], breaks }.
 *
 * `breaks` holds the indices where a new <trkseg> begins. A track segment is
 * how GPX says "the recording stopped and started again": the pen came off the
 * paper, and whatever happened in between is not part of the route. Paused
 * recordings, and files stitched from several outings, both arrive this way.
 * Ignoring segments is how a pause that covered a drive home turns into five
 * kilometres of running.
 */
export function parseGPX(text) {
  const nameMatch = text.match(/<trk>[\s\S]*?<name>([\s\S]*?)<\/name>/) || text.match(/<name>([\s\S]*?)<\/name>/);
  const name = nameMatch ? nameMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : 'Untitled route';
  const time = parseTime(text);
  const points = [], breaks = [];
  const re = /<trkpt\b([^>]*?)(\/>|>([\s\S]*?)<\/trkpt>)/g;
  const readPoints = chunk => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(chunk))) {
      const lat = attr(m[1], 'lat'), lon = attr(m[1], 'lon');
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const body = m[3] || '';
      const e = body.match(/<ele>([^<]*)<\/ele>/);
      const tm = body.match(/<time>([^<]*)<\/time>/);
      points.push([lat, lon, e ? parseFloat(e[1]) : 0, tm ? Date.parse(tm[1]) : NaN]);
    }
  };

  const segs = text.match(/<trkseg\b[^>]*>[\s\S]*?<\/trkseg>/g);
  if (segs) {
    for (const seg of segs) {
      const before = points.length;
      readPoints(seg);
      // a segment that added nothing is not a break in the route
      if (before > 0 && points.length > before) breaks.push(before);
    }
  } else {
    readPoints(text);                     // no segments declared: one continuous track
  }
  return { name, time, points, breaks };
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
export function analyze({ name, time = null, points, breaks = [] }, { targetPoints = 1400, smoothWindow = 9, gainThreshold = 1 } = {}) {
  if (points.length < 2) throw new Error('track has fewer than two points');

  // Nothing accumulates across a break. The gap between the last point before
  // a pause and the first point after it is not distance travelled, not time
  // spent exercising, and not a hill climbed — it is the part that was
  // deliberately not recorded, and counting it is how a pause for a lift home
  // adds five kilometres to a run.
  const isBreak = new Set(breaks);
  const cum = [0];
  for (let i = 1; i < points.length; i++)
    cum.push(cum[i - 1] + (isBreak.has(i) ? 0 : haversine(points[i - 1], points[i])));
  const total = cum[cum.length - 1];

  // light moving average — raw barometric/GPS elevation is far too noisy to sum
  const raw = points.map(p => p[2]);
  const sm = raw.map((_, i) => {
    const lo = Math.max(0, i - (smoothWindow >> 1)), hi = Math.min(raw.length, i + (smoothWindow >> 1) + 1);
    let s = 0; for (let k = lo; k < hi; k++) s += raw[k];
    return s / (hi - lo);
  });

  let gain = 0, loss = 0, ref = sm[0];
  for (let i = 0; i < sm.length; i++) {
    if (isBreak.has(i)) { ref = sm[i]; continue; }   // start afresh after a pause
    const d = sm[i] - ref;
    if (Math.abs(d) >= gainThreshold) { d > 0 ? gain += d : loss -= d; ref = sm[i]; }
  }

  // Seconds from the start, kept alongside every sample we keep, when the
  // recorder stamped each point. This is the whole basis for replaying a route
  // at the pace it was actually done: distance tells you where, and this tells
  // you when you were there. Files without per-point times get null, and the
  // viewer falls back to an even crawl.
  const t0 = points[0][3], tEnd = points[points.length - 1][3];
  const timed = isFinite(t0) && isFinite(tEnd) && tEnd > t0;

  const step = total / targetPoints;
  const lat = [], lon = [], ele = [], dist = [], secs = [], keptBreaks = [];
  let next = 0, lastSec = 0;
  for (let i = 0; i < points.length; i++) {
    // Both sides of a break are kept whatever the decimation thinks, or the
    // gap slides to wherever the nearest surviving samples happen to be.
    const edge = isBreak.has(i) || isBreak.has(i + 1);
    if (i === 0 || i === points.length - 1 || cum[i] >= next || edge) {
      if (isBreak.has(i) && lat.length) keptBreaks.push(lat.length);
      lat.push(+points[i][0].toFixed(6)); lon.push(+points[i][1].toFixed(6));
      ele.push(+sm[i].toFixed(1)); dist.push(+cum[i].toFixed(1));
      if (timed) {
        // clamp backwards: a GPS clock that hiccups must not make the replay
        // run backwards, and the two maps built on this rely on it rising
        const sec = (points[i][3] - t0) / 1000;
        lastSec = isFinite(sec) ? Math.max(lastSec, sec) : lastSec;
        secs.push(+lastSec.toFixed(1));
      }
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
      duration_s: timed ? (tEnd - t0) / 1000 : null,
      // wall-clock duration minus whatever the pauses swallowed: the time the
      // activity actually took, which is the number a pace is worth dividing by
      moving_s: timed ? (tEnd - t0) / 1000 - breaks.reduce((acc, b) =>
        acc + Math.max(0, ((points[b][3] - points[b - 1][3]) || 0) / 1000), 0) : null,
    },
    bbox: {
      minLat: Math.min(...lat), maxLat: Math.max(...lat),
      minLon: Math.min(...lon), maxLon: Math.max(...lon),
    },
    lat, lon, ele, dist,
    secs: timed ? secs : null,
    breaks: keptBreaks,
  };
}

/**
 * An analysed track written back out as GPX.
 *
 * The app keeps tracks in its own decimated form rather than hoarding the
 * original file, so getting a route back out means rebuilding one. Per-point
 * times are reconstructed from the start time plus the elapsed seconds the
 * track already carries, which is what keeps a recorded route replayable at
 * its own pace after a round trip through a file.
 *
 * For a route this app recorded the result is effectively the original: the
 * recorder's own filtering already thinned the fixes well below the point
 * where analysis decimates. For a large imported file it is the track as the
 * app sees it — a faithful shape at a coarser sampling than the source.
 */
export function trackToGPX(track, { name = track.name, activity = 'other' } = {}) {
  const esc = s => String(s).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const t0 = track.time ? Date.parse(track.time) : null;
  const stamped = t0 !== null && Array.isArray(track.secs) && track.secs.length === track.lat.length;

  const body = track.lat.map((lat, i) =>
    `   <trkpt lat="${lat.toFixed(7)}" lon="${track.lon[i].toFixed(7)}">\n` +
    `    <ele>${(track.ele[i] ?? 0).toFixed(1)}</ele>\n` +
    (stamped ? `    <time>${iso(t0 + track.secs[i] * 1000)}</time>\n` : '') +
    `   </trkpt>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="route3d" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
${t0 !== null ? ` <metadata>\n  <time>${iso(t0)}</time>\n </metadata>\n` : ''} <trk>
  <name>${esc(name || 'Route')}</name>
  <type>${esc(activity)}</type>
  <trkseg>
${body}
  </trkseg>
 </trk>
</gpx>
`;
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
