// src/action/main.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative as relative2, resolve, sep as sep2 } from "node:path";

// src/project.ts
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// src/model.ts
var SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
var ENV_FILE = /^\.env(?:\..+)?$/;
var utcToday = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
function fileKind(path) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash === -1 ? "" : path.slice(0, slash);
  if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) return "source";
  if (name.endsWith(".sql")) return "sql";
  if (ENV_FILE.test(name)) return "env";
  if (name === "package.json" || name === ".gitignore") return "other";
  if (name === "config.toml" && (dir === "supabase" || dir.endsWith("/supabase"))) return "other";
  return void 0;
}
function buildProject(root, loaded, git2, today = utcToday()) {
  const files = [...loaded].sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  let pkg = {};
  try {
    pkg = JSON.parse(byPath.get("package.json")?.text ?? "{}");
  } catch {
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = [];
  const hasAppLayout = files.some((f) => /^(src\/)?app\/layout\.[jt]sx?$/.test(f.path));
  if ("next" in deps || hasAppLayout) frameworks.push("next");
  else if ("vite" in deps) frameworks.push("vite");
  if ("expo" in deps) frameworks.push("expo");
  if (!frameworks.length) frameworks.push("unknown");
  const usesSupabase = Object.keys(deps).some((d) => d.startsWith("@supabase/")) || files.some((f) => f.path.startsWith("supabase/") || f.kind === "source" && /from\s+["'](?:npm:|jsr:)?@supabase\//.test(f.text));
  return {
    root,
    name: typeof pkg.name === "string" ? pkg.name : root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    frameworks,
    files,
    byPath,
    gitignore: byPath.get(".gitignore")?.text,
    git: git2,
    usesSupabase,
    today
  };
}

// src/project.ts
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".vercel",
  ".netlify",
  ".turbo",
  ".cache",
  ".expo",
  "dist",
  "build",
  "out",
  "coverage",
  ".svelte-kit",
  "vendor",
  ".pnpm-store",
  "playwright-report",
  "test-results"
]);
var MAX_FILE_BYTES = 1e6;
var SELF = "preflight.mjs";
function git(root, args, input) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}
function gitState(root, envFiles) {
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return void 0;
  } catch {
    return void 0;
  }
  const tracked = new Set(git(root, ["ls-files", "-z", "--", "."]).split("\0").filter(Boolean));
  let ignored = /* @__PURE__ */ new Set();
  if (envFiles.length) {
    try {
      ignored = new Set(git(root, ["check-ignore", "-z", "--stdin"], envFiles.join("\0") + "\0").split("\0").filter(Boolean));
    } catch {
    }
  }
  return { tracked, ignored };
}
function loadProject(root, today = utcToday()) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name === SELF) continue;
      const path = relative(root, abs).split(sep).join("/");
      const kind = fileKind(path);
      if (!kind || statSync(abs).size > MAX_FILE_BYTES) continue;
      files.push({ path, text: readFileSync(abs, "utf8"), kind });
    }
  };
  walk(root);
  const git2 = gitState(root, files.filter((f) => f.kind === "env").map((f) => f.path));
  return buildProject(root, files, git2, today);
}
function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

// src/types.ts
var SEVERITY_ORDER = { error: 2, warning: 1 };

