import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { scan } from "../src/scan.ts";
import { SARIF_SCHEMA, toSarif } from "../src/sarif.ts";
import { allRules } from "../src/rules/index.ts";
import { VERSION } from "../src/report.ts";
import { cleanup, EXAMPLES, project } from "./helpers.ts";

afterAll(cleanup);

const broken = () => scan(join(EXAMPLES, "broken-app"));

describe("toSarif", () => {
  it("writes a SARIF 2.1.0 log with one run and the tool version", () => {
    const log = toSarif(broken());
    expect(log.$schema).toBe(SARIF_SCHEMA);
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.tool.driver).toMatchObject({ name: "vibe-preflight", semanticVersion: VERSION });
  });

  it("lists every check that ran, with help text that carries the fix", () => {
    const { rules } = toSarif(broken()).runs[0]!.tool.driver;
    expect(rules.map((r) => r.id)).toEqual(allRules.map((r) => r.id));
    for (const rule of rules) {
      const source = allRules.find((r) => r.id === rule.id)!;
      expect(rule.shortDescription.text.length).toBeGreaterThan(0);
      expect(rule.fullDescription.text.length).toBeLessThanOrEqual(1024);
      expect(rule.help.text).toContain("Fix: ");
      expect(rule.help.markdown).toContain(source.fix);
      expect(rule.defaultConfiguration.level).toBe(source.severity);
      expect(rule.properties.tags).toContain("security");
      expect(Number(rule.properties["security-severity"])).toBeGreaterThan(0);
    }
    expect(rules.find((r) => r.id === "rls-disabled")).toMatchObject({ name: "RlsDisabled", properties: { tags: ["security", "database", "supabase"] } });
    expect(rules.find((r) => r.id === "stripe-webhook-unverified")!.properties.tags).toEqual(["security", "stripe"]);
    expect(rules.find((r) => r.id === "env-file-committed")!.properties.tags).toEqual(["security", "secrets"]);
  });

  it("maps each finding to ruleId, ruleIndex, level and a file/line location", () => {
    const result = broken();
    const run = toSarif(result).runs[0]!;
    expect(run.results).toHaveLength(result.findings.length);
    for (const [i, r] of run.results.entries()) {
      const f = result.findings[i]!;
      expect(r.ruleId).toBe(f.rule);
      expect(run.tool.driver.rules[r.ruleIndex]!.id).toBe(f.rule);
      expect(r.level).toBe(f.severity);
      expect(r.message.text).not.toContain("`");
      const loc = r.locations[0]!.physicalLocation;
      expect(loc.artifactLocation).toEqual({ uri: f.file, uriBaseId: "%SRCROOT%" });
      expect(loc.region.startLine).toBe(f.line);
    }
    expect(run.results.map((r) => `${r.ruleId} ${r.level} ${r.locations[0]!.physicalLocation.artifactLocation.uri}:${r.locations[0]!.physicalLocation.region.startLine}`)).toContain(
      "rls-disabled error supabase/migrations/20261101000000_init.sql:14",
    );
  });

  it("makes paths relative to the repository root when a subfolder was scanned", () => {
    for (const prefix of ["examples/broken-app", "./examples/broken-app/", "examples\\broken-app"]) {
      const uris = toSarif(broken(), { pathPrefix: prefix }).runs[0]!.results.map((r) => r.locations[0]!.physicalLocation.artifactLocation.uri);
      expect(uris).toContain("examples/broken-app/src/lib/stripe.ts");
      for (const uri of uris) expect(uri.startsWith("examples/broken-app/")).toBe(true);
    }
  });

  it("percent-encodes path segments but keeps the slashes", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.80.0" } }),
      "supabase/migrations/20250101000000_my notes#1.sql": "create table public.notes (id bigint primary key);\n",
    });
    const uri = toSarif(scan(dir)).runs[0]!.results.find((r) => r.ruleId === "rls-disabled")!.locations[0]!.physicalLocation.artifactLocation.uri;
    expect(uri).toBe("supabase/migrations/20250101000000_my%20notes%231.sql");
  });

  it("keeps the rule list when there are no findings, so code scanning can close fixed alerts", () => {
    const run = toSarif(scan(join(EXAMPLES, "fixed-app"))).runs[0]!;
    expect(run.results).toEqual([]);
    expect(run.tool.driver.rules).toHaveLength(allRules.length);
  });

  it("lists only the checks that ran", () => {
    const skip = allRules.map((r) => r.id).filter((id) => !id.startsWith("stripe-"));
    const run = toSarif(scan(join(EXAMPLES, "broken-app"), skip)).runs[0]!;
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["stripe-webhook-unverified", "stripe-webhook-parsed-body"]);
    expect(run.results.map((r) => [r.ruleId, r.ruleIndex])).toEqual([["stripe-webhook-unverified", 0]]);
  });
});
