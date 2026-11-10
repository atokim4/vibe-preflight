# breaking-app (sample data)

A made-up Hono + NestJS API on Supabase, frozen just before two breaking changes:

- It imports the `@supabase/server` framework adapters, which Supabase removes on 2026-12-01
  ([changelog](https://supabase.com/changelog/supabase-server-adapters-deprecated)).
- Its migration and seed write pg_cron's `cron.job` table directly, which Supabase blocks
  ([changelog](https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed)).

It is a test fixture, not a running app. `breaking-app-fixed/` is the same code after the migration.

```bash
node ../../skills/vibe-preflight/scripts/preflight.mjs . --only breaking
node ../../skills/vibe-preflight/scripts/preflight.mjs . --only breaking --today 2026-12-01   # what CI says from Dec 1
```
