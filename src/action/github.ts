// The few runner interfaces the action needs, written against GitHub's documented formats instead of pulling
// in @actions/core, so the bundle stays dependency-free like the scanner.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";

/** `inputs.<name>` arrives as INPUT_<NAME> (upper-cased, spaces to underscores, hyphens kept). */
export function getInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Writes a step output to the $GITHUB_OUTPUT file, with a heredoc delimiter when the value spans lines. */
export function setOutput(name: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  if (!/[\r\n]/.test(value)) {
    appendFileSync(file, `${name}=${value}${EOL}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
}

/** Appends Markdown to the job summary ($GITHUB_STEP_SUMMARY). Returns false outside a runner. */
export function appendSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  appendFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return true;
}

const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export interface AnnotationProperties {
  file?: string;
  line?: number;
  title?: string;
}

/** A `::error` / `::warning` workflow command: shows on the run page and, for changed lines, in the PR diff. */
export function annotation(level: "error" | "warning", message: string, props: AnnotationProperties = {}): string {
  const parts = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${escapeProperty(String(v))}`);
  return `::${level}${parts.length ? ` ${parts.join(",")}` : ""}::${escapeData(message)}`;
}
