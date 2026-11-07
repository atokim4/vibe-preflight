# broken-app (sample data)

A tiny, made-up Next.js + Supabase + Stripe notes app with the six mistakes vibe-preflight looks for.
It is a test fixture, not a working app. All keys and URLs are fake placeholders.

The repo leaves out the app's `.env.local` (committing one is what `env-file-committed` catches). The tests
write it into a temporary copy with placeholder values; to see that check fire here, create one yourself:

```bash
echo "SUPABASE_SERVICE_ROLE_KEY=placeholder" > .env.local
```

`fixed-app/` is the same app with every finding fixed.
