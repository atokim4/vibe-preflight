import type { Finding, Rule } from "./types.ts";
import { counts, type ScanResult } from "./scan.ts";
import { VERSION } from "./report.ts";

export interface SummaryOptions {
  /** Path of the scanned folder relative to the repository root ("" for the root). */
  pathPrefix?: string;
  /** Base for file links, e.g. https://github.com/owner/repo/blob/<sha>. No links when missing. */
  blobUrl?: string;
  /** Rows shown before the table is cut (the job summary limit is 1 MiB per step). */
  maxRows?: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Table cells can't hold a pipe or a line break. */
const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function location(f: Finding, options: SummaryOptions): string {
  const prefix = options.pathPrefix ? `${options.pathPrefix.replace(/\/+$/, "")}/` : "";
  const path = `${prefix}${f.file}`;
  const label = `\`${cell(path)}:${f.line}\``;
  if (!options.blobUrl) return label;
  const href = `${options.blobUrl.replace(/\/+$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}#L${f.line}`;
  return `[${label}](${href})`;
}

/** The job summary: totals, one table row per finding, and the why/fix of each check that fired. */
export function markdownSummary(r: ScanResult, options: SummaryOptions = {}): string {
  const maxRows = options.maxRows ?? 200;
  const c = counts(r.findings);
  const scanned = options.pathPrefix ? ` in \`${options.pathPrefix}\`` : "";
  const out = [`## vibe-preflight ${VERSION}`, ""];

  if (!r.findings.length) {
    out.push(`No findings${scanned}: ${plural(r.rules.length, "check")} passed.`);
    if (r.suppressed) out.push("", `${plural(r.suppressed, "finding")} silenced with a \`vibe-preflight-ignore\` comment.`);
    return out.join("\n") + "\n";
  }

  const ignored = r.suppressed ? `, ${r.suppressed} ignored inline` : "";
  out.push(`**${plural(c.error, "error")}, ${plural(c.warning, "warning")}**${scanned} (${plural(r.rules.length, "check")} ran${ignored}).`, "");
  out.push("| Severity | Check | Location | Finding |", "|---|---|---|---|");
  for (const f of r.findings.slice(0, maxRows)) {
    out.push(`| ${f.severity} | \`${f.rule}\` | ${location(f, options)} | ${cell(f.message)} |`);
  }
  if (r.findings.length > maxRows) out.push("", `${r.findings.length - maxRows} more not shown. The SARIF file has all of them.`);

  out.push("", "### How to fix", "");
  const byId = new Map<string, Rule>(r.rules.map((rule) => [rule.id, rule]));
  for (const id of new Set(r.findings.map((f) => f.rule))) {
    const rule = byId.get(id)!;
    out.push(`<details><summary><code>${id}</code>: ${rule.title.replace(/`/g, "")}</summary>`, "", `**Why:** ${rule.why}`, "", `**Fix:** ${rule.fix}`, "", "</details>", "");
  }
  return out.join("\n");
}
