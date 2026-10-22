/**
 * Handing a route to somebody else.
 *
 * Three kinds of route, three different answers to "what is the link?":
 *
 *   in the account   /r/<token> — opens for anyone, with no account and no app
 *   in the build     /view.html?route=<slug> — a sample, public by nature
 *   in this browser  there is no link, because there is nothing to link to
 *
 * The third is the one worth being careful about. A route in localStorage
 * exists on exactly one device, so a link to it would open nothing for the
 * person it was sent to; saying so is better than producing an address that
 * quietly fails somewhere else.
 */

import { t } from './i18n.js';
import { siteOrigin } from './site.js';

/** Is there a link to be had at all? */
export const canLink = r => !!(r?.cloud || (r && !r.cloud && !r.local));

/** The link for a route that is already shareable, or null if it is not yet. */
export function routeLink(r, origin = siteOrigin()) {
  if (!r) return null;
  if (r.cloud) return r.shareToken && r.visibility !== 'private' ? `${origin}/r/${r.shareToken}` : null;
  if (r.local) return null;
  return `${origin}/view.html?route=${encodeURIComponent(r.slug)}`;
}

/**
 * Put text on the clipboard, and say whether it got there.
 *
 * `navigator.clipboard` is the right call and is refused often enough to need
 * a second: it is unavailable outside a secure context, and some Android
 * webviews reject it even inside one. The old selection trick still works in
 * all of those, so try it before telling anybody that copying failed.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/**
 * Get a link for a route and copy it, opening the route up if that is what it
 * takes.
 *
 * Pressing "copy link" on a private route is a request to share it, so it is
 * treated as one rather than refused with an explanation of the settings. The
 * change is reported back, because quietly making something shareable would be
 * a surprise of exactly the wrong kind — and `opened` lets the caller say so
 * and redraw whatever shows the route's state.
 *
 * @param {object} r      the route
 * @param {object} [o]
 * @param {object} [o.cloud]  the cloud client, needed only to open a private route
 * @returns {Promise<{ok:boolean, url:string|null, opened:boolean, why:string}>}
 */
export async function shareRoute(r, { cloud = null } = {}) {
  if (!r) return { ok: false, url: null, opened: false, why: t('share.gone') };
  if (r.local) return { ok: false, url: null, opened: false, why: t('share.local') };

  let url = routeLink(r), opened = false;
  if (!url && r.cloud) {
    if (!cloud) {
      return { ok: false, url: null, opened: false, why: t('share.private') };
    }
    try {
      const updated = await cloud.setVisibility(r.id, 'link');
      Object.assign(r, updated, { cloud: true });
      url = routeLink(r);
      opened = true;
    } catch (err) {
      return { ok: false, url: null, opened: false,
        why: t('share.failed', { why: err?.message || err }) };
    }
  }
  if (!url) return { ok: false, url: null, opened: false, why: t('share.nolink') };

  const ok = await copyText(url);
  return {
    ok, url, opened,
    why: !ok ? t('share.blocked', { url }) : t(opened ? 'share.opened' : 'share.copied'),
  };
}
