---
name: vibe-preflight
description: Pre-launch security scan for Supabase + Stripe apps (Next.js, Vite, Expo; Lovable, Bolt, Cursor and Claude Code builds). Finds public tables without Row Level Security, `using (true)` policies, user-editable plan/role columns, views and SECURITY DEFINER functions that skip RLS, `auth.users` exposed through a view, public storage buckets, the service_role key in browser code, secrets in NEXT_PUBLIC_/VITE_/EXPO_PUBLIC_ variables, Stripe webhooks that skip signature checks, and .env files in git. Use before deploying, before making a repo public, when reviewing a vibe-coded or AI-generated app, or when the user asks "is my Supabase/Stripe app safe to launch?".
license: MIT
---

# vibe-preflight

A zero-dependency Node 20+ scanner ships in `scripts/preflight.mjs` next to this file. It reads the project's
files and asks `git` which of them are tracked. It doesn't run the app, install anything or use the network.
It reports 13 problems that keep
showing up in apps built quickly with AI tools.

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
`--fail-on warning|never`, `--skip <rule,rule>`, `--list`.

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

### `env-file-committed` (error)
An env file with values is tracked by git, or git doesn't ignore it. Add `.env*` and `!.env.example` to
`.gitignore`; for a tracked file run `git rm --cached <file>` and commit. Removing it does not remove it
from history, so every key in it must be rotated. Don't rewrite git history yourself; offer the steps.

## Limits (tell the user when it matters)

- Static checks only, 13 of them. A clean run doesn't mean the app is secure: auth flows, rate limits,
  business logic and what happens inside function bodies are out of scope.
- RLS checks read `.sql` files (Supabase migrations, `schema.sql`). Policies created only in the dashboard
  are invisible; suggest `supabase db pull` to get them into migrations.
- Silence a confirmed false positive with a `vibe-preflight-ignore <rule-id>` comment on the line or the line
  above it, and say why in the comment.
