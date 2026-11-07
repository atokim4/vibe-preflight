export type Severity = "error" | "warning";

export const SEVERITY_ORDER: Record<Severity, number> = { error: 2, warning: 1 };

export interface Finding {
  rule: string;
  severity: Severity;
  /** One line: what is wrong, in the project's own terms. */
  message: string;
  /** Path relative to the scanned root, with forward slashes. */
  file: string;
  line: number;
}

export interface SourceFile {
  /** Relative path, forward slashes. */
  path: string;
  text: string;
  kind: "source" | "sql" | "env" | "other";
}

export type Framework = "next" | "vite" | "expo" | "unknown";

export interface Project {
  root: string;
  name: string;
  frameworks: Framework[];
  files: SourceFile[];
  byPath: Map<string, SourceFile>;
  gitignore?: string;
  /** What git says about the env files. Undefined when the folder is not in a git work tree (or git is missing). */
  git?: GitState;
  /** Supabase is used (a dependency, an import, or a supabase/ folder). The RLS checks only run then. */
  usesSupabase: boolean;
}

export interface Rule {
  id: string;
  severity: Severity;
  title: string;
  /** Why it matters, 1-3 sentences. */
  why: string;
  /** How to fix it. */
  fix: string;
  check(project: Project): Finding[];
}

export interface GitState {
  /** Tracked files under the root, relative to it. */
  tracked: Set<string>;
  /** Env files (relative paths) that git ignores. */
  ignored: Set<string>;
}
