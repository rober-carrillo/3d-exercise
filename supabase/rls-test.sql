-- Does the security model actually hold?
--
-- RLS mistakes are silent: everything works, and strangers can read your data.
-- So every claim the schema makes gets asserted here, from the seat of the
-- person making the request — signed in as the owner, signed in as somebody
-- else, and signed in as nobody at all.
--
--   psql -f schema-local.sql -f schema.sql -f rls-test.sql
--
-- Any failure raises, so a non-zero exit means the model is broken.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- two people, three routes each: one private, one link-shared, one public
delete from routes; delete from profiles; delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'rober@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'stranger@example.com');
insert into profiles (id, handle) values
  ('11111111-1111-1111-1111-111111111111', 'rober'),
  ('22222222-2222-2222-2222-222222222222', 'stranger');

insert into routes (id, owner, name, visibility, share_token, stats, bbox, centre, track) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Private morning run', 'private', 'dddddddd-0000-0000-0000-000000000001',
   '{"distance_m":3090}', '{}', '{}', '{"lat":[],"lon":[]}'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Shared by link', 'link', 'dddddddd-0000-0000-0000-000000000002',
   '{"distance_m":2480}', '{}', '{}', '{"lat":[],"lon":[]}'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Public hike', 'public', 'dddddddd-0000-0000-0000-000000000003',
   '{"distance_m":14010}', '{}', '{}', '{"lat":[],"lon":[]}'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'Stranger private', 'private', 'dddddddd-0000-0000-0000-000000000004',
   '{"distance_m":100}', '{}', '{}', '{"lat":[],"lon":[]}');

create or replace function assert(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok then raise notice '  PASS  %', what;
  else raise exception 'FAILED: %', what;
  end if;
end $$;

-- the client roles really are restricted; the table owner bypasses RLS
grant select, insert, update, delete on routes, profiles to authenticated;
grant select on routes, profiles to anon;

\echo ''
\echo 'AS THE OWNER'
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select assert((select count(*) from routes) = 3, 'owner sees their own three routes, and only those');
select assert((select count(*) from routes where visibility = 'private') = 1, 'owner can read their private route');
select assert((select count(*) from routes where owner = '22222222-2222-2222-2222-222222222222') = 0,
              'owner cannot see the stranger''s private route');

-- and cannot plant a route under somebody else's name
do $$ begin
  begin
    insert into routes (owner, name, stats, bbox, centre, track)
    values ('22222222-2222-2222-2222-222222222222', 'planted', '{}', '{}', '{}', '{}');
    raise exception 'FAILED: a user was able to create a route owned by someone else';
  exception when insufficient_privilege then
    raise notice '  PASS  cannot create a route owned by someone else';
  end;
end $$;

\echo ''
\echo 'AS A DIFFERENT SIGNED-IN USER'
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from routes where owner = '11111111-1111-1111-1111-111111111111') = 1,
              'a stranger sees only the public route of someone else''s three');
select assert((select count(*) from routes
               where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0,
              'a stranger cannot read a private route even knowing its id');
select assert((select count(*) from routes
               where id = 'aaaaaaaa-0000-0000-0000-000000000002') = 0,
              'a stranger cannot read a link-shared route by id — the token is the only way in');

-- nor edit or delete what is not theirs. A write blocked by RLS is not an
-- error, it simply matches no rows — which is exactly why it has to be
-- asserted rather than assumed.
with u as (
  update routes set name = 'hijacked'
   where id = 'aaaaaaaa-0000-0000-0000-000000000003' returning 1)
select assert((select count(*) from u) = 0,
  'a stranger cannot rename someone else''s public route');

with d as (
  delete from routes where id = 'aaaaaaaa-0000-0000-0000-000000000003' returning 1)
select assert((select count(*) from d) = 0,
  'a stranger cannot delete someone else''s public route');

\echo ''
\echo 'AS NOBODY (not signed in)'
reset role; set role anon;
select set_config('request.jwt.claim.sub', '', false);
select assert((select count(*) from routes) = 1, 'an anonymous visitor sees public routes only');
select assert((select count(*) from routes where visibility <> 'public') = 0,
              'nothing private or link-shared leaks to anonymous');

\echo ''
\echo 'SHARE LINKS'
select assert((select count(*) from route_by_token('dddddddd-0000-0000-0000-000000000002')) = 1,
              'the right token opens the link-shared route, with no account at all');
select assert((select count(*) from route_by_token('dddddddd-0000-0000-0000-000000000001')) = 0,
              'a token for a PRIVATE route opens nothing');
select assert((select count(*) from route_by_token('dddddddd-0000-0000-0000-000000000009')) = 0,
              'a made-up token opens nothing');
select assert((select owner_handle from route_by_token('dddddddd-0000-0000-0000-000000000002')) = 'rober',
              'a shared route carries its owner''s handle');

\echo ''
\echo 'REVOKING A LINK'
reset role; set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
update routes set share_token = gen_random_uuid()
 where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select assert((select count(*) from route_by_token('dddddddd-0000-0000-0000-000000000002')) = 0,
              'rotating the token kills every link already handed out');

reset role;
\echo ''
\echo 'all assertions passed'
