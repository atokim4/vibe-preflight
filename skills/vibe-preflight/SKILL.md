---
name: vibe-preflight
description: Pre-launch security scan for Supabase + Stripe apps (Next.js, Vite, Expo; Lovable, Bolt, Cursor and Claude Code builds). Finds public tables without Row Level Security, `using (true)` policies, user-editable plan/role columns, views and SECURITY DEFINER functions that skip RLS, `auth.users` exposed through a view, public storage buckets, missing or leaking Data API grants after Supabase's 2026-10-30 change (42501 permission denied for table), the service_role key in browser code, secrets in NEXT_PUBLIC_/VITE_/EXPO_PUBLIC_ variables, Stripe webhooks that skip signature checks or check them against a parsed body, .env files in git, imports of the @supabase/server framework adapters (Hono, H3, Elysia, NestJS) that Supabase removes on 2026-12-01, and direct INSERT/UPDATE on pg_cron's cron.job table. Use before deploying, before making a repo public, when reviewing a vibe-coded or AI-generated app, or when the user asks "is my Supabase/Stripe app safe to launch?".
license: MIT
---

# vibe-preflight

A zero-dependency Node 20+ scanner ships in `scripts/preflight.mjs` next to this file. It reads the project's
files and asks `git` which of them are tracked. It doesn't run the app, install anything or use the network.
It reports 19 problems that keep showing up in apps built quickly with AI tools, two of them Supabase
breaking changes.

## When to run it

- The user is about to deploy, launch, or open-source a project that uses Supabase and/or Stripe.
- You just wrote or changed Supabase migrations, RLS policies, env variables, or a Stripe webhook.
- The user asks for a security review of a Next.js / Vite / Expo app with Supabase.

Skip it for projects with neither Supabase nor Stripe; only the env checks would apply.

## How to run it

From the project root:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/preflight.mjs . --format json
```

Claude Code fills in `${CLAUDE_SKILL_DIR}` (also for a plugin install). In other agents use this skill's
folder instead, e.g. `.agents/skills/vibe-preflight` or `.claude/skills/vibe-preflight`.

Use `--format json` when you will read the result yourself, plain text (`--explain` adds why + fix) when you
show it to the user. Exit code: `0` no errors, `1` errors found, `2` bad arguments. Other flags:
`--fail-on warning|never`, `--only database|secrets|stripe|breaking|<rule>`, `--today YYYY-MM-DD` (judge date-based checks as of
that day, e.g. `--today 2026-12-01` to see what fails after the adapter removal), `--skip <rule,rule>`, `--list`.

JSON shape: `{ summary: { error, warning }, findings: [{ rule, severity, message, file, line }] }`.

## How to read the findings

1. Fix every `error` before launch. Treat `warning` as "confirm with the user": it is often fine.
2. Open the file at the reported line and confirm the finding against the real code before you change
   anything. The scanner is pattern-based and can be wrong; say so when it is.
3. Group your summary by rule, not by file, and tell the user which keys must be rotated (a key that was
   ever exposed or committed stays compromised after the code is fixed).
4. Run the scanner again after fixing. Report what it says now.

## How to fix each check

### `rls-disabled` (error)
A table in `public` is created without `enable row level security` in any migration. Supabase serves it
through the REST API to anyone with the anon key, which is public.

Write a **new** migration (never edit one that already ran):

```sql
alter table public.notes enable row level security;
create policy "notes: read own" on public.notes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "notes: insert own" on public.notes
  for insert to authenticated with check ((select auth.uid()) = user_id);
