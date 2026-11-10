import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isDirectory } from "./project.ts";
import { failsAt, scan } from "./scan.ts";
import { json, ruleList, text, VERSION } from "./report.ts";
import { parseList, rulesToSkip, SelectionError } from "./select.ts";

const HELP = `vibe-preflight ${VERSION}: 19 pre-launch checks for Supabase + Stripe apps (Next.js, Vite, Expo, Hono…)

Usage
  node preflight.mjs [dir]              scan a project (default: current directory)
  node preflight.mjs --list             list the checks

Options
  -f, --format <text|json>              output format (default: text)
  -e, --explain                         text output: add why each finding matters and how to fix it
      --fail-on <error|warning|never>   exit 1 when a finding at this level or above exists (default: error)
      --only <group|rule,...>           run only these checks; groups: database, secrets, stripe, breaking
      --skip <rule,rule>                turn checks off for this run
      --today <YYYY-MM-DD>              judge date-based checks as of this day (e.g. 2026-12-01)
      --no-color                        plain text (NO_COLOR is respected too)
  -h, --help / -v, --version

Exit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage error.
Silence one finding with a "vibe-preflight-ignore <rule-id>" comment on its line or the line above.
`;

class UsageError extends Error {}

/** A real calendar day written as YYYY-MM-DD. */
function isDay(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t) && new Date(t).toISOString().startsWith(s);
}

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
        only: { type: "string" },
        skip: { type: "string" },
        today: { type: "string" },
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
  let skip: string[];
  try {
    skip = rulesToSkip(parseList(values.only), parseList(values.skip));
  } catch (error) {
    if (error instanceof SelectionError) throw new UsageError(error.message);
    throw error;
  }

  const today = values.today;
  if (today !== undefined && !isDay(today)) throw new UsageError(`--today must be a date like 2026-12-01 (got "${today}")`);

  const result = scan(dir, skip, { today });
  const color = !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  process.stdout.write(format === "json" ? json(result) : text(result, color, values.explain));

  return failsAt(result.findings, failOn === "never" ? undefined : failOn) ? 1 : 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`vibe-preflight: ${error.message}\nRun with --help for usage.\n`);
  process.exitCode = 2;
}
