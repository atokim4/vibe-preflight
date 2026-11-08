import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, example, ROOT } from "./helpers.ts";

afterAll(cleanup);

/** Runs the bundled script that ships in the skill folder (npm run build first; `npm run check` does). */
const SCRIPT = join(ROOT, "skills/vibe-preflight/scripts/preflight.mjs");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const broken = example("broken-app");
const fixed = example("fixed-app");

describe("preflight.mjs", () => {
  it("reports the version from package.json and the plugin manifests", () => {
    const read = (file: string) => JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { version: string };
    const version = read("package.json").version;
    expect(run("--version").out.trim()).toBe(version);
    expect(read(".claude-plugin/plugin.json").version).toBe(version);
  });

  it("exits 1 on errors and 0 on a clean project", () => {
    const bad = run(broken);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("6 errors, 2 warnings");
    expect(bad.out).toContain("[stripe-webhook-unverified]");
    const good = run(fixed);
    expect(good.code).toBe(0);
    expect(good.out).toContain("✓ 0 errors, 0 warnings");
  });

  it("prints valid JSON with the findings", () => {
    const r = run(broken, "--format", "json");
    const report = JSON.parse(r.out);
    expect(report.tool).toBe("vibe-preflight");
    expect(report.summary).toEqual({ error: 6, warning: 2 });
    expect(report.findings[0]).toEqual(expect.objectContaining({ rule: "env-file-committed", file: ".env.local", line: 1 }));
  });

  it("explains each rule once with --explain", () => {
    const r = run(broken, "--explain");
    expect(r.out.match(/^rls-permissive-policy: /gm)).toHaveLength(1);
    expect(r.out).toContain("fix: Read the raw body");
  });

  it("supports --fail-on and --skip", () => {
    expect(run(broken, "--fail-on", "never").code).toBe(0);
    const skipped = run(broken, "--format", "json", "--skip", "rls-disabled,env-file-committed");
    expect(JSON.parse(skipped.out).findings.map((f: { rule: string }) => f.rule)).not.toContain("rls-disabled");
    expect(JSON.parse(skipped.out).rules).toHaveLength(11);
  });

  it("exits 2 with a message on bad input", () => {
    for (const args of [["--format", "xml"], ["--fail-on", "info"], ["--skip", "nope"], ["/does/not/exist"], ["--bogus"], ["a", "b"]]) {
      const r = run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toMatch(/^vibe-preflight: /);
    }
  });

  it("lists the 13 checks", () => {
    const r = run("--list");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(13);
  });
});