```

Ask which access the app needs before writing policies. A table that only the server touches can keep RLS
on with no policies at all.

### `rls-permissive-policy` (error on write, warning on read)
`using (true)` / `with check (true)`, usually from the dashboard templates. On insert/update/delete it lets
a user write other users' rows: replace `true` with an ownership check as above and scope it
`to authenticated`. On select it shows every row to everyone: fine for a public catalogue or blog, so ask.
If it is intended, add `-- vibe-preflight-ignore rls-permissive-policy` on the line above the policy.

### `rls-no-policy` (warning)
RLS is on and the table has no policies, so the API denies every request. Fine for a table only the server
(service role) touches. If the app reads it from the browser, the query returns an empty list with no
error: add the narrowest policy that fits, or ignore the finding for a server-only table.

### `rls-update-privileged-column` (warning)
Users may update their own row, and the row has a column such as `plan`, `role`, `is_admin` or `credits`.
An RLS policy limits rows, not columns, so a user can send `update profiles set plan = 'pro'` with their own
key. Limit the writable columns:

```sql
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
```

Or move the column to a table users can't write. Change it only on the server after a verified payment.

### `view-bypasses-rls` (error)
A view runs as its owner, which on Supabase skips RLS, so a view over a locked-down table returns every
user's rows. On Postgres 15+ (all current Supabase projects): `alter view public.<name> set (security_invoker = true);`.
A materialized view can't use RLS: move it out of `public` or revoke select from `anon, authenticated`.

### `auth-users-exposed` (error)
A view in `public` selects from `auth.users` (emails, phones, sign-in data) and the API serves it. Keep
shareable fields in `public.profiles` filled by a sign-up trigger, and drop the view or revoke select on it
from `anon, authenticated`.

### `definer-search-path` (warning)
A `security definer` function without a fixed `search_path` can resolve unqualified names to objects the
caller controls. Add `set search_path = ''` and write every name with its schema (`public.profiles`).

### `definer-function-anon` (error / warning)
A `security definer` function in `public` that anon can call at `/rest/v1/rpc/<name>`. It runs with its
owner's rights, so anyone with the anon key gets what it does. On Supabase anon has its own EXECUTE grant
on new functions, so revoking from `public` alone isn't enough:

```sql
revoke execute on function public.admin_set_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_plan(uuid, text) to service_role;
```

If signed-in users must call it, grant it to `authenticated` and check `auth.uid()` inside the body.

### `storage-public-bucket` (error / warning)
Files in a public bucket download for anyone with the URL. It is an error when a select policy on
`storage.objects` that isn't scoped to the user also lets anyone list the bucket. For private files make the
bucket private, scope reads to the owner's folder (`(storage.foldername(name))[1] = (select auth.uid())::text`)
and serve signed URLs. Logos and product images can stay public: ignore the finding with a comment.

### `grant-leak` (error)
A grant to anon or authenticated reaches a table with RLS off, or one whose write policy is `true`. This is
the usual AI answer to a 42501 (`grant all on public.notes to anon`). Undo it with a new migration:
`revoke all on public.<name> from anon, authenticated;`, enable RLS, add owner policies, then grant only the
commands the app uses (`grant select, insert on public.<name> to authenticated;`).

### `grants-missing` (warning)
Since 2026-10-30 Supabase doesn't grant new `public` tables to the Data API roles, so `.from('<table>')` fails
with 42501 `permission denied for table`. The finding prints the minimal grant for what the code calls
(`update`/`delete` include `select`, serial columns add the sequence). Grant `anon` only data meant for
signed-out visitors. If RLS is off, turn it on before granting.

### `grant-broad` (warning)
`grant … on all tables in schema public to anon, authenticated` or `alter default privileges … grant … on
tables` opens every table again. Replace it with per-table grants next to each `create table`.

### `server-secret-in-client` (error)
Browser code uses `SUPABASE_SERVICE_ROLE_KEY` (or the literal `'service_role'`, a Supabase secret key, or a
Stripe secret). The service role skips all RLS. Browser code means a `"use client"` file in Next.js, and
everything under `src/` in a Vite or Expo app.

Move the privileged call to the server: a Next.js route handler or server action, or a Supabase Edge
Function. The browser calls that endpoint and keeps using the anon key. Add `import "server-only";` to the
module that creates the admin client. Tell the user to rotate the key if it was ever deployed.

### `public-env-secret` (error / warning)
A secret-looking name has a browser prefix (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`), so its value is baked
into the JavaScript bundle. Rename it without the prefix, read it only in server code, update
`.env.example` and the host's env settings, and rotate the value. Warnings are generic `*_API_KEY` names:
publishable keys are fine, paid API keys (OpenAI, Resend…) are not, so check which one it is.

### `stripe-webhook-unverified` (error)
A webhook handler acts on Stripe events without `stripe.webhooks.constructEvent`, so anyone can POST a fake
`checkout.session.completed`. Verify against the raw body:

```ts
const body = await request.text(); // raw body, not request.json()
const signature = request.headers.get("stripe-signature");
if (!signature) return new Response("Missing signature", { status: 400 });
let event: Stripe.Event;
try {
  event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
} catch {
  return new Response("Invalid signature", { status: 400 });
}
```

In Supabase Edge Functions (Deno) use
`await stripe.webhooks.constructEventAsync(body, signature, secret, undefined, Stripe.createSubtleCryptoProvider())`.

### `stripe-webhook-parsed-body` (warning)
The handler verifies the signature, but against a body that was already parsed (`req.json()`,
`JSON.stringify(...)`, `req.body` from `express.json()` or a pages/api route with the default body parser).
Stripe signs the exact bytes it sent, so every real event fails. Use `await request.text()`; in Express
register the route with `express.raw({ type: "application/json" })` before `express.json()`; in pages/api
set `export const config = { api: { bodyParser: false } }` and read the raw request. For a deeper webhook
review (replay, idempotency, event order) use the `stripe-webhook-security` skill if it's installed.

