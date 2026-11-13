# vibe-preflight

An Agent Skill for Claude Code, Codex and other coding agents that checks a Supabase + Stripe app for 21
common launch blockers before you deploy it. The same checks also run as a GitHub Action on pull requests
(see [Use in CI](#use-in-ci)). Its upgrade checks (`--only breaking` and the grants checks) also run in the browser at
[upgrade-check-2026.netlify.app](https://upgrade-check-2026.netlify.app), on any public GitHub repo. It ships with a small Node scanner (one file, no dependencies)
that the agent runs, and instructions telling the agent how to read each finding and fix it.

![vibe-preflight output on the sample broken app](media/output.png)

I built this as a personal project. The checks cover mistakes that are common in Next.js and Vite apps
generated with AI tools: RLS left off, template policies, views and functions that skip RLS, public buckets,
the service role key in the browser, Stripe webhooks that trust any POST, and the Data API grants that
Supabase stopped adding to new tables on 2026-10-30. Two more catch Supabase breaking changes before they
break a deploy: the `@supabase/server` framework adapters removed on 2026-12-01, and direct writes to
pg_cron's `cron.job` table. The last two work on any Postgres app (Node or Python, with or without Supabase):
`SELECT … FOR UPDATE` that runs outside a transaction, so the row lock is gone before the write, and a status
read followed by an `UPDATE` that never re-checks it. See [Row locks that end too early](#row-locks-that-end-too-early).

## Install

```bash
npx skills add atokim4/vibe-preflight
```

Or as a Claude Code plugin (the repo is its own plugin marketplace):

```
/plugin marketplace add atokim4/vibe-preflight
/plugin install vibe-preflight@atokim4-vibe-preflight
```

The repo holds four skills. `npx skills add atokim4/vibe-preflight` offers all of them; to take just one:

```bash
npx skills add atokim4/vibe-preflight --skill vibe-preflight            # all 21 checks
npx skills add atokim4/vibe-preflight --skill supabase-rls-audit        # the 12 database checks
npx skills add atokim4/vibe-preflight --skill stripe-webhook-security   # the 2 Stripe checks + a review list
npx skills add atokim4/vibe-preflight --skill upwork-proposal-lint      # proposal linter, unrelated to security
```

| Skill | What it does |
|---|---|
| `vibe-preflight` | Runs every check below and fixes what it finds |
| `supabase-rls-audit` | Runs `--only database`: RLS, policies, views, SECURITY DEFINER functions, storage buckets, Data API grants |
| `stripe-webhook-security` | Runs `--only stripe`, then reviews the handler for raw body, replay tolerance, idempotency, event order and the webhook secret (the review part is reading code, not scanning) |
| `upwork-proposal-lint` | Writes or checks an Upwork proposal with a copy of the linter from [cover-letter-lint](https://github.com/atokim4/cover-letter-lint): AI phrases, dashes, off-platform contact, placeholders, word count, claims not in your facts file |

The two security skills carry their own copy of the same scanner, so each works when installed alone.

Then ask your agent something like "run vibe-preflight before we deploy". You can also run the scanner
yourself, with Node 20 or newer:

```bash
node .claude/skills/vibe-preflight/scripts/preflight.mjs path/to/app
```

or without installing anything: `npx github:atokim4/vibe-preflight path/to/app`.

(the folder depends on the agent you installed the skill for).

## Use in CI

The repo is also a GitHub Action. It runs the same 21 checks, writes a SARIF file that code scanning turns
into alerts, adds a table of findings with the fix for each check to the job summary, and annotates the
lines in the pull request diff. Copy this into `.github/workflows/vibe-preflight.yml`:

```yaml
name: vibe-preflight

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write # upload-sarif needs it

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - id: preflight
        uses: atokim4/vibe-preflight@v1
        with:
          fail-on: error

      - uses: github/codeql-action/upload-sarif@v4
        if: ${{ !cancelled() && steps.preflight.outputs.sarif-file != '' }}
        with:
          sarif_file: ${{ steps.preflight.outputs.sarif-file }}
          category: vibe-preflight
```

The `v1` tag arrives with the first Marketplace release. Until then, use `atokim4/vibe-preflight@main` or
pin a commit SHA.

The upload step runs even when the scan fails the job, so the alerts show up for the same commit. Code
scanning has to be available on the repo for the upload to work: public repos have it, private ones need
GitHub Code Security. Without it, set `format: markdown` and drop the upload step; you still get the job
summary, the annotations and the failing check.

| Input | Default | What it does |
|---|---|---|
| `path` | `.` | Folder to scan, relative to the repo root. Set it to the app folder in a monorepo |
| `fail-on` | `error` | `error`, `warning` or `none`. The step fails when a finding at that level or above exists |
| `format` | `sarif` | `sarif` writes the SARIF file and the job summary, `markdown` only the job summary |
| `include` | all checks | Groups (`database`, `secrets`, `stripe`, `breaking`, `concurrency`) or check ids, comma- or newline-separated |
| `exclude` | none | Check ids to turn off |
| `sarif-file` | `vibe-preflight.sarif` | Where the SARIF file goes, relative to the repo root |

| Output | |
|---|---|
| `findings-count` | Errors plus warnings, after inline ignores |
| `errors-count` | Error-level findings only |
| `sarif-file` | Path of the SARIF file, empty with `format: markdown` |

Each SARIF result has the check id, the level, the file and line, and the check's help text with the fix.
Errors get a security-severity of 8.0 (shown as High) and warnings 5.0 (Medium). Locations are relative to
the repo root even when `path` points at a subfolder. GitHub only shows a limited number of annotations per
step, so on a big first run the job summary and the code scanning tab are where to read the full list.

The action needs no token and makes no network calls. It reads the checked-out files and runs `git
ls-files`, like the CLI.

## The 21 checks

| Check | Severity | What it finds |
|---|---|---|
| `rls-disabled` | error | A table in `public` created in a migration with no `enable row level security` anywhere later |
| `rls-permissive-policy` | error on write, warning on read | `using (true)` / `with check (true)` policies |
| `rls-no-policy` | warning | RLS on and no policies: the API gets nothing, so a browser read silently returns no rows |
| `rls-update-privileged-column` | warning | An update policy for users on a table with a `plan`, `role`, `is_admin`, `credits`-style column, and no column privilege or `before update` trigger guarding it |
| `view-bypasses-rls` | error | A view in `public` without `security_invoker = true` (or any materialized view there) that the API can still read |
| `auth-users-exposed` | error | A view in `public` that selects from `auth.users` |
| `definer-search-path` | warning | A `security definer` function with no `set search_path` |
| `definer-function-anon` | error / warning | A `security definer` function in `public` that anon can call at `/rest/v1/rpc/…`. Error for an explicit grant, warning when Supabase's default grant was never revoked |
| `storage-public-bucket` | error / warning | A public storage bucket. Error when a `storage.objects` select policy that isn't scoped to the user also lets anyone list it |
| `grant-leak` | error | A grant to anon/authenticated on a table with RLS off or a `true` write policy: `grant all on public.t to anon`, `grant … on all tables in schema public`, or `alter default privileges … grant … on tables` |
| `grants-missing` | warning | `.from('<table>')` in app code on a table with no grant for the role the code runs as (created after 2026-10-30, `auto_expose_new_tables = false`, or after a default-privileges revoke). supabase-js gets 42501; the message has the minimal grant |
| `grant-broad` | warning | `grant … on all tables in schema public` or `alter default privileges … grant … on tables` to anon/authenticated, which undoes the 2026-10-30 change for every table |
| `server-secret-in-client` | error | `SUPABASE_SERVICE_ROLE_KEY`, `'service_role'` or a Stripe secret in browser code (`"use client"` files in Next.js, `src/` in Vite/Expo) |
| `public-env-secret` | error / warning | Secret-looking names behind `NEXT_PUBLIC_`, `VITE_` or `EXPO_PUBLIC_` (boolean flags such as `NEXT_PUBLIC_AUTH_PASSWORD=true` are skipped) |
| `stripe-webhook-unverified` | error | A webhook handler that acts on Stripe events without `constructEvent` / `constructEventAsync` |
| `stripe-webhook-parsed-body` | warning | `constructEvent` gets a body that was already parsed: `req.json()`, `JSON.stringify(...)`, `req.body` in pages/api without `bodyParser: false`, or `req.body` behind `express.json()` with no `express.raw()` |
| `env-file-committed` | error / warning | An `.env*` file with values that git tracks or doesn't ignore. Warning only when it holds just the Supabase CLI's local demo keys or just public variables |
| `server-adapter-removed` | warning, error from 2026-12-01 | An import of `@supabase/server/adapters/{hono,h3,elysia,nestjs}`, and each `withSupabase(...)` registration with its `auth` value and the exact bridge call that replaces it. Reads the deprecated `allow` option and mode lists too. Notes a `package.json` range below 1.6.0 and a missing `@supabase/middleware`, and flags leftover `supabaseContext` reads |
| `cron-job-direct-write` | warning | `insert into cron.job` / `update cron.job` in `supabase/migrations/*.sql` or `seed.sql`, also inside DO blocks and function bodies, with the `cron.schedule` / `cron.schedule_in_database` / `cron.alter_job` rewrite |
| `for-update-autocommit` | error | `SELECT … FOR UPDATE` / `FOR SHARE` that holds no lock past the statement: node-postgres `pool.query` (each call is its own connection, so a `BEGIN` sent through the pool doesn't help), a client with no `BEGIN` in that function, Prisma `$queryRaw` outside `$transaction(async (tx) => …)`, Drizzle `.for('update')` and Knex `.forUpdate()` outside a transaction, Sequelize `lock` without `transaction`, asyncpg outside `conn.transaction()`, psycopg / SQLAlchemy when the project turns on autocommit. A connection passed in as a parameter is left alone (the caller may hold the transaction) |
| `check-then-act` | warning | Raw SQL in one function that reads `status` / `balance` / `stock`-style columns and then sets them with an `UPDATE … WHERE id = …` that doesn't re-check the value (`balance = balance - $1` is fine). JS/TS and Python |

`SKILL.md` explains each one with the fix. The scanner also prints the why and the fix with `--explain`.

## Row locks that end too early

A row lock lasts until the transaction ends ([PostgreSQL docs](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)).
In autocommit every statement is a transaction of its own, so `SELECT … FOR UPDATE` locks the row for as long
as the SELECT takes and then lets go. The code that reads `status = 'pending'`, calls Stripe or Telegram and then
writes `paid` is not protected at all. node-postgres
[says it plainly](https://node-postgres.com/features/transactions): use the same client for every statement of
a transaction, and don't run transactions through `pool.query`.

[`examples/for-update-repro`](examples/for-update-repro) races two requests for the same order and the same
wallet on a real PostgreSQL 18 server with separate connections, 20 rounds per strategy. From
[`OUTPUT.txt`](examples/for-update-repro/OUTPUT.txt):

| Strategy | Both requests won |
|---|---|
| `pool.query` + `FOR UPDATE`, no transaction | 20/20 |
| `client.query` + `FOR UPDATE`, no `BEGIN` | 20/20 |
| `pool.query('BEGIN')` + `FOR UPDATE` through the pool | 0/20 |
| the same, while one other request uses the pool | 20/20 (and 2 connections left "idle in transaction") |
| one client: `BEGIN`, `FOR UPDATE`, `UPDATE`, `COMMIT` | 0/20 |
| `SELECT status`, then `UPDATE … WHERE id` | 20/20 |
| `UPDATE … WHERE status = 'pending' RETURNING` | 0/20 |
| wallet, 100 minus two withdrawals of 80, `pool.query` + `FOR UPDATE` | 20/20, final balance 20 |
| wallet, `SET balance = balance - 80 WHERE balance >= 80` | 0/20 |

The `pool.query('BEGIN')` row is the dangerous one: it looks right and passes a quiet test, because the pool
hands the same idle connection back. Under any other traffic the statements spread over connections. Running
the scanner on the repro flags exactly the five broken strategies and none of the four correct ones.

postgres.js and Neon are easy to miss here: a tagged `` sql`SELECT … FOR UPDATE SKIP LOCKED` `` looks like a job
claim, but each tagged query is its own transaction, so the rows are unlocked by the time the loop sends the
first message. Claim them in one statement (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`)
or inside `sql.begin(async (tx) => …)`.

Two things need no check. Django raises `TransactionManagementError` when a `select_for_update()` queryset runs
outside `transaction.atomic()` ([docs](https://docs.djangoproject.com/en/5.2/ref/models/querysets/#select-for-update)).
Supabase `.rpc()` calls run inside one transaction per request ([PostgREST](https://docs.postgrest.org/en/stable/references/transactions.html)),
so `FOR UPDATE` inside a plpgsql function called that way holds its lock until the function returns.

```bash
cd examples/for-update-repro && npm install && npm start   # downloads a PostgreSQL 18 binary (embedded-postgres)
```

## Supabase's 2026-10-30 grants change

Since [2026-10-30](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
new tables in `public` get no grants for `anon`, `authenticated` or `service_role`, so supabase-js returns
`42501 permission denied for table <name>` until you add one. Older tables keep their grants. The quick fixes
that circulate (`grant all … to anon`, the bulk `on all tables in schema public` grant) open tables that have
RLS off to anyone with the anon key.

`grants-missing` dates each table by its migration file name, follows `alter default privileges` in the
migrations and `[api] auto_expose_new_tables` in `supabase/config.toml`, and works out the grant from what the
code calls: `.select()` → `select`, `.insert()` → `insert`, `.update()`/`.delete()` → that plus `select`
(filters read columns), `.upsert()` → `select, insert, update`. Browser and SSR code counts as
`authenticated`, a client built with the service role key as `service_role`, and `anon` only gets what a
signed-out policy allows.

[`examples/grants-repro`](examples/grants-repro) replays this in real Postgres (PGlite): the 42501, the fix
grant taken straight from the finding, and the leak from `grant all` on a table with RLS off. The run is saved
in [`OUTPUT.txt`](examples/grants-repro/OUTPUT.txt); `npm run repro:grants` prints it again.

## Supabase breaking changes, Dec 2026

`--only breaking` runs just these two. Both point at the official note and print the replacement.

**Framework adapters, removed 2026-12-01.** `@supabase/server/adapters/{hono,h3,elysia,nestjs}`
[are deprecated](https://supabase.com/changelog/supabase-server-adapters-deprecated) and go away on
December 1, 2026. The replacement is a bridge file you copy from
[examples/frameworks](https://github.com/supabase/server/tree/main/examples/frameworks). The risky part of the
migration is the auth value: `auth: 'user'` has to become `withRequiredClaims()`. Using `withClaims()` instead
compiles fine and turns the 401 for anonymous callers into a 200. So the check reports every registration
with its auth value:

```
warning src/index.ts:7
        `withSupabase({ auth: "user" })` is auth: 'user'. Replace it with `toHono([withRequiredClaims(), withSupabaseClient()])` (not withClaims(), which lets anonymous requests through with a 200). [server-adapter-removed]
warning src/index.ts:9
        `withSupabase({ auth: "secret" })` is auth: 'secret'. Keep this endpoint on `withSupabase` from '@supabase/server'; apikey auth has no composable gate. [server-adapter-removed]
```

Reads of the adapters' nested `c.var.supabaseContext` are reported too, because the bridge entries
only set flat keys (`c.var.supabase`, `c.var.jwtClaims`) and a leftover read is `undefined`. It is a warning until the date and an error from it, so the default `--fail-on error` starts failing CI on
2026-12-01. `--today 2026-12-01` shows that result now.

**pg_cron's `cron.job` table.** Supabase
[blocks direct INSERT/UPDATE](https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed)
on it; jobs go through `cron.schedule`, `cron.schedule_in_database` and `cron.alter_job`. Migrations and seeds
that still write the table fail on a Supabase project.

```
warning supabase/migrations/20261105000000_cron_jobs.sql:7
        `update cron.job` writes the pg_cron table directly, which Supabase blocks; rewrite as `select cron.alter_job(jobid, schedule := '*/10 * * * *') from cron.job where jobname = 'refresh-stats';`. [cron-job-direct-write]
```

I ran both checks on public code before release. In a public
MIT-licensed Hono API on Cloudflare Workers (`@supabase/server` `^0.1.0`) it reports the Hono adapter import, the registration (written with the old `allow: "user"`
option, so the replacement is `withRequiredClaims()`) and the `supabaseContext` read in the next middleware.
Two other repos that depend on `@supabase/server` without the adapters, the `supabase/server` source (adapter
imports only in doc comments) and [splitPro](https://github.com/baz2024/splitPro) (38 SQL files, already on
`cron.schedule` / `cron.alter_job`) came back with nothing, which is right for all four.

[`examples/breaking-app`](examples/breaking-app) has both problems and
[`examples/breaking-app-fixed`](examples/breaking-app-fixed) is the same code migrated by the guide. The fixed
Hono and NestJS files typecheck against `@supabase/server` 1.9.2 and `@supabase/middleware` 1.0.0 with the
official bridge files copied in. PGlite can't load pg_cron, so the tests check the printed cron rewrites
against stub functions with pg_cron's documented signatures. That proves the SQL is valid and the arguments
bind. It doesn't prove anything about pg_cron itself.

## Options

```
-f, --format <text|json>              output format (default: text)
-e, --explain                         add why each finding matters and how to fix it
    --fail-on <error|warning|never>   exit 1 at this level or above (default: error)
    --only <group|rule,...>           run only these checks; groups: database, secrets, stripe, breaking, concurrency
    --skip <rule,rule>                turn checks off for this run
    --today <YYYY-MM-DD>              judge date-based checks as of this day (default: today, UTC)
    --list                            list the checks
```

Exit codes: `0` passed, `1` findings at or above `--fail-on`, `2` usage error. To silence a finding you
have checked, put `vibe-preflight-ignore <rule-id>` in a comment on its line or the line above (`--` in SQL,
`//` in JS/TS).

## How it works

- Walks the project (skipping `node_modules`, build output and files over 1 MB) and detects Next.js, Vite or
  Expo from `package.json`.
- Replays the `.sql` files in name order (tables, columns, policies, views, functions, grants and revokes,
  default privileges, triggers, `storage.buckets` inserts and updates) to get the final state of each object.
  Each `supabase/` folder in a monorepo is replayed on its own. Comments and `$$` function bodies are ignored. RLS checks only run when the
  project uses Supabase.
- Strips JS/TS comments before matching, so a commented-out `constructEvent` doesn't count.
- Asks `git ls-files` and `git check-ignore` about env files when the folder is in a git repo, and falls back
  to reading `.gitignore` when it isn't.

It reads files and calls `git`. It doesn't run your app or use the network. It is a static check: a clean
run doesn't mean an app is secure. Auth flows, business logic inside function bodies and anything created
only in the Supabase dashboard are out of its reach.

## Tested on

- [supabase-scanner-bench](https://github.com/atokim4/supabase-scanner-bench), a deliberately broken app with
  12 documented holes that I also run Supabase's splinter, pgrls and kelp on. Version 1.1.2 caught 5 of 12.
  The seven database checks added in 1.2.0 came out of that run, so on that bench the 1.2.0 numbers are
  not a fair comparison with the other tools.
- `examples/broken-app` (the six app-level checks fire once it has a `.env.local`, which the tests create) and
  `examples/fixed-app` (clean). Both are small made-up fixtures with placeholder values.
- Two public Supabase + Stripe starters, `vercel/nextjs-subscription-payments` and
  `KolbySisk/next-supabase-stripe-starter`: no errors. Each gets warnings for the public read policies on
  its `products` and `prices` tables, which are meant to be public.
- `makerkit/next-supabase-saas-kit-lite`: version 1.0.0 reported 7 errors there and all 7 were false
  positives (boolean `NEXT_PUBLIC_*PASSWORD*` flags, and committed env files holding only the Supabase local
  demo keys). 1.1.0 reports them as 3 warnings, and a test keeps real keys in such files an error.
- The 1.2.0 database checks on those three starters and `Razikus/supabase-nextjs-template` gave warnings only:
  `customers` tables with RLS on and no policies (server-only by design), `handle_new_user()` trigger
  functions without `search_path`, and a public avatar bucket. Each is accurate; whether it matters is your call.
- The 1.4.0 grant checks give nothing on the three starters above: their migrations predate 2026-10-30. On
  `supabase/supabase-js` they flag its test fixtures (a bulk `grant all on all tables in schema public` to anon
  over tables with RLS off or anon insert/delete policies). That is accurate for the fixtures, which are not
  meant to be secure.
- `stripe-webhook-parsed-body` (1.3.0) gives nothing on the two Stripe starters, which read the body with
  `req.text()`. After I changed one of them to `JSON.stringify(await req.json())` it reported that line.

## The paid kit

vibe-preflight is the free part of a bigger kit I sell on Gumroad, the
[Vibe App Production Kit](https://sunnatulladev.gumroad.com/l/vibe-app-production-kit) ($29). It has a
21-check scanner with checks this one doesn't have (`getSession()` trusted on the server, middleware that
blocks the Stripe webhook, the service role client without
`server-only`, ignored Supabase errors, and more), plus Claude Code and Cursor rules that keep the assistant
from writing these bugs in the first place. The checks here stay free and MIT.

If you'd rather not clone the repo, the same skill and scanner are a free download (pay what you want, $0 is fine) on
Gumroad: [vibe-preflight (free)](https://sunnatulladev.gumroad.com/l/vibe-preflight-free).

## Development

The scanner is written in TypeScript in `src/` and bundled with esbuild into
`skills/vibe-preflight/scripts/preflight.mjs`, which is committed so the skill works without a build step.
`npm run build` copies the same file into `supabase-rls-audit` and `stripe-webhook-security`, and a test
checks the copies match. The GitHub Action (`src/action/`, plus `src/sarif.ts` and `src/summary.ts`) is bundled
into `action/index.mjs` the same way and committed, since a JavaScript action runs straight from the repo.

```bash
npm install
npm run check          # typecheck, build, 135 Vitest tests
npm run action:local   # run action/index.mjs the way a runner does, on examples/broken-app
npm run repro:grants   # the PGlite grants repro (Node 22.18+)
```

`npm run action:local -- examples/fixed-app warning markdown` takes a path, `fail-on` and `format`. It sets the
`INPUT_*` variables and temporary `$GITHUB_OUTPUT` and `$GITHUB_STEP_SUMMARY` files, then prints what the
action wrote to them.

Tests are in `test/`: rule unit tests (`rules.test.ts`, `database.test.ts`, `grants.test.ts`), the example apps, the Dec 2026 breaking-change checks with the cron rewrites run against pg_cron-signature stubs in PGlite (`breaking.test.ts`), the PGlite
grants repro (`grants-repro.test.ts`, also checks `OUTPUT.txt` is current), git-tracked env files in a temporary repo,
the bundled CLI (exit codes, JSON, flags), the SARIF writer (`sarif.test.ts`), the job summary (`summary.test.ts`), the
bundled action with runner-style inputs (`action.test.ts`), the proposal linter copy (`proposal-lint.test.ts`) and the
SKILL.md frontmatter of every skill (`skills.test.ts`).
[`ci/self-test.yml`](ci/self-test.yml) is a workflow that runs `npm run check`, checks the committed bundles
match the source, and runs the action on both examples with the expected counts. It passes `actionlint`, and
every assertion in it was run locally against the action's output, but it isn't enabled on this repo yet;
copy it to `.github/workflows/` in a fork to run it there.

## License

MIT
