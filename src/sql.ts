import type { SourceFile } from "./types.ts";
import { blank } from "./text.ts";

/** One SQL statement with its position. Comments and function bodies are blanked out. */
export interface SqlStatement {
  file: string;
  line: number;
  /** Whitespace-collapsed text with keywords and unquoted identifiers lower-cased; quoted names keep their case. */
  norm: string;
}

/**
 * Split a migration into statements. Comments and dollar-quoted bodies (`$$ … $$`, `$fn$ … $fn$`) are
 * replaced by spaces first, so statements inside a function body are not mistaken for top-level ones.
 */
export function splitSql(file: SourceFile): SqlStatement[] {
  const src = file.text;
  let clean = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "-" && src[i + 1] === "-") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      clean += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      clean += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < src.length && !(src[j] === "'" && src[j + 1] !== "'")) j += src[j] === "'" ? 2 : 1;
      clean += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 64));
      if (!tag) {
        clean += c;
        i++;
        continue;
      }
      const end = src.indexOf(tag[0], i + tag[0].length);
      const stop = end === -1 ? src.length : end + tag[0].length;
      clean += "$$" + blank(src.slice(i + 2, stop - 2)) + "$$";
      i = stop;
    } else {
      clean += c;
      i++;
    }
  }

  const statements: SqlStatement[] = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  for (let k = 0; k <= clean.length; k++) {
    const ch = clean[k];
    if (ch === ";" || k === clean.length) {
      const raw = clean.slice(start, k);
      const norm = raw
        .replace(/\s+/g, " ")
        .trim()
        .replace(/("[^"]*")|[^"]+/g, (part, quoted?: string) => quoted ?? part.toLowerCase());
      if (norm) {
        const lead = raw.length - raw.trimStart().length;
        statements.push({ file: file.path, line: startLine + raw.slice(0, lead).split("\n").length - 1, norm });
      }
      start = k + 1;
      startLine = line;
    }
    if (ch === "\n") line++;
  }
  return statements;
}