### `env-file-committed` (error)
An env file with values is tracked by git, or git doesn't ignore it. Add `.env*` and `!.env.example` to
`.gitignore`; for a tracked file run `git rm --cached <file>` and commit. Removing it does not remove it
from history, so every key in it must be rotated. Don't rewrite git history yourself; offer the steps.

### `server-adapter-removed` (warning until 2026-12-01, error from then)
The code imports `@supabase/server/adapters/hono`, `/h3`, `/elysia` or `/nestjs`. Supabase
[removes them on 2026-12-01](https://supabase.com/changelog/supabase-server-adapters-deprecated); after
that an install or a Dependabot bump breaks the import. Follow the official guide,
[Moving off the adapters](https://supabase.com/docs/reference/server/frameworks#moving-off-the-adapters),
in its order:

1. Versions: `@supabase/server` 1.6.0 or later, Node 22 or later. The finding says when `package.json` allows
   an older `@supabase/server` or lacks `@supabase/middleware`.
2. Inventory first. The scanner reports each `withSupabase(...)` registration with its `auth` value (old code
   may say `allow`: `'always'` was `'none'`, `'public'` was `'publishable'`); show the user that list before
   editing. A list like `['user', 'none']` is reported as not one literal; decide that one with the user.
3. Replace by auth value. `auth: 'user'` or a bare `withSupabase()` becomes `withRequiredClaims()`;
   `auth: 'none'` gets no gate; `auth: 'publishable'` and `auth: 'secret'` stay on `withSupabase` from
   `@supabase/server` (no composable gate exists, don't hand-roll a key check). Never use `withClaims()` for
   `auth: 'user'`: it lets anonymous requests through with `jwtClaims: null` and a 200.
4. `npm install @supabase/middleware`, then copy the bridge for the framework from
   [examples/frameworks](https://github.com/supabase/server/tree/main/examples/frameworks) as is, comments
   included (`hono/supabase-middleware.ts`, `h3/…`, `elysia/…`, `nestjs/supabase.guard.ts`).

```ts
// Before
import { withSupabase } from '@supabase/server/adapters/hono'
app.use('*', withSupabase({ auth: 'user' }))
// After
import { withRequiredClaims } from '@supabase/server/middleware/required-claims'
import { withSupabaseClient } from '@supabase/server/middleware/client'
import { toHono } from './lib/supabase-middleware.js'
app.use('*', toHono([withRequiredClaims(), withSupabaseClient()]))
```

5. Call sites: `c.var.supabaseContext.supabase` → `c.var.supabase` (same for `event.context`, the Elysia
   context and `req`). `userClaims` is gone: `userClaims.id` → `jwtClaims.sub`, `.appMetadata` →
   `.app_metadata`, `.userMetadata` → `.user_metadata`. Rewrite each read; a blanket rename leaves `.id`
   undefined in plain JS. The scanner reports every `supabaseContext` read it finds, migrated or not. On Hono, give each entry array its own sub-app mounted with `app.route()`.
6. Verify: typecheck, then for every endpoint that was `auth: 'user'` prove a request without a token still
   gets 401. A passing typecheck doesn't show that. The 401 body is now `{ message, code }`.

### `cron-job-direct-write` (warning)
A migration or `seed.sql` runs `insert into cron.job` or `update cron.job`. Supabase
[blocks direct writes](https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed)
to pg_cron's table, so the migration fails on a Supabase project. The finding prints the rewrite when the
statement is simple enough to translate exactly:

```sql
-- insert into cron.job (jobname, schedule, command) values ('purge', '0 3 * * *', 'select 1');
select cron.schedule('purge', '0 3 * * *', 'select 1');   -- a name that exists is updated, so reruns are safe
-- update cron.job set schedule = '*/10 * * * *' where jobname = 'refresh-stats';
select cron.alter_job(jobid, schedule := '*/10 * * * *') from cron.job where jobname = 'refresh-stats';
```

Inside a DO block or a plpgsql function use `perform` instead of `select`. Another database or user:
`cron.schedule_in_database(job_name, schedule, command, database, username, active)`. Renaming a job has no
`alter_job` parameter: `cron.unschedule('<old>')` then `cron.schedule('<new>', …)`. Don't edit a migration
that already ran on production; add a new one.

## Limits (tell the user when it matters)

- Static checks only, 19 of them. A clean run doesn't mean the app is secure: auth flows, rate limits,
  business logic and what happens inside function bodies are out of scope.
- RLS checks read `.sql` files (Supabase migrations, `schema.sql`). Policies created only in the dashboard
  are invisible; suggest `supabase db pull` to get them into migrations.
- Silence a confirmed false positive with a `vibe-preflight-ignore <rule-id>` comment on the line or the line
  above it, and say why in the comment.
