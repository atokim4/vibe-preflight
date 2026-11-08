import { afterAll, describe, expect, it } from "vitest";
import { at, cleanup, example, findings, ids } from "./helpers.ts";

afterAll(cleanup);

const broken = findings(example("broken-app"));
const fixed = findings(example("fixed-app"));

describe("examples/broken-app", () => {
  it("trips the six app-level checks", () => {
    expect(ids(broken)).toEqual([
      "env-file-committed",
      "public-env-secret",
      "rls-disabled",
      "rls-permissive-policy",
      "server-secret-in-client",
      "stripe-webhook-unverified",
    ]);
  });

  it("points at the exact lines, errors first", () => {
    expect(at(broken)).toEqual([
      "env-file-committed error .env.local:1",
      "stripe-webhook-unverified error src/app/api/stripe/webhook/route.ts:8",
      "server-secret-in-client error src/components/admin-notes.tsx:7",
      "public-env-secret error src/lib/stripe.ts:3",
      "rls-permissive-policy error supabase/migrations/20261101000000_init.sql:8",
      "rls-disabled error supabase/migrations/20261101000000_init.sql:14",
      "public-env-secret warning src/components/summarize-button.tsx:7",
      "rls-permissive-policy warning supabase/migrations/20261101000000_init.sql:11",
    ]);
  });
});

describe("examples/fixed-app", () => {
  it("is clean", () => {
    expect(fixed).toEqual([]);
  });
});
