# breaking-app-fixed (sample data)

`breaking-app/` after both migrations, written from the official guides:

- Hono and NestJS moved off `@supabase/server/adapters/*` onto the bridges, following
  [Moving off the adapters](https://supabase.com/docs/reference/server/frameworks#moving-off-the-adapters).
  `auth: 'user'` became `withRequiredClaims()`, `auth: 'none'` lost its gate, and the `auth: 'secret'` route
  stayed on `withSupabase` from `@supabase/server`. `userClaims.id` became `jwtClaims.sub`.
- pg_cron jobs go through `cron.schedule`, `cron.schedule_in_database` and `cron.alter_job`.

The bridge files are not committed (see `src/lib/README.md`). With them copied in, `src/index.ts` and
`src/games.controller.ts` typecheck against `@supabase/server` 1.9.2, `@supabase/middleware` 1.0.0, Hono 4.13
and NestJS 11.2. vibe-preflight reports nothing here.