/** `public.notes`, `"public"."notes"`, `notes` → `public.notes`. */
export function tableName(raw: string): string {
  const parts = raw.replace(/"/g, "").split(".");
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?`;

export interface PolicyInfo {
  name: string;
  command: "all" | "select" | "insert" | "update" | "delete";
  roles: string[];
  using?: string;
  withCheck?: string;
  file: string;
  line: number;
}


/** The table privileges the Data API needs. TRUNCATE, REFERENCES and TRIGGER don't matter to supabase-js. */
export type TablePrivilege = "select" | "insert" | "update" | "delete";
export const TABLE_PRIVILEGES: TablePrivilege[] = ["select", "insert", "update", "delete"];

/** The roles PostgREST switches to. */
export type ApiRole = "anon" | "authenticated" | "service_role";
export const API_ROLE_NAMES: ApiRole[] = ["anon", "authenticated", "service_role"];

/**
 * Where a table privilege came from.
 * - `table`: `grant … on public.t to …`
 * - `schema`: `grant … on all tables in schema public to …`
 * - `default`: an `alter default privileges … grant … on tables` that ran before the table was created
 * - `platform`: Supabase's old automatic grant on new tables (before the 2026-10-30 change)
 */
export interface GrantSource {
  kind: "table" | "schema" | "default" | "platform";
  file: string;
  line: number;
}

/** Why a table got (or didn't get) Supabase's automatic Data API grants when it was created. */
export type Exposure =
  | "auto" // created before the change: Supabase granted it to anon, authenticated and service_role
  | "after-cutoff" // migration dated on or after 2026-10-30
  | "config-off" // supabase/config.toml sets [api] auto_expose_new_tables = false
  | "default-privileges"; // an `alter default privileges` in the migrations decided it

export interface TableInfo {
  name: string;
  /** The folder holding this table's `supabase/` directory ("" for the scan root). Set when projects are grouped. */
  root?: string;
  file: string;
  line: number;
  rls: boolean;
  exposure: Exposure;
  /** Privileges each API role holds after all migrations, with where each one came from. */
  grants: Map<ApiRole, Map<TablePrivilege, GrantSource>>;
  /** `serial` / `bigserial` columns: inserts also need USAGE on their sequence. */
  serialColumns: string[];
  /** Column names from `create table` and later `add column`. */
  columns: string[];
  policies: PolicyInfo[];
  /** A `revoke update`/`revoke all` or a column-level `grant update (…)` on the table. */
  columnPrivileges: boolean;
  /** A `before … update` trigger, which can reset columns the user must not change. */
  beforeUpdateTrigger: boolean;
}

export interface ViewInfo {
  name: string;
  file: string;
  line: number;
  materialized: boolean;
  securityInvoker: boolean;
  readsAuthUsers: boolean;
  /** API roles (`anon`, `authenticated`) that lost SELECT through a later `revoke`. */
  revoked: Set<string>;
}

export interface FunctionInfo {
  name: string;
  file: string;
  line: number;
  securityDefiner: boolean;
  searchPath: boolean;
  returnsTrigger: boolean;
  /** Roles that may call it. Supabase grants EXECUTE on new functions in `public` to PUBLIC, anon and authenticated. */
  executors: Set<string>;
  /** Where anon was last granted EXECUTE explicitly, if it still has it. */
  anonGrant?: { file: string; line: number };
}

export interface BucketInfo {
  id: string;
  public: boolean;
  /** Where the bucket was created or last made public. */
  file: string;
  line: number;
}

/** A grant that covers many tables at once. */
export interface BlanketGrant {
  kind: "schema" | "default";
  file: string;
  line: number;
  /** The statement, normalised (lower case, one line). */
  sql: string;
  roles: ApiRole[];
  privileges: TablePrivilege[];
}

export interface BuildOptions {
  /** `[api] auto_expose_new_tables` from supabase/config.toml, if set. */
  autoExposeNewTables?: boolean;
}

/**
 * Supabase stopped granting new `public` tables to the Data API roles on all existing projects on this date
 * (changelog 45329). Migration file names start with a UTC timestamp, so they compare as strings.
 */
export const GRANTS_CUTOFF = "20261030000000";

/** `20261102120000_todos.sql` → `20261102120000`. Undefined for names that don't start with a date. */
export function migrationStamp(path: string): string | undefined {
  const m = /^((?:19|20)\d{6,12})(?!\d)/.exec(path.slice(path.lastIndexOf("/") + 1));
  return m ? m[1]!.padEnd(14, "0") : undefined;
}

export interface Database {
  tables: Map<string, TableInfo>;
  /** Schema-wide and default-privilege grants to API roles, in migration order. */
  blanketGrants: BlanketGrant[];
  views: Map<string, ViewInfo>;
  functions: Map<string, FunctionInfo>;
  buckets: Map<string, BucketInfo>;
  /** Policies on `storage.objects`, which Supabase creates outside your migrations. */
  storagePolicies: PolicyInfo[];
}

/** Text between the parenthesis at `open` and its match. */
function balanced(s: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i).trim();
  }
  return undefined;
}

function clause(norm: string, keyword: RegExp): string | undefined {
  const m = keyword.exec(norm);
  if (!m) return undefined;
  const open = norm.indexOf("(", m.index + m[0].length - 1);
  return open === -1 ? undefined : balanced(norm, open);
}

/** Split on commas that are not inside parentheses or quotes. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

const TABLE_CONSTRAINT = /^(?:constraint|primary key|unique|check|foreign key|exclude|like)\b/;
const unquote = (s: string) => s.replace(/^"|"$/g, "");

function columnsOf(body: string): string[] {
  return splitTopLevel(body)
    .filter((part) => !TABLE_CONSTRAINT.test(part))
    .map((part) => unquote(/^("[^"]+"|[a-z_][a-z0-9_$]*)/.exec(part)?.[1] ?? ""))
    .filter(Boolean);
}

function serialColumnsOf(body: string): string[] {
  return splitTopLevel(body)
    .map((part) => /^("[^"]+"|[a-z_][a-z0-9_$]*) (?:small|big)?serial\b/.exec(part)?.[1])
    .filter((c): c is string => Boolean(c))
    .map(unquote);
}

/** `select, update (a, b)` → select, update. `all [privileges]` → the four the Data API uses. */
export function tablePrivileges(raw: string): TablePrivilege[] {
  const words = raw.replace(/\([^)]*\)/g, " ").split(",").map((w) => w.trim());
  if (words.some((w) => /^all(?: privileges)?$/.test(w))) return [...TABLE_PRIVILEGES];
  return TABLE_PRIVILEGES.filter((p) => words.includes(p));
}

/** API roles a grant names. The PUBLIC pseudo-role reaches every one of them. */
function apiRoles(roles: string[]): ApiRole[] {
  if (roles.includes("public")) return [...API_ROLE_NAMES];
  return API_ROLE_NAMES.filter((r) => roles.includes(r));
}

const allGranted = (source: GrantSource) =>
  new Map(API_ROLE_NAMES.map((r) => [r, new Map(TABLE_PRIVILEGES.map((p) => [p, source]))]));

const roleList = (raw: string) =>
  raw
    .replace(/\b(?:granted by .*|cascade|restrict|with grant option)$/, "")
    .split(",")
    .map((r) => unquote(r.trim()))
    .filter(Boolean);

/** The API roles a grant or revoke names. `public` (the PUBLIC pseudo-role) stands for everyone. */
const API_ROLES = ["public", "anon", "authenticated"];

/** Replay all migrations in file-name order and return the final tables, views, functions and storage buckets. */
export function buildDatabase(files: SourceFile[], options: BuildOptions = {}): Database {
  const db: Database = { tables: new Map(), blanketGrants: [], views: new Map(), functions: new Map(), buckets: new Map(), storagePolicies: [] };
  const { tables, views, functions, buckets } = db;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  /** Roles whose EXECUTE on new public functions was revoked with `alter default privileges`. */
  const defaultRevoked = new Set<string>();
  /**
   * Table privileges new `public` tables get, once an `alter default privileges … on tables` has set them.
   * Undefined until then: the platform default applies.
   */
  let tableDefaults: Map<ApiRole, Map<TablePrivilege, GrantSource>> | undefined;

  /** Supabase's own default for a table created in this file. */
  const platformExposure = (path: string): Exposure => {
    if (options.autoExposeNewTables === false) return "config-off";
    const stamp = migrationStamp(path);
    // The `true` opt-out only ever affected the local CLI; hosted projects ignore it after the cutoff.
    return stamp !== undefined && stamp >= GRANTS_CUTOFF ? "after-cutoff" : "auto";
  };

  for (const file of sorted) {
    for (const st of splitSql(file)) {
      const s = st.norm;
      const at = { file: st.file, line: st.line };
      let m: RegExpExecArray | null;

      if ((m = new RegExp(`^create (?:(?:global |local )?(?:temporary |temp )|unlogged )?table (?:if not exists )?(${IDENT})\\s*\\(`).exec(s))) {
        const name = tableName(m[1]!);
        const body = balanced(s, m.index + m[0].length - 1) ?? "";
        let exposure: Exposure = "auto";
        let grants = new Map<ApiRole, Map<TablePrivilege, GrantSource>>();
        if (inPublicSchema(name)) {
          if (tableDefaults) {
            exposure = "default-privileges";
            grants = new Map([...tableDefaults].map(([r, privs]) => [r, new Map(privs)]));
          } else {
            exposure = platformExposure(st.file);
            if (exposure === "auto") grants = allGranted({ kind: "platform", ...at });
          }
        }
        if (!tables.has(name))
          tables.set(name, {
            name,
            ...at,
            rls: false,
            exposure,
            grants,
            serialColumns: serialColumnsOf(body),
            columns: columnsOf(body),
            policies: [],
            columnPrivileges: false,
            beforeUpdateTrigger: false,
          });
        continue;
      }
      if ((m = new RegExp(`^drop table (?:if exists )?(${IDENT}(?:\\s*,\\s*${IDENT})*)`).exec(s))) {
        for (const t of m[1]!.split(",")) tables.delete(tableName(t.trim()));
        continue;
      }
      if ((m = new RegExp(`^alter table (?:if exists )?(?:only )?(${IDENT}) (.*)$`).exec(s))) {
        const t = tables.get(tableName(m[1]!));
        if (!t) continue;
        const rest = m[2]!;
        if (/(?:^|, ?)enable row level security/.test(rest)) t.rls = true;
        if (/(?:^|, ?)disable row level security/.test(rest)) t.rls = false;
        for (const add of rest.matchAll(/(?:^|, ?)add (?:column )?(?:if not exists )?("[^"]+"|[a-z_][a-z0-9_$]*)/g))
          if (!TABLE_CONSTRAINT.test(add[1]!)) t.columns.push(unquote(add[1]!));
        const rename = /^rename to "?([a-z_][a-z0-9_]*)"?/.exec(rest);
        if (rename) {
          tables.delete(t.name);
          t.name = `${t.name.split(".")[0]}.${rename[1]}`;
          tables.set(t.name, t);
        }
        continue;
      }
      if ((m = new RegExp(`^create policy ("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})(.*)$`).exec(s))) {
        const target = tableName(m[2]!);
        const rest = m[3]!;
        const command = (/ for (all|select|insert|update|delete)\b/.exec(rest)?.[1] ?? "all") as PolicyInfo["command"];
        const rolesRaw = / to ([a-z_, "]+?)(?= using| with check|$)/.exec(rest)?.[1];
        const policy: PolicyInfo = {
          name: unquote(m[1]!),
          command,
          roles: rolesRaw ? rolesRaw.split(",").map((r) => unquote(r.trim())) : ["public"],
          using: clause(rest, /\busing\s*\(/),
          withCheck: clause(rest, /\bwith check\s*\(/),
          ...at,
        };
        if (target === "storage.objects") db.storagePolicies.push(policy);
        else tables.get(target)?.policies.push(policy);
        continue;
      }
      if ((m = new RegExp(`^drop policy (?:if exists )?("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})`).exec(s))) {
        const target = tableName(m[2]!);
        const name = unquote(m[1]!);
        if (target === "storage.objects") db.storagePolicies = db.storagePolicies.filter((p) => p.name !== name);
        const t = tables.get(target);
        if (t) t.policies = t.policies.filter((p) => p.name !== name);
        continue;
      }
      if ((m = new RegExp(`^create (?:or replace )?(?:constraint )?trigger \\S+ before (.*?) on (${IDENT})`).exec(s))) {
        const t = tables.get(tableName(m[2]!));
        if (t && /\bupdate\b/.test(m[1]!)) t.beforeUpdateTrigger = true;
        continue;
      }

      if ((m = new RegExp(`^create (?:or replace )?(?:temp |temporary )?(?:recursive )?(materialized )?view (?:if not exists )?(${IDENT})(.*)$`).exec(s))) {
        const name = tableName(m[2]!);
        const rest = m[3]!;
        const options = clause(rest, /^\s*with\s*\(/) ?? "";
        views.set(name, {
          name,
          ...at,
          materialized: Boolean(m[1]),
          securityInvoker: /\bsecurity_invoker\s*(?:=\s*(?:true|on|1|'true'|'on')\s*)?(?:,|$)/.test(options),
          readsAuthUsers: /\b(?:from|join)\s+"?auth"?\."?users"?(?![a-z0-9_])/.test(rest),
          revoked: new Set(),
        });
        continue;
      }
      if ((m = new RegExp(`^alter (?:materialized )?view (?:if exists )?(${IDENT}) set \\((.*)\\)`).exec(s))) {
        const v = views.get(tableName(m[1]!));
        if (v && /\bsecurity_invoker\s*(?:=\s*(?:true|on|1)\s*)?(?:,|$)/.test(m[2]!)) v.securityInvoker = true;
        continue;
      }
      if ((m = new RegExp(`^drop (?:materialized )?view (?:if exists )?(${IDENT}(?:\\s*,\\s*${IDENT})*)`).exec(s))) {
        for (const v of m[1]!.split(",")) views.delete(tableName(v.trim()));
        continue;
      }

      if ((m = new RegExp(`^create (?:or replace )?function (${IDENT})\\s*\\(`).exec(s))) {
        const name = tableName(m[1]!);
        const open = m.index + m[0].length - 1;
        const args = balanced(s, open) ?? "";
        const rest = s.slice(open + args.length + 2);
        functions.set(name, {
          name,
          ...at,
          securityDefiner: /\bsecurity definer\b/.test(rest),
          searchPath: /\bset search_path\b/.test(rest),
          returnsTrigger: /^\s*returns (?:trigger|event_trigger)\b/.test(rest),
          executors: new Set(API_ROLES.filter((r) => !defaultRevoked.has(r))),
        });
        continue;
      }
      if ((m = new RegExp(`^alter function (${IDENT})\\s*(?:\\([^)]*\\))? (.*)$`).exec(s))) {
        const f = functions.get(tableName(m[1]!));
        if (!f) continue;
        if (/\bset search_path\b/.test(m[2]!)) f.searchPath = true;
        if (/\breset (?:search_path|all)\b/.test(m[2]!)) f.searchPath = false;
        if (/\bsecurity definer\b/.test(m[2]!)) f.securityDefiner = true;
        if (/\bsecurity invoker\b/.test(m[2]!)) f.securityDefiner = false;
        continue;
      }
      if ((m = new RegExp(`^drop function (?:if exists )?(${IDENT})`).exec(s))) {
        functions.delete(tableName(m[1]!));
        continue;
      }
      if ((m = /^alter default privileges (?:for (?:role|user) ("?[a-z_]+"?) )?(?:in schema ("?[a-z_]+"?) )?(grant|revoke) (.+?) on tables (?:to|from) (.+)$/.exec(s))) {
        const owner = m[1] ? unquote(m[1]) : "postgres";
        const schema = m[2] ? unquote(m[2]) : "public";
        // Migrations run as `postgres`; defaults for other creators don't touch the tables they create.
        if (owner !== "postgres" || schema !== "public") continue;
        const grant = m[3] === "grant";
        const privileges = tablePrivileges(m[4]!);
        const roles = apiRoles(roleList(m[5]!));
        if (!tableDefaults)
          tableDefaults = platformExposure(st.file) === "auto" ? allGranted({ kind: "platform", ...at }) : new Map();
        for (const r of roles) {
          const held = tableDefaults.get(r) ?? new Map<TablePrivilege, GrantSource>();
          for (const p of privileges) {
            if (grant) held.set(p, { kind: "default", ...at });
            else held.delete(p);
          }
          tableDefaults.set(r, held);
        }
        if (grant && roles.length && privileges.length)
          db.blanketGrants.push({ kind: "default", ...at, sql: s, roles, privileges });
        continue;
      }
      if ((m = /^(grant|revoke) (.+?) on all tables in schema (.+?) (?:to|from) (.+)$/.exec(s))) {
        const schemas = m[3]!.split(",").map((x) => unquote(x.trim()));
        if (!schemas.includes("public")) continue;
        const grant = m[1] === "grant";
        const privileges = tablePrivileges(m[2]!);
        const roles = apiRoles(roleList(m[4]!));
        for (const t of tables.values()) if (inPublicSchema(t.name)) setGrants(t, grant, privileges, roles, { kind: "schema", ...at });
        if (grant && roles.length && privileges.length)
          db.blanketGrants.push({ kind: "schema", ...at, sql: s, roles, privileges });
        continue;
      }
      if ((m = /^alter default privileges (?:for (?:role|user) \S+ )?in schema public revoke execute on functions from (.*)$/.exec(s))) {
        for (const r of roleList(m[1]!)) defaultRevoked.add(r);
        continue;
      }

      if ((m = new RegExp(`^(grant|revoke) (.+?) on (?:(table|function|routine|procedure) )?(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*(?:\\([^)]*\\))? (?:to|from) (.+)$`).exec(s))) {
        const names = m[3] && m[3] !== "table" ? [m[4]!] : m[4]!.split(",").map((n) => n.trim());
        for (const name of names) applyPrivilege(db, m[1] as "grant" | "revoke", m[2]!, m[3], tableName(name), roleList(m[5]!), at);
        continue;
      }

      if ((m = /^insert into "?storage"?\."?buckets"? \(([^)]*)\) values (.*)$/.exec(s))) {
        const cols = splitTopLevel(m[1]!).map(unquote);
        for (const tuple of m[2]!.replace(/ on conflict\b.*$/, "").matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
          const values = splitTopLevel(tuple[1]!);
          const get = (col: string) => values[cols.indexOf(col)]?.replace(/^'|'$/g, "");
          const id = get("id") ?? get("name");
          if (id) buckets.set(id, { id, public: get("public") === "true", ...at });
        }
        continue;
      }
      if ((m = /^update "?storage"?\."?buckets"? set (.*?) where (?:id|name) = '([^']+)'/.exec(s))) {
        const b = buckets.get(m[2]!);
        const flag = /\bpublic = (true|false)\b/.exec(m[1]!)?.[1];
        if (b && flag) {
          b.public = flag === "true";
          if (b.public) Object.assign(b, at);
        }
      }
    }
  }
  return db;
}

function applyPrivilege(
  db: Database,
  action: "grant" | "revoke",
  privileges: string,
  objectType: string | undefined,
  name: string,
  roles: string[],
  at: { file: string; line: number },
): void {
  if (objectType && objectType !== "table") {
    const f = db.functions.get(name);
    if (!f || !/\b(?:execute|all)\b/.test(privileges)) return;
    for (const r of roles) {
      if (action === "grant") f.executors.add(r);
      else f.executors.delete(r);
    }
    if (action === "grant" && roles.includes("anon")) f.anonGrant = at;
    if (action === "revoke" && roles.includes("anon")) f.anonGrant = undefined;
    return;
  }
  const view = db.views.get(name);
  if (view && /\b(?:select|all)\b/.test(privileges)) {
    for (const r of roles) {
      if (action === "revoke") view.revoked.add(r);
      else view.revoked.delete(r);
    }
  }
  const t = db.tables.get(name);
  if (!t) return;
  setGrants(t, action === "grant", tablePrivileges(privileges), apiRoles(roles), { kind: "table", ...at });
  // A column list on update means "only these columns"; a revoke of update takes the table-wide right away.
  if (action === "grant" ? /\bupdate\s*\(/.test(privileges) : /\b(?:update|all)\b/.test(privileges)) t.columnPrivileges = true;
}

const inPublicSchema = (name: string) => name.startsWith("public.");

function setGrants(t: TableInfo, grant: boolean, privileges: TablePrivilege[], roles: ApiRole[], source: GrantSource): void {
  for (const r of roles) {
    const held = t.grants.get(r) ?? new Map<TablePrivilege, GrantSource>();
    for (const p of privileges) {
      if (grant) held.set(p, source);
      else held.delete(p);
    }
    t.grants.set(r, held);
  }
}

/** `[api] auto_expose_new_tables = true|false` in supabase/config.toml. Undefined when it isn't set. */
export function autoExposeSetting(configToml: string | undefined): boolean | undefined {
  if (!configToml) return undefined;
  let section = "";
  for (const raw of configToml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1]!.trim();
    else if (section === "api") {
      const m = /^auto_expose_new_tables\s*=\s*(true|false)$/.exec(line);
      if (m) return m[1] === "true";
    }
  }
  return undefined;
}
