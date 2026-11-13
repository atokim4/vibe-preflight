import type { Rule, Severity } from "./types.ts";
import { counts, type ScanResult } from "./engine.ts";
import { allRules } from "./rules/index.ts";

export const VERSION = "1.7.0";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summary(r: ScanResult): string {
  const c = counts(r.findings);
  return `${plural(c.error, "error")}, ${plural(c.warning, "warning")}`;
}

export function json(r: ScanResult): string {
  return (
    JSON.stringify(
      {
        tool: "vibe-preflight",
        version: VERSION,
        project: r.project.name,
        frameworks: r.project.frameworks,
        supabase: r.project.usesSupabase,
        rules: r.rules.map((rule) => rule.id),
        summary: counts(r.findings),
        suppressed: r.suppressed,
        findings: r.findings,
      },
      null,
      2,
    ) + "\n"
  );
}

export function text(r: ScanResult, color: boolean, explain: boolean): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tag: Record<Severity, string> = { error: c("31;1", "error  "), warning: c("33;1", "warning") };
  const files = r.project.files.filter((f) => f.kind === "source").length;
  const sql = r.project.files.filter((f) => f.kind === "sql").length;
  const py = r.project.files.filter((f) => f.kind === "python").length;
  const fileCounts = [plural(files, "source file"), ...(py ? [plural(py, "Python file")] : []), plural(sql, "SQL file")].join(", ");
  const out = [c("1", `vibe-preflight ${VERSION}`) + c("2", ` · ${r.project.name} · ${fileCounts} · ${plural(r.rules.length, "check")}`), ""];

  for (const f of r.findings) {
    out.push(`${tag[f.severity]} ${c("2", `${f.file}:${f.line}`)}`);
    out.push(`        ${f.message} ${c("2", `[${f.rule}]`)}`);
  }
  if (r.findings.length) out.push("");

  if (explain && r.findings.length) {
    const byId = new Map<string, Rule>(r.rules.map((rule) => [rule.id, rule]));
    for (const id of new Set(r.findings.map((f) => f.rule))) {
      const rule = byId.get(id)!;
      out.push(c("1", `${id}: ${rule.title}`), `  why: ${rule.why}`, `  fix: ${rule.fix}`, "");
    }
  }

  const line = summary(r) + (r.suppressed ? c("2", ` (${r.suppressed} ignored inline)`) : "");
  const c2 = counts(r.findings);
  out.push(c2.error ? c("31;1", line) : r.findings.length ? c("33", line) : c("32;1", `✓ ${line}`));
  if (r.findings.length && !explain) out.push(c("2", "Run with --explain for why each one matters and how to fix it."));
  return out.join("\n") + "\n";
}

/** Plain list of the checks, for `--list`. */
export function ruleList(): string {
  return allRules.map((r) => `${r.id.padEnd(28)} ${r.severity.padEnd(8)} ${r.title}`).join("\n") + "\n";
}
