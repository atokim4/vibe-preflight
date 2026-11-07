---
name: vibe-preflight
description: Pre-launch security scan for Supabase + Stripe apps (Next.js, Vite, Expo; Lovable, Bolt, Cursor and Claude Code builds). Finds public tables without Row Level Security, `using (true)` policies, the service_role key in browser code, secrets in NEXT_PUBLIC_/VITE_/EXPO_PUBLIC_ variables, Stripe webhooks that skip signature checks, and .env files in git. Use before deploying, before making a repo public, when reviewing a vibe-coded or AI-generated app, or when the user asks "is my Supabase/Stripe app safe to launch?".
license: MIT
---

# vibe-preflight

A zero-dependency Node 20+ scanner ships in `scripts/preflight.mjs` next to this file. It reads the project's
files and asks `git` which of them are tracked. It doesn't run the app, install anything or use the network.
It reports six problems that keep
showing up in apps built quickly with AI tools.

## When to run it

- The user is about to deploy, launch, or open-source a project that uses Supabase and/or Stripe.
- You just wrote or changed Supabase migrations, RLS policies, env variables, or a Stripe webhook.
- The user asks for a security review of a Next.js / Vite / Expo app with Supabase.

Skip it for projects with neither Supabase nor Stripe; only the env checks would apply.

## How to run it

From the project root (replace `<skill-dir>` with this skill's folder):

```bash
node <skill-dir>/scripts/preflight.mjs . --format json
```

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

- Static checks only, six of them. A clean run doesn't mean the app is secure: storage bucket policies,
  auth flows, rate limits and business logic are out of scope.
- RLS checks read `.sql` files (Supabase migrations, `schema.sql`). Policies created only in the dashboard
  are invisible; suggest `supabase db pull` to get them into migrations.
- Silence a confirmed false positive with a `vibe-preflight-ignore <rule-id>` comment on the line or the line
  above it, and say why in the comment.
