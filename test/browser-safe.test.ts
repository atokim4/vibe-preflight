import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The web checker bundles these modules; they must not touch the file system or other Node built-ins.
const NODE_ONLY = new Set(["cli.ts", "project.ts", "scan.ts"]);
const src = join(import.meta.dirname, "../src");
const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.startsWith("action"));

describe("browser-safe engine", () => {
  for (const f of files.filter((x) => !NODE_ONLY.has(x))) {
    it(`${f} imports no Node built-ins`, () => {
      expect(readFileSync(join(src, f), "utf8")).not.toMatch(/^import\b[^\n]*\bfrom\s+["'](node:|fs|path|child_process)["']/m);
    });
  }
});
