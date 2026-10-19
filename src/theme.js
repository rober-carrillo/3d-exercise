/**
 * Light or dark, chosen rather than inherited.
 *
 * The app used to follow the system setting and nothing else, which is tidy
 * until you are outdoors in the sun with a phone that decided hours ago it was
 * night. So the choice is a button, light is where everyone starts, and the
 * answer is remembered.
 *
 * One attribute carries it — `<html data-theme="dark">` — and ui.css has a
 * single dark block keyed to it. The value is written before first paint by a
 * one-line script in each page's <head>, because a theme applied by a module
 * arrives after the first frame and the whole page flashes white on the way to
 * being dark.
 */

const KEY = 'salpicon.theme.v1';
const valid = t => (t === 'dark' ? 'dark' : t === 'light' ? 'light' : null);

/**
 * Storage is not always there to be read. A private window, blocked site data
 * or a webview with storage switched off all throw on access rather than
 * returning nothing, and a theme is not worth a broken page.
 */
function stored() {
  try { return valid(localStorage.getItem(KEY)); } catch { return null; }
}
const systemDark = () => !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

let current = 'light';

/**
 * Apply the remembered choice, or the fallback if there is none.
 * @param {object} [o]
 * @param {'light'|'system'} [o.fallback] what to do for a first-time visitor.
 *   The site says `light`; a standalone single-file route says `system`,
 *   since it has no button to change its mind with.
 */
export function initTheme({ fallback = 'light' } = {}) {
  const chosen = stored();
  return apply(chosen ?? (fallback === 'system' && systemDark() ? 'dark' : 'light'), !!chosen);
}

function apply(next, remember) {
  current = valid(next) ?? 'light';
  document.documentElement.dataset.theme = current;
  if (remember) { try { localStorage.setItem(KEY, current); } catch {} }
  // The address bar and the WebGL haze both take their colour from the page,
  // and neither notices an attribute changing on its own.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '';
  dispatchEvent(new CustomEvent('salpicon:theme', { detail: current }));
  return current;
}

export const theme = () => current;
export const setTheme = next => apply(next, true);
export const toggleTheme = () => setTheme(current === 'dark' ? 'light' : 'dark');

const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="moon" d="M20.3 14.9A8.5 8.5 0 0 1 9.1 3.7a8.5 8.5 0 1 0 11.2 11.2Z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/>'
  + '<path d="M12 2.6v2.1M12 19.3v2.1M4.2 12H2.1M21.9 12h-2.1M6.5 6.5 5 5M19 19l-1.5-1.5M17.5 6.5 19 5M5 19l1.5-1.5"/></svg>';

/**
 * Wire a button to the switch.
 *
 * The icon is what will happen, not what is on: a moon while the page is light
 * because pressing it brings the night, a sun while it is dark. Showing the
 * current state instead reads as a status light and nobody presses it.
 */
export function themeToggle(btn) {
  if (!btn) return;
  const paint = () => {
    const dark = current === 'dark';
    btn.innerHTML = dark ? SUN : MOON;
    btn.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(dark));
  };
  btn.addEventListener('click', () => { toggleTheme(); paint(); });
  addEventListener('salpicon:theme', paint);
  paint();
  return paint;
}
