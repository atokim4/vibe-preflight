// The focused skills ship their own copy of the scanner, because each skill can be installed on its own.
import { copyFileSync, mkdirSync } from "node:fs";

const source = "skills/vibe-preflight/scripts/preflight.mjs";
for (const skill of ["supabase-rls-audit", "stripe-webhook-security"]) {
  mkdirSync(`skills/${skill}/scripts`, { recursive: true });
  copyFileSync(source, `skills/${skill}/scripts/preflight.mjs`);
}
