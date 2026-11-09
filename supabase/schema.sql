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

-- ---------------------------------------------------------------------------
-- Scene reports
--
-- What a route looked like on somebody else's phone.
--
-- There is a class of bug this table exists for and nothing else: the terrain
-- comes out with spikes in it on one device, on the same build, from the same
-- tiles, and there is no way to see it from here. Elevation arrives as a PNG
-- whose red channel is worth 256 metres a step (src/terrain.js), so a device
-- that hands back a slightly different byte than the file held draws a
-- mountain. Whether it does is a property of the device, which means the only
-- place the evidence exists is the device.
--
-- So a viewing writes itself down — tiles asked for and arrived, the decoded
-- elevation field's own statistics, the raw bytes of any pixel that disagrees
-- with its neighbours, a probe of whether the canvas can hold eight bits a
-- channel at all, and a thumbnail of the result. See src/scenelog.js for what
-- goes in and why. A report is sent when something in it is wrong, or when
-- somebody presses the button; a scene that worked is kept on the device and
-- goes no further.
--
-- `faults` is a column rather than a key inside the blob so that a list of
-- reports can be read, filtered and counted without opening any of them.
-- ---------------------------------------------------------------------------

create table if not exists scene_reports (
  id          uuid primary key default gen_random_uuid(),
  reporter    uuid not null references auth.users on delete cascade,
  -- Which route, when it was one from the account. A local-only route has no
  -- id to point at, and a report is worth having either way, so this is null.
  route_id    uuid references routes on delete set null,
  route_name  text,
  faults      text[] not null default '{}',
  app_version text,
  platform    text,
  report      jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists scene_reports_reporter_idx on scene_reports (reporter, created_at desc);
create index if not exists scene_reports_faults_idx   on scene_reports using gin (faults);

-- Who is allowed to read everybody's reports.
--
-- A table rather than a hard-coded uuid in a policy, so adding or removing
-- somebody is a row and not a migration. It is readable by nobody and writable
-- by nobody: rows go in from the SQL editor, which runs as the table owner and
-- bypasses row-level security.
create table if not exists admins (
  id          uuid primary key references auth.users on delete cascade,
  note        text,
  created_at  timestamptz not null default now()
);
alter table admins enable row level security;

-- Am I one of them?
--
-- `security definer`, and that is not a shortcut. A policy's subquery runs
-- with the privileges of whoever is asking, so a policy that reads `admins`
-- directly needs every client to hold select on it — and row-level security
-- would then answer "no rows" to all of them, making the check silently
-- false for the admin too. A definer function reads the table as its owner
-- and returns one boolean, which is all a policy needs and all a client gets.
create or replace function is_admin() returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select exists (select 1 from admins a where a.id = auth.uid()); $$;

revoke all on function is_admin() from public;
grant execute on function is_admin() to authenticated;

alter table scene_reports enable row level security;

-- Her own reports are hers: she can file them, read them back and delete them.
drop policy if exists scene_reports_own on scene_reports;
create policy scene_reports_own on scene_reports
  for all to authenticated
  using (reporter = auth.uid()) with check (reporter = auth.uid());

-- And an admin may read them all, which is the entire point of the table.
-- Read only: a report is somebody's account of what they saw, and nothing
-- here should be able to edit it.
drop policy if exists scene_reports_admin_read on scene_reports;
-- Scoped to `authenticated` on purpose. Left unscoped, an anonymous select
-- would evaluate is_admin(), which anon may not execute, and the refusal
-- would come back as a permission error on the table rather than as the empty
-- answer an outsider ought to get.
create policy scene_reports_admin_read on scene_reports
  for select to authenticated using (is_admin());

-- Reading somebody's reports means knowing which rows are theirs, and the
-- reporter column is a bare uuid. `security definer` because an admin has no
-- policy on auth.users and should not be given one; the gate is inside.
create or replace function scene_reports_for(who text default null, lim int default 50)
returns table (
  id uuid, reporter uuid, handle text, email text, route_id uuid, route_name text,
  faults text[], app_version text, platform text, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.reporter, p.handle, u.email, s.route_id, s.route_name,
         s.faults, s.app_version, s.platform, s.created_at
    from scene_reports s
    left join profiles p on p.id = s.reporter
    left join auth.users u on u.id = s.reporter
   where is_admin()
     and (who is null or p.handle = who or u.email = who or s.reporter::text = who)
   order by s.created_at desc
   limit greatest(1, least(coalesce(lim, 50), 500));
$$;

revoke all on function scene_reports_for(text, int) from public;
grant execute on function scene_reports_for(text, int) to authenticated;
