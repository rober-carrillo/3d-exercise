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

let client = null, cloud = null, config = null, loaded = null;

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
      } catch { client = null; cloud = null; }
    }
    return !!client;
  })();
  return loaded;
}

export const enabled = () => !!client;
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
  const res = await client.auth.signUp(email.trim(), password);
  return { needsConfirmation: res.needsConfirmation, user: res.user };
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
