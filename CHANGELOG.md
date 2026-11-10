# Changelog

## 1.6.1 (2026-11-10)

No rule changes. The file-system and git code moved out of the scan engine (`src/model.ts` and
`src/engine.ts` are pure now), so the same checks also run in a browser. The JWT check decodes with `atob` instead of Node's `Buffer`.
`package.json` has a `bin`, so `npx github:atokim4/vibe-preflight .` runs the scanner.

## 1.6.0 (2026-11-10)

Two checks for Supabase breaking changes, in a new `breaking` group (`--only breaking`) and in the
`vibe-preflight` skill:

- `server-adapter-removed`: imports of `@supabase/server/adapters/{hono,h3,elysia,nestjs}`, which Supabase
  [removes on 2026-12-01](https://supabase.com/changelog/supabase-server-adapters-deprecated). Also finds
  Deno `npm:` specifiers, `import()` and `require()`. Each `withSupabase(...)` registration is reported with
  its `auth` value and the replacement from the
  [migration guide](https://supabase.com/docs/reference/server/frameworks#moving-off-the-adapters):
  `withRequiredClaims()` for `'user'` or no config, no gate for `'none'`, stay on `withSupabase` for
  `'publishable'` / `'secret'`. Notes a `package.json` range below 1.6.0 and a missing `@supabase/middleware`
  (nearest `package.json`, so monorepos work). Reads the deprecated `allow` option (`'always'`, `'public'`)
  and mode lists. Reports reads of the adapters' `supabaseContext` in any project on `@supabase/server`,
  since the bridges only set flat keys. Warning before the date, error from it.
- `cron-job-direct-write` (warning): `insert into cron.job` / `update cron.job` in `supabase/migrations/*.sql`
  and seeds (and any other `.sql`, such as Prisma migrations, in a project that uses Supabase), including DO blocks and plpgsql/sql function bodies, which Supabase
  [blocks](https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed).
  Prints the `cron.schedule` / `cron.schedule_in_database` / `cron.alter_job` rewrite when the statement
  translates exactly (`perform` inside plpgsql), general advice otherwise. Reads and `cron.job_run_details`
  are left alone.
- CLI `--today YYYY-MM-DD` judges date-based checks as of that day.
- `examples/breaking-app` and `examples/breaking-app-fixed`. The fixed Hono and NestJS files typecheck against
  `@supabase/server` 1.9.2 and `@supabase/middleware` 1.0.0 with the official bridges copied in (checked by
  hand, the bridges aren't committed).
- Tests: 21 new (135 in total). The printed cron rewrites run in PGlite against stubs with pg_cron's documented
  signatures and a role that can read but not write `cron.job`. PGlite can't load pg_cron, so this checks
  the SQL and the argument binding, not pg_cron.
- Checked on public code: a true positive in a public Hono API (adapter import, an
  `allow: "user"` registration, a `supabaseContext` read); nothing reported on splitPro, the supabase/server
  source and two repos that depend on `@supabase/server` without the adapters.
- The plugin manifests still said 14 checks; they say 19 now.

## 1.5.0 (2026-11-09)

GitHub Action (`action.yml` at the repo root, `runs.using: node24`, bundled into `action/index.mjs` with no
runtime dependencies):

- Inputs `path`, `fail-on` (`error` | `warning` | `none`), `format` (`sarif` | `markdown`), `include`,
  `exclude`, `sarif-file`. Outputs `findings-count`, `errors-count`, `sarif-file`.
- SARIF 2.1.0 for code scanning: every check that ran as a rule with help text (why + fix), `security`
  tags and a security-severity; each finding with `ruleId`, `ruleIndex`, `level` and a repo-relative
  file/line location.
- Job summary with a table of findings (linked to the commit) and the fix for each check that fired.
- `::error` / `::warning` annotations on the reported lines.
- `ci/self-test.yml`: a workflow that runs the unit tests, checks the bundles are current and runs the
  action on both examples (not enabled on this repo yet).
- CLI: `--only` / `--skip` parsing moved to `src/select.ts`, shared with the action. The `--help` header said
  14 checks; it now says 17.

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
