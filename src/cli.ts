import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Severity } from "./types.ts";
import { SEVERITY_ORDER } from "./types.ts";
import { isDirectory } from "./project.ts";
import { counts, scan } from "./scan.ts";
import { json, ruleList, text, VERSION } from "./report.ts";
import { allRules } from "./rules/index.ts";

const HELP = `vibe-preflight ${VERSION}: 6 pre-launch security checks for Supabase + Stripe apps (Next.js, Vite, Expo)

Usage
  node preflight.mjs [dir]              scan a project (default: current directory)
  node preflight.mjs --list             list the checks

Options
  -f, --format <text|json>              output format (default: text)
  -e, --explain                         text output: add why each finding matters and how to fix it
      --fail-on <error|warning|never>   exit 1 when a finding at this level or above exists (default: error)
      --skip <rule,rule>                turn checks off for this run
      --no-color                        plain text (NO_COLOR is respected too)
  -h, --help / -v, --version

Exit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage error.
Silence one finding with a "vibe-preflight-ignore <rule-id>" comment on its line or the line above.
`;

class UsageError extends Error {}

function run(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", short: "f", default: "text" },
        explain: { type: "boolean", short: "e", default: false },
        "fail-on": { type: "string", default: "error" },
        skip: { type: "string" },
        "no-color": { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const info = values.help ? HELP : values.version ? `${VERSION}\n` : values.list ? ruleList() : undefined;
  if (info) {
    process.stdout.write(info);
    return 0;
  }

  if (positionals.length > 1) throw new UsageError(`expected one folder, got: ${positionals.join(" ")}`);
  const dir = resolve(positionals[0] ?? ".");
  if (!isDirectory(dir)) throw new UsageError(`not a folder: ${dir}`);

  const format = values.format;
  if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json (got "${format}")`);
  const failOn = values["fail-on"];
  if (failOn !== "error" && failOn !== "warning" && failOn !== "never") throw new UsageError(`--fail-on must be error, warning or never (got "${failOn}")`);
  const skip = values.skip?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const known = new Set(allRules.map((r) => r.id));
  for (const id of skip) if (!known.has(id)) throw new UsageError(`unknown check "${id}" in --skip (see --list)`);

  const result = scan(dir, skip);
  const color = !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  process.stdout.write(format === "json" ? json(result) : text(result, color, values.explain));

  if (failOn === "never") return 0;
  const c = counts(result.findings);
  const threshold = SEVERITY_ORDER[failOn];
  return (Object.keys(c) as Severity[]).some((s) => SEVERITY_ORDER[s] >= threshold && c[s] > 0) ? 1 : 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`vibe-preflight: ${error.message}\nRun with --help for usage.\n`);
  process.exitCode = 2;
}
