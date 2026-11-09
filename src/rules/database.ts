import type { Finding, Project, Rule, SourceFile } from "../types.ts";
import { autoExposeSetting, buildDatabase, type Database, type PolicyInfo, type TableInfo } from "../sql.ts";

const cache = new WeakMap<Project, Database>();

/**
 * The folder a migration belongs to: everything before its `supabase/` segment. A monorepo can hold several
 * Supabase projects (an app and a test fixture), and their tables must not mix.
 */
export function supabaseRoot(path: string): string {
  const i = path.startsWith("supabase/") ? 0 : path.indexOf("/supabase/");
  return i === -1 ? "" : path.slice(0, i === 0 ? 0 : i + 1);
}

/**
 * The schema after replaying the migrations, each Supabase project on its own. Empty for non-Supabase apps:
 * plain Postgres isn't exposed to browsers, so none of the database checks apply there.
 */
export function database(project: Project): Database {
  let db = cache.get(project);
  if (db) return db;
  const groups = new Map<string, SourceFile[]>();
  if (project.usesSupabase)
    for (const f of project.files.filter((f) => f.kind === "sql")) {
      const root = supabaseRoot(f.path);
      groups.set(root, [...(groups.get(root) ?? []), f]);
    }
  db = { tables: new Map(), blanketGrants: [], views: new Map(), functions: new Map(), buckets: new Map(), storagePolicies: [] };
  for (const [root, files] of groups) {
    const config = project.byPath.get(`${root}supabase/config.toml`);
    const part = buildDatabase(files, { autoExposeNewTables: autoExposeSetting(config?.text) });
    const key = (name: string) => (groups.size > 1 ? `${root}\0${name}` : name);
    for (const t of part.tables.values()) db.tables.set(key(t.name), { ...t, root });
    for (const v of part.views.values()) db.views.set(key(v.name), v);
    for (const f of part.functions.values()) db.functions.set(key(f.name), f);
    for (const b of part.buckets.values()) db.buckets.set(key(b.id), b);
    db.blanketGrants.push(...part.blanketGrants);
    db.storagePolicies.push(...part.storagePolicies);
  }
  cache.set(project, db);
  return db;
}

/** Supabase's Data API serves the `public` schema by default. */
const inPublic = (name: string) => name.startsWith("public.");
export const publicTables = (project: Project): TableInfo[] => [...database(project).tables.values()].filter((t) => inPublic(t.name));
const forApiUsers = (p: PolicyInfo) => p.roles.some((r) => r === "public" || r === "anon" || r === "authenticated");
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const short = (name: string) => name.replace(/^public\./, "");

export const isTrue = (expr?: string) => expr !== undefined && /^\(*\s*true\s*\)*$/.test(expr);

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

export const rlsNoPolicy: Rule = {
  id: "rls-no-policy",
  severity: "warning",
  title: "Table with RLS on and no policies",
  why: "RLS with no policies denies every API request. That is right for a server-only table, but if the app reads it with the anon key the query silently returns no rows.",
  fix: "If the browser should read it, add the narrowest policy that fits, e.g. `create policy \"read flags\" on public.<name> for select to anon, authenticated using (true);` for public config. If only the server uses it, keep it as is and mark the table with `-- vibe-preflight-ignore rls-no-policy`.",
  check(project) {
    return publicTables(project)
      .filter((t) => t.rls && t.policies.length === 0)
      .map((t) => ({
        rule: this.id,
        severity: this.severity,
        message: `\`${t.name}\` has RLS on and no policies: every API read and write is denied.`,
        file: t.file,
        line: t.line,
      }));
  },
};

/** Columns that decide what a user has paid for or may do. A user who can update their own row must not set these. */
const PRIVILEGED_COLUMN =
  /^(?:plan|plan_id|tier|pricing_tier|subscription|subscription_(?:status|tier|plan|id)|stripe_(?:customer|subscription|price)_id|is_?(?:admin|pro|premium|paid|verified|staff|superuser)|admin|premium|role|roles|user_role|credits?|balance|quota|usage_limit)$/;

export const rlsUpdatePrivilegedColumn: Rule = {
  id: "rls-update-privileged-column",
  severity: "warning",
  title: "Users can update their own row, including a plan, role or billing column",
  why: "An update policy decides which rows a user may change, not which columns. If the row holds `plan`, `role` or `is_admin`, a user can call the API with their own key and upgrade themselves.",
  fix: "Limit the columns: `revoke update on public.<name> from authenticated; grant update (display_name, avatar_url) on public.<name> to authenticated;`. Or move the privileged columns to a table users can't write, or reset them in a `before update` trigger. Change them only from the server (service role) after a verified payment.",
  check(project) {
    const out: Finding[] = [];
    for (const t of publicTables(project)) {
      if (!t.rls || t.columnPrivileges || t.beforeUpdateTrigger) continue;
      const columns = t.columns.filter((c) => PRIVILEGED_COLUMN.test(c));
      if (!columns.length) continue;
      const policy = t.policies.find((p) => (p.command === "update" || p.command === "all") && forApiUsers(p));
      if (!policy) continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        message: `Policy "${policy.name}" lets users update their row in \`${t.name}\`, including ${list(columns.map((c) => `\`${c}\``))}. No column privilege or trigger stops them.`,
        file: policy.file,
        line: policy.line,
      });
    }
    return out;
  },
};

const apiCanRead = (v: { revoked: Set<string> }) => !(v.revoked.has("anon") && v.revoked.has("authenticated"));

export const viewBypassesRls: Rule = {
  id: "view-bypasses-rls",
  severity: "error",
  title: "View in `public` that runs with its owner's rights",
  why: "A Postgres view runs as the user who created it, and on Supabase that user skips RLS. Unless it is created `with (security_invoker = true)`, the view returns rows from every user even when the table below it is locked down. Materialized views can't apply RLS at all.",
  fix: "Postgres 15+: `alter view public.<name> set (security_invoker = true);`. For a materialized view, move it to a schema the API doesn't serve, or `revoke select on public.<name> from anon, authenticated;` and read it from the server.",
  check(project) {
    return [...database(project).views.values()]
      .filter((v) => inPublic(v.name) && apiCanRead(v) && (v.materialized || !v.securityInvoker))
      .map((v) => ({
        rule: this.id,
        severity: this.severity,
        message: v.materialized
          ? `Materialized view \`${v.name}\` is served by the API and RLS doesn't apply to it.`
          : `View \`${v.name}\` has no \`security_invoker\`, so it reads the tables below it without RLS.`,
        file: v.file,
        line: v.line,
      }));
  },
};

