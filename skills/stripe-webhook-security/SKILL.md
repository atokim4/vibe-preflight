---
name: stripe-webhook-security
description: Check and fix a Stripe webhook endpoint. Scans for handlers that act on Stripe events without `constructEvent` signature verification and for signatures checked against a parsed body (`req.json()`, `JSON.stringify`, `express.json()`, a pages/api route with the default body parser), then walks through raw body, idempotency, replay and secret handling. Use when the user writes or reviews a Stripe webhook, asks "is my Stripe webhook secure", gets "No signatures found matching the expected signature", or before launching an app that takes payments.
license: MIT
---

# Stripe webhook security

This skill runs the Stripe part of the vibe-preflight scanner (`scripts/preflight.mjs` next to this file,
Node 20+, no dependencies, no network). It finds webhook handlers in Next.js route handlers, pages/api,
Express and Supabase Edge Functions and checks two things in code. The rest of this page is a review you do by
reading the handler, because a pattern scan can't prove it.

## 1. Run the scan

From the project root:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/preflight.mjs . --only stripe --fail-on warning --format json
```

Claude Code fills in `${CLAUDE_SKILL_DIR}`. Other agents: use this skill's folder, e.g.
`.agents/skills/stripe-webhook-security` or `.claude/skills/stripe-webhook-security`.

| Rule | Level | What it means |
|------|-------|---------------|
| `stripe-webhook-unverified` | error | The handler acts on Stripe events and never calls `constructEvent` / `constructEventAsync`. Anyone who finds the URL can POST a fake `checkout.session.completed`. |
| `stripe-webhook-parsed-body` | warning | The signature is checked, but against a body that was already parsed. Stripe signs the exact bytes it sent, so real events fail with 400 and someone ends up deleting the check. |

`--only stripe` finds a handler by Stripe event names, a read of the `stripe-signature` header, or a webhook
path in a file that mentions Stripe. If it reports `0 errors` but the user knows they have a webhook, find
the handler yourself and do the review below anyway.

## 2. Fix verification

Route handler (Next.js App Router, Remix, Hono and other fetch-style handlers):

```ts
export async function POST(request: Request) {
  const body = await request.text(); // raw body, never request.json()
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }
  // handle event
  return Response.json({ received: true });
}
```

Express: register the webhook route with `express.raw({ type: "application/json" })` **before**
`app.use(express.json())`, and pass `req.body` (a Buffer then) to `constructEvent`.

Next.js pages/api: `export const config = { api: { bodyParser: false } };` and read the raw request into a
Buffer before verifying.

Supabase Edge Functions and other Deno / edge runtimes:
`await stripe.webhooks.constructEventAsync(body, signature, secret, undefined, Stripe.createSubtleCryptoProvider())`.

## 3. Review the rest by reading the handler

The scanner doesn't check these. Look at the code and tell the user what you found for each one.

- **Secret.** `STRIPE_WEBHOOK_SECRET` (`whsec_...`) comes from server env, never from a `NEXT_PUBLIC_` /
  `VITE_` variable or the source. Test mode and live mode have different secrets, and so does each endpoint
  and the `stripe listen` CLI.
- **Replay.** `constructEvent` rejects a signature older than its tolerance (300 seconds by default). Leave
  the tolerance argument out, or keep it small. Never catch the error and carry on.
- **Idempotency.** Stripe can deliver the same event more than once. Either make the write naturally
  repeatable (an upsert keyed by the Stripe id, setting a status rather than adding credits) or store
  `event.id` in a table with a unique constraint and skip ids you have seen. Look hard at anything that adds:
  credits, balance, stock.
- **Order.** Events can arrive out of order. For subscriptions, fetch the current object from the API
  (`stripe.subscriptions.retrieve`) or compare timestamps instead of trusting the order of events.
- **Trust.** Take the user and plan from the verified event (`client_reference_id`, `metadata`, the
  customer id you stored at checkout), never from a query string or a second unsigned request. The success
  page redirect proves nothing: grant access from the webhook.
- **Response.** Return 2xx quickly once the event is stored or handled. Slow work goes to a queue. Return
  400 only for a bad signature, so Stripe's retries stay meaningful.
- **Event list.** Subscribe the endpoint only to the events the code handles, and ignore other types
  without an error.

## 4. Report

List the scanner findings, then one line per review item: fine, fixed, or a question for the user (for
example "credits are added on every delivery: should a repeated event add them again?"). Run the scan again
after the fix and show its last line. To test for real, suggest `stripe listen --forward-to
localhost:3000/api/webhooks` and `stripe trigger checkout.session.completed` with the Stripe CLI.

A confirmed false positive can be silenced with `// vibe-preflight-ignore <rule-id>` on the line or the
line above it, with the reason in the comment.
