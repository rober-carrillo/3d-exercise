/**
 * Talking to the route database.
 *
 * The Supabase client is injected rather than imported. That keeps this file
 * free of dependencies, lets the serialisation below be tested without a
 * project to connect to, and means swapping the backend later touches one
 * function instead of every call site:
 *
 *   import { createClient } from '@supabase/supabase-js';
 *   const cloud = createCloud(createClient(URL, ANON_KEY));
 *
 * The anon key belongs in the client. It identifies the project, not the
 * person, and the row-level security in supabase/schema.sql is what actually
 * protects the data — which is why that file has a test suite and this one
 * mostly moves JSON around.
 */

/* ---------- the serialisation boundary ---------- */

/**
 * An analysed track becomes a database row.
 *
 * `secs` is the field to watch. It is what makes a route replay at the pace it
 * was run, it is null for anything that was never timed, and it is the first
 * thing a careless round trip drops — at which point recorded pace silently
 * stops working on every cloud route while still working locally, which is a
 * miserable bug to find. The round-trip test exists for that one field.
 */
export function routeToRow(track, { name, activity = 'run', source = 'import', visibility = 'private', profile = null } = {}) {
  const b = track.bbox;
  return {
    name: name || track.name || 'Untitled route',
    activity,
    source,
    visibility,
    recorded_at: track.time ?? null,
    stats: track.stats,
    bbox: b,
    centre: { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 },
    profile,
    track: {
      name: track.name,
      time: track.time ?? null,
      lat: track.lat, lon: track.lon, ele: track.ele, dist: track.dist,
      secs: track.secs ?? null,
    },
  };
}

/** A database row becomes what the viewer expects. */
export function rowToRoute(row) {
  const t = row.track || {};
  return {
    id: row.id,
    slug: row.id,
    name: row.name,
    activity: row.activity,
    source: row.source,
    date: row.recorded_at ?? row.created_at ?? null,
    dateSource: row.recorded_at ? 'recorded' : 'added',
    pace: !!t.secs,
    visibility: row.visibility,
    shareToken: row.share_token ?? null,
    stats: row.stats,
    bbox: row.bbox,
    centre: row.centre,
    center: row.centre ? [row.centre.lat, row.centre.lon] : null,   // the card's shape
    profile: row.profile,
    track: {
      name: t.name ?? row.name,
      time: t.time ?? row.recorded_at ?? null,
      stats: row.stats,
      bbox: row.bbox,
      lat: t.lat, lon: t.lon, ele: t.ele, dist: t.dist,
      secs: t.secs ?? null,
    },
  };
}

/* ---------- the client ---------- */

export function createCloud(db) {
  const must = () => { if (!db) throw new Error('No database client configured'); return db; };

  return {
    /* -- who is here -- */
    session: () => must().auth.session(),
    user: () => must().auth.user(),
    onAuthChange(fn) { return must().auth.onChange(fn); },
    signUp: (email, password) => must().auth.signUp(email, password),
    signIn: (email, password) => must().auth.signIn(email, password),
    signOut: () => must().auth.signOut(),

    /* -- routes -- */

    /**
     * The caller's own routes, newest first.
     *
     * No `where owner = me`: row-level security will not return anybody
     * else's rows, and adding the filter here would only suggest that
     * removing it might.
     */
    async myRoutes() {
      const rows = await must().from('routes').select(
        'id,name,activity,source,recorded_at,created_at,stats,bbox,centre,profile,visibility,share_token',
        { order: 'recorded_at.desc.nullslast' },
      );
      return (rows ?? []).map(rowToRoute);
    },

    /** One route including its track, for the viewer. */
    async route(id) {
      const rows = await must().from('routes').select('*', { filter: { id: `eq.${id}` }, limit: 1 });
      if (!rows?.length) throw new Error('That route is not here');
      return rowToRoute(rows[0]);
    },

    async save(track, meta) {
      const owner = must().auth.user()?.id;
      if (!owner) throw new Error('Sign in before saving a route');
      return rowToRoute(await must().from('routes').insert({ ...routeToRow(track, meta), owner }));
    },

    async setVisibility(id, visibility) {
      return rowToRoute(await must().from('routes').update({ visibility }, { id: `eq.${id}` }));
    },

    /** Invalidate every link already handed out for a route. */
    rotateShareToken(id) { return must().rpc('rotate_share_token', { route_id: id }); },

    remove(id) { return must().from('routes').remove({ id: `eq.${id}` }); },

    /**
     * Open a shared route from its token, with or without an account. This is
     * the only way into a link-shared route: no policy grants it to an
     * ordinary select, so the function is the door and the token is the key.
     */
    async byToken(token) {
      const rows = await must().rpc('route_by_token', { tok: token });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ? rowToRoute(row) : null;
    },

    /**
     * Move routes held in this browser into the account that just signed in.
     *
     * Everything recorded before signing up lives in localStorage, and losing
     * it at the moment somebody finally makes an account would be the worst
     * possible introduction. Uploads are attempted one at a time and the local
     * copy is left alone: a duplicate is recoverable, a route that exists in
     * neither place is not.
     */
    async importLocal(entries, { onProgress } = {}) {
      const done = [], failed = [];
      for (const [i, e] of entries.entries()) {
        try {
          done.push(await this.save(e.track, {
            name: e.name,
            activity: e.activity ?? e.track?.activity ?? 'run',
            source: e.source ?? 'import',
            profile: e.profile ?? null,
          }));
        } catch (error) {
          failed.push({ entry: e, error });
        }
        onProgress?.(i + 1, entries.length);
      }
      return { done, failed };
    },
  };
}
