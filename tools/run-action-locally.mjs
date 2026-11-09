// Runs action/index.mjs the way a GitHub runner does (INPUT_* variables, $GITHUB_OUTPUT, $GITHUB_STEP_SUMMARY),
// so the action can be tried without act or a runner.
//   node tools/run-action-locally.mjs [path] [fail-on] [format]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [path = "examples/broken-app", failOn = "error", format = "sarif"] = process.argv.slice(2);
const temp = mkdtempSync(join(tmpdir(), "vibe-preflight-action-"));
const output = join(temp, "output");
const summary = join(temp, "summary.md");
writeFileSync(output, "");
writeFileSync(summary, "");

const result = spawnSync(process.execPath, [join(root, "action/index.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    GITHUB_WORKSPACE: root,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    INPUT_PATH: path,
    "INPUT_FAIL-ON": failOn,
    INPUT_FORMAT: format,
    "INPUT_SARIF-FILE": join(temp, "vibe-preflight.sarif"),
  },
});

console.log(`\n--- exit code: ${result.status}\n--- $GITHUB_OUTPUT\n${readFileSync(output, "utf8")}--- job summary\n${readFileSync(summary, "utf8")}`);
rmSync(temp, { recursive: true, force: true });
process.exitCode = result.status ?? 1;
