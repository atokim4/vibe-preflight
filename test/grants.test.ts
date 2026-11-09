import { afterAll, describe, expect, it } from "vitest";
import { cleanup, findings, NEXT_SUPABASE, only, project } from "./helpers.ts";
import { autoExposeSetting, migrationStamp, tablePrivileges } from "../src/sql.ts";

afterAll(cleanup);

const AFTER = "supabase/migrations/20261102120000_todos.sql";
const BEFORE = "supabase/migrations/20260901000000_todos.sql";

const TODOS =
  "create table public.todos (id uuid primary key default gen_random_uuid(), user_id uuid not null, title text);\n" +
  "alter table public.todos enable row level security;\n" +
  "create policy own on public.todos for all to authenticated using ((select auth.uid()) = user_id);\n";

const CLIENT_TODOS = `"use client";
import { supabase } from "@/lib/supabase";
export async function load() {
  const { data } = await supabase.from("todos").select("*");
  await supabase.from('todos').insert({ title: "x" });
  return data;
}
`;

const app = (files: Record<string, string>) => project({ ...NEXT_SUPABASE, ...files });
const of = (files: Record<string, string>, rule: string) => only(findings(app(files)), rule);
const messages = (files: Record<string, string>, rule: string) => of(files, rule).map((f) => f.message);

describe("sql helpers", () => {
  it("reads the timestamp a migration file name starts with", () => {
    expect(migrationStamp("supabase/migrations/20261102120000_todos.sql")).toBe("20261102120000");
    expect(migrationStamp("supabase/migrations/20261102_todos.sql")).toBe("20261102000000");
    expect(migrationStamp("supabase/migrations/001.sql")).toBeUndefined();
  });

  it("reads [api] auto_expose_new_tables from config.toml", () => {
    expect(autoExposeSetting('[api]\nenabled = true\nauto_expose_new_tables = false # opt in\n[db]\nport = 54322')).toBe(false);
    expect(autoExposeSetting("[db]\nauto_expose_new_tables = false")).toBeUndefined();
    expect(autoExposeSetting(undefined)).toBeUndefined();
  });

  it("expands privilege lists", () => {
    expect(tablePrivileges("all privileges")).toEqual(["select", "insert", "update", "delete"]);
    expect(tablePrivileges("select, update (display_name), truncate")).toEqual(["select", "update"]);
  });
});

