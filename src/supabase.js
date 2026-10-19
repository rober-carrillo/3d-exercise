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

  const setSession = s => {
    // the server sends a lifetime; store the moment it dies so a refresh can
    // be done before a request fails rather than after
    session = s ? { ...s, expires_at: Date.now() + (s.expires_in ?? 3600) * 1000 } : null;
    writeStored(session);
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
    async signUp(email, password) {
      const out = await request('/auth/v1/signup', { method: 'POST', body: { email, password } });
      // With email confirmation switched on, Supabase returns a user and no
      // session — the caller has to say "check your email" rather than
      // pretending somebody is signed in.
      if (out?.access_token) setSession(out);
      return { user: out?.user ?? out, session: out?.access_token ? session : null,
               needsConfirmation: !out?.access_token };
    },
    async signIn(email, password) {
      setSession(await request('/auth/v1/token?grant_type=password', {
        method: 'POST', body: { email, password },
      }));
      return session;
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
