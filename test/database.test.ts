import { afterAll, describe, expect, it } from "vitest";
import { cleanup, findings, NEXT_SUPABASE, only, project } from "./helpers.ts";

afterAll(cleanup);

const migration = (sql: string) => project({ ...NEXT_SUPABASE, "supabase/migrations/001.sql": sql });
const lines = (sql: string, rule: string) => only(findings(migration(sql)), rule).map((f) => `${f.severity} ${f.line}`);

describe("rls-no-policy", () => {
  it("warns on a public table with RLS on and no policies", () => {
    const sql = "create table public.flags (key text primary key);\nalter table public.flags enable row level security;";
    expect(lines(sql, "rls-no-policy")).toEqual(["warning 1"]);
    expect(only(findings(migration(sql)), "rls-no-policy")[0]!.message).toContain("`public.flags`");
  });

  it("stays quiet once a policy exists, and leaves RLS-off tables to rls-disabled", () => {
    const sql =
      "create table public.a (id int); alter table public.a enable row level security;\n" +
      "create policy r on public.a for select to authenticated using (true);\n" +
      "create table public.b (id int);";
    expect(lines(sql, "rls-no-policy")).toEqual([]);
  });
});

describe("rls-update-privileged-column", () => {
  const table =
    "create table public.profiles (\n  id uuid primary key,\n  display_name text,\n  plan text not null default 'free',\n  constraint plan_ok check (plan in ('free', 'pro'))\n);\n" +
    "alter table public.profiles enable row level security;\n";
  const update = "create policy own on public.profiles for update to authenticated using ((select auth.uid()) = id);\n";

  it("warns when users can update their own row and the row has a billing or role column", () => {
    const list = only(findings(migration(table + update)), "rls-update-privileged-column");
    expect(list.map((f) => `${f.severity} ${f.line}`)).toEqual(["warning 8"]);
    expect(list[0]!.message).toContain("`plan`");
  });

  it("also counts a column added later and an `all` policy", () => {
    const sql =
      "create table public.accounts (id uuid primary key, name text); alter table public.accounts enable row level security;\n" +
      "alter table public.accounts add column if not exists is_admin boolean default false;\n" +
      "create policy own on public.accounts for all to authenticated using ((select auth.uid()) = id);";
    expect(only(findings(migration(sql)), "rls-update-privileged-column").map((f) => f.message)).toEqual([
      expect.stringContaining("`is_admin`"),
    ]);
  });

  it("accepts column-level privileges or a before-update trigger", () => {
    const revoke = "revoke update on public.profiles from authenticated;\ngrant update (display_name) on public.profiles to authenticated;";
    const trigger =
      "create trigger keep_plan before update on public.profiles for each row execute function private.keep_plan();";
    expect(lines(table + update + revoke, "rls-update-privileged-column")).toEqual([]);
    expect(lines(table + update + trigger, "rls-update-privileged-column")).toEqual([]);
  });

  it("ignores tables without such columns and service_role-only policies", () => {
    const notes =
      "create table public.notes (id int, user_id uuid, body text); alter table public.notes enable row level security;\n" +
      "create policy own on public.notes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);\n";
    const svc = "create policy svc on public.profiles for update to service_role using (true);";
    expect(lines(notes, "rls-update-privileged-column")).toEqual([]);
    expect(lines(table + svc, "rls-update-privileged-column")).toEqual([]);
  });
});

describe("view-bypasses-rls", () => {
  it("flags a public view without security_invoker", () => {
    const sql = "create table public.notes (id int, user_id uuid);\ncreate view public.recent as select id from public.notes;";
    expect(lines(sql, "view-bypasses-rls")).toEqual(["error 2"]);
  });

  it("accepts security_invoker on create or a later alter, a revoked view and other schemas", () => {
    const sql = [
      "create view public.a with (security_invoker = true) as select 1;",
      "create or replace view public.b with (security_invoker=on) as select 1;",
      "create view public.c as select 1;",
      "alter view public.c set (security_invoker = true);",
      "create view public.d as select 1;",
      "revoke all on public.d from anon, authenticated;",
      "create view private.e as select 1;",
      "create view public.f as select 1;",
      "drop view public.f;",
    ].join("\n");
    expect(lines(sql, "view-bypasses-rls")).toEqual([]);
  });

  it("always flags a materialized view in public (RLS can't apply to it)", () => {
    expect(lines("create materialized view public.stats as select 1;", "view-bypasses-rls")).toEqual(["error 1"]);
  });
});

