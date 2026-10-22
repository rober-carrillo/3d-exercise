/**
 * Where this app lives on the public internet.
 *
 * Not the same thing as where it is running. In a browser the two are one and
 * `location.origin` answers both, but the Android build serves its files from
 * a WebView whose origin is `https://localhost` — so a share link built from
 * `location.origin` came out as `https://localhost/r/<token>`, which works on
 * exactly one device in the world and that is the device it was copied from.
 * Somebody sends that to a friend and the friend gets a connection error.
 *
 * The real address is written into config.json at build time and set here
 * once, early, by whoever reads that config.
 *
 * Nothing here is security-sensitive: the token in the link is the credential,
 * and the database decides what it opens. This only decides which hostname the
 * link is addressed to.
 */

/** Origins that are the app running, never the app's address. */
const LOCAL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|capacitor:\/\/|file:\/\/)/i;

let configured = null;

/** Called once, with whatever config.json says. */
export function setSite(url) {
  if (!url) return;
  try {
    configured = new URL(url).origin;
  } catch {
    configured = null;            // a malformed value is no worse than none
  }
}

/**
 * The origin a link handed to somebody else should carry.
 *
 * Prefers the configured address, and falls back to wherever we are — which
 * is right in a browser, and is the best that can be done in a build that was
 * made without one. A localhost origin is never returned when a real one is
 * known, because a link to localhost is not a link.
 */
export function siteOrigin() {
  if (configured) return configured;
  const here = typeof location !== 'undefined' ? location.origin : '';
  return here;
}

/** True when the address we would hand out only works on this device. */
export function siteIsLocal() {
  return LOCAL.test(siteOrigin());
}
