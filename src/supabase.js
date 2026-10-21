/**
 * A small client for Supabase.
 *
 * The official library is excellent and weighs about six hundred kilobytes
 * across five packages with bare imports, which needs a bundler — and this
 * project deliberately has none: `src/` is plain modules a browser loads
 * directly, which is also what keeps the Android build offline-capable. What
 * is actually needed here is a handful of HTTP calls against a documented
 * REST API, so they are written out.
 *
 * Nothing security-critical lives here. Row-level security decides what any
 * request is allowed to see, in the database, where a client cannot argue with
 * it; the worst a bug in this file can do is break a session, not widen one.
 */

const SESSION_KEY = 'salpicon.session.v1';

const readStored = () => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
};
const writeStored = session => {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
};

export function createClient(url, publishableKey) {
  if (!url || !publishableKey) throw new Error('Supabase needs a project URL and a publishable key');
  const base = url.replace(/\/+$/, '');
  let session = readStored();
  const listeners = new Set();

  const announce = () => { for (const fn of listeners) { try { fn(session?.user ?? null); } catch {} } };

  /**
   * @param {object|null} s
   * @param {object} [o]
   * @param {boolean} [o.persist] write it to storage as well as holding it.
   *   False for a session that has not been checked with the server yet —
   *   anybody can put tokens in a URL fragment, and one written to storage
   *   before it is verified outlives the tab that was about to verify it.
   */
  const setSession = (s, { persist = true } = {}) => {
    // the server sends a lifetime; store the moment it dies so a refresh can
    // be done before a request fails rather than after
    session = s ? { ...s, expires_at: Date.now() + (s.expires_in ?? 3600) * 1000 } : null;
    if (persist) writeStored(session);
    else if (!s) writeStored(null);        // clearing always reaches storage
    announce();
    return session;
  };

  const authHeaders = token => ({
    apikey: publishableKey,
    Authorization: `Bearer ${token ?? publishableKey}`,
    'Content-Type': 'application/json',
  });

  async function request(path, { method = 'GET', body, headers = {}, token } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...authHeaders(token), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      const msg = data?.error_description || data?.msg || data?.message || data?.error || res.statusText;
      throw Object.assign(new Error(msg), { status: res.status, data });
    }
    return data;
  }

  /** A valid access token, refreshed first if it is about to expire. */
  async function token() {
    if (!session) return null;
    if (session.expires_at && session.expires_at - Date.now() < 60_000 && session.refresh_token) {
      try {
        setSession(await request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', body: { refresh_token: session.refresh_token },
        }));
      } catch {
        setSession(null);            // refresh refused: the session is over
        return null;
      }
    }
    return session?.access_token ?? null;
  }

  const auth = {
    /**
     * Create an account.
     *
     * `redirectTo` is where the confirmation email sends them afterwards. It
     * has to be sent per request rather than left to the project's Site URL,
     * because the same project serves the website, a preview deployment and
     * an Android app, and only the request knows which one asked. Supabase
     * will refuse any address not on the allow-list in the dashboard, which
     * is what stops this being an open redirect.
     */
    async signUp(email, password, { redirectTo } = {}) {
      const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
      const out = await request(`/auth/v1/signup${q}`, { method: 'POST', body: { email, password } });
      // With email confirmation switched on, Supabase returns a user and no
      // session — the caller has to say "check your email" rather than
      // pretending somebody is signed in.
      if (out?.access_token) setSession(out);
      return { user: out?.user ?? out, session: out?.access_token ? session : null,
               needsConfirmation: !out?.access_token };
    },

    /**
     * Pick up a session handed back in the URL, and tidy the address bar.
     *
     * Confirming an email is a round trip out of the app and back: the link
     * goes to Supabase, Supabase verifies the token and redirects here with
     * the session in the fragment — `#access_token=…&refresh_token=…`. Without
     * this, somebody who had just confirmed their address would land on the
     * site still apparently signed out, which is the point at which people
     * decide an app is broken and close it.
     *
     * The fragment is used rather than the query deliberately: it is never
     * sent to the server and never written to an access log.
     *
     * Returns what happened, so the page can say something: 'signed-in',
     * 'error' with a message, or null when there was nothing in the URL,
     * which is almost every page load.
     */
    fromUrl({ clean = true } = {}) {
      let result = null;
      try {
        const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
        const err = hash.get('error_description') || hash.get('error');
        const access = hash.get('access_token');
        if (err) {
          result = { state: 'error', message: err.replace(/\+/g, ' '), kind: hash.get('error_code') };
        } else if (access) {
          // Held, not stored. `me()` is what turns it into a real session, so
          // a forged fragment cannot leave anything behind if this tab closes
          // before the server has been asked about it.
          setSession({
            access_token: access,
            refresh_token: hash.get('refresh_token'),
            token_type: hash.get('token_type') ?? 'bearer',
            expires_in: Number(hash.get('expires_in')) || 3600,
            user: null,                 // filled in by `me()`
          }, { persist: false });
          result = { state: 'signed-in', kind: hash.get('type') };
        } else if (new URLSearchParams(location.search).get('code')) {
          // A project set to the PKCE flow sends ?code= instead, and that code
          // can only be exchanged with a verifier this client never created.
          // Saying so is better than failing silently.
          result = { state: 'error', kind: 'pkce',
            message: 'This project is set to the PKCE flow, which this client cannot complete.' };
        }
        if (result && clean) {
          history.replaceState(null, '', location.pathname + location.search.replace(/[?&]code=[^&]*/, ''));
        }
      } catch { return null; }
      return result;
    },

    /**
     * Who the current token belongs to.
     *
     * A session recovered from a URL fragment has no user object in it — the
     * fragment carries tokens and nothing else — so it is fetched once and
     * folded in, or every page would show somebody signed in as nobody.
     */
    async me() {
      const tok = await token();
      if (!tok) return null;
      try {
        const user = await request('/auth/v1/user', { token: tok });
        if (user?.id) setSession({ ...session, expires_in: (session.expires_at - Date.now()) / 1000, user });
        return user;
      } catch (err) {
        // A token the server will not accept is not a session. Anyone can put
        // whatever they like in a URL fragment, and keeping it would leave the
        // app looking signed in as nobody while every request it made failed.
        // A network error is different and must not sign anybody out.
        if (err?.status === 401 || err?.status === 403) { setSession(null); return null; }
        return session?.user ?? null;
      }
    },
    async signIn(email, password) {
      setSession(await request('/auth/v1/token?grant_type=password', {
        method: 'POST', body: { email, password },
      }));
      return session;
    },
    /**
     * Send somebody a link to set a new password.
     *
     * Always resolves, whatever the server says about the address. Reporting
     * that an email is not registered tells anyone who asks which addresses
     * have accounts here, and that is a list worth not handing out; the
     * caller says "if that address has an account, a link is on its way"
     * either way.
     */
    async recover(email, { redirectTo } = {}) {
      const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
      try {
        await request(`/auth/v1/recover${q}`, { method: 'POST', body: { email } });
      } catch (err) {
        // A rate limit is worth passing on, since waiting is the fix and the
        // person needs to know that. Anything else is swallowed on purpose.
        if (/rate limit|too many/i.test(String(err?.message))) throw err;
      }
      return true;
    },

    /**
     * Change the password of whoever is signed in.
     *
     * Used both from the recovery link — which signs somebody in just long
     * enough to do this — and from an ordinary session.
     */
    async setPassword(password) {
      const tok = await token();
      if (!tok) throw new Error('Not signed in');
      const user = await request('/auth/v1/user', { method: 'PUT', body: { password }, token: tok });
      if (user?.id) setSession({ ...session, expires_in: (session.expires_at - Date.now()) / 1000, user });
      return user;
    },

    async signOut() {
      const t = await token();
      if (t) { try { await request('/auth/v1/logout', { method: 'POST', token: t }); } catch {} }
      setSession(null);
    },
    session: () => session,
    user: () => session?.user ?? null,
    onChange(fn) { listeners.add(fn); fn(session?.user ?? null); return () => listeners.delete(fn); },
  };

  /** PostgREST, with only the verbs this app uses. */
  function from(table) {
    const qs = params => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) p.set(k, v);
      const s = p.toString();
      return s ? `?${s}` : '';
    };
    return {
      async select(columns = '*', { filter = {}, order, limit } = {}) {
        const params = { select: columns, ...filter };
        if (order) params.order = order;
        if (limit) params.limit = String(limit);
        return request(`/rest/v1/${table}${qs(params)}`, { token: await token() }) ?? [];
      },
      async insert(row) {
        const out = await request(`/rest/v1/${table}`, {
          method: 'POST', body: row, token: await token(),
          headers: { Prefer: 'return=representation' },
        });
        return Array.isArray(out) ? out[0] : out;
      },
      async update(patch, filter) {
        const out = await request(`/rest/v1/${table}${qs(filter)}`, {
          method: 'PATCH', body: patch, token: await token(),
          headers: { Prefer: 'return=representation' },
        });
        return Array.isArray(out) ? out[0] : out;
      },
      async remove(filter) {
        await request(`/rest/v1/${table}${qs(filter)}`, { method: 'DELETE', token: await token() });
      },
    };
  }

  const rpc = async (fn, args) =>
    request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args ?? {}, token: await token() });

  return { auth, from, rpc, url: base };
}