describe("auth-users-exposed", () => {
  it("flags a public view that reads auth.users, even with security_invoker", () => {
    const sql =
      "create view public.directory as select id, email from auth.users;\n" +
      'create view public.people with (security_invoker = true) as select u.id from public.notes n join "auth"."users" u on u.id = n.user_id;';
    expect(lines(sql, "auth-users-exposed")).toEqual(["error 1", "error 2"]);
  });

  it("is fine once anon and authenticated lose access, or in another schema", () => {
    const sql =
      "create view public.directory as select id, email from auth.users;\nrevoke select on public.directory from anon, authenticated;\n" +
      "create view private.directory as select id, email from auth.users;";
    expect(lines(sql, "auth-users-exposed")).toEqual([]);
  });
});

describe("definer-search-path", () => {
  it("warns on a SECURITY DEFINER function without a fixed search_path", () => {
    const sql = "create function public.stats()\nreturns int\nlanguage sql\nsecurity definer\nas $$ select 1 $$;";
    expect(lines(sql, "definer-search-path")).toEqual(["warning 1"]);
  });

  it("accepts set search_path on create or a later alter, and invoker functions", () => {
    const sql = [
      "create function public.a() returns int language sql security definer set search_path = '' as $$ select 1 $$;",
      "create or replace function public.b(x int) returns int language sql security definer as $$ select 1 $$;",
      "alter function public.b(int) set search_path = public, pg_temp;",
      "create function public.c() returns int language sql as $$ select 1 $$;",
    ].join("\n");
    expect(lines(sql, "definer-search-path")).toEqual([]);
  });
});

describe("definer-function-anon", () => {
  const fn = "create function public.set_plan(u uuid, p text) returns void language plpgsql security definer set search_path = '' as $$ begin end $$;\n";

  it("is an error when anon is granted EXECUTE explicitly", () => {
    const list = only(findings(migration(fn + "grant execute on function public.set_plan(uuid, text) to anon, authenticated;")), "definer-function-anon");
    expect(list.map((f) => `${f.severity} ${f.line}`)).toEqual(["error 2"]);
    expect(list[0]!.message).toContain("/rest/v1/rpc/set_plan");
  });

  it("is a warning when only Supabase's default privileges let anon call it", () => {
    expect(lines(fn, "definer-function-anon")).toEqual(["warning 1"]);
    // Revoking from public alone leaves the direct grant that Supabase gives anon.
    expect(lines(fn + "revoke execute on function public.set_plan(uuid, text) from public;", "definer-function-anon")).toEqual(["warning 1"]);
  });

  it("accepts a revoke from anon, trigger functions and default privileges revoked up front", () => {
    const revoked = fn + "revoke execute on function public.set_plan(uuid, text) from public, anon;";
    const trigger = "create function public.on_signup() returns trigger language plpgsql security definer set search_path = '' as $$ begin return new; end $$;";
    const defaults =
      "alter default privileges in schema public revoke execute on functions from public, anon;\n" + fn;
    expect(lines(revoked, "definer-function-anon")).toEqual([]);
    expect(lines(trigger, "definer-function-anon")).toEqual([]);
    expect(lines(defaults, "definer-function-anon")).toEqual([]);
  });

  it("flags a grant to anon that comes after a revoke", () => {
    const sql = fn + "revoke execute on function public.set_plan(uuid, text) from public, anon;\ngrant execute on function public.set_plan to anon;";
    expect(lines(sql, "definer-function-anon")).toEqual(["error 3"]);
  });
});

describe("storage-public-bucket", () => {
  it("warns on a public bucket and errors when anyone can also list it", () => {
    const sql =
      "insert into storage.buckets (id, name, public)\nvalues ('invoices', 'invoices', true), ('logos', 'logos', true), ('private', 'private', false);\n" +
      "create policy \"list\" on storage.objects for select using (bucket_id = 'invoices');";
    const list = only(findings(migration(sql)), "storage-public-bucket");
    expect(list.map((f) => `${f.severity} ${f.line} ${f.message.slice(0, 22)}`)).toEqual([
      "error 1 Storage bucket `invoic",
      "warning 1 Storage bucket `logos`",
    ]);
    expect(list[0]!.message).toContain("list every file");
  });

  it("follows update storage.buckets and accepts owner-scoped listing", () => {
    const sql =
      "insert into storage.buckets (id, name) values ('docs', 'docs');\nupdate storage.buckets set public = true where id = 'docs';\n" +
      "create policy own on storage.objects for select to authenticated using (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);\n" +
      "insert into storage.buckets (id, name, public) values ('tmp', 'tmp', true);\nupdate storage.buckets set public = false where id = 'tmp';";
    expect(lines(sql, "storage-public-bucket")).toEqual(["warning 2"]);
  });
});
