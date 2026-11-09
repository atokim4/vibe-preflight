import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRepro } from "../examples/grants-repro/repro.ts";
import { EXAMPLES } from "./helpers.ts";

const repro = await runRepro();
const o = repro.outcomes;

describe("examples/grants-repro (real Postgres in PGlite)", () => {
  it("scans the app: grants-missing on todos, grant-leak on the notes quick fix", () => {
    expect(repro.findings.map((f) => `${f.rule} ${f.severity} ${f.at}`)).toEqual([
      "rls-disabled error supabase/migrations/20261106090000_notes.sql:2",
      "grant-leak error supabase/migrations/20261107090000_fix_permission_denied.sql:2",
      "grants-missing warning supabase/migrations/20261105090000_todos.sql:2",
    ]);
  });

  it("fails with 42501 without a grant, and with UPDATE alone", () => {
    for (const key of ["todos.select.nogrant", "todos.insert.nogrant", "todos.update.updateonly"])
      expect(o[key], key).toMatchObject({ ok: false, code: "42501" });
  });

  it("works with exactly the grant grants-missing suggests, and RLS still scopes rows", () => {
    expect(o["todos.select.granted"]!.rows).toEqual([{ id: 1, title: "alice: buy milk", done: false }]);
    expect(o["todos.insert.granted"]).toMatchObject({ ok: true, affected: 1 });
    expect(o["todos.update.granted"]).toMatchObject({ ok: true, affected: 1 });
    expect(o["todos.update.otheruser"]).toMatchObject({ ok: true, affected: 0 });
    expect(o["todos.select.anon"]).toMatchObject({ ok: false, code: "42501" });
  });

  it("shows the leak from grant all with RLS off, and the fix closing it", () => {
    expect(o["notes.select.anon"]!.rows).toHaveLength(2);
    expect(o["notes.update.anon"]).toMatchObject({ ok: true, affected: 2 });
    expect(o["notes.select.anon.fixed"]).toMatchObject({ ok: false, code: "42501" });
    expect(o["notes.select.bob.fixed"]!.rows).toEqual([{ id: 2, body: "changed by a stranger" }]);
  });

  it("matches the saved OUTPUT.txt", () => {
    expect(readFileSync(join(EXAMPLES, "grants-repro/OUTPUT.txt"), "utf8")).toBe(repro.transcript);
  });
});
