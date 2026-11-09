# Changelog

## 1.4.0 (2026-11-09)

Supabase stopped granting new `public` tables to the Data API roles on 2026-10-30
([changelog 45329](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)).
Three checks for it, all in the `database` group and the `supabase-rls-audit` skill:

- `grants-missing` (warning): app code calls `.from('<table>')` on a table with no grant for the role it runs
  as. Prints the minimal grant (only the commands the code uses, `select` added for `update`/`delete`, the
  sequence for `serial` columns, `anon` only behind a signed-out policy).
- `grant-leak` (error): a grant to anon/authenticated on a table with RLS off or a `true` write policy,
  including schema-wide grants and `alter default privileges`.
- `grant-broad` (warning): `grant … on all tables in schema public` or default privileges that re-grant every
  table.
- The SQL replay now tracks table grants per role, `on all tables in schema`, `alter default privileges … on
  tables`, migration dates and `[api] auto_expose_new_tables` in `supabase/config.toml`.
- Each `supabase/` folder in a monorepo is replayed on its own, so a test fixture's tables no longer mix with
  the app's.
- `examples/grants-repro`: a PGlite replay that shows the 42501, the suggested grant fixing it, and the leak
  from `grant all` with RLS off. `examples/fixed-app` gets the grants its code needs.

## 1.3.0 (2026-11-09)

Focused skills `supabase-rls-audit`, `stripe-webhook-security` and `upwork-proposal-lint`; `--only` groups;
`stripe-webhook-parsed-body`.

## 1.2.0 (2026-11-08)

Seven database checks: RLS without policies, user-editable plan/role columns, views without
`security_invoker`, views over `auth.users`, SECURITY DEFINER `search_path` and anon RPC, public buckets.

## 1.1.x (2026-11-07)

Fewer false positives on public starters; Claude Code plugin marketplace; Cursor plugin manifest.

## 1.0.0 (2026-11-07)

First release: six checks, the skill and the example apps.
