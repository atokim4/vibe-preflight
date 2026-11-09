import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDirectory } from "../project.ts";
import { failsAt, scan, type ScanResult } from "../scan.ts";
import { text } from "../report.ts";
import { toSarif } from "../sarif.ts";
import { markdownSummary } from "../summary.ts";
import { parseList, rulesToSkip, SelectionError } from "../select.ts";
import type { Severity } from "../types.ts";
import { annotation, appendSummary, getInput, setOutput } from "./github.ts";

class InputError extends Error {}

type FailOn = Severity | "none";
type Format = "sarif" | "markdown";

interface Inputs {
  workspace: string;
  root: string;
  /** `root` relative to the workspace, forward slashes, "" for the workspace itself. */
  prefix: string;
  failOn: FailOn;
  format: Format;
  skip: string[];
  sarifFile: string;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InputError(`input "${name}" must be one of ${allowed.join(", ")} (got "${value}")`);
}

const toPosix = (p: string) => p.split(sep).join("/");

function readInputs(env: NodeJS.ProcessEnv): Inputs {
  const workspace = resolve(env.GITHUB_WORKSPACE || process.cwd());
  const root = resolve(workspace, getInput("path", env) || ".");
  const prefix = toPosix(relative(workspace, root));
  if (prefix.startsWith("..") || isAbsolute(prefix)) throw new InputError(`input "path" must be inside the workspace (${workspace}), got ${root}`);
  if (!isDirectory(root)) throw new InputError(`input "path" is not a folder: ${root}`);

  let skip: string[];
  try {
    skip = rulesToSkip(parseList(getInput("include", env)), parseList(getInput("exclude", env)));
  } catch (error) {
    if (error instanceof SelectionError) throw new InputError(error.message);
    throw error;
  }

  return {
    workspace,
    root,
    prefix,
    failOn: oneOf("fail-on", getInput("fail-on", env) || "error", ["error", "warning", "none"] as const),
    format: oneOf("format", getInput("format", env) || "sarif", ["sarif", "markdown"] as const),
    skip,
    sarifFile: getInput("sarif-file", env) || "vibe-preflight.sarif",
  };
}

function blobUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = env;
  return server && repo && sha ? `${server}/${repo}/blob/${sha}` : undefined;
}

function writeSarif(result: ScanResult, inputs: Inputs): string {
  const file = resolve(inputs.workspace, inputs.sarifFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(toSarif(result, { pathPrefix: inputs.prefix }), null, 2) + "\n");
  const rel = toPosix(relative(inputs.workspace, file));
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

/** Runs the action and returns the exit code. Everything it needs comes from `env`, so it can run outside a runner. */
export function run(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): number {
  let inputs: Inputs;
  try {
    inputs = readInputs(env);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    log(annotation("error", `vibe-preflight: ${error.message}`));
    return 1;
  }

  const result = scan(inputs.root, inputs.skip);
  log(text(result, false, false).trimEnd());

  for (const f of result.findings) {
    const file = inputs.prefix ? `${inputs.prefix}/${f.file}` : f.file;
    log(annotation(f.severity, f.message, { file, line: f.line, title: `vibe-preflight: ${f.rule}` }));
  }

  const summary = markdownSummary(result, { pathPrefix: inputs.prefix, blobUrl: blobUrl(env) });
  if (!appendSummary(summary, env) && inputs.format === "markdown") log(summary);

  const sarifFile = inputs.format === "sarif" ? writeSarif(result, inputs) : "";
  if (sarifFile) log(`SARIF written to ${sarifFile}`);
  setOutput("findings-count", String(result.findings.length), env);
  setOutput("errors-count", String(result.findings.filter((f) => f.severity === "error").length), env);
  setOutput("sarif-file", sarifFile, env);

  if (inputs.failOn !== "none" && failsAt(result.findings, inputs.failOn)) {
    log(annotation("error", `vibe-preflight: failing because of findings at "${inputs.failOn}" level or above (set fail-on: none to only report)`));
    return 1;
  }
  return 0;
}