describe("grants-missing", () => {
  it("warns on a table created after 2026-10-30 that client code uses, with the exact minimal grant", () => {
    const list = of({ [AFTER]: TODOS, "app/todos.tsx": CLIENT_TODOS }, "grants-missing");
    expect(list.map((f) => `${f.severity} ${f.file}:${f.line}`)).toEqual([`warning ${AFTER}:1`]);
    expect(list[0]!.message).toContain('will 42501 "permission denied for table todos"');
    expect(list[0]!.message).toContain(".from('todos') at app/todos.tsx:4 and 1 more");
    expect(list[0]!.message).toContain("`grant select, insert on public.todos to authenticated;`");
    expect(list[0]!.message).not.toContain("anon");
  });

  it("stays quiet for tables from before the change, which kept Supabase's automatic grants", () => {
    expect(of({ [BEFORE]: TODOS, "app/todos.tsx": CLIENT_TODOS }, "grants-missing")).toEqual([]);
  });

  it("stays quiet when the grant is there, and names only what is still missing", () => {
    const full = TODOS + "grant select, insert on table public.todos to authenticated;";
    expect(of({ [AFTER]: full, "app/todos.tsx": CLIENT_TODOS }, "grants-missing")).toEqual([]);
    const selectOnly = TODOS + "grant select on public.todos to authenticated;";
    expect(messages({ [AFTER]: selectOnly, "app/todos.tsx": CLIENT_TODOS }, "grants-missing")[0]).toContain(
      "`grant insert on public.todos to authenticated;`",
    );
  });

  it("adds select for update and delete, since their filters read columns", () => {
    const code = `"use client";\nexport const done = (id) => supabase.from("todos").update({ title: "y" }).eq("id", id);\n`;
    expect(messages({ [AFTER]: TODOS, "app/done.tsx": code }, "grants-missing")[0]).toContain(
      "`grant select, update on public.todos to authenticated;`",
    );
  });

  it("applies to every migration when config.toml opts out of auto-exposure", () => {
    const config = "[api]\nenabled = true\nauto_expose_new_tables = false\n";
    const msg = messages({ [BEFORE]: TODOS, "supabase/config.toml": config, "app/todos.tsx": CLIENT_TODOS }, "grants-missing");
    expect(msg).toEqual([expect.stringContaining("`auto_expose_new_tables = false` in supabase/config.toml")]);
  });

  it("follows alter default privileges in the migrations", () => {
    const optIn =
      "alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;\n";
    const msg = messages({ [BEFORE]: optIn + TODOS, "app/todos.tsx": CLIENT_TODOS }, "grants-missing");
    expect(msg).toEqual([expect.stringContaining("after an `alter default privileges`")]);
    const restore =
      "alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;\n";
    expect(of({ [AFTER]: restore + TODOS, "app/todos.tsx": CLIENT_TODOS }, "grants-missing")).toEqual([]);
  });

  it("grants anon only what a signed-out policy allows", () => {
    const posts =
      "create table public.posts (id int primary key, body text, author uuid);\nalter table public.posts enable row level security;\n" +
      'create policy "public read" on public.posts for select to anon, authenticated using (true);\n' +
      "create policy own on public.posts for insert with check ((select auth.uid()) = author);\n";
    const code = `"use client";\nexport const list = () => supabase.from("posts").select("*");\nexport const add = (b) => supabase.from("posts").insert({ body: b });\n`;
    const msg = messages({ [AFTER]: posts, "app/posts.tsx": code }, "grants-missing")[0];
    expect(msg).toContain("`grant select on public.posts to anon; grant select, insert on public.posts to authenticated;`");
  });

  it("grants service_role for server code that uses the service role key", () => {
    const route = `import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export async function POST() { await admin.from("todos").delete().eq("id", 1); }
`;
    expect(messages({ [AFTER]: TODOS, "app/api/purge/route.ts": route }, "grants-missing")[0]).toContain(
      "`grant select, delete on public.todos to service_role;`",
    );
  });

  it("counts .schema('public').from(...)", () => {
    const code = `"use client";\nexport const l = () => supabase.schema('public').from("todos").select();\n`;
    expect(of({ [AFTER]: TODOS, "app/l.tsx": code }, "grants-missing")).toHaveLength(1);
  });

  it("adds the sequence grant for serial columns", () => {
    const sql = "create table public.logs (id bigserial primary key, msg text);\nalter table public.logs enable row level security;\n";
    const code = `"use client";\nexport const log = (m) => supabase.from("logs").insert({ msg: m });\n`;
    expect(messages({ [AFTER]: sql, "app/log.tsx": code }, "grants-missing")[0]).toContain(
      "`grant insert on public.logs to authenticated; grant usage on sequence public.logs_id_seq to authenticated;`",
    );
  });

  it("tells you to enable RLS first when it is off", () => {
    const sql = "create table public.todos (id int, title text);\n";
    expect(messages({ [AFTER]: sql, "app/todos.tsx": CLIENT_TODOS }, "grants-missing")[0]).toContain("Enable RLS and add policies first");
  });

  it("ignores storage buckets, Array.from and tables no code queries", () => {
    const code = `"use client";\nexport const up = (f) => supabase.storage.from("todos").upload("a", f);\nexport const xs = Array.from("todos");\nexport const b = () => supabase.schema("billing").from("todos").select();\n`;
    expect(of({ [AFTER]: TODOS, "app/up.tsx": code }, "grants-missing")).toEqual([]);
    expect(of({ [AFTER]: TODOS }, "grants-missing")).toEqual([]);
  });
});

