import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { Framework, GitState, Project, SourceFile } from "./types.ts";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".output", ".vercel", ".netlify", ".turbo", ".cache", ".expo",
  "dist", "build", "out", "coverage", ".svelte-kit", "vendor", ".pnpm-store", "playwright-report", "test-results",
]);
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const ENV_FILE = /^\.env(?:\..+)?$/;
const MAX_FILE_BYTES = 1_000_000;
/** The bundled scanner contains the patterns it looks for. */
const SELF = "preflight.mjs";

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/** Tracked files and ignored env files, relative to `root`. Undefined when git or the work tree isn't there. */
function gitState(root: string, envFiles: string[]): GitState | undefined {
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return undefined;
  } catch {
    return undefined;
  }
  // `ls-files` without --full-name prints paths relative to the cwd, which is the root.
  const tracked = new Set(git(root, ["ls-files", "-z", "--", "."]).split("\0").filter(Boolean));
  let ignored = new Set<string>();
  if (envFiles.length) {
    try {
      ignored = new Set(git(root, ["check-ignore", "-z", "--stdin"], envFiles.join("\0") + "\0").split("\0").filter(Boolean));
    } catch {
      // Exit code 1 means "none of them is ignored".
    }
  }
  return { tracked, ignored };
}

export function loadProject(root: string): Project {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name === SELF) continue;
      let kind: SourceFile["kind"] | undefined;
      if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith(".d.ts")) kind = "source";
      else if (entry.name.endsWith(".sql")) kind = "sql";
      else if (ENV_FILE.test(entry.name)) kind = "env";
      else if (entry.name === "package.json" || entry.name === ".gitignore") kind = "other";
      else if (entry.name === "config.toml" && basename(dir) === "supabase") kind = "other";
      if (!kind || statSync(abs).size > MAX_FILE_BYTES) continue;
      files.push({ path: relative(root, abs).split(sep).join("/"), text: readFileSync(abs, "utf8"), kind });
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));

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
    name: typeof pkg.name === "string" ? pkg.name : basename(root),
    frameworks,
    files,
    byPath,
    gitignore: byPath.get(".gitignore")?.text,
    git: gitState(root, files.filter((f) => f.kind === "env").map((f) => f.path)),
    usesSupabase,
  };
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
