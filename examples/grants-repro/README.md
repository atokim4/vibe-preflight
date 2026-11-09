# grants-repro

Supabase's 2026-10-30 grants change, replayed in real Postgres with [PGlite](https://pglite.dev) (Postgres
compiled to WebAssembly, runs in-process). Sample data only.

- `app/` is a tiny made-up Vite + supabase-js app. `todos` is created after the change with RLS and owner
  policies but no grant. `notes` has RLS off, and a later migration "fixes" its 42501 with
  `grant all on public.notes to anon, authenticated`.
- `supabase-bootstrap.sql` recreates the parts of a Supabase database the repro needs: the `anon`,
  `authenticated` and `service_role` roles, `auth.uid()`, the old automatic grants, and the revoke from the
  changelog.
- `repro.ts` scans `app/`, applies the migrations, and runs the SQL PostgREST would run for the app's
  supabase-js calls as `anon` or a signed-in sample user. The fix for `todos` is the exact grant the
  `grants-missing` finding printed.

```bash
npm run repro:grants   # from the repo root, Node 22.18+
```

[`OUTPUT.txt`](OUTPUT.txt) is a saved run. `test/grants-repro.test.ts` runs it again and checks every result
and that `OUTPUT.txt` still matches.
