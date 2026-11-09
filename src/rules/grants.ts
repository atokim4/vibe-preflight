import type { Finding, Rule } from "../types.ts";
import { API_ROLE_NAMES, TABLE_PRIVILEGES, type ApiRole, type GrantSource, type PolicyInfo, type TableInfo, type TablePrivilege } from "../sql.ts";
import { tableCalls } from "../usage.ts";
import { database, isTrue, publicTables } from "./database.ts";

const short = (name: string) => name.replace(/^public\./, "");
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const ordered = (privileges: Iterable<TablePrivilege>) => TABLE_PRIVILEGES.filter((p) => new Set(privileges).has(p));
const where = (s: { file: string; line: number }) => `${s.file}:${s.line}`;

const appliesTo = (p: PolicyInfo, role: ApiRole) => p.roles.includes(role) || p.roles.includes("public");
const coversCommand = (p: PolicyInfo, privilege: TablePrivilege) => p.command === privilege || p.command === "all";
const readsAuth = (expr = "") => /\bauth\.(?:uid|jwt|role)\s*\(/.test(expr);

/** A policy that lets the role write rows it doesn't own (`using (true)` / `with check (true)`). */
function openWritePolicy(t: TableInfo, privilege: TablePrivilege, role: ApiRole): PolicyInfo | undefined {
  if (privilege === "select") return undefined;
  return t.policies.find((p) => {
    if (!appliesTo(p, role) || !coversCommand(p, privilege)) return false;
    // With no `with check`, Postgres checks new rows against `using`.
    const check = p.withCheck ?? p.using;
    return privilege === "insert" ? isTrue(check) : isTrue(p.using) || (privilege === "update" && isTrue(check));
  });
}

/**
 * Anon only needs a privilege when a policy hands that command to signed-out visitors: one `to anon`, or a
 * `to public` one that doesn't depend on who is signed in (public read, an open contact form).
 */
function anonNeeds(t: TableInfo, privilege: TablePrivilege): boolean {
  return t.rls && t.policies.some(
    (p) => coversCommand(p, privilege) && (p.roles.includes("anon") || (p.roles.includes("public") && !readsAuth(p.using) && !readsAuth(p.withCheck))),
  );
}

const WHY_NO_GRANTS: Record<TableInfo["exposure"], string> = {
  "after-cutoff": "is created in a migration dated after Supabase's 2026-10-30 change, so it gets no Data API grants",
  "config-off": "is created with `auto_expose_new_tables = false` in supabase/config.toml, so it gets no Data API grants",
  "default-privileges": "is created after an `alter default privileges` that stopped the automatic Data API grants",
  auto: "had its Data API grants revoked",
};

export const grantsMissing: Rule = {
  id: "grants-missing",
  severity: "warning",
  title: "Table the app queries with no Data API grant (Supabase's 2026-10-30 change)",
  why: "Since 2026-10-30 Supabase no longer grants new `public` tables to anon, authenticated and service_role. RLS policies alone don't help: without a GRANT every supabase-js call fails with 42501 `permission denied for table`.",
  fix: "Add the smallest grant the code needs in the same migration that creates the table, e.g. `grant select, insert, update, delete on public.<name> to authenticated;`. Grant to anon only what signed-out visitors really use (`grant select on public.<name> to anon;` for public reads). Keep RLS on. Avoid `grant all` and `on all tables in schema public`.",
  check(project) {
    const tables = publicTables(project);
    const roots = [...new Set(tables.map((t) => t.root ?? ""))].sort((a, b) => b.length - a.length);
    /** App code belongs to the nearest Supabase project above it. */
    const rootOf = (file: string) => roots.find((r) => file.startsWith(r)) ?? "";
    const calls = tableCalls(project).map((c) => ({ ...c, root: rootOf(c.file) }));
    const out: Finding[] = [];
    for (const t of tables) {
      const used = calls.filter((c) => c.table === t.name && c.root === (t.root ?? ""));
      if (!used.length) continue;

      const needs = new Map<ApiRole, Set<TablePrivilege>>();
      const need = (role: ApiRole, privilege: TablePrivilege) => needs.set(role, (needs.get(role) ?? new Set()).add(privilege));
      for (const c of used)
        for (const p of c.privileges) {
          need(c.role, p);
          if (c.role === "authenticated" && anonNeeds(t, p)) need("anon", p);
        }

      const statements: string[] = [];
      for (const role of API_ROLE_NAMES) {
        const missing = ordered([...(needs.get(role) ?? [])].filter((p) => !t.grants.get(role)?.has(p)));
        if (!missing.length) continue;
        statements.push(`grant ${missing.join(", ")} on ${t.name} to ${role};`);
        if (missing.includes("insert"))
          for (const col of t.serialColumns) statements.push(`grant usage on sequence ${t.name}_${col}_seq to ${role};`);
      }
      if (!statements.length) continue;

      const first = used[0]!;
      const call = `.from('${short(t.name)}') at ${where(first)}${used.length > 1 ? ` and ${used.length - 1} more` : ""}`;
      out.push({
        rule: this.id,
        severity: this.severity,
        message:
          `\`${t.name}\` ${WHY_NO_GRANTS[t.exposure]}: supabase-js will 42501 "permission denied for table ${short(t.name)}" on ${call}. ` +
          `Minimal grant: \`${statements.join(" ")}\`` +
          (t.rls ? "" : " Enable RLS and add policies first: a grant on a table without RLS opens every row."),
        file: t.file,
        line: t.line,
      });
    }
    return out;
  },
};

interface Exposed {
  source: GrantSource;
  roles: Set<ApiRole>;
  privileges: Set<TablePrivilege>;
  /** Table → the open write policies it has, or null when RLS is off. */
  tables: Map<string, Set<PolicyInfo> | null>;
}

/** Explicit grants to anon/authenticated that reach rows RLS doesn't protect, grouped by the statement that made them. */
function leaks(tables: TableInfo[]): Exposed[] {
  const bySource = new Map<string, Exposed>();
  for (const t of tables) {
    for (const role of ["anon", "authenticated"] as const) {
      for (const [privilege, source] of t.grants.get(role) ?? []) {
        if (source.kind === "platform") continue;
        const policy = t.rls ? openWritePolicy(t, privilege, role) : undefined;
        if (t.rls && !policy) continue;
        const key = where(source);
        const entry = bySource.get(key) ?? { source, roles: new Set(), privileges: new Set(), tables: new Map() };
        entry.roles.add(role);
        entry.privileges.add(privilege);
        if (!policy) entry.tables.set(t.name, null);
        else entry.tables.set(t.name, (entry.tables.get(t.name) ?? new Set()).add(policy));
        bySource.set(key, entry);
      }
    }
  }
  return [...bySource.values()];
}

const STATEMENT: Record<GrantSource["kind"], string> = {
  table: "This grant",
  schema: "This `on all tables in schema public` grant",
  default: "This `alter default privileges` grant",
  platform: "",
};

export const grantLeak: Rule = {
  id: "grant-leak",
  severity: "error",
  title: "Grant to anon/authenticated on a table RLS doesn't protect",
  why: "A GRANT opens a table to the Data API and RLS decides which rows each request sees. A grant on a table with RLS off, or with a `using (true)` write policy, lets anyone with the anon key (or any signed-up user) read and rewrite every row. This is the usual AI fix for 42501 errors after Supabase's 2026-10-30 change.",
  fix: "Turn RLS on (`alter table public.<name> enable row level security;`), replace `true` in write policies with an ownership check like `(select auth.uid()) = user_id`, and grant only the commands the app uses to the role that uses them: `grant select, insert, update, delete on public.<name> to authenticated;`. Revoke the rest: `revoke all on public.<name> from anon;`.",
  check(project) {
    return leaks(publicTables(project)).map((e) => {
      const tables = [...e.tables];
      const why = (policies: Set<PolicyInfo> | null) =>
        policies === null
          ? "RLS is off"
          : `${policies.size > 1 ? "policies" : "policy"} ${list([...policies].map((p) => `"${p.name}" (${p.command})`))} ${policies.size > 1 ? "use" : "uses"} \`true\``;
      const shown = tables.slice(0, 3).map(([name, policies]) => `\`${name}\` (${why(policies)})`);
      const more = tables.length > 3 ? ` and ${tables.length - 3} more` : "";
      const who = e.roles.has("anon") ? "anyone with the anon key" : "any signed-in user";
      const privileges = ordered(e.privileges);
      const reads = privileges.includes("select");
      const writes = privileges.some((p) => p !== "select");
      const harm = tables.some(([, policies]) => policies === null)
        ? `can ${reads && writes ? "read and change" : reads ? "read" : "change"} every row`
        : "can write rows that belong to other users";
      return {
        rule: this.id,
        severity: this.severity,
        message: `${STATEMENT[e.source.kind]} gives ${list([...e.roles])} ${privileges.join(", ")} on ${list(shown)}${more}: ${who} ${harm}.`,
        file: e.source.file,
        line: e.source.line,
      };
    });
  },
};

export const grantBroad: Rule = {
  id: "grant-broad",
  severity: "warning",
  title: "Blanket grant on every table in `public`",
  why: "`grant … on all tables in schema public` and `alter default privileges … grant … on tables` hand every table to the Data API roles, which undoes Supabase's 2026-10-30 change. Internal tables, queues and audit logs become reachable as soon as their RLS slips.",
  fix: "Grant per table, next to the `create table`, with only what the app uses: `grant select on public.<name> to anon;` for public reads, `grant select, insert, update, delete on public.<name> to authenticated;` for user data. Server-only tables get `grant … to service_role` and nothing for anon/authenticated.",
  check(project) {
    const db = database(project);
    const leaking = new Set(leaks(publicTables(project)).map((e) => where(e.source)));
    return db.blanketGrants
      .filter((g) => g.roles.some((r) => r !== "service_role") && !leaking.has(where(g)))
      .map((g) => ({
        rule: this.id,
        severity: this.severity,
        message:
          g.kind === "schema"
            ? `Grants ${g.privileges.join(", ")} on every table in \`public\` to ${list(g.roles)}, which undoes Supabase's 2026-10-30 change for all of them. Grant per table instead.`
            : `Turns automatic grants back on for every future table in \`public\` (${g.privileges.join(", ")} to ${list(g.roles)}), which undoes Supabase's 2026-10-30 change. Grant per table instead.`,
        file: g.file,
        line: g.line,
      }));
  },
};
