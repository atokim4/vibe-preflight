import type { Project, Rule, SourceFile } from "../types.ts";
import { isClientFile, isTestFile } from "../context.ts";
import { lineAt, stripJsComments } from "../text.ts";

const EVENT_NAME = /["'`](checkout\.session\.completed|customer\.subscription\.[a-z_]+|invoice\.(?:paid|payment_succeeded|payment_failed)|payment_intent\.succeeded)["'`]/;
const VERIFIED = /\bconstructEvent(?:Async)?\s*\(/;

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
    return /stripe-signature/i.test(code) || (/webhook/i.test(f.path) && /\bevent\b/.test(code));
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