describe("grant-leak", () => {
  const NOTES = "create table public.notes (id int primary key, user_id uuid, body text);\n";

  it("errors on grant all to anon on a table with RLS off", () => {
    const list = of({ [AFTER]: NOTES + "grant all on public.notes to anon;" }, "grant-leak");
    expect(list.map((f) => `${f.severity} ${f.line}`)).toEqual(["error 2"]);
    expect(list[0]!.message).toBe(
      "This grant gives anon select, insert, update, delete on `public.notes` (RLS is off): anyone with the anon key can read and change every row.",
    );
  });

  it("errors on a write grant when the write policy is using (true)", () => {
    const rls = NOTES + "alter table public.notes enable row level security;\n";
    const open = rls + "create policy w on public.notes for update to authenticated using (true);\ngrant select, update on public.notes to authenticated;";
    expect(messages({ [AFTER]: open }, "grant-leak")).toEqual([
      'This grant gives authenticated update on `public.notes` (policy "w" (update) uses `true`): any signed-in user can write rows that belong to other users.',
    ]);
    const owned = rls + "create policy w on public.notes for update to authenticated using ((select auth.uid()) = user_id);\ngrant select, update on public.notes to authenticated;";
    expect(of({ [AFTER]: owned }, "grant-leak")).toEqual([]);
  });

  it("allows a select grant to anon behind a public-read policy", () => {
    const sql = NOTES + "alter table public.notes enable row level security;\ncreate policy r on public.notes for select to anon using (true);\ngrant select on public.notes to anon;";
    expect(of({ [AFTER]: sql }, "grant-leak")).toEqual([]);
  });

  it("errors once per blanket statement and lists the tables it opens", () => {
    const sql = NOTES + "create table public.jobs (id int);\nalter table public.jobs enable row level security;\ngrant select, insert, update, delete on all tables in schema public to anon, authenticated;";
    const files = { [AFTER]: sql };
    expect(messages(files, "grant-leak")).toEqual([
      "This `on all tables in schema public` grant gives anon and authenticated select, insert, update, delete on `public.notes` (RLS is off): anyone with the anon key can read and change every row.",
    ]);
    expect(of(files, "grant-broad")).toEqual([]);
  });

  it("errors on alter default privileges grant all to anon once a table without RLS is created after it", () => {
    const sql = "alter default privileges in schema public grant all on tables to anon;\n" + NOTES;
    expect(of({ [AFTER]: sql }, "grant-leak").map((f) => `${f.severity} ${f.line}`)).toEqual(["error 1"]);
  });

  it("leaves Supabase's own pre-change grants to rls-disabled", () => {
    expect(of({ [BEFORE]: NOTES }, "grant-leak")).toEqual([]);
    expect(of({ [BEFORE]: NOTES }, "rls-disabled")).toHaveLength(1);
  });
});

describe("monorepos", () => {
  it("replays each supabase/ folder on its own and matches code to the nearest one", () => {
    const files = {
      "packages/fixtures/supabase/migrations/20260101000000_users.sql": "create table public.users (id int primary key);\n",
      "packages/app/supabase/migrations/20261102000000_users.sql":
        "create table public.users (id int primary key);\nalter table public.users enable row level security;\n" +
        "grant select, insert, update, delete on all tables in schema public to anon, authenticated;\n",
      "packages/app/src/users.tsx": `"use client";\nexport const u = () => supabase.from("users").select("*");\n`,
    };
    // The fixture's RLS-off table doesn't leak through the app's blanket grant, and the app's table is granted.
    expect(of(files, "grant-leak")).toEqual([]);
    expect(of(files, "grants-missing")).toEqual([]);
    expect(of(files, "grant-broad").map((f) => f.file)).toEqual(["packages/app/supabase/migrations/20261102000000_users.sql"]);
    expect(of(files, "rls-disabled").map((f) => f.file)).toEqual(["packages/fixtures/supabase/migrations/20260101000000_users.sql"]);
  });
});

describe("grant-broad", () => {
  it("warns on the rollback snippet when the tables have RLS", () => {
    const sql =
      TODOS +
      "alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;\n" +
      "grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;\n";
    const list = of({ [AFTER]: sql }, "grant-broad");
    expect(list.map((f) => `${f.severity} ${f.line}`)).toEqual(["warning 4", "warning 5"]);
    expect(list[0]!.message).toContain("every future table");
    expect(list[1]!.message).toContain("every table in `public`");
  });

  it("ignores blanket grants to service_role only and other schemas", () => {
    const sql = TODOS + "grant all on all tables in schema public to service_role;\ngrant select on all tables in schema reporting to anon;";
    expect(of({ [AFTER]: sql }, "grant-broad")).toEqual([]);
  });
});
