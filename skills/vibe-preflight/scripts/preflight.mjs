#!/usr/bin/env node

// src/cli.ts
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// src/types.ts
var SEVERITY_ORDER = { error: 2, warning: 1 };

// src/project.ts
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
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
var SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
var ENV_FILE = /^\.env(?:\..+)?$/;
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
function loadProject(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name === SELF) continue;
      let kind;
      if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith(".d.ts")) kind = "source";
      else if (entry.name.endsWith(".sql")) kind = "sql";
      else if (ENV_FILE.test(entry.name)) kind = "env";
      else if (entry.name === "package.json" || entry.name === ".gitignore") kind = "other";
      if (!kind || statSync(abs).size > MAX_FILE_BYTES) continue;
      files.push({ path: relative(root, abs).split(sep).join("/"), text: readFileSync(abs, "utf8"), kind });
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
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
    name: typeof pkg.name === "string" ? pkg.name : basename(root),
    frameworks,
    files,
    byPath,
    gitignore: byPath.get(".gitignore")?.text,
    git: gitState(root, files.filter((f) => f.kind === "env").map((f) => f.path)),
    usesSupabase
  };
}
function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

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
function basename2(path) {
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
  const statements = [];
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
        statements.push({ file: file.path, line: startLine + raw.slice(0, lead).split("\n").length - 1, norm });
      }
      start = k + 1;
      startLine = line;
    }
    if (ch === "\n") line++;
  }
  return statements;
}
function tableName(raw) {
  const parts = raw.replace(/"/g, "").split(".");
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}
var IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?`;
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
function buildSchema(files) {
  const tables = /* @__PURE__ */ new Map();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    for (const st of splitSql(file)) {
      const s = st.norm;
      let m;
      if (m = new RegExp(`^create (?:(?:global |local )?(?:temporary |temp )|unlogged )?table (?:if not exists )?(${IDENT})\\s*\\(`).exec(s)) {
        const name = tableName(m[1]);
        if (!tables.has(name)) tables.set(name, { name, file: st.file, line: st.line, rls: false, policies: [] });
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
        const rename = /^rename to "?([a-z_][a-z0-9_]*)"?/.exec(rest);
        if (rename) {
          tables.delete(t.name);
          t.name = `${t.name.split(".")[0]}.${rename[1]}`;
          tables.set(t.name, t);
        }
        continue;
      }
      if (m = new RegExp(`^create policy ("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})(.*)$`).exec(s)) {
        const t = tables.get(tableName(m[2]));
        if (!t) continue;
        const rest = m[3];
        const command = / for (all|select|insert|update|delete)\b/.exec(rest)?.[1] ?? "all";
        const rolesRaw = / to ([a-z_, "]+?)(?= using| with check|$)/.exec(rest)?.[1];
        t.policies.push({
          name: m[1].replace(/"/g, ""),
          command,
          roles: rolesRaw ? rolesRaw.split(",").map((r) => r.replace(/"/g, "").trim()) : ["public"],
          using: clause(rest, /\busing\s*\(/),
          withCheck: clause(rest, /\bwith check\s*\(/),
          file: st.file,
          line: st.line
        });
        continue;
      }
      if (m = new RegExp(`^drop policy (?:if exists )?("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})`).exec(s)) {
        const t = tables.get(tableName(m[2]));
        const name = m[1].replace(/"/g, "");
        if (t) t.policies = t.policies.filter((p) => p.name !== name);
      }
    }
  }
  return tables;
}

// src/rules/database.ts
var cache = /* @__PURE__ */ new WeakMap();
function publicTables(project) {
  let tables = cache.get(project);
  if (!tables) {
    const sql = project.usesSupabase ? project.files.filter((f) => f.kind === "sql") : [];
    tables = [...buildSchema(sql).values()].filter((t) => t.name.startsWith("public."));
    cache.set(project, tables);
  }
  return tables;
}
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

// src/rules/secrets.ts
var SECRET_NAME = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES_URL|WEBHOOK_SIGNING|_SK$|SIGNING_KEY)/;
var MAYBE_SECRET_NAME = /(API_KEY|TOKEN|ACCESS_KEY|_KEY$)/;
var BROWSER_SAFE_NAME = /(ANON|PUBLISHABLE|PUBLIC_KEY|FIREBASE|MAPS|SITE_KEY|MEASUREMENT|POSTHOG|SENTRY_DSN|PUSHER_KEY|ALGOLIA_SEARCH|MAPBOX)/;
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
    for (const f of files) {
      const text2 = f.kind === "source" ? stripJsComments(f.text) : f.text;
      for (const m of text2.matchAll(re)) if (!first.has(m[0])) first.set(m[0], { file: f.path, line: lineAt(text2, m.index) });
    }
    const out = [];
    for (const [name, at] of first) {
      const bare = prefixes.reduce((n, p) => n.startsWith(p) ? n.slice(p.length) : n, name);
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
          message: `${basename2(f.path)} runs in the browser and uses ${m[1] ? `\`${what}\`` : "the `service_role` key"}.`,
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
var envFileCommitted = {
  id: "env-file-committed",
  severity: "error",
  title: "Env file with real values committed to git (or not covered by .gitignore)",
  why: "Whatever is in `.env` goes to GitHub, every clone and every fork, and stays in git history after you delete it.",
  fix: "Add `.env*` and `!.env.example` to `.gitignore`. If git already tracks the file, run `git rm --cached <file>`, commit, and rotate every key that was in it.",
  check(project) {
    const out = [];
    for (const f of project.files) {
      if (f.kind !== "env" || TEMPLATE_ENV.test(f.path) || !HAS_VALUE.test(f.text)) continue;
      if (project.git) {
        const tracked = project.git.tracked.has(f.path);
        if (!tracked && project.git.ignored.has(f.path)) continue;
        out.push({
          rule: this.id,
          severity: this.severity,
          message: tracked ? `\`${f.path}\` is committed to git.` : `\`${f.path}\` is not ignored by git, so \`git add .\` will commit it.`,
          file: f.path,
          line: 1
        });
        continue;
      }
      if (f.path.includes("/") || isIgnored(project.gitignore, f.path)) continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        message: project.gitignore ? `\`${f.path}\` is not in .gitignore, so \`git add .\` will commit it.` : `\`${f.path}\` exists and the project has no .gitignore.`,
        file: f.path,
        line: 1
      });
    }
    return out;
  }
};

