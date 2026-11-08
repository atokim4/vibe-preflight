import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

// The upwork-proposal-lint skill ships a copy of the cover-letter-lint linter; these tests check that the copy runs.
const LINTER = join(ROOT, "skills/upwork-proposal-lint/scripts/lint-cover.mjs");
const lint = (text: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [LINTER, "--json", ...args, "-"], { input: text, encoding: "utf8" });
  return { code: r.status, report: JSON.parse(r.stdout) as { findings: { rule: string; severity: string }[] } };
};

const GOOD = `Hi,

A blank page after a successful payment plus orders missing in your admin usually means the webhook never
reaches Supabase, so the confirmation page has nothing to load. I'd check the webhook secret and the
success_url on Vercel, fix the handler and run a full test order in Stripe test mode. About 4 hours, $150
fixed. My checkout demo is a personal project I can show.

Did the problem start after a domain or deploy change?

Alex
`;

describe("upwork-proposal-lint linter", () => {
  it("passes a short, specific proposal (sample text)", () => {
    const r = lint(GOOD);
    expect(r.code).toBe(0);
    expect(r.report.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("fails template phrases, dashes, off-platform contact and placeholders", () => {
    const r = lint("Dear Sir, I hope this finds you well. I am excited to help — message me on WhatsApp at +1 555 123 4567. [Your Name]\n");
    expect(r.code).toBe(1);
    const errors = new Set(r.report.findings.filter((f) => f.severity === "error").map((f) => f.rule));
    expect([...errors].sort()).toEqual(["ai-phrase", "dash", "off-platform", "placeholder"]);
  });
});
