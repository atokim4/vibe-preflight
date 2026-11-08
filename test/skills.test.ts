import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

const SKILLS = join(ROOT, "skills");

describe("skill folders", () => {
  for (const folder of readdirSync(SKILLS)) {
    it(`${folder}/SKILL.md has frontmatter installers can parse`, () => {
      const head = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(SKILLS, folder, "SKILL.md"), "utf8"));
      expect(head).not.toBeNull();
      const fields = Object.fromEntries(head![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
      expect(fields.name).toBe(folder);
      expect(fields.license).toBe("MIT");
      // A plain YAML scalar can't hold ": " or start with a quote; one such description made `npx skills add` skip the skill.
      expect(fields.description).not.toMatch(/: |^["'`]/);
      expect(fields.description!.length).toBeLessThanOrEqual(1024);
    });
  }
});
