import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { scan } from "../src/scan.ts";
import { markdownSummary } from "../src/summary.ts";
import { EXAMPLES } from "./helpers.ts";

const broken = () => scan(join(EXAMPLES, "broken-app"));

describe("markdownSummary", () => {
  it("has a totals line, one table row per finding and the fix of each check that fired", () => {
    const md = markdownSummary(broken(), { pathPrefix: "examples/broken-app" });
    expect(md).toContain("**5 errors, 4 warnings** in `examples/broken-app` (17 checks ran).");
    expect(md).toContain("| Severity | Check | Location | Finding |");
    expect(md.split("\n").filter((l) => /^\| (error|warning) \|/.test(l))).toHaveLength(9);
    expect(md).toContain("| error | `rls-disabled` | `examples/broken-app/supabase/migrations/20261101000000_init.sql:14` |");
    expect(md).toContain("<code>stripe-webhook-unverified</code>");
    expect(md).toContain("**Fix:** Read the raw body");
    expect(md.match(/<details>/g)).toHaveLength(6);
  });

  it("links locations to the commit when the blob URL is known", () => {
    const md = markdownSummary(broken(), { blobUrl: "https://github.com/o/r/blob/abc123/" });
    expect(md).toContain("[`src/lib/stripe.ts:3`](https://github.com/o/r/blob/abc123/src/lib/stripe.ts#L3)");
  });

  it("escapes pipes in messages so the table keeps its columns", () => {
    const r = broken();
    r.findings = [{ ...r.findings[0]!, message: "a | b\nc" }];
    expect(markdownSummary(r)).toContain("| a \\| b c |");
  });

  it("cuts long tables and says how many rows are missing", () => {
    const md = markdownSummary(broken(), { maxRows: 2 });
    expect(md.split("\n").filter((l) => /^\| (error|warning) \|/.test(l))).toHaveLength(2);
    expect(md).toContain("7 more not shown.");
  });

  it("says the checks passed when there is nothing to report", () => {
    expect(markdownSummary(scan(join(EXAMPLES, "fixed-app")))).toBe("## vibe-preflight 1.5.0\n\nNo findings: 17 checks passed.\n");
  });
});
