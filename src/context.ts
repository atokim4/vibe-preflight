import type { Project, SourceFile } from "./types.ts";
import { hasDirective } from "./text.ts";

/** Supabase Edge Functions run on Deno on the server. */
export function isEdgeFunction(f: SourceFile): boolean {
  return /(^|\/)supabase\/functions\//.test(f.path);
}

export function isTestFile(f: SourceFile): boolean {
  return /(^|\/)(__tests__|tests?|e2e|fixtures?|__mocks__)\//.test(f.path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f.path);
}

/** Config and tooling files at the root (next.config.ts, vite.config.ts, …) run in Node, never in the browser. */
function isToolingFile(f: SourceFile): boolean {
  return /^[^/]*\.config\.[cm]?[jt]s$/.test(f.path) || /(^|\/)scripts\//.test(f.path);
}

export const isNext = (project: Project) => project.frameworks.includes("next");

/**
 * Code that ends up in the browser bundle.
 * - Next.js: files with a "use client" directive.
 * - Vite / Expo SPA: everything under src/ (or app/, components/, lib/, hooks/), except Edge Functions,
 *   tests, tooling and server/ folders.
 */
export function isClientFile(project: Project, f: SourceFile): boolean {
  if (f.kind !== "source" || isEdgeFunction(f) || isTestFile(f) || isToolingFile(f)) return false;
  if (hasDirective(f.text, "use client")) return true;
  const spa = project.frameworks.includes("vite") || project.frameworks.includes("expo");
  if (spa && !isNext(project)) return /^(src|app|components|lib|hooks)\//.test(f.path) && !/(^|\/)server\//.test(f.path);
  return false;
}

/** The env prefixes whose values are inlined into the client bundle for this project. */
export function publicPrefixes(project: Project): string[] {
  const prefixes: string[] = [];
  if (isNext(project)) prefixes.push("NEXT_PUBLIC_");
  if (project.frameworks.includes("vite")) prefixes.push("VITE_");
  if (project.frameworks.includes("expo")) prefixes.push("EXPO_PUBLIC_");
  return prefixes.length ? prefixes : ["NEXT_PUBLIC_", "VITE_", "EXPO_PUBLIC_"];
}
