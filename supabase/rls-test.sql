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
select rotate_share_token('aaaaaaaa-0000-0000-0000-000000000002') as fresh \gset
select assert((select count(*) from route_by_token('dddddddd-0000-0000-0000-000000000002')) = 0,
              'rotating the token kills every link already handed out');
select assert((select count(*) from route_by_token(:'fresh')) = 1,
              'the new token works immediately');

-- and a stranger cannot rotate what is not theirs
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select assert(rotate_share_token('aaaaaaaa-0000-0000-0000-000000000002') is null,
              'a stranger rotating someone else''s token changes nothing');
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select assert((select count(*) from route_by_token(:'fresh')) = 1,
              'and the owner''s link still works afterwards');

\echo ''
\echo 'SCENE REPORTS'
reset role;
grant select, insert, update, delete on scene_reports to authenticated;
grant select on scene_reports to anon;
-- rober is an admin; the stranger is not
insert into admins (id, note) values ('11111111-1111-1111-1111-111111111111', 'test admin');
insert into scene_reports (reporter, route_id, route_name, faults, app_version, platform, report) values
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Stranger private', '{dem-spikes}', '1.5.1', 'android', '{"dem":{"spikes":41}}'),
  ('22222222-2222-2222-2222-222222222222', null, 'A local route', '{}', '1.5.1', 'android', '{}'),
  ('11111111-1111-1111-1111-111111111111', null, 'Mine', '{tiles-missing:dem}', '1.5.1', 'web', '{}');

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from scene_reports) = 2,
              'a reporter sees her own reports and only those');
with d as (delete from scene_reports where reporter = '11111111-1111-1111-1111-111111111111' returning 1)
select assert((select count(*) from d) = 0,
              'a reporter cannot delete somebody else''s report');
-- Filing one in somebody else's name is the interesting attack: a report is
-- evidence, and being able to forge whose device it came from would make the
-- whole table worthless. The with-check clause is what stops it, so it has to
-- raise rather than quietly insert.
do $$ begin
  begin
    insert into scene_reports (reporter, report)
      values ('11111111-1111-1111-1111-111111111111', '{}');
    raise exception 'FAILED: a reporter was able to file a report as somebody else';
  exception when insufficient_privilege then
    raise notice '  PASS  a reporter cannot file a report in somebody else''s name';
  end;
end $$;

\echo ''
\echo 'AS THE ADMIN'
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select assert((select count(*) from scene_reports) = 3,
              'an admin reads every report, including other people''s');
select assert((select count(*) from scene_reports_for(null, 50)) = 3,
              'the listing function returns them all');
select assert((select count(*) from scene_reports_for('stranger', 50)) = 2,
              'and can be narrowed to one person by handle');
select assert((select handle from scene_reports_for('stranger', 1)) = 'stranger',
              'the listing carries the handle, which the reports table does not');
select assert((select faults from scene_reports_for('stranger', 1)) = '{dem-spikes}',
              'and the verdicts, so a list can be read without opening a report');

\echo ''
\echo 'AS NOBODY'
reset role; set role anon;
select set_config('request.jwt.claim.sub', '', false);
select assert((select count(*) from scene_reports) = 0,
              'reports do not leak to anonymous visitors');
-- The listing is not merely empty for an outsider, it is not callable: execute
-- was granted to signed-in people only.
do $$ begin
  begin
    perform count(*) from scene_reports_for(null, 50);
    raise exception 'FAILED: an anonymous visitor could call the report listing';
  exception when insufficient_privilege then
    raise notice '  PASS  the listing function is not callable without an account';
  end;
end $$;

reset role;

\echo ''
\echo 'all assertions passed'