export const authUsersExposed: Rule = {
  id: "auth-users-exposed",
  severity: "error",
  title: "View in `public` that reads `auth.users`",
  why: "`auth.users` holds every user's email, phone and sign-in metadata. A view over it in `public` puts that on the API for anyone with the anon key (or any signed-in user).",
  fix: "Keep the fields you want to share (e.g. a display name) in a `public.profiles` table with RLS, filled by a trigger on sign-up. Drop the view, or move it to a private schema and `revoke select on public.<name> from anon, authenticated;`.",
  check(project) {
    return [...database(project).views.values()]
      .filter((v) => inPublic(v.name) && v.readsAuthUsers && apiCanRead(v))
      .map((v) => ({
        rule: this.id,
        severity: this.severity,
        message: `View \`${v.name}\` selects from \`auth.users\` and the API serves it.`,
        file: v.file,
        line: v.line,
      }));
  },
};

export const definerSearchPath: Rule = {
  id: "definer-search-path",
  severity: "warning",
  title: "SECURITY DEFINER function without a fixed `search_path`",
  why: "A SECURITY DEFINER function runs with its owner's rights. Without a fixed search_path, an unqualified name in its body can resolve to an object the caller controls.",
  fix: "Add `set search_path = ''` to the function and write every name with its schema (`public.profiles`, `auth.uid()`), or run `alter function public.<name>(<args>) set search_path = '';`.",
  check(project) {
    return [...database(project).functions.values()]
      .filter((f) => f.securityDefiner && !f.searchPath)
      .map((f) => ({
        rule: this.id,
        severity: this.severity,
        message: `\`${f.name}()\` is SECURITY DEFINER and doesn't set search_path.`,
        file: f.file,
        line: f.line,
      }));
  },
};

export const definerFunctionAnon: Rule = {
  id: "definer-function-anon",
  severity: "error",
  title: "SECURITY DEFINER function anyone can call over the API",
  why: "Supabase exposes functions in `public` at /rest/v1/rpc/<name>, and new functions there are executable by anon. A SECURITY DEFINER function skips RLS, so anyone with the anon key gets whatever it does.",
  fix: "`revoke execute on function public.<name>(<args>) from public, anon;` and grant it only to `authenticated` (and check `auth.uid()` inside), or to `service_role` for admin work. Revoking from `public` alone isn't enough on Supabase: anon has its own grant.",
  check(project) {
    return [...database(project).functions.values()]
      .filter((f) => inPublic(f.name) && f.securityDefiner && !f.returnsTrigger && f.executors.has("anon"))
      .map((f) => {
        const explicit = f.anonGrant !== undefined;
        const where = f.anonGrant ?? { file: f.file, line: f.line };
        return {
          rule: this.id,
          severity: explicit ? ("error" as const) : ("warning" as const),
          message: `\`${f.name}()\` is SECURITY DEFINER and anon can call it at /rest/v1/rpc/${short(f.name)}${explicit ? " (granted explicitly)" : " (Supabase's default grant was never revoked)"}.`,
          ...where,
        };
      });
  },
};

const bucketOf = (expr = "") => /\bbucket_id\s*=\s*'([^']+)'/.exec(expr)?.[1];
const scopedToUser = (expr = "") => /\bauth\.(?:uid|jwt)\s*\(/.test(expr);

export const storagePublicBucket: Rule = {
  id: "storage-public-bucket",
  severity: "error",
  title: "Public storage bucket",
  why: "Every file in a public bucket can be downloaded by anyone who has or guesses its URL, with no auth check. With a select policy on storage.objects that isn't scoped to the user, anyone can also list the bucket and find every file.",
  fix: "For private files (invoices, uploads, exports): `update storage.buckets set public = false where id = '<bucket>';`, scope select to the owner's folder (`(storage.foldername(name))[1] = (select auth.uid())::text`) and hand out signed URLs from the server. Public buckets are fine for assets meant for everyone (logos, product images); mark those with `-- vibe-preflight-ignore storage-public-bucket`.",
  check(project) {
    const db = database(project);
    const out: Finding[] = [];
    for (const b of db.buckets.values()) {
      if (!b.public) continue;
      const listing = db.storagePolicies.find(
        (p) =>
          (p.command === "select" || p.command === "all") &&
          forApiUsers(p) &&
          bucketOf(p.using) === b.id &&
          !scopedToUser(p.using),
      );
      out.push({
        rule: this.id,
        severity: listing ? "error" : "warning",
        message: listing
          ? `Storage bucket \`${b.id}\` is public, and policy "${listing.name}" lets anyone list every file in it.`
          : `Storage bucket \`${b.id}\` is public: anyone with a file's URL can download it.`,
        file: b.file,
        line: b.line,
      });
    }
    return out;
  },
};
