import type { Finding, Project, Rule, SourceFile } from "../types.ts";
import { isClientFile, isTestFile } from "../context.ts";
import { lineAt, stripJsComments } from "../text.ts";

const EVENT_NAME = /["'`](checkout\.session\.completed|customer\.subscription\.[a-z_]+|invoice\.(?:paid|payment_succeeded|payment_failed)|payment_intent\.succeeded)["'`]/;
const VERIFIED = /\bconstructEvent(?:Async)?\s*\(/;
// Reading the header, not just naming it: a CORS helper that lists `stripe-signature` in Allow-Headers isn't a handler.
const READS_SIGNATURE = /headers(?:\(\))?\s*(?:\.get\s*\(\s*|\[\s*)["'`]stripe-signature["'`]/i;

/** Server files that receive Stripe webhooks. */
export function stripeWebhookFiles(project: Project): SourceFile[] {
  return project.files.filter((f) => {
    if (f.kind !== "source" || isTestFile(f) || isClientFile(project, f)) return false;
    const code = stripJsComments(f.text);
    const namesStripe = /stripe/i.test(code) || /stripe/i.test(f.path);
    // Stripe's event names are specific enough on their own; anything else needs "stripe" in the code or path,
    // so Clerk, Supabase or Lemon Squeezy webhooks aren't mistaken for Stripe ones.
    if (EVENT_NAME.test(code) && /\b(POST|handler|serve|Deno\.serve|export default)\b/.test(code)) return true;
    if (!namesStripe) return false;
    return READS_SIGNATURE.test(code) || (/webhook/i.test(f.path) && /\bevent\b/.test(code));
  });
}

export const webhookUnverified: Rule = {
  id: "stripe-webhook-unverified",
  severity: "error",
  title: "Stripe webhook that doesn't verify the signature",
  why: "Without `stripe.webhooks.constructEvent`, anyone who finds the URL can POST a fake `checkout.session.completed` and get the paid plan for free.",
  fix: "Read the raw body (`await request.text()`), then call `stripe.webhooks.constructEvent(body, request.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)` and answer 400 when it throws. In Deno / edge runtimes use `await constructEventAsync(…)`.",
  check(project) {
    return stripeWebhookFiles(project)
      .filter((f) => !VERIFIED.test(stripJsComments(f.text)))
      .map((f) => {
        const m = EVENT_NAME.exec(f.text) ?? /stripe/i.exec(f.text);
        return {
          rule: this.id,
          severity: this.severity,
          message: "Handles Stripe events without `constructEvent`, so any POST is trusted.",
          file: f.path,
          line: m ? lineAt(f.text, m.index) : 1,
        };
      });
  },
};

const CONSTRUCT_EVENT = /\bconstructEvent(?:Async)?\s*\(\s*/g;
const PARSED_JSON = /\b(?:req|request|c\.req|ctx\.request)\.json\s*\(/;
const JSON_BODY_PARSER = /\b(?:express|bodyParser)\.json\s*\(/;
const RAW_BODY_PARSER = /\b(?:express|bodyParser)\.raw\s*\(/;

export const webhookParsedBody: Rule = {
  id: "stripe-webhook-parsed-body",
  severity: "warning",
  title: "Stripe signature checked against a parsed body",
  why: "Stripe signs the exact bytes it sent. A body that was parsed and serialized again never matches, so every real event fails with 400, and the usual quick fix people reach for is deleting the check.",
  fix: "Pass the raw body to `constructEvent`: `await request.text()` in route handlers and edge functions, `express.raw({ type: 'application/json' })` on the webhook route before any `express.json()`, and `export const config = { api: { bodyParser: false } }` plus a raw buffer in a Next.js pages/api route.",
  check(project) {
    const jsonParserApp = project.files.some((f) => f.kind === "source" && JSON_BODY_PARSER.test(stripJsComments(f.text)));
    const rawParserApp = project.files.some((f) => f.kind === "source" && RAW_BODY_PARSER.test(stripJsComments(f.text)));
    const out: Finding[] = [];
    for (const f of stripeWebhookFiles(project)) {
      const code = stripJsComments(f.text);
      const add = (offset: number, message: string) =>
        out.push({ rule: this.id, severity: this.severity, message, file: f.path, line: lineAt(f.text, offset) });
      const calls = [...code.matchAll(CONSTRUCT_EVENT)];
      if (!calls.length) continue;
      const json = PARSED_JSON.exec(code);
      if (json) add(json.index, "Reads the webhook body with `.json()` and then checks the signature, which needs the raw text.");
      for (const call of calls) {
        const arg = code.slice(call.index + call[0].length);
        const at = call.index;
        if (/^JSON\.stringify\s*\(/.test(arg)) add(at, "`constructEvent` gets `JSON.stringify(...)` of a parsed body, so the signature never matches.");
        else if (/^req\.body\b(?!\s*\.)/.test(arg)) {
          if (/(^|\/)pages\/api\//.test(f.path) && !/\bbodyParser\s*:\s*false\b/.test(code))
            add(at, "`req.body` in a pages/api route is already parsed JSON unless the route sets `bodyParser: false`.");
          else if (jsonParserApp && !rawParserApp)
            add(at, "`req.body` comes from `express.json()` and no `express.raw()` is set up, so it isn't the raw body.");
        }
      }
    }
    return out;
  },
};
