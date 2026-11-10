import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildProject, fileKind, utcToday } from "./model.ts";
import type { GitState, Project, SourceFile } from "./types.ts";

export { utcToday } from "./model.ts";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".output", ".vercel", ".netlify", ".turbo", ".cache", ".expo",
  "dist", "build", "out", "coverage", ".svelte-kit", "vendor", ".pnpm-store", "playwright-report", "test-results",
]);
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

export function loadProject(root: string, today: string = utcToday()): Project {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name === SELF) continue;
      const path = relative(root, abs).split(sep).join("/");
      const kind = fileKind(path);
      if (!kind || statSync(abs).size > MAX_FILE_BYTES) continue;
      files.push({ path, text: readFileSync(abs, "utf8"), kind });
    }
  };
  walk(root);
  const git = gitState(root, files.filter((f) => f.kind === "env").map((f) => f.path));
  return buildProject(root, files, git, today);
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
