import type { Finding, Project, Rule } from "../types.ts";
import { buildSchema, type TableInfo } from "../sql.ts";

const cache = new WeakMap<Project, TableInfo[]>();

/** Tables in `public` after replaying the migrations. Empty for non-Supabase apps: plain Postgres tables aren't exposed to browsers. */
function publicTables(project: Project): TableInfo[] {
  let tables = cache.get(project);
  if (!tables) {
    const sql = project.usesSupabase ? project.files.filter((f) => f.kind === "sql") : [];
    tables = [...buildSchema(sql).values()].filter((t) => t.name.startsWith("public."));
    cache.set(project, tables);
  }
  return tables;
}

const isTrue = (expr?: string) => expr !== undefined && /^\(*\s*true\s*\)*$/.test(expr);

export const rlsDisabled: Rule = {
  id: "rls-disabled",
  severity: "error",
  title: "Supabase table in the public schema without Row Level Security",
  why: "Supabase serves every table in `public` through its REST API, and the anon key ships in your frontend. Without RLS anyone holding that key can read and change every row.",
  fix: "Add `alter table public.<name> enable row level security;` in a new migration, then add policies for the access you actually want (usually `(select auth.uid()) = user_id`).",
  check(project) {
    return publicTables(project)
      .filter((t) => !t.rls)
      .map((t) => ({
        rule: this.id,
        severity: this.severity,
        message: `\`${t.name}\` is created without \`enable row level security\` in any migration.`,
        file: t.file,
        line: t.line,
      }));
  },
};

export const rlsPermissivePolicy: Rule = {
  id: "rls-permissive-policy",
  severity: "error",
  title: "Policy that allows everything (`using (true)` / `with check (true)`)",
  why: "These are the dashboard's template policies. On insert/update/delete they let a user write rows that belong to someone else; on select they show every user's rows to everyone.",
  fix: "Replace `true` with an ownership check such as `(select auth.uid()) = user_id` and scope the policy `to authenticated`. Keep `using (true)` on select only for data that is meant to be public, and mark that line with `-- vibe-preflight-ignore rls-permissive-policy`.",
  check(project) {
    const out: Finding[] = [];
    for (const t of publicTables(project)) {
      for (const p of t.policies) {
        const openRead = (p.command === "select" || p.command === "all") && isTrue(p.using);
        const openWrite =
          (p.command !== "select" && isTrue(p.withCheck)) ||
          ((p.command === "update" || p.command === "delete" || p.command === "all") && isTrue(p.using));
        if (!openRead && !openWrite) continue;
        if (p.roles.every((r) => r === "service_role")) continue;
        const who =
          p.roles.includes("public") || p.roles.includes("anon")
            ? "anyone (signed in or not)"
            : p.roles.includes("authenticated")
              ? "any signed-in user"
              : `the ${p.roles.join(", ")} role`;
        out.push({
          rule: this.id,
          // A public read can be on purpose (a blog, a product catalogue); an open write almost never is.
          severity: openWrite ? "error" : "warning",
          message: `Policy "${p.name}" on \`${t.name}\` (${p.command}) lets ${who} ${openWrite ? "write rows on behalf of any user" : "read every row"}.`,
          file: p.file,
          line: p.line,
        });
      }
    }
    return out;
  },
};
