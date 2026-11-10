import type { Rule, Severity } from "./types.ts";
import type { ScanResult } from "./scan.ts";
import { ruleGroups } from "./rules/index.ts";
import { VERSION } from "./report.ts";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const INFORMATION_URI = "https://github.com/atokim4/vibe-preflight";
const CHECKS_URI = `${INFORMATION_URI}#the-19-checks`;

/**
 * GitHub's security-severity score per default level: 7.0-8.9 shows as "High", 4.0-6.9 as "Medium".
 * The checks are pattern-based, so none claims "Critical".
 */
const SECURITY_SEVERITY: Record<Severity, string> = { error: "8.0", warning: "5.0" };

export interface SarifOptions {
  /** Path of the scanned folder relative to the repository root ("" when it is the root), forward slashes. */
  pathPrefix?: string;
}

/** Minimal typing of the SARIF 2.1.0 parts this tool writes. */
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

export interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

export interface SarifDriver {
  name: string;
  semanticVersion: string;
  informationUri: string;
  rules: SarifRule[];
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string; markdown: string };
  helpUri: string;
  defaultConfiguration: { level: Severity };
  properties: { tags: string[]; precision: "medium"; "security-severity": string };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: Severity;
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: "%SRCROOT%" };
      region: { startLine: number };
    };
  }[];
}

/** "rls-disabled" -> "RlsDisabled": SARIF rule names are conventionally PascalCase. */
const pascal = (id: string) => id.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** Backticks are Markdown; in the plain-text fields they only add noise. */
const plain = (s: string) => s.replace(/`/g, "");

/** Code scanning caps short/full descriptions at 1,024 characters. */
const cap = (s: string, max = 1024) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function groupOf(id: string): string | undefined {
  return Object.entries(ruleGroups).find(([, ids]) => ids.includes(id))?.[0];
}

function sarifRule(rule: Rule): SarifRule {
  const group = groupOf(rule.id);
  return {
    id: rule.id,
    name: pascal(rule.id),
    shortDescription: { text: cap(plain(rule.title)) },
    fullDescription: { text: cap(plain(rule.why)) },
    help: {
      text: `Why: ${plain(rule.why)}\n\nFix: ${plain(rule.fix)}`,
      markdown: `**Why it matters:** ${rule.why}\n\n**How to fix it:** ${rule.fix}\n\n[All checks](${CHECKS_URI})`,
    },
    helpUri: CHECKS_URI,
    defaultConfiguration: { level: rule.severity },
    properties: {
      tags: ["security", ...(group ? [group] : []), ...(group === "database" ? ["supabase"] : [])],
      precision: "medium",
      "security-severity": SECURITY_SEVERITY[rule.severity],
    },
  };
}

/**
 * One SARIF run for a scan. Every rule that ran is listed (not only the ones with findings), so code scanning
 * can close alerts that a later run no longer reports. Locations are relative to %SRCROOT%, the repository root, which is how code scanning resolves them.
 */
export function toSarif(result: ScanResult, options: SarifOptions = {}): SarifLog {
  const prefix = (options.pathPrefix ?? "").replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
  const rules = result.rules.map(sarifRule);
  const index = new Map(rules.map((r, i) => [r.id, i]));
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "vibe-preflight", semanticVersion: VERSION, informationUri: INFORMATION_URI, rules } },
        results: result.findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: index.get(f.rule)!,
          level: f.severity,
          message: { text: plain(f.message) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodePath(prefix ? `${prefix}/${f.file}` : f.file), uriBaseId: "%SRCROOT%" },
                region: { startLine: Math.max(1, f.line) },
              },
            },
          ],
        })),
      },
    ],
  };
}

/** A relative URI reference: each path segment percent-encoded (spaces, #, ? …), the slashes kept. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
