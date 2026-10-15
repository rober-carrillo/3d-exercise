-- The parts Supabase supplies, stubbed so schema.sql can be run and tested
-- against a plain Postgres. Not for production — Supabase already has all of
-- this, and running it there would collide with the real auth schema.
--
-- Supabase's auth.uid() reads the user id out of the request's JWT claims.
-- Locally there is no JWT, so the same shape is faked with a session setting:
--   select set_config('request.jwt.claim.sub', '<uuid>', true);
-- which is exactly how the real one behaves, including returning null when
-- nobody is signed in.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- the two roles Supabase hands to clients
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema public, auth to anon, authenticated;
