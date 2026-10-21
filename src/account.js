/**
 * Accounts, and what the app does without one.
 *
 * Signing in is optional and stays that way. Everything works signed out —
 * recording, importing, the 3D view, the figures page — because the first
 * thing a new person does should not be filling in a form. What an account
 * adds is that routes survive the browser they were made in, and that one can
 * be handed to somebody else.
 *
 * So this module is written to be absent. `ready()` resolves either way, and
 * `enabled()` says which world we are in; the rest of the app branches on that
 * rather than assuming a database exists.
 */

import { createClient } from './supabase.js';
import { createCloud } from './cloud.js';
import { t } from './i18n.js';

let client = null, cloud = null, config = null, loaded = null, returned = null;

/**
 * Read the build's config and set up if it carries a project.
 *
 * Config is absent in a plain checkout and in a standalone file, and that is
 * not an error — it is the signed-out world, which is a complete product.
 */
export function ready() {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      config = await fetch('./config.json').then(r => (r.ok ? r.json() : null));
    } catch { config = null; }
    if (config?.supabaseUrl && config?.supabaseKey) {
      try {
        client = createClient(config.supabaseUrl, config.supabaseKey);
        cloud = createCloud(client);
        // Somebody arriving from a confirmation email has their session in the
        // URL and nowhere else. Reading it here, before any page paints, is
        // what makes them arrive signed in rather than apparently rejected.
        returned = client.auth.fromUrl();
        if (returned?.state === 'signed-in') {
          // Confirm the tokens are real before telling anybody they are in.
          const who = await client.auth.me().catch(() => null);
          if (!who?.id) returned = { state: 'error', kind: 'rejected', message: 'the link could not be verified.' };
        }
      } catch { client = null; cloud = null; }
    }
    return !!client;
  })();
  return loaded;
}

export const enabled = () => !!client;

/**
 * What the URL said, if this page was opened from an email link.
 *
 * `{ state: 'signed-in' }` after a confirmation, `{ state: 'error', message }`
 * when the link had expired or been used already, and null — almost always —
 * when the page was opened normally.
 */
export const arrivedFromEmail = () => returned;

/** Where a confirmation email should send somebody back to. */
export const returnUrl = () => `${location.origin}/`;
export const user = () => client?.auth.user() ?? null;
export const onChange = fn => (client ? client.auth.onChange(fn) : (fn(null), () => {}));
export const routes = () => cloud;

/**
 * Turn whatever the server said into something worth reading on screen.
 *
 * Auth errors arrive as terse server strings — "Invalid login credentials",
 * "User already registered" — which are accurate and unhelpful. Each one here
 * says what to do next instead.
 */
export function explain(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (m.includes('invalid login')) return t('err.badlogin');
  if (m.includes('already registered')) return t('err.exists');
  if (m.includes('password')) return t('err.password');
  if (m.includes('email') && m.includes('invalid')) return t('err.email');
  if (m.includes('rate limit')) return t('err.rate');
  if (m.includes('confirm')) return t('err.confirm');
  if (m.includes('failed to fetch') || m.includes('networkerror')) return t('err.offline');
  return err?.message || t('err.generic');
}

export async function signIn(email, password) {
  if (!client) throw new Error('Accounts are not configured in this build');
  await client.auth.signIn(email.trim(), password);
  return user();
}

/**
 * Create an account.
 *
 * Returns `{ needsConfirmation }` because the two outcomes look nothing alike
 * to the person in front of the screen: either they are signed in, or they
 * have to go and find an email before anything happens, and saying nothing
 * about the second is how someone sits waiting at a blank screen.
 */
export async function signUp(email, password) {
  if (!client) throw new Error('Accounts are not configured in this build');
  const res = await client.auth.signUp(email.trim(), password, { redirectTo: returnUrl() });
  return { needsConfirmation: res.needsConfirmation, user: res.user };
}

/**
 * Ask for a password-reset link.
 *
 * Resolves the same way whether or not that address has an account. The
 * message the caller shows says "if there is an account" for the same reason:
 * a page that confirms which addresses are registered is a page that enumerates
 * its own users for anybody who asks.
 */
export async function recover(email) {
  if (!client) throw new Error('Accounts are not configured in this build');
  return client.auth.recover(email.trim(), { redirectTo: returnUrl() });
}

/** Set a new password for whoever is signed in. */
export async function setPassword(password) {
  if (!client) throw new Error('Accounts are not configured in this build');
  return client.auth.setPassword(password);
}

export async function signOut() {
  if (client) await client.auth.signOut();
}

/**
 * Move anything held in this browser into the account that just signed in.
 *
 * Routes recorded before signing up live only in localStorage, and losing them
 * at the moment somebody finally makes an account would be the worst possible
 * introduction. Local copies are kept, not deleted: a duplicate can be removed
 * later, a route that exists nowhere cannot be recovered.
 */
export async function uploadLocal(entries, onProgress) {
  if (!cloud) throw new Error('Accounts are not configured in this build');
  return cloud.importLocal(entries, { onProgress });
}
