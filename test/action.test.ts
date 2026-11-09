import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotation, getInput, setOutput } from "../src/action/github.ts";
import { ROOT } from "./helpers.ts";

/** Runs the committed bundle (action/index.mjs) like a runner does: INPUT_* variables and the runner files. */
const ACTION = join(ROOT, "action/index.mjs");
let temp: string;

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "vibe-preflight-action-test-"));
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function runAction(inputs: Record<string, string>) {
  const dir = mkdtempSync(join(temp, "run-"));
  const files = { GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary.md") };
  for (const f of Object.values(files)) writeFileSync(f, "");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GITHUB_WORKSPACE: ROOT, ...files, "INPUT_SARIF-FILE": join(dir, "out.sarif") };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const r = spawnSync(process.execPath, [ACTION], { cwd: ROOT, encoding: "utf8", env });
  const outputs = Object.fromEntries(
    readFileSync(files.GITHUB_OUTPUT, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  return { code: r.status, log: r.stdout + r.stderr, outputs, summary: readFileSync(files.GITHUB_STEP_SUMMARY, "utf8"), sarif: join(dir, "out.sarif") };
}

describe("action/index.mjs", () => {
  it("reports the broken example, writes SARIF and outputs, and fails on errors", () => {
    const r = runAction({ path: "examples/broken-app" });
    expect(r.code).toBe(1);
    expect(r.outputs).toEqual({ "findings-count": "9", "errors-count": "5", "sarif-file": r.sarif });
    const sarif = JSON.parse(readFileSync(r.sarif, "utf8"));
    expect(sarif.runs[0].results).toHaveLength(9);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toMatch(/^examples\/broken-app\//);
    expect(r.summary).toContain("**5 errors, 4 warnings** in `examples/broken-app`");
    expect(r.log).toContain("::error file=examples/broken-app/src/lib/stripe.ts,line=3,title=vibe-preflight%3A public-env-secret::");
    expect(r.log).toContain('failing because of findings at "error" level');
  });

  it("passes on the fixed example, and on the broken one with fail-on: none", () => {
    const fixed = runAction({ path: "examples/fixed-app", "fail-on": "warning" });
    expect(fixed.code).toBe(0);
    expect(fixed.outputs["findings-count"]).toBe("0");
    expect(fixed.summary).toContain("No findings in `examples/fixed-app`");
    expect(runAction({ path: "examples/broken-app", "fail-on": "none" }).code).toBe(0);
  });

  it("fails on warnings only when asked to", () => {
    const stripeOnly = { path: "examples/broken-app", include: "stripe", exclude: "stripe-webhook-unverified" };
    expect(runAction(stripeOnly).outputs["findings-count"]).toBe("0");
    const grants = { path: "examples/broken-app", include: "grants-missing" };
    expect(runAction(grants)).toMatchObject({ code: 0, outputs: { "findings-count": "2", "errors-count": "0" } });
    expect(runAction({ ...grants, "fail-on": "warning" }).code).toBe(1);
  });

  it("writes no SARIF file in markdown format", () => {
    const r = runAction({ path: "examples/broken-app", format: "markdown", "fail-on": "none" });
    expect(r.outputs["sarif-file"]).toBe("");
    expect(existsSync(r.sarif)).toBe(false);
    expect(r.summary).toContain("### How to fix");
  });

  it("rejects bad inputs with an error annotation", () => {
    for (const [inputs, text] of [
      [{ "fail-on": "sometimes" }, 'input "fail-on" must be one of error, warning, none'],
      [{ format: "html" }, 'input "format" must be one of sarif, markdown'],
      [{ include: "rls-disbled" }, 'unknown group or check "rls-disbled"'],
      [{ path: "../" }, 'input "path" must be inside the workspace'],
      [{ path: "no-such-folder" }, 'input "path" is not a folder'],
    ] as const) {
      const r = runAction(inputs);
      expect(r.code).toBe(1);
      expect(r.log).toContain(`::error::vibe-preflight: ${text}`);
    }
  });
});

describe("runner helpers", () => {
  it("reads inputs the way the runner names them", () => {
    expect(getInput("fail-on", { "INPUT_FAIL-ON": " warning \n" })).toBe("warning");
    expect(getInput("sarif file", { INPUT_SARIF_FILE: "x" })).toBe("x");
    expect(getInput("path", {})).toBe("");
  });

  it("escapes annotation data and properties", () => {
    expect(annotation("warning", "50% done\nnext", { file: "a,b.ts", line: 3, title: "t: x" })).toBe("::warning file=a%2Cb.ts,line=3,title=t%3A x::50%25 done%0Anext");
    expect(annotation("error", "plain")).toBe("::error::plain");
  });

  it("uses a heredoc delimiter for multi-line outputs", () => {
    const file = join(temp, "multi-output");
    writeFileSync(file, "");
    setOutput("one", "1", { GITHUB_OUTPUT: file });
    setOutput("many", "a\nb", { GITHUB_OUTPUT: file });
    const [line1, start, a, b, end] = readFileSync(file, "utf8").split(/\r?\n/);
    expect(line1).toBe("one=1");
    const delimiter = start!.replace("many<<", "");
    expect(delimiter).toMatch(/^ghadelimiter_[0-9a-f-]{36}$/);
    expect([a, b, end]).toEqual(["a", "b", delimiter]);
  });
});
