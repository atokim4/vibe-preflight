/**
 * Supabase's 2026-10-30 grants change, replayed in real Postgres (PGlite, in-process).
 *
 * 1. Scans ./app with vibe-preflight.
 * 2. Builds a Supabase-like database (supabase-bootstrap.sql) and applies the app's migrations.
 * 3. Runs the SQL that PostgREST runs for the app's supabase-js calls, as the role it would use:
 *    - todos: 42501 without a grant, then works with exactly the grant grants-missing printed;
 *    - notes: the "grant all to anon" fix lets a signed-out visitor read and rewrite every user's notes,
 *      and the grant-leak fix closes it again.
 *
 * Run: npm run repro:grants (Node 22.18+, which runs TypeScript directly).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { scan } from "../../src/scan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app");

/** Sample users. */
const ALICE = "00000000-0000-4000-a000-00000000000a";
const BOB = "00000000-0000-4000-a000-00000000000b";

export interface Outcome {
  ok: boolean;
  /** Postgres error code when it failed (42501 = insufficient_privilege). */
  code?: string;
  rows: Record<string, unknown>[];
  affected: number;
}

export interface Repro {
  transcript: string;
  findings: { rule: string; severity: string; at: string; message: string }[];
  outcomes: Record<string, Outcome>;
}

/** The SQL from a finding's "Minimal grant: `…`" part. */
export function suggestedGrant(message: string): string {
  const m = /Minimal grant: `([^`]+)`/.exec(message);
  if (!m) throw new Error(`no grant in finding: ${message}`);
  return m[1]!;
}

export async function runRepro(): Promise<Repro> {
  const out: string[] = [];
  const log = (line = "") => out.push(line);
  const outcomes: Record<string, Outcome> = {};

  const result = scan(APP, ["env-file-committed"]);
  const findings = result.findings.map((f) => ({ rule: f.rule, severity: f.severity, at: `${f.file}:${f.line}`, message: f.message }));
  log("$ vibe-preflight examples/grants-repro/app");
  for (const f of findings) log(`${f.severity.padEnd(7)} ${f.rule}  ${f.at}\n        ${f.message}`);
  log();

  const db = new PGlite();
  try {
    await db.exec(readFileSync(join(HERE, "supabase-bootstrap.sql"), "utf8"));
    const migrations = readdirSync(join(APP, "supabase/migrations")).sort();
    for (const name of migrations) await db.exec(readFileSync(join(APP, "supabase/migrations", name), "utf8"));
    log(`-- applied supabase-bootstrap.sql + ${migrations.length} migrations; seeding sample rows as postgres`);
    await db.exec(`
      insert into public.todos (user_id, title) values ('${ALICE}', 'alice: buy milk'), ('${BOB}', 'bob: call mom');
      insert into public.notes (user_id, body) values ('${ALICE}', 'alice: door code 4821'), ('${BOB}', 'bob: salary 5400');
    `);

    /** One API request: what PostgREST does, in a transaction with the request's role and JWT subject. */
    const request = async (key: string, who: "anon" | "alice" | "bob", sql: string): Promise<Outcome> => {
      const role = who === "anon" ? "anon" : "authenticated";
      const sub = who === "alice" ? ALICE : who === "bob" ? BOB : "";
      log(`${who}> ${sql}`);
      let outcome: Outcome;
      try {
        outcome = await db.transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          await tx.exec(`set local role ${role}`);
          const r = await tx.query<Record<string, unknown>>(sql);
          return { ok: true, rows: r.rows, affected: r.affectedRows ?? 0 };
        });
        if (outcome.rows.length) for (const row of outcome.rows) log(`  ${JSON.stringify(row)}`);
        else log(`  ok (${outcome.affected} row${outcome.affected === 1 ? "" : "s"})`);
      } catch (error) {
        const e = error as { code?: string; message?: string };
        outcome = { ok: false, code: e.code, rows: [], affected: 0 };
        log(`  ERROR ${e.code}: ${e.message}`);
      }
      outcomes[key] = outcome;
      return outcome;
    };
    const admin = async (sql: string) => {
      log(`postgres> ${sql}`);
      await db.exec(sql);
    };

    log("\n-- 1. todos: RLS and policies are right, but no grant (created after 2026-10-30)");
    await request("todos.select.nogrant", "alice", "select id, title, done from public.todos order by id");
    await request("todos.insert.nogrant", "alice", "insert into public.todos (title) values ('alice: new todo')");

    log("\n-- 2. granting only UPDATE is not enough: the filter (where id = 1) needs SELECT");
    await admin("grant update on public.todos to authenticated;");
    await request("todos.update.updateonly", "alice", "update public.todos set done = true where id = 1");
    await admin("revoke update on public.todos from authenticated;");

    const missing = findings.find((f) => f.rule === "grants-missing" && f.message.includes("public.todos"));
    if (!missing) throw new Error("grants-missing did not report public.todos");
    log("\n-- 3. the grant grants-missing printed, nothing more");
    await admin(suggestedGrant(missing.message));
    await request("todos.select.granted", "alice", "select id, title, done from public.todos order by id");
    await request("todos.insert.granted", "alice", "insert into public.todos (title) values ('alice: new todo')");
    await request("todos.update.granted", "alice", "update public.todos set done = true where id = 1");
    await request("todos.update.otheruser", "alice", "update public.todos set done = true where id = 2");
    await request("todos.select.anon", "anon", "select id, title from public.todos");

    log("\n-- 4. notes: RLS off + `grant all on public.notes to anon, authenticated` (the 42501 quick fix)");
    await request("notes.select.anon", "anon", "select id, user_id, body from public.notes order by id");
    await request("notes.update.anon", "anon", "update public.notes set body = 'changed by a stranger' where true");

    log("\n-- 5. the grant-leak fix: RLS on, an owner policy, and only the grant the app uses");
    await admin(
      "revoke all on public.notes from anon, authenticated;\n" +
        "alter table public.notes enable row level security;\n" +
        `create policy "notes: own rows" on public.notes for select to authenticated using ((select auth.uid()) = user_id);\n` +
        "grant select on public.notes to authenticated;",
    );
    await request("notes.select.anon.fixed", "anon", "select id, user_id, body from public.notes order by id");
    await request("notes.select.bob.fixed", "bob", "select id, body from public.notes order by id");
  } finally {
    await db.close();
  }

  return { transcript: out.join("\n") + "\n", findings, outcomes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { transcript } = await runRepro();
  process.stdout.write(transcript);
}
