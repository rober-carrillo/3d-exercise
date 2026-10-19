-- Salpicón! — database schema.
--
-- Runs as-is in the Supabase SQL editor. Supabase provides `auth.users` and
-- `auth.uid()`; schema-local.sql stubs both so this file can be tested against
-- a plain Postgres, which is how the policies at the bottom are verified.
--
-- The whole security model is here rather than in the app. A client that can
-- reach the database can issue any query it likes, so "private means private"
-- has to be true of the table, not of the screen in front of it.

create extension if not exists pgcrypto;

create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  handle      text unique,
  created_at  timestamptz not null default now()
);

create table if not exists routes (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users on delete cascade,

  name        text not null,
  activity    text not null default 'run'
              check (activity in ('walk','run','ride','field','other')),
  source      text not null default 'import'
              check (source in ('import','recorded','drawn')),

  -- when it happened; null for a file that carried no timestamps
  recorded_at timestamptz,

  -- derived once, on the way in, so a list of routes costs one cheap query
  stats       jsonb not null,
  bbox        jsonb not null,
  centre      jsonb not null,
  profile     jsonb,                         -- 96 elevation samples for the card

  -- the track itself: decimated lat/lon/ele/dist/secs, ~37 KB a route
  track       jsonb not null,

  visibility  text not null default 'private'
              check (visibility in ('private','link','public')),
  -- regenerating this revokes every link that was handed out
  share_token uuid not null unique default gen_random_uuid(),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists routes_owner_idx   on routes (owner, recorded_at desc nulls last);
create index if not exists routes_public_idx  on routes (recorded_at desc) where visibility = 'public';
create index if not exists routes_token_idx   on routes (share_token);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists routes_touch on routes;
create trigger routes_touch before update on routes
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Three rules, and nothing else gets through. Note what is deliberately
-- absent: there is no policy for `visibility = 'link'`. A link-shared route is
-- unreachable by any ordinary select, including for a signed-in stranger who
-- guesses its id. The only way in is the token function below, which is why
-- the token can be treated as the key.
-- ---------------------------------------------------------------------------

alter table routes enable row level security;
alter table profiles enable row level security;

drop policy if exists routes_owner_all on routes;
create policy routes_owner_all on routes
  for all using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists routes_public_read on routes;
create policy routes_public_read on routes
  for select using (visibility = 'public');

drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (true);

-- ---------------------------------------------------------------------------
-- Share links
--
-- `security definer` steps around RLS, so the function itself has to be the
-- gate: it returns a row only when the token matches exactly and the owner
-- actually chose to share it. It takes the token as an argument rather than
-- reading it from anywhere ambient, so there is no way to ask it for a listing.
-- `search_path` is pinned because a definer function that resolves names
-- through the caller's path can be hijacked by a table they create.
-- ---------------------------------------------------------------------------

create or replace function route_by_token(tok uuid)
returns table (
  id uuid, name text, activity text, source text, recorded_at timestamptz,
  stats jsonb, bbox jsonb, centre jsonb, profile jsonb, track jsonb,
  owner_handle text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.name, r.activity, r.source, r.recorded_at,
         r.stats, r.bbox, r.centre, r.profile, r.track,
         p.handle
    from routes r
    left join profiles p on p.id = r.owner
   where r.share_token = tok
     and r.visibility in ('link','public');
$$;

revoke all on function route_by_token(uuid) from public;
grant execute on function route_by_token(uuid) to anon, authenticated;

-- Revoking a link.
--
-- Deliberately NOT security definer: this one runs as the caller, so the
-- owner policy decides whose routes may be rotated. A stranger calling it
-- with somebody else's id updates nothing and gets null back, which is the
-- behaviour you want from a function that hands out a new key.
create or replace function rotate_share_token(route_id uuid)
returns uuid
language sql
volatile
set search_path = public, pg_temp
as $$
  update routes set share_token = gen_random_uuid()
   where id = route_id
  returning share_token;
$$;

revoke all on function rotate_share_token(uuid) from public;
grant execute on function rotate_share_token(uuid) to authenticated;
