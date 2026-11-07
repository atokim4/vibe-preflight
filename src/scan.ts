import type { Finding, Project, Rule, Severity } from "./types.ts";
import { SEVERITY_ORDER } from "./types.ts";
import { loadProject } from "./project.ts";
import { allRules } from "./rules/index.ts";

export interface ScanResult {
  project: Project;
  rules: Rule[];
  findings: Finding[];
  /** Findings silenced by a `vibe-preflight-ignore` comment. */
  suppressed: number;
}

const IGNORE = /vibe-preflight-ignore\b([\w\s,-]*)/;

/** A `vibe-preflight-ignore [rule-id …]` comment on the finding's line or the line above it. */
function ignoredInline(project: Project, f: Finding): boolean {
  const lines = project.byPath.get(f.file)?.text.split("\n");
  if (!lines) return false;
  for (const l of [lines[f.line - 1], lines[f.line - 2]]) {
    const m = l === undefined ? null : IGNORE.exec(l);
    if (!m) continue;
    const ids = m[1]!.split(/[\s,]+/).filter((x) => /^[a-z][a-z0-9-]+$/.test(x));
    if (!ids.length || ids.includes(f.rule)) return true;
  }
  return false;
}

export function scan(root: string, skip: string[] = []): ScanResult {
  const project = loadProject(root);
  const rules = allRules.filter((r) => !skip.includes(r.id));
  const findings: Finding[] = [];
  let suppressed = 0;
  for (const rule of rules) {
    for (const f of rule.check(project)) {
      if (ignoredInline(project, f)) suppressed++;
      else findings.push(f);
    }
  }
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  return { project, rules, findings, suppressed };
}

export function counts(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
