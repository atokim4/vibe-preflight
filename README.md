# vibe-preflight

An Agent Skill for Claude Code, Codex and other coding agents that checks a Supabase + Stripe app for 14
common launch blockers before you deploy it. It ships with a small Node scanner (one file, no dependencies)
that the agent runs, and instructions telling the agent how to read each finding and fix it.

![vibe-preflight output on the sample broken app](media/output.png)

I built this as a personal project. The checks cover mistakes that are common in Next.js and Vite apps
generated with AI tools: RLS left off, template policies, views and functions that skip RLS, public buckets,
the service role key in the browser, and Stripe webhooks that trust any POST.

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
npx skills add atokim4/vibe-preflight --skill vibe-preflight            # all 14 checks
npx skills add atokim4/vibe-preflight --skill supabase-rls-audit        # the 9 database checks
npx skills add atokim4/vibe-preflight --skill stripe-webhook-security   # the 2 Stripe checks + a review list
npx skills add atokim4/vibe-preflight --skill upwork-proposal-lint      # proposal linter, unrelated to security
```

| Skill | What it does |
|---|---|
| `vibe-preflight` | Runs every check below and fixes what it finds |
| `supabase-rls-audit` | Runs `--only database`: RLS, policies, views, SECURITY DEFINER functions, storage buckets |
| `stripe-webhook-security` | Runs `--only stripe`, then reviews the handler for raw body, replay tolerance, idempotency, event order and the webhook secret (the review part is reading code, not scanning) |
| `upwork-proposal-lint` | Writes or checks an Upwork proposal with a copy of the linter from [cover-letter-lint](https://github.com/atokim4/cover-letter-lint): AI phrases, dashes, off-platform contact, placeholders, word count, claims not in your facts file |

The two security skills carry their own copy of the same scanner, so each works when installed alone.

Then ask your agent something like "run vibe-preflight before we deploy". You can also run the scanner
yourself, with Node 20 or newer:

```bash
node .claude/skills/vibe-preflight/scripts/preflight.mjs path/to/app
```

(the folder depends on the agent you installed the skill for).

## The 14 checks

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
| `server-secret-in-client` | error | `SUPABASE_SERVICE_ROLE_KEY`, `'service_role'` or a Stripe secret in browser code (`"use client"` files in Next.js, `src/` in Vite/Expo) |
| `public-env-secret` | error / warning | Secret-looking names behind `NEXT_PUBLIC_`, `VITE_` or `EXPO_PUBLIC_` (boolean flags such as `NEXT_PUBLIC_AUTH_PASSWORD=true` are skipped) |
| `stripe-webhook-unverified` | error | A webhook handler that acts on Stripe events without `constructEvent` / `constructEventAsync` |
| `stripe-webhook-parsed-body` | warning | `constructEvent` gets a body that was already parsed: `req.json()`, `JSON.stringify(...)`, `req.body` in pages/api without `bodyParser: false`, or `req.body` behind `express.json()` with no `express.raw()` |
| `env-file-committed` | error / warning | An `.env*` file with values that git tracks or doesn't ignore. Warning only when it holds just the Supabase CLI's local demo keys or just public variables |

`SKILL.md` explains each one with the fix. The scanner also prints the why and the fix with `--explain`.

## Options

```
-f, --format <text|json>              output format (default: text)
-e, --explain                         add why each finding matters and how to fix it
    --fail-on <error|warning|never>   exit 1 at this level or above (default: error)
    --only <group|rule,...>           run only these checks; groups: database, secrets, stripe
    --skip <rule,rule>                turn checks off for this run
    --list                            list the checks
```

Exit codes: `0` passed, `1` findings at or above `--fail-on`, `2` usage error. To silence a finding you
have checked, put `vibe-preflight-ignore <rule-id>` in a comment on its line or the line above (`--` in SQL,
`//` in JS/TS).

## How it works

- Walks the project (skipping `node_modules`, build output and files over 1 MB) and detects Next.js, Vite or
  Expo from `package.json`.
- Replays the `.sql` files in name order (tables, columns, policies, views, functions, grants and revokes,
  triggers, `storage.buckets` inserts and updates) to get the final state of each object. Comments and `$$` function bodies are ignored. RLS checks only run when the
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
checks the copies match.

```bash
npm install
npm run check   # typecheck, build, 64 Vitest tests
```

Tests are in `test/`: rule unit tests (`rules.test.ts`, `database.test.ts`), the two example apps, git-tracked env files in a temporary repo, and
the bundled CLI (exit codes, JSON, flags), the proposal linter copy (`proposal-lint.test.ts`) and the SKILL.md frontmatter of every skill (`skills.test.ts`).

## License

MIT
