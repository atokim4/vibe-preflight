-- The parts of a Supabase database the repro needs, recreated in plain Postgres (PGlite).
-- Sample setup for the repro only; a real project gets all of this from Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
-- PostgREST puts the JWT's `sub` claim in this setting; auth.uid() reads it.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Before 2026-10-30: every new table in public was granted to the API roles automatically.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

-- The 2026-10-30 change, as the changelog gives it.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
