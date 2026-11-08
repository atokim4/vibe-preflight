---
name: supabase-rls-audit
description: Audit Supabase Row Level Security from the migrations in a repo. Finds public tables without RLS, tables with RLS and no policies, `using (true)` / `with check (true)` policies, update policies that let users change their own plan/role/credits columns, views that skip RLS, views over `auth.users`, SECURITY DEFINER functions without a fixed search_path or callable by anon, and public storage buckets. Use when the user asks to check Supabase RLS or policies, before launching a Supabase app, after writing a migration, or when reviewing a Lovable, Bolt or Cursor build that uses Supabase.
license: MIT
---

# Supabase RLS audit

This skill runs the database part of the vibe-preflight scanner (`scripts/preflight.mjs` next to this file,
Node 20+, no dependencies, no network). It reads the `.sql` files in the project (Supabase migrations,
`schema.sql`), replays tables, policies, views, functions, grants and storage buckets in order, and reports
9 problems. It doesn't connect to a database.

## Run it

From the project root:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/preflight.mjs . --only database --format json
```

Claude Code fills in `${CLAUDE_SKILL_DIR}`. Other agents: use this skill's folder, e.g.
`.agents/skills/supabase-rls-audit` or `.claude/skills/supabase-rls-audit`.

Exit code `1` means at least one error. Add `--fail-on warning` to fail on warnings too, `--explain` (text
output) for why and how to fix each one. JSON: `{ summary: { error, warning }, findings: [{ rule, severity,
message, file, line }] }`.

If the result says `0 SQL files`, the policies probably live only in the dashboard. Ask the user to run
`supabase db pull` (it writes the remote schema into a migration) and scan again. Don't report the project as
clean from an empty scan.

## The checks

| Rule | Level | What it means |
|------|-------|---------------|
| `rls-disabled` | error | A `public` table never gets `enable row level security`, so anyone with the anon key can read and write it through the API. |
| `rls-permissive-policy` | error on write, warning on read | `using (true)` or `with check (true)`. On insert/update/delete any user can change other users' rows. On select every row is public. |
| `rls-no-policy` | warning | RLS on, no policies: the API denies everything. Fine for server-only tables; a silent empty list if the browser reads it. |
| `rls-update-privileged-column` | warning | Users may update their own row and it has `plan`, `role`, `is_admin`, `credits` or similar. RLS limits rows, not columns. |
| `view-bypasses-rls` | error | A view without `security_invoker = true` runs as its owner and skips RLS on the tables under it. |
| `auth-users-exposed` | error | A view in `public` selects from `auth.users`. |
| `definer-search-path` | warning | A `security definer` function without `set search_path`. |
| `definer-function-anon` | error / warning | A `security definer` function in `public` that anon can call at `/rest/v1/rpc/<name>`. Error with an explicit grant to anon, warning for Supabase's default grant. |
| `storage-public-bucket` | error / warning | A public bucket. Error when a select policy on `storage.objects` also lets anyone list it. |

## How to fix

Always write a **new** migration. Never edit one that already ran on a database.

Missing or permissive policies: ask what access the app needs, then scope each policy to a role and to the
owner.

```sql
alter table public.notes enable row level security;
create policy "notes: read own" on public.notes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "notes: insert own" on public.notes
  for insert to authenticated with check ((select auth.uid()) = user_id);
```

Privileged columns: allow updates only on the columns users may change.

```sql
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
```

Views: `alter view public.<name> set (security_invoker = true);` (Postgres 15+, all current Supabase
projects). A materialized view can't use RLS: move it out of `public` or revoke select from `anon,
authenticated`. For `auth.users`, copy the shareable fields into `public.profiles` with a sign-up trigger.

SECURITY DEFINER functions: add `set search_path = ''` and write every name with its schema. Then lock down
who can call it:

```sql
revoke execute on function public.admin_set_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_plan(uuid, text) to service_role;
```

Revoking from `public` alone isn't enough on Supabase, because anon has its own grant on new functions.

Storage: make private buckets private, scope reads to the owner's folder
(`(storage.foldername(name))[1] = (select auth.uid())::text`) and serve signed URLs. Product images and logos
can stay public.

A finding that is intended (a public catalogue, a server-only table) can be silenced with
`-- vibe-preflight-ignore <rule-id>` on the line or the line above it. Write why in the same comment.

## Reporting

1. Open each reported line and confirm it against the SQL before changing anything. The scanner reads SQL
   text and can be wrong; say so when it is.
2. Group the summary by rule. Errors first, then the warnings you confirmed with the user.
3. Run the scan again after the fix and report the new result.

## Limits

- Only what is in `.sql` files. Dashboard-only changes, other schemas and what a function does inside its
  body are not checked.
- A clean result means these 9 patterns weren't found. It doesn't prove the policies match the app's rules.
  Testing as a real anon and signed-in user (the Supabase client with the anon key) is still worth doing.
- For the browser and env side (service_role key in client code, secrets in `NEXT_PUBLIC_` variables,
  committed `.env`) run the full scan without `--only`, or use the `vibe-preflight` skill.
