import { allRules, ruleGroups } from "./rules/index.ts";

/** A bad `--only` / `--skip` (CLI) or `include` / `exclude` (Action) value. */
export class SelectionError extends Error {}

/** Splits "a, b" or one id per line into a clean list. */
export const parseList = (value: string | undefined): string[] =>
  value?.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) ?? [];

/**
 * Turns an include list (groups or check ids; empty = every check) and an exclude list (check ids) into the
 * ids to skip. Unknown names throw, so a typo never silently turns a check off.
 */
export function rulesToSkip(include: string[], exclude: string[]): string[] {
  const known = new Set(allRules.map((r) => r.id));
  for (const id of exclude) if (!known.has(id)) throw new SelectionError(`unknown check "${id}" (exclude takes check ids; see --list)`);
  const skip = new Set(exclude);
  if (include.length) {
    const wanted = new Set<string>();
    for (const name of include) {
      const ids = ruleGroups[name] ?? (known.has(name) ? [name] : undefined);
      if (!ids) throw new SelectionError(`unknown group or check "${name}" (groups: ${Object.keys(ruleGroups).join(", ")}; checks: --list)`);
      for (const id of ids) wanted.add(id);
    }
    for (const id of known) if (!wanted.has(id)) skip.add(id);
  }
  return [...skip];
}
