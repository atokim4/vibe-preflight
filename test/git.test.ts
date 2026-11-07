import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, findings, only, project } from "./helpers.ts";

afterAll(cleanup);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });

describe("env-file-committed (inside a git repo)", () => {
  it("asks git: tracked files are errors even when .gitignore lists them, nested ignores count", () => {
    const dir = project({
      "package.json": "{}",
      ".gitignore": ".env\n",
      ".env.production": "SECRET=1\n",
      "apps/web/.gitignore": ".env.local\n",
      "apps/web/.env.local": "SECRET=1\n",
      "apps/api/.env": "SECRET=1\n",
    });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    // Committed before it was ignored: .gitignore says .env, but git still tracks it.
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    git(dir, "add", "-f", ".env");
    git(dir, "commit", "-qm", "init");
    const list = only(findings(dir), "env-file-committed").map((f) => f.message);
    expect(list).toEqual(["`.env` is committed to git.", "`.env.production` is committed to git."]);
  });

  it("works when the scanned folder is a subfolder of the repo", () => {
    const root = project({ "web/package.json": "{}", "web/.env": "SECRET=1\n" });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    mkdirSync(join(root, "web", "src"), { recursive: true });
    expect(only(findings(join(root, "web")), "env-file-committed").map((f) => `${f.file}: ${f.message}`)).toEqual([".env: `.env` is committed to git."]);
  });
});
