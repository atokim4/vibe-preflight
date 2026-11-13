import type { Framework, GitState, Project, SourceFile } from "./types.ts";

/** Building the project model from files that are already loaded. Pure: the CLI reads from disk, the web page from GitHub. */

export const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const ENV_FILE = /^\.env(?:\..+)?$/;

/** Today in UTC as YYYY-MM-DD. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10);

/** The kind the scanner reads a file as, or undefined when no check reads it. `path` is relative, forward slashes. */
export function fileKind(path: string): SourceFile["kind"] | undefined {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash === -1 ? "" : path.slice(0, slash);
  if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) return "source";
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".sql")) return "sql";
  if (ENV_FILE.test(name)) return "env";
  if (name === "package.json" || name === ".gitignore") return "other";
  // Python dependency lists: the concurrency checks read them to tell asyncpg projects apart.
  if (/^(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.cfg)$/.test(name)) return "other";
  if (name === "config.toml" && (dir === "supabase" || dir.endsWith("/supabase"))) return "other";
  return undefined;
}

/**
 * The project model the rules run on. `root` names the project (its last segment is the fallback name), `git`
 * is what git says about the files (undefined when unknown).
 */
export function buildProject(root: string, loaded: readonly SourceFile[], git: GitState | undefined, today: string = utcToday()): Project {
  const files = [...loaded].sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  let pkg: { name?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(byPath.get("package.json")?.text ?? "{}");
  } catch {
    // A broken package.json only costs us framework detection.
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const frameworks: Framework[] = [];
  const hasAppLayout = files.some((f) => /^(src\/)?app\/layout\.[jt]sx?$/.test(f.path));
  if ("next" in deps || hasAppLayout) frameworks.push("next");
  else if ("vite" in deps) frameworks.push("vite");
  if ("expo" in deps) frameworks.push("expo");
  if (!frameworks.length) frameworks.push("unknown");

  const usesSupabase =
    Object.keys(deps).some((d) => d.startsWith("@supabase/")) ||
    files.some((f) => f.path.startsWith("supabase/") || (f.kind === "source" && /from\s+["'](?:npm:|jsr:)?@supabase\//.test(f.text)));

  return {
    root,
    name: typeof pkg.name === "string" ? pkg.name : root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    frameworks,
    files,
    byPath,
    gitignore: byPath.get(".gitignore")?.text,
    git,
    usesSupabase,
    today,
  };
}

