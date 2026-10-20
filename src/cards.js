/**
 * The route list, shared by every page that shows one.
 *
 * "Your routes" and the public library are the same diary of months and rows
 * with a different set of routes behind them and different buttons on the
 * right. They were the same markup copied twice, which is how two lists that
 * are meant to look identical stop looking identical; the shape lives here now
 * and each page supplies only what differs.
 *
 * Everything is returned as a string. The lists are at most a few hundred rows
 * and get rebuilt whole on every change, which is simpler to reason about than
 * patching nodes and fast enough that nobody can tell.
 */

import { rampCss } from './terrain.js';
import { t, lang } from './i18n.js';

/**
 * Month and weekday names come from the platform rather than a list here.
 * Every browser already carries them in every language, correctly capitalised
 * and correctly abbreviated, and a hand-written table is a second place for
 * Spanish to be slightly wrong.
 */
const locale = () => (lang() === 'es' ? 'es-ES' : 'en-US');
const monthName = (y, m) => {
  const s = new Date(Date.UTC(y, m, 1)).toLocaleDateString(locale(), { month: 'long', timeZone: 'UTC' });
  return s.charAt(0).toUpperCase() + s.slice(1);          // Spanish lowercases them
};

const fmt = n => n.toLocaleString(locale(), { maximumFractionDigits: 0 });

export const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * When the route happened: the recorded time, or the day it joined the library
 * for files that never carried one. Entries saved by an older version of the
 * page only have `added`, so fall back to it.
 */
export const whenOf = r => new Date(r.date || r.added || 0);

/** Newest first. ISO strings sort chronologically as text. */
export const byDate = (a, b) => String(b.date || b.added || '').localeCompare(String(a.date || a.added || ''));

/** Recorded routes are named "Run · 12 Oct", so a local route's sport comes from its name. */
export function activityOf(r) {
  if (r.activity) return t('act.' + r.activity);
  const m = /^(run|walk|ride|field)\b/i.exec(r.name || '');
  return m ? t('act.' + m[1].toLowerCase()) : '';
}

/** Where the row goes: the account's copy, this browser's copy, or the build's. */
export function routeHref(r) {
  if (r.cloud) return `./view.html?cloud=${encodeURIComponent(r.id)}`;
  if (r.local) return `./view.html?local=${encodeURIComponent(r.slug)}`;
  return `./view.html?route=${encodeURIComponent(r.slug)}`;
}

export function groupByMonth(routes) {
  const groups = new Map();
  for (const r of routes) {
    const d = whenOf(r), key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/** The elevation sparkline, coloured by the same ramp the 3D view uses. */
function spark(r) {
  const W = 150, H = 30;
  const lo = Math.min(...r.profile), hi = Math.max(...r.profile), span = Math.max(1, hi - lo);
  const path = r.profile.map((e, i) =>
    (i ? 'L' : 'M') + (i / (r.profile.length - 1) * W).toFixed(1) + ' ' + (H - 2 - (e - lo) / span * (H - 6)).toFixed(1)
  ).join('');
  let stops = '';
  for (let k = 0; k <= 10; k++) {
    const e = r.profile[Math.round(k / 10 * (r.profile.length - 1))];
    stops += `<stop offset="${k * 10}%" stop-color="${rampCss((e - r.stats.ele_min) / Math.max(1, r.stats.ele_max - r.stats.ele_min))}"/>`;
  }
  const id = 'g' + String(r.slug || r.id).replace(/[^a-z0-9]/gi, '');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" x2="1">${stops}</linearGradient></defs>
      <path d="${path}L${W} ${H}L0 ${H}Z" fill="rgba(19,138,74,.10)"/>
      <path d="${path}" fill="none" stroke="url(#${id})" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

/**
 * One row.
 * @param {object} r        a route, from the manifest, the account or this browser
 * @param {object} [o]
 * @param {(r:object)=>string} [o.actions]  the buttons on the right
 * @param {boolean} [o.tagOrigin]  mark which routes are samples and which are
 *   only in this browser. The public library has no use for it — everything
 *   there is a sample — and saying so on every row is just noise.
 */
export function routeRow(r, { actions = () => '', tagOrigin = true } = {}) {
  const d = whenOf(r);
  const meta = [activityOf(r), r.dateSource === 'recorded' ? '' : t('row.added')].filter(Boolean).join(' · ');
  return `
    <div class="row">
      <a class="go" href="${routeHref(r)}">
        <span class="day"><b>${d.getDate()}</b><small>${d.toLocaleDateString(locale(), { weekday: 'short' })}</small></span>
        <span class="what"><b>${escapeHtml(r.name)}</b><small>${meta}${
          r.pace ? `<span class="tag pace">${t('row.pace')}</span>` : ''}${
          tagOrigin && r.local ? `<span class="tag">${t('row.local')}</span>` : ''}${
          tagOrigin && !r.cloud && !r.local ? `<span class="tag">${t('row.example')}</span>` : ''
        }</small></span>
        ${spark(r)}
        <span class="num"><b>${(r.stats.distance_m / 1000).toFixed(2)} km</b><small>↑ ${fmt(r.stats.gain_m)} m</small></span>
      </a>
      <span class="acts">${actions(r)}</span>
    </div>`;
}

/** A month heading with the month's totals, and its rows under it. */
export function monthSection(key, list, opts) {
  const [y, m] = key.split('-').map(Number);
  const km = list.reduce((s, r) => s + r.stats.distance_m, 0) / 1000;
  const up = list.reduce((s, r) => s + r.stats.gain_m, 0);
  const sum = t(list.length === 1 ? 'row.month.one' : 'row.month.sum',
    { n: list.length, km: km.toFixed(1), up: fmt(up) });
  return `
    <section class="month">
      <div class="month-head">
        <h2>${monthName(y, m)} ${y}</h2>
        <span>${sum}</span>
      </div>
      ${list.map(r => routeRow(r, opts)).join('')}
    </section>`;
}

/** The whole diary for a set of routes, newest month first. */
export function routeDiary(routes, opts) {
  return [...groupByMonth([...routes].sort(byDate))]
    .map(([key, list]) => monthSection(key, list, opts)).join('');
}