// src/text.ts
function lineAt(text2, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text2.length; i++) if (text2.charCodeAt(i) === 10) line++;
  return line;
}
function blank(s) {
  return s.replace(/[^\n]/g, " ");
}
function stripJsComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && (n === "/" || n === "*")) {
      const end = n === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : n === "/" ? end : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
function hasDirective(src, directive) {
  const body = stripJsComments(src).trimStart();
  return body.startsWith(`"${directive}"`) || body.startsWith(`'${directive}'`);
}
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// src/sql.ts
function splitSql(file) {
  const src = file.text;
  let clean = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
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
  const statements2 = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  for (let k = 0; k <= clean.length; k++) {
    const ch = clean[k];
    if (ch === ";" || k === clean.length) {
      const raw = clean.slice(start, k);
      const norm = raw.replace(/\s+/g, " ").trim().replace(/("[^"]*")|[^"]+/g, (part, quoted) => quoted ?? part.toLowerCase());
      if (norm) {
        const lead = raw.length - raw.trimStart().length;
        statements2.push({ file: file.path, line: startLine + raw.slice(0, lead).split("\n").length - 1, norm });
      }
      start = k + 1;
      startLine = line;
    }
    if (ch === "\n") line++;
  }
  return statements2;
}
function tableName(raw) {
  const parts = raw.replace(/"/g, "").split(".");
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}
var IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?`;
var TABLE_PRIVILEGES = ["select", "insert", "update", "delete"];
var API_ROLE_NAMES = ["anon", "authenticated", "service_role"];
var GRANTS_CUTOFF = "20261030000000";
function migrationStamp(path) {
  const m = /^((?:19|20)\d{6,12})(?!\d)/.exec(path.slice(path.lastIndexOf("/") + 1));
  return m ? m[1].padEnd(14, "0") : void 0;
}
function balanced(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i).trim();
  }
  return void 0;
}
function clause(norm, keyword) {
  const m = keyword.exec(norm);
  if (!m) return void 0;
  const open = norm.indexOf("(", m.index + m[0].length - 1);
  return open === -1 ? void 0 : balanced(norm, open);
}
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
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
var TABLE_CONSTRAINT = /^(?:constraint|primary key|unique|check|foreign key|exclude|like)\b/;
var unquote = (s) => s.replace(/^"|"$/g, "");
function columnsOf(body) {
  return splitTopLevel(body).filter((part) => !TABLE_CONSTRAINT.test(part)).map((part) => unquote(/^("[^"]+"|[a-z_][a-z0-9_$]*)/.exec(part)?.[1] ?? "")).filter(Boolean);
}
function serialColumnsOf(body) {
  return splitTopLevel(body).map((part) => /^("[^"]+"|[a-z_][a-z0-9_$]*) (?:small|big)?serial\b/.exec(part)?.[1]).filter((c) => Boolean(c)).map(unquote);
}
function tablePrivileges(raw) {
  const words = raw.replace(/\([^)]*\)/g, " ").split(",").map((w) => w.trim());
  if (words.some((w) => /^all(?: privileges)?$/.test(w))) return [...TABLE_PRIVILEGES];
  return TABLE_PRIVILEGES.filter((p) => words.includes(p));
}
function apiRoles(roles) {
  if (roles.includes("public")) return [...API_ROLE_NAMES];
  return API_ROLE_NAMES.filter((r) => roles.includes(r));
}
var allGranted = (source) => new Map(API_ROLE_NAMES.map((r) => [r, new Map(TABLE_PRIVILEGES.map((p) => [p, source]))]));
var roleList = (raw) => raw.replace(/\b(?:granted by .*|cascade|restrict|with grant option)$/, "").split(",").map((r) => unquote(r.trim())).filter(Boolean);
var API_ROLES = ["public", "anon", "authenticated"];
function buildDatabase(files, options = {}) {
  const db = { tables: /* @__PURE__ */ new Map(), blanketGrants: [], views: /* @__PURE__ */ new Map(), functions: /* @__PURE__ */ new Map(), buckets: /* @__PURE__ */ new Map(), storagePolicies: [] };
  const { tables, views, functions, buckets } = db;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const defaultRevoked = /* @__PURE__ */ new Set();
  let tableDefaults;
  const platformExposure = (path) => {
    if (options.autoExposeNewTables === false) return "config-off";
    const stamp = migrationStamp(path);
    return stamp !== void 0 && stamp >= GRANTS_CUTOFF ? "after-cutoff" : "auto";
  };
  for (const file of sorted) {
    for (const st of splitSql(file)) {
      const s = st.norm;
      const at = { file: st.file, line: st.line };
      let m;
      if (m = new RegExp(`^create (?:(?:global |local )?(?:temporary |temp )|unlogged )?table (?:if not exists )?(${IDENT})\\s*\\(`).exec(s)) {
        const name = tableName(m[1]);
        const body = balanced(s, m.index + m[0].length - 1) ?? "";
        let exposure = "auto";
        let grants = /* @__PURE__ */ new Map();
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
            beforeUpdateTrigger: false
          });
        continue;
      }
      if (m = new RegExp(`^drop table (?:if exists )?(${IDENT}(?:\\s*,\\s*${IDENT})*)`).exec(s)) {
        for (const t of m[1].split(",")) tables.delete(tableName(t.trim()));
        continue;
      }
      if (m = new RegExp(`^alter table (?:if exists )?(?:only )?(${IDENT}) (.*)$`).exec(s)) {
        const t = tables.get(tableName(m[1]));
        if (!t) continue;
        const rest = m[2];
        if (/(?:^|, ?)enable row level security/.test(rest)) t.rls = true;
        if (/(?:^|, ?)disable row level security/.test(rest)) t.rls = false;
        for (const add of rest.matchAll(/(?:^|, ?)add (?:column )?(?:if not exists )?("[^"]+"|[a-z_][a-z0-9_$]*)/g))
          if (!TABLE_CONSTRAINT.test(add[1])) t.columns.push(unquote(add[1]));
        const rename = /^rename to "?([a-z_][a-z0-9_]*)"?/.exec(rest);
        if (rename) {
          tables.delete(t.name);
          t.name = `${t.name.split(".")[0]}.${rename[1]}`;
          tables.set(t.name, t);
        }
        continue;
      }
      if (m = new RegExp(`^create policy ("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})(.*)$`).exec(s)) {
        const target = tableName(m[2]);
        const rest = m[3];
        const command = / for (all|select|insert|update|delete)\b/.exec(rest)?.[1] ?? "all";
        const rolesRaw = / to ([a-z_, "]+?)(?= using| with check|$)/.exec(rest)?.[1];
        const policy = {
          name: unquote(m[1]),
          command,
          roles: rolesRaw ? rolesRaw.split(",").map((r) => unquote(r.trim())) : ["public"],
          using: clause(rest, /\busing\s*\(/),
          withCheck: clause(rest, /\bwith check\s*\(/),
          ...at
        };
        if (target === "storage.objects") db.storagePolicies.push(policy);
        else tables.get(target)?.policies.push(policy);
        continue;
      }
      if (m = new RegExp(`^drop policy (?:if exists )?("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})`).exec(s)) {
        const target = tableName(m[2]);
        const name = unquote(m[1]);
        if (target === "storage.objects") db.storagePolicies = db.storagePolicies.filter((p) => p.name !== name);
        const t = tables.get(target);
        if (t) t.policies = t.policies.filter((p) => p.name !== name);
        continue;
      }
      if (m = new RegExp(`^create (?:or replace )?(?:constraint )?trigger \\S+ before (.*?) on (${IDENT})`).exec(s)) {
        const t = tables.get(tableName(m[2]));
        if (t && /\bupdate\b/.test(m[1])) t.beforeUpdateTrigger = true;
        continue;
      }
      if (m = new RegExp(`^create (?:or replace )?(?:temp |temporary )?(?:recursive )?(materialized )?view (?:if not exists )?(${IDENT})(.*)$`).exec(s)) {
        const name = tableName(m[2]);
        const rest = m[3];
        const options2 = clause(rest, /^\s*with\s*\(/) ?? "";
        views.set(name, {
          name,
          ...at,
          materialized: Boolean(m[1]),
          securityInvoker: /\bsecurity_invoker\s*(?:=\s*(?:true|on|1|'true'|'on')\s*)?(?:,|$)/.test(options2),
          readsAuthUsers: /\b(?:from|join)\s+"?auth"?\."?users"?(?![a-z0-9_])/.test(rest),
          revoked: /* @__PURE__ */ new Set()
        });
        continue;
      }
      if (m = new RegExp(`^alter (?:materialized )?view (?:if exists )?(${IDENT}) set \\((.*)\\)`).exec(s)) {
        const v = views.get(tableName(m[1]));
        if (v && /\bsecurity_invoker\s*(?:=\s*(?:true|on|1)\s*)?(?:,|$)/.test(m[2])) v.securityInvoker = true;
        continue;
      }
      if (m = new RegExp(`^drop (?:materialized )?view (?:if exists )?(${IDENT}(?:\\s*,\\s*${IDENT})*)`).exec(s)) {
        for (const v of m[1].split(",")) views.delete(tableName(v.trim()));
        continue;
      }
      if (m = new RegExp(`^create (?:or replace )?function (${IDENT})\\s*\\(`).exec(s)) {
        const name = tableName(m[1]);
        const open = m.index + m[0].length - 1;
        const args = balanced(s, open) ?? "";
        const rest = s.slice(open + args.length + 2);
        functions.set(name, {
          name,
          ...at,
          securityDefiner: /\bsecurity definer\b/.test(rest),
          searchPath: /\bset search_path\b/.test(rest),
          returnsTrigger: /^\s*returns (?:trigger|event_trigger)\b/.test(rest),
          executors: new Set(API_ROLES.filter((r) => !defaultRevoked.has(r)))
        });
        continue;
      }
      if (m = new RegExp(`^alter function (${IDENT})\\s*(?:\\([^)]*\\))? (.*)$`).exec(s)) {
        const f = functions.get(tableName(m[1]));
        if (!f) continue;
        if (/\bset search_path\b/.test(m[2])) f.searchPath = true;
        if (/\breset (?:search_path|all)\b/.test(m[2])) f.searchPath = false;
        if (/\bsecurity definer\b/.test(m[2])) f.securityDefiner = true;
        if (/\bsecurity invoker\b/.test(m[2])) f.securityDefiner = false;
        continue;
      }
      if (m = new RegExp(`^drop function (?:if exists )?(${IDENT})`).exec(s)) {
        functions.delete(tableName(m[1]));
        continue;
      }
      if (m = /^alter default privileges (?:for (?:role|user) ("?[a-z_]+"?) )?(?:in schema ("?[a-z_]+"?) )?(grant|revoke) (.+?) on tables (?:to|from) (.+)$/.exec(s)) {
        const owner = m[1] ? unquote(m[1]) : "postgres";
        const schema = m[2] ? unquote(m[2]) : "public";
        if (owner !== "postgres" || schema !== "public") continue;
        const grant = m[3] === "grant";
        const privileges = tablePrivileges(m[4]);
        const roles = apiRoles(roleList(m[5]));
        if (!tableDefaults)
          tableDefaults = platformExposure(st.file) === "auto" ? allGranted({ kind: "platform", ...at }) : /* @__PURE__ */ new Map();
        for (const r of roles) {
          const held = tableDefaults.get(r) ?? /* @__PURE__ */ new Map();
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
      if (m = /^(grant|revoke) (.+?) on all tables in schema (.+?) (?:to|from) (.+)$/.exec(s)) {
        const schemas = m[3].split(",").map((x) => unquote(x.trim()));
        if (!schemas.includes("public")) continue;
        const grant = m[1] === "grant";
        const privileges = tablePrivileges(m[2]);
        const roles = apiRoles(roleList(m[4]));
        for (const t of tables.values()) if (inPublicSchema(t.name)) setGrants(t, grant, privileges, roles, { kind: "schema", ...at });
        if (grant && roles.length && privileges.length)
          db.blanketGrants.push({ kind: "schema", ...at, sql: s, roles, privileges });
        continue;
      }
      if (m = /^alter default privileges (?:for (?:role|user) \S+ )?in schema public revoke execute on functions from (.*)$/.exec(s)) {
        for (const r of roleList(m[1])) defaultRevoked.add(r);
        continue;
      }
      if (m = new RegExp(`^(grant|revoke) (.+?) on (?:(table|function|routine|procedure) )?(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*(?:\\([^)]*\\))? (?:to|from) (.+)$`).exec(s)) {
        const names = m[3] && m[3] !== "table" ? [m[4]] : m[4].split(",").map((n) => n.trim());
        for (const name of names) applyPrivilege(db, m[1], m[2], m[3], tableName(name), roleList(m[5]), at);
        continue;
      }
      if (m = /^insert into "?storage"?\."?buckets"? \(([^)]*)\) values (.*)$/.exec(s)) {
        const cols = splitTopLevel(m[1]).map(unquote);
        for (const tuple of m[2].replace(/ on conflict\b.*$/, "").matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
          const values = splitTopLevel(tuple[1]);
          const get = (col) => values[cols.indexOf(col)]?.replace(/^'|'$/g, "");
          const id = get("id") ?? get("name");
          if (id) buckets.set(id, { id, public: get("public") === "true", ...at });
        }
        continue;
      }
      if (m = /^update "?storage"?\."?buckets"? set (.*?) where (?:id|name) = '([^']+)'/.exec(s)) {
        const b = buckets.get(m[2]);
        const flag = /\bpublic = (true|false)\b/.exec(m[1])?.[1];
        if (b && flag) {
          b.public = flag === "true";
          if (b.public) Object.assign(b, at);
        }
      }
    }
  }
  return db;
}
function applyPrivilege(db, action, privileges, objectType, name, roles, at) {
  if (objectType && objectType !== "table") {
    const f = db.functions.get(name);
    if (!f || !/\b(?:execute|all)\b/.test(privileges)) return;
    for (const r of roles) {
      if (action === "grant") f.executors.add(r);
      else f.executors.delete(r);
    }
    if (action === "grant" && roles.includes("anon")) f.anonGrant = at;
    if (action === "revoke" && roles.includes("anon")) f.anonGrant = void 0;
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
  if (action === "grant" ? /\bupdate\s*\(/.test(privileges) : /\b(?:update|all)\b/.test(privileges)) t.columnPrivileges = true;
}
var inPublicSchema = (name) => name.startsWith("public.");
function setGrants(t, grant, privileges, roles, source) {
  for (const r of roles) {
    const held = t.grants.get(r) ?? /* @__PURE__ */ new Map();
    for (const p of privileges) {
      if (grant) held.set(p, source);
      else held.delete(p);
    }
    t.grants.set(r, held);
  }
}
function autoExposeSetting(configToml) {
  if (!configToml) return void 0;
  let section = "";
  for (const raw of configToml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1].trim();
    else if (section === "api") {
      const m = /^auto_expose_new_tables\s*=\s*(true|false)$/.exec(line);
      if (m) return m[1] === "true";
    }
  }
  return void 0;
}

// src/rules/database.ts
var cache = /* @__PURE__ */ new WeakMap();
function supabaseRoot(path) {
  const i = path.startsWith("supabase/") ? 0 : path.indexOf("/supabase/");
  return i === -1 ? "" : path.slice(0, i === 0 ? 0 : i + 1);
}
function database(project) {
  let db = cache.get(project);
  if (db) return db;
  const groups = /* @__PURE__ */ new Map();
  if (project.usesSupabase)
    for (const f of project.files.filter((f2) => f2.kind === "sql")) {
      const root = supabaseRoot(f.path);
      groups.set(root, [...groups.get(root) ?? [], f]);
    }
  db = { tables: /* @__PURE__ */ new Map(), blanketGrants: [], views: /* @__PURE__ */ new Map(), functions: /* @__PURE__ */ new Map(), buckets: /* @__PURE__ */ new Map(), storagePolicies: [] };
  for (const [root, files] of groups) {
    const config = project.byPath.get(`${root}supabase/config.toml`);
    const part = buildDatabase(files, { autoExposeNewTables: autoExposeSetting(config?.text) });
    const key = (name) => groups.size > 1 ? `${root}\0${name}` : name;
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
var inPublic = (name) => name.startsWith("public.");
var publicTables = (project) => [...database(project).tables.values()].filter((t) => inPublic(t.name));
var forApiUsers = (p) => p.roles.some((r) => r === "public" || r === "anon" || r === "authenticated");
var list = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
var short = (name) => name.replace(/^public\./, "");
var isTrue = (expr) => expr !== void 0 && /^\(*\s*true\s*\)*$/.test(expr);
var rlsDisabled = {
  id: "rls-disabled",
  severity: "error",
  title: "Supabase table in the public schema without Row Level Security",
  why: "Supabase serves every table in `public` through its REST API, and the anon key ships in your frontend. Without RLS anyone holding that key can read and change every row.",
  fix: "Add `alter table public.<name> enable row level security;` in a new migration, then add policies for the access you actually want (usually `(select auth.uid()) = user_id`).",
  check(project) {
    return publicTables(project).filter((t) => !t.rls).map((t) => ({
      rule: this.id,
      severity: this.severity,
      message: `\`${t.name}\` is created without \`enable row level security\` in any migration.`,
      file: t.file,
      line: t.line
    }));
  }
};
var rlsPermissivePolicy = {
  id: "rls-permissive-policy",
  severity: "error",
  title: "Policy that allows everything (`using (true)` / `with check (true)`)",
  why: "These are the dashboard's template policies. On insert/update/delete they let a user write rows that belong to someone else; on select they show every user's rows to everyone.",
  fix: "Replace `true` with an ownership check such as `(select auth.uid()) = user_id` and scope the policy `to authenticated`. Keep `using (true)` on select only for data that is meant to be public, and mark that line with `-- vibe-preflight-ignore rls-permissive-policy`.",
  check(project) {
    const out = [];
    for (const t of publicTables(project)) {
      for (const p of t.policies) {
        const openRead = (p.command === "select" || p.command === "all") && isTrue(p.using);
        const openWrite = p.command !== "select" && isTrue(p.withCheck) || (p.command === "update" || p.command === "delete" || p.command === "all") && isTrue(p.using);
        if (!openRead && !openWrite) continue;
        if (p.roles.every((r) => r === "service_role")) continue;
        const who = p.roles.includes("public") || p.roles.includes("anon") ? "anyone (signed in or not)" : p.roles.includes("authenticated") ? "any signed-in user" : `the ${p.roles.join(", ")} role`;
        out.push({
          rule: this.id,
          // A public read can be on purpose (a blog, a product catalogue); an open write almost never is.
          severity: openWrite ? "error" : "warning",
          message: `Policy "${p.name}" on \`${t.name}\` (${p.command}) lets ${who} ${openWrite ? "write rows on behalf of any user" : "read every row"}.`,
          file: p.file,
          line: p.line
        });
      }
    }
    return out;
  }
};
var rlsNoPolicy = {
  id: "rls-no-policy",
  severity: "warning",
  title: "Table with RLS on and no policies",
  why: "RLS with no policies denies every API request. That is right for a server-only table, but if the app reads it with the anon key the query silently returns no rows.",
  fix: 'If the browser should read it, add the narrowest policy that fits, e.g. `create policy "read flags" on public.<name> for select to anon, authenticated using (true);` for public config. If only the server uses it, keep it as is and mark the table with `-- vibe-preflight-ignore rls-no-policy`.',
  check(project) {
    return publicTables(project).filter((t) => t.rls && t.policies.length === 0).map((t) => ({
      rule: this.id,
      severity: this.severity,
      message: `\`${t.name}\` has RLS on and no policies: every API read and write is denied.`,
      file: t.file,
      line: t.line
    }));
  }
};
var PRIVILEGED_COLUMN = /^(?:plan|plan_id|tier|pricing_tier|subscription|subscription_(?:status|tier|plan|id)|stripe_(?:customer|subscription|price)_id|is_?(?:admin|pro|premium|paid|verified|staff|superuser)|admin|premium|role|roles|user_role|credits?|balance|quota|usage_limit)$/;
var rlsUpdatePrivilegedColumn = {
  id: "rls-update-privileged-column",
  severity: "warning",
  title: "Users can update their own row, including a plan, role or billing column",
  why: "An update policy decides which rows a user may change, not which columns. If the row holds `plan`, `role` or `is_admin`, a user can call the API with their own key and upgrade themselves.",
  fix: "Limit the columns: `revoke update on public.<name> from authenticated; grant update (display_name, avatar_url) on public.<name> to authenticated;`. Or move the privileged columns to a table users can't write, or reset them in a `before update` trigger. Change them only from the server (service role) after a verified payment.",
  check(project) {
    const out = [];
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
        line: policy.line
      });
    }
    return out;
  }
};
var apiCanRead = (v) => !(v.revoked.has("anon") && v.revoked.has("authenticated"));
var viewBypassesRls = {
  id: "view-bypasses-rls",
  severity: "error",
  title: "View in `public` that runs with its owner's rights",
  why: "A Postgres view runs as the user who created it, and on Supabase that user skips RLS. Unless it is created `with (security_invoker = true)`, the view returns rows from every user even when the table below it is locked down. Materialized views can't apply RLS at all.",
  fix: "Postgres 15+: `alter view public.<name> set (security_invoker = true);`. For a materialized view, move it to a schema the API doesn't serve, or `revoke select on public.<name> from anon, authenticated;` and read it from the server.",
  check(project) {
    return [...database(project).views.values()].filter((v) => inPublic(v.name) && apiCanRead(v) && (v.materialized || !v.securityInvoker)).map((v) => ({
      rule: this.id,
      severity: this.severity,
      message: v.materialized ? `Materialized view \`${v.name}\` is served by the API and RLS doesn't apply to it.` : `View \`${v.name}\` has no \`security_invoker\`, so it reads the tables below it without RLS.`,
      file: v.file,
      line: v.line
    }));
  }
};
var authUsersExposed = {
  id: "auth-users-exposed",
  severity: "error",
  title: "View in `public` that reads `auth.users`",
  why: "`auth.users` holds every user's email, phone and sign-in metadata. A view over it in `public` puts that on the API for anyone with the anon key (or any signed-in user).",
  fix: "Keep the fields you want to share (e.g. a display name) in a `public.profiles` table with RLS, filled by a trigger on sign-up. Drop the view, or move it to a private schema and `revoke select on public.<name> from anon, authenticated;`.",
  check(project) {
    return [...database(project).views.values()].filter((v) => inPublic(v.name) && v.readsAuthUsers && apiCanRead(v)).map((v) => ({
      rule: this.id,
      severity: this.severity,
      message: `View \`${v.name}\` selects from \`auth.users\` and the API serves it.`,
      file: v.file,
      line: v.line
    }));
  }
};
var definerSearchPath = {
  id: "definer-search-path",
  severity: "warning",
  title: "SECURITY DEFINER function without a fixed `search_path`",
  why: "A SECURITY DEFINER function runs with its owner's rights. Without a fixed search_path, an unqualified name in its body can resolve to an object the caller controls.",
  fix: "Add `set search_path = ''` to the function and write every name with its schema (`public.profiles`, `auth.uid()`), or run `alter function public.<name>(<args>) set search_path = '';`.",
  check(project) {
    return [...database(project).functions.values()].filter((f) => f.securityDefiner && !f.searchPath).map((f) => ({
      rule: this.id,
      severity: this.severity,
      message: `\`${f.name}()\` is SECURITY DEFINER and doesn't set search_path.`,
      file: f.file,
      line: f.line
    }));
  }
};
var definerFunctionAnon = {
  id: "definer-function-anon",
  severity: "error",
  title: "SECURITY DEFINER function anyone can call over the API",
  why: "Supabase exposes functions in `public` at /rest/v1/rpc/<name>, and new functions there are executable by anon. A SECURITY DEFINER function skips RLS, so anyone with the anon key gets whatever it does.",
  fix: "`revoke execute on function public.<name>(<args>) from public, anon;` and grant it only to `authenticated` (and check `auth.uid()` inside), or to `service_role` for admin work. Revoking from `public` alone isn't enough on Supabase: anon has its own grant.",
  check(project) {
    return [...database(project).functions.values()].filter((f) => inPublic(f.name) && f.securityDefiner && !f.returnsTrigger && f.executors.has("anon")).map((f) => {
      const explicit = f.anonGrant !== void 0;
      const where2 = f.anonGrant ?? { file: f.file, line: f.line };
      return {
        rule: this.id,
        severity: explicit ? "error" : "warning",
        message: `\`${f.name}()\` is SECURITY DEFINER and anon can call it at /rest/v1/rpc/${short(f.name)}${explicit ? " (granted explicitly)" : " (Supabase's default grant was never revoked)"}.`,
        ...where2
      };
    });
  }
};
var bucketOf = (expr = "") => /\bbucket_id\s*=\s*'([^']+)'/.exec(expr)?.[1];
var scopedToUser = (expr = "") => /\bauth\.(?:uid|jwt)\s*\(/.test(expr);
var storagePublicBucket = {
  id: "storage-public-bucket",
  severity: "error",
  title: "Public storage bucket",
  why: "Every file in a public bucket can be downloaded by anyone who has or guesses its URL, with no auth check. With a select policy on storage.objects that isn't scoped to the user, anyone can also list the bucket and find every file.",
  fix: "For private files (invoices, uploads, exports): `update storage.buckets set public = false where id = '<bucket>';`, scope select to the owner's folder (`(storage.foldername(name))[1] = (select auth.uid())::text`) and hand out signed URLs from the server. Public buckets are fine for assets meant for everyone (logos, product images); mark those with `-- vibe-preflight-ignore storage-public-bucket`.",
  check(project) {
    const db = database(project);
    const out = [];
    for (const b of db.buckets.values()) {
      if (!b.public) continue;
      const listing = db.storagePolicies.find(
        (p) => (p.command === "select" || p.command === "all") && forApiUsers(p) && bucketOf(p.using) === b.id && !scopedToUser(p.using)
      );
      out.push({
        rule: this.id,
        severity: listing ? "error" : "warning",
        message: listing ? `Storage bucket \`${b.id}\` is public, and policy "${listing.name}" lets anyone list every file in it.` : `Storage bucket \`${b.id}\` is public: anyone with a file's URL can download it.`,
        file: b.file,
        line: b.line
      });
    }
    return out;
  }
};

// src/context.ts
function isEdgeFunction(f) {
  return /(^|\/)supabase\/functions\//.test(f.path);
}
function isTestFile(f) {
  return /(^|\/)(__tests__|tests?|e2e|fixtures?|__mocks__)\//.test(f.path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f.path);
}
function isToolingFile(f) {
  return /^[^/]*\.config\.[cm]?[jt]s$/.test(f.path) || /(^|\/)scripts\//.test(f.path);
}
var isNext = (project) => project.frameworks.includes("next");
function isClientFile(project, f) {
  if (f.kind !== "source" || isEdgeFunction(f) || isTestFile(f) || isToolingFile(f)) return false;
  if (hasDirective(f.text, "use client")) return true;
  const spa = project.frameworks.includes("vite") || project.frameworks.includes("expo");
  if (spa && !isNext(project)) return /^(src|app|components|lib|hooks)\//.test(f.path) && !/(^|\/)server\//.test(f.path);
  return false;
}
function publicPrefixes(project) {
  const prefixes = [];
  if (isNext(project)) prefixes.push("NEXT_PUBLIC_");
  if (project.frameworks.includes("vite")) prefixes.push("VITE_");
  if (project.frameworks.includes("expo")) prefixes.push("EXPO_PUBLIC_");
  return prefixes.length ? prefixes : ["NEXT_PUBLIC_", "VITE_", "EXPO_PUBLIC_"];
}

// src/usage.ts
var FROM = /\.\s*from\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g;
var NOT_A_TABLE = /(?:\bstorage|\bArray|\bBuffer|Uint8Array|\bschema\s*\(\s*["'`](?!public["'`])[^)]*\))\s*$/;
var METHOD = /\.\s*(select|insert|update|upsert|delete)\s*\(/g;
var SERVICE_KEY = /SERVICE_ROLE|service_role|serviceRole|SUPABASE_SECRET_KEY|sb_secret_/;
function chainAfter(code, start) {
  const rest = code.slice(start, start + 800);
  const end = rest.search(/;|\n\s*\n|\.\s*from\s*\(|\b(?:const|let|var|return|if|for)\s/);
  return end === -1 ? rest : rest.slice(0, end);
}
function privilegesFor(chain) {
  const needed = /* @__PURE__ */ new Set();
  for (const m of chain.matchAll(METHOD)) {
    const method = m[1];
    if (method === "upsert") ["insert", "update", "select"].forEach((p) => needed.add(p));
    else needed.add(method);
    if (method === "update" || method === "delete") needed.add("select");
  }
  if (!needed.size) needed.add("select");
  return [...needed];
}
function callsIn(project, file) {
  const code = stripJsComments(file.text);
  const client = isClientFile(project, file);
  const role = !client && SERVICE_KEY.test(code) ? "service_role" : "authenticated";
  const calls = [];
  for (const m of code.matchAll(FROM)) {
    if (NOT_A_TABLE.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    calls.push({
      table: `public.${m[2]}`,
      file: file.path,
      line: lineAt(code, m.index),
      role,
      client,
      privileges: privilegesFor(chainAfter(code, m.index + m[0].length))
    });
  }
  return calls;
}
var cache2 = /* @__PURE__ */ new WeakMap();
function tableCalls(project) {
  let calls = cache2.get(project);
  if (!calls) {
    calls = project.files.filter((f) => f.kind === "source" && !isTestFile(f)).flatMap((f) => callsIn(project, f));
    cache2.set(project, calls);
  }
  return calls;
}

// src/rules/grants.ts
var short2 = (name) => name.replace(/^public\./, "");
var list2 = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
var ordered = (privileges) => TABLE_PRIVILEGES.filter((p) => new Set(privileges).has(p));
var where = (s) => `${s.file}:${s.line}`;
var appliesTo = (p, role) => p.roles.includes(role) || p.roles.includes("public");
var coversCommand = (p, privilege) => p.command === privilege || p.command === "all";
var readsAuth = (expr = "") => /\bauth\.(?:uid|jwt|role)\s*\(/.test(expr);
function openWritePolicy(t, privilege, role) {
  if (privilege === "select") return void 0;
  return t.policies.find((p) => {
    if (!appliesTo(p, role) || !coversCommand(p, privilege)) return false;
    const check = p.withCheck ?? p.using;
    return privilege === "insert" ? isTrue(check) : isTrue(p.using) || privilege === "update" && isTrue(check);
  });
}
function anonNeeds(t, privilege) {
  return t.rls && t.policies.some(
    (p) => coversCommand(p, privilege) && (p.roles.includes("anon") || p.roles.includes("public") && !readsAuth(p.using) && !readsAuth(p.withCheck))
  );
}
var WHY_NO_GRANTS = {
  "after-cutoff": "is created in a migration dated after Supabase's 2026-10-30 change, so it gets no Data API grants",
  "config-off": "is created with `auto_expose_new_tables = false` in supabase/config.toml, so it gets no Data API grants",
  "default-privileges": "is created after an `alter default privileges` that stopped the automatic Data API grants",
  auto: "had its Data API grants revoked"
};
var grantsMissing = {
  id: "grants-missing",
  severity: "warning",
  title: "Table the app queries with no Data API grant (Supabase's 2026-10-30 change)",
  why: "Since 2026-10-30 Supabase no longer grants new `public` tables to anon, authenticated and service_role. RLS policies alone don't help: without a GRANT every supabase-js call fails with 42501 `permission denied for table`.",
  fix: "Add the smallest grant the code needs in the same migration that creates the table, e.g. `grant select, insert, update, delete on public.<name> to authenticated;`. Grant to anon only what signed-out visitors really use (`grant select on public.<name> to anon;` for public reads). Keep RLS on. Avoid `grant all` and `on all tables in schema public`.",
  check(project) {
    const tables = publicTables(project);
    const roots = [...new Set(tables.map((t) => t.root ?? ""))].sort((a, b) => b.length - a.length);
    const rootOf = (file) => roots.find((r) => file.startsWith(r)) ?? "";
    const calls = tableCalls(project).map((c) => ({ ...c, root: rootOf(c.file) }));
    const out = [];
    for (const t of tables) {
      const used = calls.filter((c) => c.table === t.name && c.root === (t.root ?? ""));
      if (!used.length) continue;
      const needs = /* @__PURE__ */ new Map();
      const need = (role, privilege) => needs.set(role, (needs.get(role) ?? /* @__PURE__ */ new Set()).add(privilege));
      for (const c of used)
        for (const p of c.privileges) {
          need(c.role, p);
          if (c.role === "authenticated" && anonNeeds(t, p)) need("anon", p);
        }
      const statements2 = [];
      for (const role of API_ROLE_NAMES) {
        const missing = ordered([...needs.get(role) ?? []].filter((p) => !t.grants.get(role)?.has(p)));
        if (!missing.length) continue;
        statements2.push(`grant ${missing.join(", ")} on ${t.name} to ${role};`);
        if (missing.includes("insert"))
          for (const col of t.serialColumns) statements2.push(`grant usage on sequence ${t.name}_${col}_seq to ${role};`);
      }
      if (!statements2.length) continue;
      const first = used[0];
      const call = `.from('${short2(t.name)}') at ${where(first)}${used.length > 1 ? ` and ${used.length - 1} more` : ""}`;
      out.push({
        rule: this.id,
        severity: this.severity,
        message: `\`${t.name}\` ${WHY_NO_GRANTS[t.exposure]}: supabase-js will 42501 "permission denied for table ${short2(t.name)}" on ${call}. Minimal grant: \`${statements2.join(" ")}\`` + (t.rls ? "" : " Enable RLS and add policies first: a grant on a table without RLS opens every row."),
        file: t.file,
        line: t.line
      });
    }
    return out;
  }
};
function leaks(tables) {
  const bySource = /* @__PURE__ */ new Map();
  for (const t of tables) {
    for (const role of ["anon", "authenticated"]) {
      for (const [privilege, source] of t.grants.get(role) ?? []) {
        if (source.kind === "platform") continue;
        const policy = t.rls ? openWritePolicy(t, privilege, role) : void 0;
        if (t.rls && !policy) continue;
        const key = where(source);
        const entry = bySource.get(key) ?? { source, roles: /* @__PURE__ */ new Set(), privileges: /* @__PURE__ */ new Set(), tables: /* @__PURE__ */ new Map() };
        entry.roles.add(role);
        entry.privileges.add(privilege);
        if (!policy) entry.tables.set(t.name, null);
        else entry.tables.set(t.name, (entry.tables.get(t.name) ?? /* @__PURE__ */ new Set()).add(policy));
        bySource.set(key, entry);
      }
    }
  }
  return [...bySource.values()];
}
var STATEMENT = {
  table: "This grant",
  schema: "This `on all tables in schema public` grant",
  default: "This `alter default privileges` grant",
  platform: ""
};
var grantLeak = {
  id: "grant-leak",
  severity: "error",
  title: "Grant to anon/authenticated on a table RLS doesn't protect",
  why: "A GRANT opens a table to the Data API and RLS decides which rows each request sees. A grant on a table with RLS off, or with a `using (true)` write policy, lets anyone with the anon key (or any signed-up user) read and rewrite every row. This is the usual AI fix for 42501 errors after Supabase's 2026-10-30 change.",
  fix: "Turn RLS on (`alter table public.<name> enable row level security;`), replace `true` in write policies with an ownership check like `(select auth.uid()) = user_id`, and grant only the commands the app uses to the role that uses them: `grant select, insert, update, delete on public.<name> to authenticated;`. Revoke the rest: `revoke all on public.<name> from anon;`.",
  check(project) {
    return leaks(publicTables(project)).map((e) => {
      const tables = [...e.tables];
      const why = (policies) => policies === null ? "RLS is off" : `${policies.size > 1 ? "policies" : "policy"} ${list2([...policies].map((p) => `"${p.name}" (${p.command})`))} ${policies.size > 1 ? "use" : "uses"} \`true\``;
      const shown = tables.slice(0, 3).map(([name, policies]) => `\`${name}\` (${why(policies)})`);
      const more = tables.length > 3 ? ` and ${tables.length - 3} more` : "";
      const who = e.roles.has("anon") ? "anyone with the anon key" : "any signed-in user";
      const privileges = ordered(e.privileges);
      const reads = privileges.includes("select");
      const writes = privileges.some((p) => p !== "select");
      const harm = tables.some(([, policies]) => policies === null) ? `can ${reads && writes ? "read and change" : reads ? "read" : "change"} every row` : "can write rows that belong to other users";
      return {
        rule: this.id,
        severity: this.severity,
        message: `${STATEMENT[e.source.kind]} gives ${list2([...e.roles])} ${privileges.join(", ")} on ${list2(shown)}${more}: ${who} ${harm}.`,
        file: e.source.file,
        line: e.source.line
      };
    });
  }
};
var grantBroad = {
  id: "grant-broad",
  severity: "warning",
  title: "Blanket grant on every table in `public`",
  why: "`grant \u2026 on all tables in schema public` and `alter default privileges \u2026 grant \u2026 on tables` hand every table to the Data API roles, which undoes Supabase's 2026-10-30 change. Internal tables, queues and audit logs become reachable as soon as their RLS slips.",
  fix: "Grant per table, next to the `create table`, with only what the app uses: `grant select on public.<name> to anon;` for public reads, `grant select, insert, update, delete on public.<name> to authenticated;` for user data. Server-only tables get `grant \u2026 to service_role` and nothing for anon/authenticated.",
  check(project) {
    const db = database(project);
    const leaking = new Set(leaks(publicTables(project)).map((e) => where(e.source)));
    return db.blanketGrants.filter((g) => g.roles.some((r) => r !== "service_role") && !leaking.has(where(g))).map((g) => ({
      rule: this.id,
      severity: this.severity,
      message: g.kind === "schema" ? `Grants ${g.privileges.join(", ")} on every table in \`public\` to ${list2(g.roles)}, which undoes Supabase's 2026-10-30 change for all of them. Grant per table instead.` : `Turns automatic grants back on for every future table in \`public\` (${g.privileges.join(", ")} to ${list2(g.roles)}), which undoes Supabase's 2026-10-30 change. Grant per table instead.`,
      file: g.file,
      line: g.line
    }));
  }
};

// src/rules/secrets.ts
var SECRET_NAME = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES_URL|WEBHOOK_SIGNING|_SK$|SIGNING_KEY)/;
var MAYBE_SECRET_NAME = /(API_KEY|TOKEN|ACCESS_KEY|_KEY$)/;
var BROWSER_SAFE_NAME = /(ANON|PUBLISHABLE|PUBLIC_KEY|FIREBASE|MAPS|SITE_KEY|MEASUREMENT|POSTHOG|SENTRY_DSN|PUSHER_KEY|ALGOLIA_SEARCH|MAPBOX)/;
var BOOL_VALUE = /^\s*["']?(?:true|false|0|1|yes|no|on|off)?["']?\s*$/i;
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function isBooleanFlag(name, sources, envs) {
  const n = escapeRe(name);
  const assigned = envs.flatMap((t) => [...t.matchAll(new RegExp(`^\\s*(?:export\\s+)?${n}\\s*=(.*)$`, "gm"))].map((m) => m[1]));
  if (assigned.some((v) => !BOOL_VALUE.test(v.replace(/\s+#.*$/, "")))) return false;
  const word = new RegExp(`\\b${n}\\b`, "g");
  const compared = new RegExp(`^${n}\\s*[!=]==?\\s*["'\`](?:true|false)["'\`]`);
  const comparedBefore = /["'`](?:true|false)["'`]\s*[!=]==?\s*(?:process\.env\.|import\.meta\.env\.)?$/;
  let uses = 0;
  for (const t of sources) {
    for (const m of t.matchAll(word)) {
      uses++;
      if (!compared.test(t.slice(m.index)) && !comparedBefore.test(t.slice(Math.max(0, m.index - 40), m.index))) return false;
    }
  }
  return uses > 0 || assigned.some((v) => v.trim() !== "");
}
var publicEnvSecret = {
  id: "public-env-secret",
  severity: "error",
  title: "Secret in a browser-exposed env variable (NEXT_PUBLIC_ / VITE_ / EXPO_PUBLIC_)",
  why: "Variables with these prefixes are copied into the JavaScript bundle at build time. Anyone can read them in the browser's dev tools.",
  fix: "Rename the variable without the public prefix, read it only in server code (route handler, server action, Edge Function), and rotate the key, because the old value has already shipped.",
  check(project) {
    const prefixes = publicPrefixes(project);
    const re = new RegExp(`\\b(?:${prefixes.join("|")})[A-Z0-9_]+`, "g");
    const first = /* @__PURE__ */ new Map();
    const files = [...project.files.filter((f) => f.kind === "source" && !isTestFile(f)), ...project.files.filter((f) => f.kind === "env")];
    const sources = [];
    const envs = [];
    for (const f of files) {
      const text2 = f.kind === "source" ? stripJsComments(f.text) : f.text;
      (f.kind === "source" ? sources : envs).push(text2);
      for (const m of text2.matchAll(re)) if (!first.has(m[0])) first.set(m[0], { file: f.path, line: lineAt(text2, m.index) });
    }
    const out = [];
    for (const [name, at] of first) {
      const bare = prefixes.reduce((n, p) => n.startsWith(p) ? n.slice(p.length) : n, name);
      if ((SECRET_NAME.test(bare) || MAYBE_SECRET_NAME.test(bare)) && isBooleanFlag(name, sources, envs)) continue;
      if (SECRET_NAME.test(bare)) {
        out.push({ rule: this.id, severity: "error", message: `\`${name}\` looks like a secret and is exposed to the browser.`, ...at });
      } else if (MAYBE_SECRET_NAME.test(bare) && !BROWSER_SAFE_NAME.test(bare)) {
        out.push({
          rule: this.id,
          severity: "warning",
          message: `\`${name}\` is exposed to the browser. Fine for a publishable key, a leak if it's a paid API key (OpenAI, Resend, \u2026).`,
          ...at
        });
      }
    }
    return out;
  }
};
var SERVER_SECRET_REF = /\b([A-Z0-9_]*(?:SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET))\b|['"]service_role['"]/g;
var serverSecretInClient = {
  id: "server-secret-in-client",
  severity: "error",
  title: "Supabase service_role key (or a Stripe secret) used in browser code",
  why: "The service_role key skips every RLS policy. In a Vite / Lovable / Bolt app the value lands in the bundle; in Next.js a client component gets `undefined`, so the code either leaks the key or quietly breaks.",
  fix: "Move the call to the server: a Next.js route handler or server action, or a Supabase Edge Function. The browser should only use the anon/publishable key, with RLS doing the access control.",
  check(project) {
    const out = [];
    for (const f of project.files) {
      if (!isClientFile(project, f)) continue;
      const code = stripJsComments(f.text);
      const seen = /* @__PURE__ */ new Set();
      for (const m of code.matchAll(SERVER_SECRET_REF)) {
        const what = m[1] ?? "service_role";
        if (seen.has(what)) continue;
        seen.add(what);
        out.push({
          rule: this.id,
          severity: this.severity,
          message: `${basename(f.path)} runs in the browser and uses ${m[1] ? `\`${what}\`` : "the `service_role` key"}.`,
          file: f.path,
          line: lineAt(f.text, m.index)
        });
      }
    }
    return out;
  }
};
function isIgnored(gitignore, name) {
  if (!gitignore) return false;
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    const pattern = (negate ? line.slice(1) : line).replace(/^\//, "").replace(/\/$/, "");
    if (pattern.includes("/") && !pattern.startsWith("**/")) continue;
    if (globToRegExp(pattern.replace(/^\*\*\//, "")).test(name)) ignored = !negate;
  }
  return ignored;
}
var TEMPLATE_ENV = /\.(example|sample|template|dist)$/;
var HAS_VALUE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/m;
var REAL_KEY = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}|\bsb_secret_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}/;
var JWT_ANY = /\beyJ[A-Za-z0-9_-]+\.eyJ/;
var JWT = /\beyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g;
function decodeBase64Url(data) {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function jwtIssuer(payload) {
  try {
    return JSON.parse(decodeBase64Url(payload)).iss;
  } catch {
    return void 0;
  }
}
function onlyLocalSupabaseKeys(text2) {
  if (REAL_KEY.test(text2)) return false;
  const issuers = [...text2.matchAll(JWT)].map((m) => jwtIssuer(m[1]));
  return issuers.length > 0 && issuers.every((iss) => iss === "supabase-demo");
}
var ENV_KIND_NOTE = {
  secret: "",
  "local-supabase": " Its keys are the public Supabase local-dev defaults, which is fine; make sure real project keys never go in this file.",
  "public-only": " It only sets browser-exposed variables, which ship in the bundle anyway; keep it that way, or real keys added later get committed too."
};
function envValueKind(text2, prefixes) {
  if (onlyLocalSupabaseKeys(text2)) return "local-supabase";
  const names = [...text2.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S/gm)].map((m) => m[1]);
  if (names.length > 0 && names.every((n) => prefixes.some((p) => n.startsWith(p))) && !REAL_KEY.test(text2) && !JWT_ANY.test(text2)) return "public-only";
  return "secret";
}
var envFileCommitted = {
  id: "env-file-committed",
  severity: "error",
  title: "Env file with real values committed to git (or not covered by .gitignore)",
  why: "Whatever is in `.env` goes to GitHub, every clone and every fork, and stays in git history after you delete it.",
  fix: "Add `.env*` and `!.env.example` to `.gitignore`. If git already tracks the file, run `git rm --cached <file>`, commit, and rotate every key that was in it.",
  check(project) {
    const out = [];
    const prefixes = publicPrefixes(project);
    const push = (f, where2) => {
      const kind = envValueKind(f.text, prefixes);
      out.push({
        rule: this.id,
        severity: kind === "secret" ? this.severity : "warning",
        message: `${where2}.${ENV_KIND_NOTE[kind]}`,
        file: f.path,
        line: 1
      });
    };
    for (const f of project.files) {
      if (f.kind !== "env" || TEMPLATE_ENV.test(f.path) || !HAS_VALUE.test(f.text)) continue;
      if (project.git) {
        const tracked = project.git.tracked.has(f.path);
        if (!tracked && project.git.ignored.has(f.path)) continue;
        push(f, tracked ? `\`${f.path}\` is committed to git` : `\`${f.path}\` is not ignored by git, so \`git add .\` will commit it`);
        continue;
      }
      if (f.path.includes("/") || isIgnored(project.gitignore, f.path)) continue;
      push(f, project.gitignore ? `\`${f.path}\` is not in .gitignore, so \`git add .\` will commit it` : `\`${f.path}\` exists and the project has no .gitignore`);
    }
    return out;
  }
};

// src/rules/stripe.ts
var EVENT_NAME = /["'`](checkout\.session\.completed|customer\.subscription\.[a-z_]+|invoice\.(?:paid|payment_succeeded|payment_failed)|payment_intent\.succeeded)["'`]/;
var VERIFIED = /\bconstructEvent(?:Async)?\s*\(/;
var READS_SIGNATURE = /headers(?:\(\))?\s*(?:\.get\s*\(\s*|\[\s*)["'`]stripe-signature["'`]/i;
function stripeWebhookFiles(project) {
  return project.files.filter((f) => {
    if (f.kind !== "source" || isTestFile(f) || isClientFile(project, f)) return false;
    const code = stripJsComments(f.text);
    const namesStripe = /stripe/i.test(code) || /stripe/i.test(f.path);
    if (EVENT_NAME.test(code) && /\b(POST|handler|serve|Deno\.serve|export default)\b/.test(code)) return true;
    if (!namesStripe) return false;
    return READS_SIGNATURE.test(code) || /webhook/i.test(f.path) && /\bevent\b/.test(code);
  });
}
var webhookUnverified = {
  id: "stripe-webhook-unverified",
  severity: "error",
  title: "Stripe webhook that doesn't verify the signature",
  why: "Without `stripe.webhooks.constructEvent`, anyone who finds the URL can POST a fake `checkout.session.completed` and get the paid plan for free.",
  fix: "Read the raw body (`await request.text()`), then call `stripe.webhooks.constructEvent(body, request.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)` and answer 400 when it throws. In Deno / edge runtimes use `await constructEventAsync(\u2026)`.",
  check(project) {
    return stripeWebhookFiles(project).filter((f) => !VERIFIED.test(stripJsComments(f.text))).map((f) => {
      const m = EVENT_NAME.exec(f.text) ?? /stripe/i.exec(f.text);
      return {
        rule: this.id,
        severity: this.severity,
        message: "Handles Stripe events without `constructEvent`, so any POST is trusted.",
        file: f.path,
        line: m ? lineAt(f.text, m.index) : 1
      };
    });
  }
};
var CONSTRUCT_EVENT = /\bconstructEvent(?:Async)?\s*\(\s*/g;
var PARSED_JSON = /\b(?:req|request|c\.req|ctx\.request)\.json\s*\(/;
var JSON_BODY_PARSER = /\b(?:express|bodyParser)\.json\s*\(/;
var RAW_BODY_PARSER = /\b(?:express|bodyParser)\.raw\s*\(/;
var webhookParsedBody = {
  id: "stripe-webhook-parsed-body",
  severity: "warning",
  title: "Stripe signature checked against a parsed body",
  why: "Stripe signs the exact bytes it sent. A body that was parsed and serialized again never matches, so every real event fails with 400, and the usual quick fix people reach for is deleting the check.",
  fix: "Pass the raw body to `constructEvent`: `await request.text()` in route handlers and edge functions, `express.raw({ type: 'application/json' })` on the webhook route before any `express.json()`, and `export const config = { api: { bodyParser: false } }` plus a raw buffer in a Next.js pages/api route.",
  check(project) {
    const jsonParserApp = project.files.some((f) => f.kind === "source" && JSON_BODY_PARSER.test(stripJsComments(f.text)));
    const rawParserApp = project.files.some((f) => f.kind === "source" && RAW_BODY_PARSER.test(stripJsComments(f.text)));
    const out = [];
    for (const f of stripeWebhookFiles(project)) {
      const code = stripJsComments(f.text);
      const add = (offset, message) => out.push({ rule: this.id, severity: this.severity, message, file: f.path, line: lineAt(f.text, offset) });
      const calls = [...code.matchAll(CONSTRUCT_EVENT)];
      if (!calls.length) continue;
      const json = PARSED_JSON.exec(code);
      if (json) add(json.index, "Reads the webhook body with `.json()` and then checks the signature, which needs the raw text.");
      for (const call of calls) {
        const arg = code.slice(call.index + call[0].length);
        const at = call.index;
        if (/^JSON\.stringify\s*\(/.test(arg)) add(at, "`constructEvent` gets `JSON.stringify(...)` of a parsed body, so the signature never matches.");
        else if (/^req\.body\b(?!\s*\.)/.test(arg)) {
          if (/(^|\/)pages\/api\//.test(f.path) && !/\bbodyParser\s*:\s*false\b/.test(code))
            add(at, "`req.body` in a pages/api route is already parsed JSON unless the route sets `bodyParser: false`.");
          else if (jsonParserApp && !rawParserApp)
            add(at, "`req.body` comes from `express.json()` and no `express.raw()` is set up, so it isn't the raw body.");
        }
      }
    }
    return out;
  }
};

// src/rules/server-adapters.ts
var ADAPTERS_REMOVED_ON = "2026-12-01";
var BRIDGE_MIN_VERSION = [1, 6, 0];
var BRIDGES_URL = "https://github.com/supabase/server/tree/main/examples/frameworks";
var BRIDGES = {
  hono: { file: "hono/supabase-middleware.ts", saveAs: "src/lib/supabase-middleware.ts", call: (e) => `toHono([${e}])` },
  h3: { file: "h3/supabase-middleware.ts", saveAs: "src/lib/supabase-middleware.ts", call: (e) => `toH3([${e}])` },
  elysia: {
    file: "elysia/supabase-middleware.ts",
    saveAs: "src/lib/supabase-middleware.ts",
    call: (e) => `wrapElysia([${e}], (req) => app.handle(req))`,
    note: "served as the fetch handler, with `.use(supabaseCtx<typeof entries>())` on the app"
  },
  nestjs: {
    file: "nestjs/supabase.guard.ts",
    saveAs: "src/lib/supabase.guard.ts",
    call: (e) => `toNestGuard([${e}])`,
    note: "called once into a const that every @UseGuards() reuses; @SupabaseCtx() reads become `@Req() req: Contributions<typeof entries>`"
  }
};
var ADAPTER_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])(?:npm:)?@supabase\/server(?:@[^/"'`\s]+)?\/adapters\/(hono|h3|elysia|nestjs)\1/g;
function minVersion(range) {
  const m = /^\s*(?:[\^~]|>=?|=)?\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(range.replace(/^npm:@supabase\/server@/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : void 0;
}
var older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function nearestPackage(project, file) {
  const parts = file.split("/").slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const path = [...parts.slice(0, i), "package.json"].join("/");
    const pkg = project.byPath.get(path);
    if (!pkg) continue;
    try {
      const json = JSON.parse(pkg.text);
      return { path, deps: { ...json.devDependencies, ...json.dependencies } };
    } catch {
      return void 0;
    }
  }
  return void 0;
}
var daysUntil = (today, day) => Math.round((Date.parse(day) - Date.parse(today)) / 864e5);
var removedBy = (today) => daysUntil(today, ADAPTERS_REMOVED_ON) <= 0;
function callArgs(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}
var MODE_ALIASES = { user: "user", none: "none", always: "none", publishable: "publishable", public: "publishable", secret: "secret" };
function optionModes(args, key) {
  const at = new RegExp(`\\b${key}\\s*:\\s*`).exec(args);
  if (!at) return void 0;
  const rest = args.slice(at.index + at[0].length);
  const single = /^(["'`])([^"'`]*)\1/.exec(rest);
  const list3 = /^\[([^\]]*)\]/.exec(rest);
  const raw = single ? [single[2]] : list3 ? [...list3[1].matchAll(/(["'`])([^"'`]*)\1/g)].map((m) => m[2]) : [];
  if (!raw.length || list3 && list3[1].replace(/(["'`])[^"'`]*\1/g, "").replace(/[\s,]/g, "")) return ["dynamic"];
  return raw.map((mode) => MODE_ALIASES[mode.split(":")[0]] ?? "dynamic");
}
function authValue(args) {
  const hasKey = (key) => new RegExp(`\\b${key}\\s*:`).test(args);
  if (!hasKey("auth") && !hasKey("allow")) return "user";
  const modes = optionModes(args, hasKey("auth") ? "auth" : "allow");
  const unique = [...new Set(modes)];
  if (unique.length === 1) return unique[0];
  if (unique.includes("publishable") || unique.includes("secret")) return unique.includes("secret") ? "secret" : "publishable";
  return "dynamic";
}
function replacement(adapter, auth) {
  const bridge = BRIDGES[adapter];
  const note = bridge.note ? `, ${bridge.note}` : "";
  switch (auth) {
    case "user":
      return `Replace it with \`${bridge.call("withRequiredClaims(), withSupabaseClient()")}\` (not withClaims(), which lets anonymous requests through with a 200)${note}.`;
    case "none":
      return `Replace it with \`${bridge.call("withSupabaseClient()")}\`${note}, no gate.`;
    case "publishable":
    case "secret":
      return "Keep this endpoint on `withSupabase` from '@supabase/server'; apikey auth has no composable gate.";
    case "dynamic":
      return "Decide it by hand: 'user' needs withRequiredClaims(), 'none' no gate, 'publishable' or 'secret' stays on withSupabase.";
  }
}
function withSupabaseNames(code) {
  const names = /* @__PURE__ */ new Set();
  const IMPORT_CLAUSE = /\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'`](?:npm:)?@supabase\/server(?:@[^/"'`\s]+)?\/adapters\/[a-z0-9]+["'`]/g;
  for (const m of code.matchAll(IMPORT_CLAUSE)) {
    for (const spec of m[1].split(",")) {
      const named = /^\s*withSupabase(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
      if (named) names.add(named[1] ?? "withSupabase");
    }
  }
  if (/\{\s*withSupabase\s*\}\s*=\s*(?:await\s+import|require)\s*\(\s*["'`][^"'`]*\/adapters\//.test(code)) names.add("withSupabase");
  return [...names];
}
function adapterFindings(project, f, rule) {
  const code = stripJsComments(f.text);
  const imports = [...code.matchAll(ADAPTER_IMPORT)];
  if (!imports.length) return [];
  const left = daysUntil(project.today, ADAPTERS_REMOVED_ON);
  const removed = removedBy(project.today);
  const severity = removed ? "error" : "warning";
  const when = removed ? `was removed on ${ADAPTERS_REMOVED_ON}` : `is removed on ${ADAPTERS_REMOVED_ON} (${left} day${left === 1 ? "" : "s"} left)`;
  const pkg = nearestPackage(project, f.path);
  const notes = [];
  const range = pkg?.deps["@supabase/server"];
  const min = range ? minVersion(range) : void 0;
  if (range && min && older(min, BRIDGE_MIN_VERSION) < 0)
    notes.push(`${pkg.path} allows @supabase/server ${range}; the bridges need 1.6.0 or later`);
  if (pkg && !("@supabase/middleware" in pkg.deps)) notes.push("add @supabase/middleware as a direct dependency (the bridge imports it)");
  const out = [];
  const adapters = /* @__PURE__ */ new Set();
  for (const m of imports) {
    const adapter2 = m[2];
    adapters.add(adapter2);
    const bridge = BRIDGES[adapter2];
    out.push({
      rule: rule.id,
      severity,
      message: `\`@supabase/server/adapters/${adapter2}\` ${when}. Copy \`${bridge.file}\` from supabase/server examples/frameworks to \`${bridge.saveAs}\`` + (notes.length ? `; ${notes.join("; ")}` : "") + ".",
      file: f.path,
      line: lineAt(f.text, m.index)
    });
  }
  const adapter = adapters.size === 1 ? [...adapters][0] : void 0;
  for (const name of withSupabaseNames(code)) {
    const CALL = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*(?:<[^>()]*>)?\\s*\\(`, "g");
    for (const call of code.matchAll(CALL)) {
      const args = callArgs(code, call.index + call[0].length - 1).trim();
      const auth = authValue(args);
      const shown = `${name}(${args.length > 60 ? args.slice(0, 57) + "..." : args})`.replace(/\s+/g, " ");
      out.push({
        rule: rule.id,
        severity,
        message: `\`${shown}\` ${auth === "dynamic" ? "has an auth value that isn't one literal" : `is auth: '${auth}'`}. ${replacement(adapter ?? "hono", auth).replace(adapter ? /^$/ : /toHono/g, "the bridge")}`,
        file: f.path,
        line: lineAt(f.text, call.index)
      });
    }
  }
  return out;
}
var CONTEXT_READ = /\.\s*supabaseContext\b|\.get\s*\(\s*["'`]supabaseContext["'`]\s*\)|\[\s*["'`]supabaseContext["'`]\s*\]/g;
function contextReadFindings(f, rule, severity) {
  const code = stripJsComments(f.text);
  return [...code.matchAll(CONTEXT_READ)].map((m) => ({
    rule: rule.id,
    severity,
    message: "Reads the adapters' `supabaseContext`, which the bridge entries don't set. Use the flat keys (`c.var.supabase`, `c.var.supabaseAdmin`, `c.var.jwtClaims`); `userClaims` is gone, so `.id` becomes `jwtClaims.sub`, `.appMetadata` `.app_metadata`, `.userMetadata` `.user_metadata`.",
    file: f.path,
    line: lineAt(f.text, m.index)
  }));
}
var dependsOnServer = (project) => project.files.some((f) => /(^|\/)package\.json$/.test(f.path) && /"@supabase\/server"\s*:/.test(f.text));
var serverAdapterRemoved = {
  id: "server-adapter-removed",
  severity: "error",
  title: "@supabase/server framework adapter (removed 2026-12-01)",
  why: "Supabase removes `@supabase/server/adapters/{hono,h3,elysia,nestjs}` on 2026-12-01, so an install or a Dependabot bump after that breaks the import. The migration has one silent trap: replacing `auth: 'user'` with `withClaims()` turns a 401 into a 200 for anonymous callers. Warning before the date, error from it.",
  fix: `Follow https://supabase.com/docs/reference/server/frameworks#moving-off-the-adapters. Need @supabase/server 1.6.0+ and Node 22+, add @supabase/middleware as a direct dependency, copy your framework's bridge from ${BRIDGES_URL} as is (comments included). Then: auth 'user' (or a bare withSupabase()) becomes \`toHono([withRequiredClaims(), withSupabaseClient()])\` with imports from '@supabase/server/middleware/required-claims' and '/middleware/client'; auth 'none' becomes \`toHono([withSupabaseClient()])\`; 'publishable' and 'secret' stay on withSupabase from '@supabase/server'. Rewrite \`c.var.supabaseContext.supabase\` to \`c.var.supabase\` and \`userClaims.id\` to \`jwtClaims.sub\` (field by field, no blanket rename). Then prove each gated endpoint still answers 401 without a token.`,
  check(project) {
    const sources = project.files.filter((f) => f.kind === "source");
    const imports = sources.flatMap((f) => adapterFindings(project, f, this));
    if (!imports.length && !dependsOnServer(project)) return [];
    const severity = removedBy(project.today) ? "error" : "warning";
    return [...imports, ...sources.flatMap((f) => contextReadFindings(f, this, severity))];
  }
};

// src/rules/cron.ts
var CHANGELOG = "https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed";
var DIRECT_WRITE = /^(insert\s+into|update)\s+(?:only\s+)?"?cron"?\s*\.\s*"?job"?(?![\w$"])/i;
var PLPGSQL_LEAD = /^(?:(?:begin|then|else|loop|exception\s+when\s+[\w\s]+?\s+then)\s+)+/i;
function dollarTag(src, i) {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))?.[0];
}
function skipQuoted(src, i) {
  const c = src[i];
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === c && src[j + 1] === c) j += 2;
      else if (src[j] === c) break;
      else j++;
    }
    return { end: Math.min(j + 1, src.length) };
  }
  if (c === "$") {
    const tag = dollarTag(src, i);
    if (!tag) return void 0;
    const close = src.indexOf(tag, i + tag.length);
    const bodyEnd = close === -1 ? src.length : close;
    return { end: close === -1 ? src.length : close + tag.length, body: { start: i + tag.length, end: bodyEnd } };
  }
  return void 0;
}
function blankSqlComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "-" && src[i + 1] === "-") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else {
      const q = skipQuoted(src, i);
      if (q?.body) {
        out += src.slice(i, q.body.start) + blankSqlComments(src.slice(q.body.start, q.body.end)) + src.slice(q.body.end, q.end);
        i = q.end;
      } else if (q) {
        out += src.slice(i, q.end);
        i = q.end;
      } else {
        out += src[i];
        i++;
      }
    }
  }
  return out;
}
function statements(src, from, to) {
  const out = [];
  let start = from;
  let bodies = [];
  let i = from;
  const push = (end) => {
    if (src.slice(start, end).trim()) out.push({ span: { start, end }, bodies });
    bodies = [];
  };
  while (i < to) {
    const q = skipQuoted(src, i);
    if (q) {
      if (q.body) bodies.push({ start: q.body.start, end: Math.min(q.body.end, to) });
      i = Math.min(q.end, to);
    } else if (src[i] === ";") {
      push(i);
      start = ++i;
    } else i++;
  }
  push(to);
  return out;
}
function splitTopLevel2(s) {
  const parts = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const q = skipQuoted(s, i);
    if (q) {
      i = q.end;
      continue;
    }
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(last, i).trim());
      last = i + 1;
    }
    i++;
  }
  parts.push(s.slice(last).trim());
  return parts;
}
function parenthesized(s, open) {
  if (s[open] !== "(") return void 0;
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const q = skipQuoted(s, i);
    if (q) {
      i = q.end;
      continue;
    }
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return { inner: s.slice(open + 1, i), after: i + 1 };
    i++;
  }
  return void 0;
}
var column = (raw) => raw.replace(/"/g, "").trim().toLowerCase();
var PARAMS = {
  jobname: "job_name",
  schedule: "schedule",
  command: "command",
  database: "database",
  username: "username",
  active: "active"
};
var MAX_ARG = 48;
var shorten = (value, name) => value.length > MAX_ARG ? `<${name}>` : value;
function insertRewrite(stmt) {
  const head = /^insert\s+into\s+(?:only\s+)?"?cron"?\s*\.\s*"?job"?\s*/i.exec(stmt);
  if (!head) return void 0;
  const cols = parenthesized(stmt, head[0].length);
  if (!cols) return void 0;
  const valuesAt = /^\s*values\s*/i.exec(stmt.slice(cols.after));
  if (!valuesAt) return void 0;
  const vals = parenthesized(stmt, cols.after + valuesAt[0].length);
  if (!vals) return void 0;
  const rest = stmt.slice(vals.after).trim();
  if (rest && !/^(on\s+conflict|returning)\b/i.test(rest)) return void 0;
  const names = splitTopLevel2(cols.inner).map(column);
  const values = splitTopLevel2(vals.inner);
  if (names.length !== values.length) return void 0;
  const row = /* @__PURE__ */ new Map();
  for (const [k, name2] of names.entries()) {
    if (name2 === "jobid") continue;
    if (!(name2 in PARAMS)) return void 0;
    row.set(name2, values[k]);
  }
  const schedule = row.get("schedule");
  const command = row.get("command");
  if (!schedule || !command) return void 0;
  const v = (name2) => shorten(row.get(name2), name2);
  const name = row.get("jobname");
  const extras = ["username", "active"].filter((k) => row.has(k));
  if (!row.has("database") && !extras.length) {
    return name ? `select cron.schedule(${v("jobname")}, ${v("schedule")}, ${v("command")});` : `select cron.schedule(${v("schedule")}, ${v("command")});`;
  }
  if (!name) return void 0;
  const database2 = row.has("database") ? v("database") : "current_database()";
  const named = extras.map((k) => `${k} := ${v(k)}`);
  return `select cron.schedule_in_database(${[v("jobname"), v("schedule"), v("command"), database2, ...named].join(", ")});`;
}
function updateRewrite(stmt) {
  const m = /^update\s+(?:only\s+)?"?cron"?\s*\.\s*"?job"?\s+set\s+([\s\S]*?)(?:\s+where\s+([\s\S]*?))?\s*(?:returning\b[\s\S]*)?$/i.exec(stmt.trim());
  if (!m) return void 0;
  const named = [];
  for (const item of splitTopLevel2(m[1])) {
    const eq = /^("?[A-Za-z_]+"?)\s*=\s*([\s\S]+)$/.exec(item);
    if (!eq) return void 0;
    const col = column(eq[1]);
    if (col === "jobname" || !(col in PARAMS)) return void 0;
    named.push(`${col} := ${shorten(eq[2].trim(), col)}`);
  }
  if (!named.length) return void 0;
  const where2 = m[2]?.trim();
  const byId = where2 && /^"?jobid"?\s*=\s*(\d+)$/i.exec(where2);
  if (byId) return `select cron.alter_job(${byId[1]}, ${named.join(", ")});`;
  return `select cron.alter_job(jobid, ${named.join(", ")}) from cron.job${where2 ? ` where ${where2}` : ""};`;
}
function cronFindings(file, rule) {
  const src = blankSqlComments(file.text);
  const out = [];
  const visit = (from, to, plpgsql) => {
    for (const { span, bodies } of statements(src, from, to)) {
      const raw = src.slice(span.start, span.end);
      let lead = raw.search(/\S/);
      if (plpgsql) lead += PLPGSQL_LEAD.exec(raw.slice(lead))?.[0].length ?? 0;
      const at = span.start + lead;
      const stmt = src.slice(at, span.end);
      const write = DIRECT_WRITE.exec(stmt);
      if (write) {
        const insert = /^insert/i.test(write[1]);
        let rewrite = insert ? insertRewrite(stmt) : updateRewrite(stmt);
        if (rewrite && plpgsql) rewrite = rewrite.replace(/^select /, "perform ");
        const verb = insert ? "insert into" : "update";
        const fallback = insert ? "use `select cron.schedule('<name>', '<schedule>', $$<command>$$);` instead" : "use `select cron.alter_job(<jobid>, schedule := \u2026, command := \u2026, active := \u2026);` instead (a rename is cron.unschedule + cron.schedule)";
        out.push({
          rule: rule.id,
          severity: rule.severity,
          message: `\`${verb} cron.job\` writes the pg_cron table directly, which Supabase blocks; ${rewrite ? `rewrite as \`${rewrite}\`` : fallback}.`,
          file: file.path,
          line: lineAt(file.text, at)
        });
        continue;
      }
      const procedural = /^do\b/i.test(stmt) || /^create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(stmt) && /\blanguage\s+'?plpgsql\b/i.test(stmt);
      for (const b of bodies) visit(b.start, b.end, procedural);
    }
  };
  visit(0, src.length, false);
  return out;
}
var isSupabaseSql = (f) => /(^|\/)supabase\/(?:migrations\/[^/]+|seed|seeds?\/[^/]+)\.sql$/.test(f.path);
var cronJobDirectWrite = {
  id: "cron-job-direct-write",
  severity: "warning",
  title: "Direct INSERT/UPDATE on pg_cron's cron.job table",
  why: `Supabase doesn't allow writing \`cron.job\` rows directly, because that skips the checks pg_cron's functions make (${CHANGELOG}). The migration or seed fails with a permission error on a Supabase project, often only in CI or on the first deploy.`,
  fix: "Create jobs with `select cron.schedule('<name>', '<schedule>', $$<command>$$);` (a name that exists updates that job, so it's safe to rerun), or `cron.schedule_in_database(...)` for another database or user. Change one with `select cron.alter_job(<jobid>, schedule := \u2026, command := \u2026, active := \u2026);`, or for a name `select cron.alter_job(jobid, active := false) from cron.job where jobname = '<name>';`. Remove one with `select cron.unschedule('<name>');`.",
  check(project) {
    return project.files.filter((f) => f.kind === "sql" && (isSupabaseSql(f) || project.usesSupabase)).flatMap((f) => cronFindings(f, this));
  }
};

// src/rules/index.ts
var allRules = [
  rlsDisabled,
  rlsPermissivePolicy,
  rlsNoPolicy,
  rlsUpdatePrivilegedColumn,
  viewBypassesRls,
  authUsersExposed,
  definerSearchPath,
  definerFunctionAnon,
  storagePublicBucket,
  grantLeak,
  grantsMissing,
  grantBroad,
  serverSecretInClient,
  publicEnvSecret,
  webhookUnverified,
  webhookParsedBody,
  envFileCommitted,
  serverAdapterRemoved,
  cronJobDirectWrite
];
var ruleGroups = {
  database: [rlsDisabled, rlsPermissivePolicy, rlsNoPolicy, rlsUpdatePrivilegedColumn, viewBypassesRls, authUsersExposed, definerSearchPath, definerFunctionAnon, storagePublicBucket, grantLeak, grantsMissing, grantBroad].map((r) => r.id),
  secrets: [serverSecretInClient, publicEnvSecret, envFileCommitted].map((r) => r.id),
  stripe: [webhookUnverified, webhookParsedBody].map((r) => r.id),
  /** Supabase breaking changes that make code or migrations fail after an upgrade or a cutoff date. */
  breaking: [serverAdapterRemoved, cronJobDirectWrite].map((r) => r.id)
};

// src/engine.ts
var IGNORE = /vibe-preflight-ignore\b([\w\s,-]*)/;
function ignoredInline(project, f) {
  const lines = project.byPath.get(f.file)?.text.split("\n");
  if (!lines) return false;
  for (const l of [lines[f.line - 1], lines[f.line - 2]]) {
    const m = l === void 0 ? null : IGNORE.exec(l);
    if (!m) continue;
    const ids = m[1].split(/[\s,]+/).filter((x) => /^[a-z][a-z0-9-]+$/.test(x));
    if (!ids.length || ids.includes(f.rule)) return true;
  }
  return false;
}
function scanProject(project, skip = []) {
  const rules = allRules.filter((r) => !skip.includes(r.id));
  const findings = [];
  let suppressed = 0;
  for (const rule of rules) {
    for (const f of rule.check(project)) {
      if (ignoredInline(project, f)) suppressed++;
      else findings.push(f);
    }
  }
  findings.sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)
  );
  return { project, rules, findings, suppressed };
}
function counts(findings) {
  const c = { error: 0, warning: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
function failsAt(findings, level) {
  if (!level) return false;
  return findings.some((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[level]);
}

// src/scan.ts
function scan(root, skip = [], options = {}) {
  return scanProject(loadProject(root, options.today), skip);
}

// src/report.ts
var VERSION = "1.6.1";
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function summary(r) {
  const c = counts(r.findings);
  return `${plural(c.error, "error")}, ${plural(c.warning, "warning")}`;
}
function text(r, color, explain) {
  const c = (code, s) => color ? `\x1B[${code}m${s}\x1B[0m` : s;
  const tag = { error: c("31;1", "error  "), warning: c("33;1", "warning") };
  const files = r.project.files.filter((f) => f.kind === "source").length;
  const sql = r.project.files.filter((f) => f.kind === "sql").length;
  const out = [c("1", `vibe-preflight ${VERSION}`) + c("2", ` \xB7 ${r.project.name} \xB7 ${plural(files, "source file")}, ${plural(sql, "SQL file")} \xB7 ${plural(r.rules.length, "check")}`), ""];
  for (const f of r.findings) {
    out.push(`${tag[f.severity]} ${c("2", `${f.file}:${f.line}`)}`);
    out.push(`        ${f.message} ${c("2", `[${f.rule}]`)}`);
  }
  if (r.findings.length) out.push("");
  if (explain && r.findings.length) {
    const byId = new Map(r.rules.map((rule) => [rule.id, rule]));
    for (const id of new Set(r.findings.map((f) => f.rule))) {
      const rule = byId.get(id);
      out.push(c("1", `${id}: ${rule.title}`), `  why: ${rule.why}`, `  fix: ${rule.fix}`, "");
    }
  }
  const line = summary(r) + (r.suppressed ? c("2", ` (${r.suppressed} ignored inline)`) : "");
  const c2 = counts(r.findings);
  out.push(c2.error ? c("31;1", line) : r.findings.length ? c("33", line) : c("32;1", `\u2713 ${line}`));
  if (r.findings.length && !explain) out.push(c("2", "Run with --explain for why each one matters and how to fix it."));
  return out.join("\n") + "\n";
}

// src/sarif.ts
var SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
var INFORMATION_URI = "https://github.com/atokim4/vibe-preflight";
var CHECKS_URI = `${INFORMATION_URI}#the-19-checks`;
var SECURITY_SEVERITY = { error: "8.0", warning: "5.0" };
var pascal = (id) => id.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
var plain = (s) => s.replace(/`/g, "");
var cap = (s, max = 1024) => s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
function groupOf(id) {
  return Object.entries(ruleGroups).find(([, ids]) => ids.includes(id))?.[0];
}
function sarifRule(rule) {
  const group = groupOf(rule.id);
  return {
    id: rule.id,
    name: pascal(rule.id),
    shortDescription: { text: cap(plain(rule.title)) },
    fullDescription: { text: cap(plain(rule.why)) },
    help: {
      text: `Why: ${plain(rule.why)}

Fix: ${plain(rule.fix)}`,
      markdown: `**Why it matters:** ${rule.why}

**How to fix it:** ${rule.fix}

[All checks](${CHECKS_URI})`
    },
    helpUri: CHECKS_URI,
    defaultConfiguration: { level: rule.severity },
    properties: {
      tags: ["security", ...group ? [group] : [], ...group === "database" ? ["supabase"] : []],
      precision: "medium",
      "security-severity": SECURITY_SEVERITY[rule.severity]
    }
  };
}
function toSarif(result, options = {}) {
  const prefix = (options.pathPrefix ?? "").replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
  const rules = result.rules.map(sarifRule);
  const index = new Map(rules.map((r, i) => [r.id, i]));
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "vibe-preflight", semanticVersion: VERSION, informationUri: INFORMATION_URI, rules } },
        results: result.findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: index.get(f.rule),
          level: f.severity,
          message: { text: plain(f.message) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodePath(prefix ? `${prefix}/${f.file}` : f.file), uriBaseId: "%SRCROOT%" },
                region: { startLine: Math.max(1, f.line) }
              }
            }
          ]
        }))
      }
    ]
  };
}
var encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

// src/summary.ts
var plural2 = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var cell = (s) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
function location(f, options) {
  const prefix = options.pathPrefix ? `${options.pathPrefix.replace(/\/+$/, "")}/` : "";
  const path = `${prefix}${f.file}`;
  const label = `\`${cell(path)}:${f.line}\``;
  if (!options.blobUrl) return label;
  const href = `${options.blobUrl.replace(/\/+$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}#L${f.line}`;
  return `[${label}](${href})`;
}
function markdownSummary(r, options = {}) {
  const maxRows = options.maxRows ?? 200;
  const c = counts(r.findings);
  const scanned = options.pathPrefix ? ` in \`${options.pathPrefix}\`` : "";
  const out = [`## vibe-preflight ${VERSION}`, ""];
  if (!r.findings.length) {
    out.push(`No findings${scanned}: ${plural2(r.rules.length, "check")} passed.`);
    if (r.suppressed) out.push("", `${plural2(r.suppressed, "finding")} silenced with a \`vibe-preflight-ignore\` comment.`);
    return out.join("\n") + "\n";
  }
  const ignored = r.suppressed ? `, ${r.suppressed} ignored inline` : "";
  out.push(`**${plural2(c.error, "error")}, ${plural2(c.warning, "warning")}**${scanned} (${plural2(r.rules.length, "check")} ran${ignored}).`, "");
  out.push("| Severity | Check | Location | Finding |", "|---|---|---|---|");
  for (const f of r.findings.slice(0, maxRows)) {
    out.push(`| ${f.severity} | \`${f.rule}\` | ${location(f, options)} | ${cell(f.message)} |`);
  }
  if (r.findings.length > maxRows) out.push("", `${r.findings.length - maxRows} more not shown. The SARIF file has all of them.`);
  out.push("", "### How to fix", "");
  const byId = new Map(r.rules.map((rule) => [rule.id, rule]));
  for (const id of new Set(r.findings.map((f) => f.rule))) {
    const rule = byId.get(id);
    out.push(`<details><summary><code>${id}</code>: ${rule.title.replace(/`/g, "")}</summary>`, "", `**Why:** ${rule.why}`, "", `**Fix:** ${rule.fix}`, "", "</details>", "");
  }
  return out.join("\n");
}

// src/select.ts
var SelectionError = class extends Error {
};
var parseList = (value) => value?.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) ?? [];
function rulesToSkip(include, exclude) {
  const known = new Set(allRules.map((r) => r.id));
  for (const id of exclude) if (!known.has(id)) throw new SelectionError(`unknown check "${id}" (exclude takes check ids; see --list)`);
  const skip = new Set(exclude);
  if (include.length) {
    const wanted = /* @__PURE__ */ new Set();
    for (const name of include) {
      const ids = ruleGroups[name] ?? (known.has(name) ? [name] : void 0);
      if (!ids) throw new SelectionError(`unknown group or check "${name}" (groups: ${Object.keys(ruleGroups).join(", ")}; checks: --list)`);
      for (const id of ids) wanted.add(id);
    }
    for (const id of known) if (!wanted.has(id)) skip.add(id);
  }
  return [...skip];
}

// src/action/github.ts
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";
function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function setOutput(name, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  if (!/[\r\n]/.test(value)) {
    appendFileSync(file, `${name}=${value}${EOL}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
}
function appendSummary(markdown, env = process.env) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  appendFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}
`);
  return true;
}
var escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
function annotation(level, message, props = {}) {
  const parts = Object.entries(props).filter(([, v]) => v !== void 0 && v !== "").map(([k, v]) => `${k}=${escapeProperty(String(v))}`);
  return `::${level}${parts.length ? ` ${parts.join(",")}` : ""}::${escapeData(message)}`;
}

// src/action/main.ts
var InputError = class extends Error {
};
function oneOf(name, value, allowed) {
  if (allowed.includes(value)) return value;
  throw new InputError(`input "${name}" must be one of ${allowed.join(", ")} (got "${value}")`);
}
var toPosix = (p) => p.split(sep2).join("/");
function readInputs(env) {
  const workspace = resolve(env.GITHUB_WORKSPACE || process.cwd());
  const root = resolve(workspace, getInput("path", env) || ".");
  const prefix = toPosix(relative2(workspace, root));
  if (prefix.startsWith("..") || isAbsolute(prefix)) throw new InputError(`input "path" must be inside the workspace (${workspace}), got ${root}`);
  if (!isDirectory(root)) throw new InputError(`input "path" is not a folder: ${root}`);
  let skip;
  try {
    skip = rulesToSkip(parseList(getInput("include", env)), parseList(getInput("exclude", env)));
  } catch (error) {
    if (error instanceof SelectionError) throw new InputError(error.message);
    throw error;
  }
  return {
    workspace,
    root,
    prefix,
    failOn: oneOf("fail-on", getInput("fail-on", env) || "error", ["error", "warning", "none"]),
    format: oneOf("format", getInput("format", env) || "sarif", ["sarif", "markdown"]),
    skip,
    sarifFile: getInput("sarif-file", env) || "vibe-preflight.sarif"
  };
}
function blobUrl(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = env;
  return server && repo && sha ? `${server}/${repo}/blob/${sha}` : void 0;
}
function writeSarif(result, inputs) {
  const file = resolve(inputs.workspace, inputs.sarifFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(toSarif(result, { pathPrefix: inputs.prefix }), null, 2) + "\n");
  const rel = toPosix(relative2(inputs.workspace, file));
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}
function run(env = process.env, log = (l) => process.stdout.write(`${l}
`)) {
  let inputs;
  try {
    inputs = readInputs(env);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    log(annotation("error", `vibe-preflight: ${error.message}`));
    return 1;
  }
  const result = scan(inputs.root, inputs.skip);
  log(text(result, false, false).trimEnd());
  for (const f of result.findings) {
    const file = inputs.prefix ? `${inputs.prefix}/${f.file}` : f.file;
    log(annotation(f.severity, f.message, { file, line: f.line, title: `vibe-preflight: ${f.rule}` }));
  }
  const summary2 = markdownSummary(result, { pathPrefix: inputs.prefix, blobUrl: blobUrl(env) });
  if (!appendSummary(summary2, env) && inputs.format === "markdown") log(summary2);
  const sarifFile = inputs.format === "sarif" ? writeSarif(result, inputs) : "";
  if (sarifFile) log(`SARIF written to ${sarifFile}`);
  setOutput("findings-count", String(result.findings.length), env);
  setOutput("errors-count", String(result.findings.filter((f) => f.severity === "error").length), env);
  setOutput("sarif-file", sarifFile, env);
  if (inputs.failOn !== "none" && failsAt(result.findings, inputs.failOn)) {
    log(annotation("error", `vibe-preflight: failing because of findings at "${inputs.failOn}" level or above (set fail-on: none to only report)`));
    return 1;
  }
  return 0;
}

// src/action/index.ts
try {
  process.exitCode = run();
} catch (error) {
  process.stdout.write(`${annotation("error", `vibe-preflight crashed: ${error.stack ?? String(error)}`)}
`);
  process.exitCode = 1;
}