// src/rules/stripe.ts
var EVENT_NAME = /["'`](checkout\.session\.completed|customer\.subscription\.[a-z_]+|invoice\.(?:paid|payment_succeeded|payment_failed)|payment_intent\.succeeded)["'`]/;
var VERIFIED = /\bconstructEvent(?:Async)?\s*\(/;
function stripeWebhookFiles(project) {
  return project.files.filter((f) => {
    if (f.kind !== "source" || isTestFile(f) || isClientFile(project, f)) return false;
    const code = stripJsComments(f.text);
    const namesStripe = /stripe/i.test(code) || /stripe/i.test(f.path);
    if (EVENT_NAME.test(code) && /\b(POST|handler|serve|Deno\.serve|export default)\b/.test(code)) return true;
    if (!namesStripe) return false;
    return /stripe-signature/i.test(code) || /webhook/i.test(f.path) && /\bevent\b/.test(code);
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

// src/rules/index.ts
var allRules = [rlsDisabled, rlsPermissivePolicy, serverSecretInClient, publicEnvSecret, webhookUnverified, envFileCommitted];

// src/scan.ts
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
function scan(root, skip = []) {
  const project = loadProject(root);
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

// src/report.ts
var VERSION = "1.0.0";
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function summary(r) {
  const c = counts(r.findings);
  return `${plural(c.error, "error")}, ${plural(c.warning, "warning")}`;
}
function json(r) {
  return JSON.stringify(
    {
      tool: "vibe-preflight",
      version: VERSION,
      project: r.project.name,
      frameworks: r.project.frameworks,
      supabase: r.project.usesSupabase,
      rules: r.rules.map((rule) => rule.id),
      summary: counts(r.findings),
      suppressed: r.suppressed,
      findings: r.findings
    },
    null,
    2
  ) + "\n";
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
function ruleList() {
  return allRules.map((r) => `${r.id.padEnd(28)} ${r.severity.padEnd(8)} ${r.title}`).join("\n") + "\n";
}

// src/cli.ts
var HELP = `vibe-preflight ${VERSION}: 6 pre-launch security checks for Supabase + Stripe apps (Next.js, Vite, Expo)

Usage
  node preflight.mjs [dir]              scan a project (default: current directory)
  node preflight.mjs --list             list the checks

Options
  -f, --format <text|json>              output format (default: text)
  -e, --explain                         text output: add why each finding matters and how to fix it
      --fail-on <error|warning|never>   exit 1 when a finding at this level or above exists (default: error)
      --skip <rule,rule>                turn checks off for this run
      --no-color                        plain text (NO_COLOR is respected too)
  -h, --help / -v, --version

Exit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage error.
Silence one finding with a "vibe-preflight-ignore <rule-id>" comment on its line or the line above.
`;
var UsageError = class extends Error {
};
function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", short: "f", default: "text" },
        explain: { type: "boolean", short: "e", default: false },
        "fail-on": { type: "string", default: "error" },
        skip: { type: "string" },
        "no-color": { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false }
      }
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  const info = values.help ? HELP : values.version ? `${VERSION}
` : values.list ? ruleList() : void 0;
  if (info) {
    process.stdout.write(info);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError(`expected one folder, got: ${positionals.join(" ")}`);
  const dir = resolve(positionals[0] ?? ".");
  if (!isDirectory(dir)) throw new UsageError(`not a folder: ${dir}`);
  const format = values.format;
  if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json (got "${format}")`);
  const failOn = values["fail-on"];
  if (failOn !== "error" && failOn !== "warning" && failOn !== "never") throw new UsageError(`--fail-on must be error, warning or never (got "${failOn}")`);
  const skip = values.skip?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const known = new Set(allRules.map((r) => r.id));
  for (const id of skip) if (!known.has(id)) throw new UsageError(`unknown check "${id}" in --skip (see --list)`);
  const result = scan(dir, skip);
  const color = !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  process.stdout.write(format === "json" ? json(result) : text(result, color, values.explain));
  if (failOn === "never") return 0;
  const c = counts(result.findings);
  const threshold = SEVERITY_ORDER[failOn];
  return Object.keys(c).some((s) => SEVERITY_ORDER[s] >= threshold && c[s] > 0) ? 1 : 0;
}
try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`vibe-preflight: ${error.message}
Run with --help for usage.
`);
  process.exitCode = 2;
}
