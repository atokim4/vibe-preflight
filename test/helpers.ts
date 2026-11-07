import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "../src/scan.ts";
import type { Finding } from "../src/types.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLES = join(ROOT, "examples");

const dirs: string[] = [];

/** Write a throwaway project (outside any git repo) from a { path: content } map, optionally on top of a copy of `base`. */
export function project(files: Record<string, string>, base?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-preflight-test-"));
  dirs.push(dir);
  if (base) cpSync(base, dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const findings = (dir: string): Finding[] => scan(dir).findings;
export const only = (list: Finding[], rule: string) => list.filter((f) => f.rule === rule);
export const ids = (list: Finding[]) => [...new Set(list.map((f) => f.rule))].sort();
export const at = (list: Finding[]) => list.map((f) => `${f.rule} ${f.severity} ${f.file}:${f.line}`);

/**
 * The local env files of the example apps. They aren't in the repo (a committed .env is exactly what one check
 * looks for), so the tests write them into the throwaway copy. Placeholder values only.
 */
export const EXAMPLE_ENV: Record<"broken-app" | "fixed-app", Record<string, string>> = {
  "broken-app": {
    ".env.local": [
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key",
      "SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role-key",
      "NEXT_PUBLIC_STRIPE_SECRET_KEY=placeholder-stripe-secret",
      "NEXT_PUBLIC_OPENAI_API_KEY=placeholder-openai-key",
    ].join("\n"),
  },
  "fixed-app": {
    ".env.local": [
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key",
      "SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role-key",
      "STRIPE_SECRET_KEY=placeholder-stripe-secret",
    ].join("\n"),
  },
};

/** A throwaway copy of an example app, with its local env file. */
export const example = (name: keyof typeof EXAMPLE_ENV) => project(EXAMPLE_ENV[name], join(EXAMPLES, name));

export const NEXT_SUPABASE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "t", dependencies: { next: "16.0.0", "@supabase/supabase-js": "2.80.0", stripe: "19.0.0" } }),
  ".gitignore": ".env*\n!.env.example\nnode_modules\n",
  "app/layout.tsx": "export default function L({ children }) { return children; }\n",
};
