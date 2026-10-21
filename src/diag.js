/**
 * A flight recorder for a recording.
 *
 * A track that comes out wrong is nearly impossible to argue about after the
 * fact. The GPX holds only what survived the filter, so it cannot say whether
 * a corner was cut because the fixes went round it and were thrown away,
 * because they never arrived, or because they arrived from the wrong place
 * entirely. Those three have the same shape on a map and completely different
 * causes.
 *
 * So every fix is written down as it arrives, before anything is decided about
 * it, together with what the recorder then did and why. The result is a file
 * small enough to send in a message — a few hundred kilobytes for an hour —
 * and complete enough to answer the question without another run.
 *
 * Nothing here is on by default in the sense that matters: it costs one object
 * per fix, about one per second, and it is kept only for the most recent
 * recording. It never leaves the phone unless somebody presses save.
 */

const KEY = 'salpicon.diag.v1';
/** An hour at 1 Hz is 3,600, about 900 kB. Two hours is the ceiling. */
const MAX_FIXES = 7200;

let log = null;

/** Begin a new log. Anything previously held is replaced. */
export function startDiag({ activity, presets, app } = {}) {
  log = {
    version: 1,
    started: new Date().toISOString(),
    activity,
    presets,
    app,
    provider: null,          // what the service reported it managed to start
    fixes: [],
    // Raw GPS heard in parallel, recorded into nothing. The only way to know
    // whether the fused provider is better or worse than what it replaced is
    // to listen to both on the same walk.
    shadow: [],
    notes: [],
  };
  return log;
}

export const diagging = () => !!log;

/** Which provider the native service actually started on. */
export function noteProvider(name) {
  if (log) { log.provider = name; log.notes.push({ t: Date.now(), note: `provider: ${name}` }); }
}

export function note(text) {
  if (log) log.notes.push({ t: Date.now(), note: String(text) });
}

/**
 * One fix, exactly as it arrived, plus the verdict on it.
 *
 * @param {object} fix     straight from the provider, untouched
 * @param {string|null} verdict  null when kept, otherwise why it was not
 * @param {object} [state] where the recorder thinks it is after this fix
 */
export function logFix(fix, verdict, state = {}) {
  if (!log || log.fixes.length >= MAX_FIXES) return;
  const prev = log.fixes[log.fixes.length - 1];
  log.fixes.push({
    t: fix.t ?? Date.now(),
    gap: prev ? +(((fix.t ?? Date.now()) - prev.t) / 1000).toFixed(2) : 0,
    lat: fix.lat, lon: fix.lon,
    acc: fix.accuracy ?? null,
    ele: fix.ele ?? null,
    eleRef: fix.eleRef ?? null,
    // the provenance fields: present on the Android build, absent in a browser
    prov: fix.provider ?? null,
    spd: fix.hasSpeed ? fix.speed : null,
    brg: fix.hasBearing ? fix.bearing : null,
    sats: fix.satellites ?? null,
    age: fix.ageMs ?? null,
    mock: fix.mock ?? null,
    vacc: fix.vAccuracy ?? null,
    verdict: verdict ?? 'kept',
    // where the recorder put the smoothed point, so lag can be measured
    slat: state.lat ?? null,
    slon: state.lon ?? null,
    n: state.points ?? null,
  });
}

/** A raw-GPS fix, heard alongside and used for comparison only. */
export function logShadow(fix) {
  if (!log || log.shadow.length >= MAX_FIXES) return;
  log.shadow.push({
    t: fix.t ?? Date.now(),
    lat: fix.lat, lon: fix.lon,
    acc: fix.accuracy ?? null,
    spd: fix.speed ?? null,
    brg: fix.bearing ?? null,
    sats: fix.satellites ?? null,
  });
}

/**
 * What the log says, in one paragraph.
 *
 * Computed rather than eyeballed, because the interesting numbers — how long
 * the longest hole was, how many fixes carried no bearing — are exactly the
 * ones nobody spots by scrolling.
 */
export function summarise(l = log) {
  if (!l?.fixes?.length) return null;
  const f = l.fixes;
  const gaps = f.slice(1).map(x => x.gap);
  const accs = f.map(x => x.acc).filter(a => a != null);
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const verdicts = {};
  for (const x of f) verdicts[x.verdict] = (verdicts[x.verdict] ?? 0) + 1;
  const noBearing = f.filter(x => x.brg == null).length;
  const noSpeed = f.filter(x => x.spd == null).length;
  return {
    fixes: f.length,
    span_s: Math.round((f[f.length - 1].t - f[0].t) / 1000),
    hz: +(f.length / Math.max(1, (f[f.length - 1].t - f[0].t) / 1000)).toFixed(2),
    gap_median_s: med(gaps),
    gap_max_s: gaps.length ? Math.max(...gaps) : 0,
    // the one that matters: a hole long enough to cut a corner off a route
    holes_over_10s: gaps.filter(g => g > 10).length,
    accuracy_median_m: med(accs),
    accuracy_worst_m: accs.length ? Math.max(...accs) : null,
    accuracy_over_35m: accs.filter(a => a > 35).length,
    // a fix with no bearing and no speed is very likely not from satellites
    without_bearing: noBearing,
    without_speed: noSpeed,
    providers: [...new Set(f.map(x => x.prov).filter(Boolean))],
    verdicts,
    shadow_fixes: l.shadow?.length ?? 0,
    shadow_accuracy_median_m: med((l.shadow ?? []).map(x => x.acc).filter(a => a != null)),
  };
}

/** The whole log as a file, ready to be written out or sent. */
export function diagFile(name = 'salpicon-diag') {
  if (!log) return null;
  const body = { ...log, finished: new Date().toISOString(), summary: summarise(log) };
  return {
    name: `${name}.json`,
    text: JSON.stringify(body, null, 1),
  };
}

/**
 * Keep the last log across a page load.
 *
 * The app navigates to the route it has just recorded the moment recording
 * stops, which throws away everything in memory — including the only copy of
 * why that recording went wrong.
 */
export function persistDiag(slug) {
  if (!log) return;
  const summary = summarise(log);           // computed from everything, kept whatever we trim
  const write = (fixes, shadow = log.shadow) =>
    localStorage.setItem(KEY, JSON.stringify({ slug, ...log, fixes, shadow, summary }));
  try {
    write(log.fixes);
  } catch {
    // Out of quota. Half a log is worth a great deal more than none, and the
    // summary above was taken across the whole thing before any trimming, so
    // the counts and the worst gap survive even when the fixes behind them do
    // not. The newest are kept: whatever went wrong, it was still going wrong
    // at the end.
    // The shadow is a comparison, not the recording: it goes first when room
  // runs out.
  for (const n of [2000, 500, 0]) {
      // The last rung keeps no fixes at all. The summary is a few hundred
      // bytes and carries the counts, the worst gap and how many fixes came
      // in without a bearing — which is most of what a diagnosis needs, and
      // losing it because the rows behind it would not fit would be the worst
      // outcome available.
      try { write(log.fixes.slice(log.fixes.length - n), n ? log.shadow.slice(-n) : []); break; } catch {}
    }
  }
  log = null;
}

export function lastDiag() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

export function clearDiag() {
  try { localStorage.removeItem(KEY); } catch {}
}
