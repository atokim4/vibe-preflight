import type { Finding, Project, Rule, SourceFile } from "../types.ts";
import { lineAt, stripJsComments } from "../text.ts";

/**
 * The framework adapters in @supabase/server are deprecated and removed on 2026-12-01
 * (https://supabase.com/changelog/supabase-server-adapters-deprecated). The replacement is a bridge file copied
 * from the server repo's examples/frameworks, called on an entry array
 * (https://supabase.com/docs/reference/server/frameworks#moving-off-the-adapters).
 */
export const ADAPTERS_REMOVED_ON = "2026-12-01";
/** The bridges need @supabase/server 1.6.0 or later. */
const BRIDGE_MIN_VERSION: Version = [1, 6, 0];
const BRIDGES_URL = "https://github.com/supabase/server/tree/main/examples/frameworks";

type Adapter = "hono" | "h3" | "elysia" | "nestjs";

interface Bridge {
  /** File in examples/frameworks to copy into the project. */
  file: string;
  /** How the guide suggests saving it. */
  saveAs: string;
  /** The replacement for a registration, given the entry list. */
  call: (entries: string) => string;
  /** What else changes at the registration for this framework. */
  note?: string;
}

const BRIDGES: Record<Adapter, Bridge> = {
  hono: { file: "hono/supabase-middleware.ts", saveAs: "src/lib/supabase-middleware.ts", call: (e) => `toHono([${e}])` },
  h3: { file: "h3/supabase-middleware.ts", saveAs: "src/lib/supabase-middleware.ts", call: (e) => `toH3([${e}])` },
  elysia: {
    file: "elysia/supabase-middleware.ts",
    saveAs: "src/lib/supabase-middleware.ts",
    call: (e) => `wrapElysia([${e}], (req) => app.handle(req))`,
    note: "served as the fetch handler, with `.use(supabaseCtx<typeof entries>())` on the app",
  },
  nestjs: {
    file: "nestjs/supabase.guard.ts",
    saveAs: "src/lib/supabase.guard.ts",
    call: (e) => `toNestGuard([${e}])`,
    note: "called once into a const that every @UseGuards() reuses; @SupabaseCtx() reads become `@Req() req: Contributions<typeof entries>`",
  },
};

/** `from '@supabase/server/adapters/hono'`, `import('…')`, `require('…')`, Deno's `npm:@supabase/server@1.9.0/adapters/h3`. */
const ADAPTER_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])(?:npm:)?@supabase\/server(?:@[^/"'`\s]+)?\/adapters\/(hono|h3|elysia|nestjs)\1/g;

type Version = [number, number, number];

/** The lowest version a range like `^1.4.0`, `~1.9.1`, `>=1.5.1 <2` or `1.6.0` allows. Undefined for tags, URLs, `*`. */
export function minVersion(range: string): Version | undefined {
  const m = /^\s*(?:[\^~]|>=?|=)?\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(range.replace(/^npm:@supabase\/server@/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

const older = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The package.json closest to `file` (same folder or an ancestor), parsed. */
function nearestPackage(project: Project, file: string): { path: string; deps: Record<string, string> } | undefined {
  const parts = file.split("/").slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const path = [...parts.slice(0, i), "package.json"].join("/");
    const pkg = project.byPath.get(path);
    if (!pkg) continue;
    try {
      const json = JSON.parse(pkg.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return { path, deps: { ...json.devDependencies, ...json.dependencies } };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Days from `today` to `day`, both YYYY-MM-DD. */
const daysUntil = (today: string, day: string) => Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000);

const removedBy = (today: string) => daysUntil(today, ADAPTERS_REMOVED_ON) <= 0;

/** The text between the parentheses of a call that starts at `open` (the index of `(`). */
function callArgs(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

export type AuthValue = "user" | "none" | "publishable" | "secret" | "dynamic";

/** Old `allow` values: 'always' was 'none', 'public' was 'publishable'. */
const MODE_ALIASES: Record<string, AuthValue> = { user: "user", none: "none", always: "none", publishable: "publishable", public: "publishable", secret: "secret" };

/** The string literals of an option (`auth: 'user'` or `auth: ['user', 'secret:cron']`), or undefined when it isn't literal. */
function optionModes(args: string, key: "auth" | "allow"): AuthValue[] | undefined {
  const at = new RegExp(`\\b${key}\\s*:\\s*`).exec(args);
  if (!at) return undefined;
  const rest = args.slice(at.index + at[0].length);
  const single = /^(["'`])([^"'`]*)\1/.exec(rest);
  const list = /^\[([^\]]*)\]/.exec(rest);
  const raw = single ? [single[2]!] : list ? [...list[1]!.matchAll(/(["'`])([^"'`]*)\1/g)].map((m) => m[2]!) : [];
  if (!raw.length || (list && list[1]!.replace(/(["'`])[^"'`]*\1/g, "").replace(/[\s,]/g, ""))) return ["dynamic"];
  return raw.map((mode) => MODE_ALIASES[mode.split(":")[0]!] ?? "dynamic");
}

/**
 * The `auth` a `withSupabase(...)` registration uses. No config, or a config without `auth`/`allow`, means 'user'.
 * `allow` is the deprecated name and loses to `auth`. A list that mixes in an apikey mode can't move to a bridge
 * gate; any other mixed list needs a person to decide.
 */
export function authValue(args: string): AuthValue {
  const hasKey = (key: string) => new RegExp(`\\b${key}\\s*:`).test(args);
  if (!hasKey("auth") && !hasKey("allow")) return "user";
  const modes = optionModes(args, hasKey("auth") ? "auth" : "allow")!;
  const unique = [...new Set(modes)];
  if (unique.length === 1) return unique[0]!;
  if (unique.includes("publishable") || unique.includes("secret")) return unique.includes("secret") ? "secret" : "publishable";
  return "dynamic";
}

/** What to do with a registration, per the guide's "Decide what replaces each auth value" table. One sentence. */
export function replacement(adapter: Adapter, auth: AuthValue): string {
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

/** The local names `withSupabase` is imported under from adapter specifiers in this file. */
function withSupabaseNames(code: string): string[] {
  const names = new Set<string>();
  const IMPORT_CLAUSE = /\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'`](?:npm:)?@supabase\/server(?:@[^/"'`\s]+)?\/adapters\/[a-z0-9]+["'`]/g;
  for (const m of code.matchAll(IMPORT_CLAUSE)) {
    for (const spec of m[1]!.split(",")) {
      const named = /^\s*withSupabase(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
      if (named) names.add(named[1] ?? "withSupabase");
    }
  }
  // `const { withSupabase } = require('@supabase/server/adapters/hono')`
  if (/\{\s*withSupabase\s*\}\s*=\s*(?:await\s+import|require)\s*\(\s*["'`][^"'`]*\/adapters\//.test(code)) names.add("withSupabase");
  return [...names];
}

function adapterFindings(project: Project, f: SourceFile, rule: Rule): Finding[] {
  const code = stripJsComments(f.text);
  const imports = [...code.matchAll(ADAPTER_IMPORT)];
  if (!imports.length) return [];

  const left = daysUntil(project.today, ADAPTERS_REMOVED_ON);
  const removed = removedBy(project.today);
  const severity = removed ? "error" : "warning";
  const when = removed ? `was removed on ${ADAPTERS_REMOVED_ON}` : `is removed on ${ADAPTERS_REMOVED_ON} (${left} day${left === 1 ? "" : "s"} left)`;

  const pkg = nearestPackage(project, f.path);
  const notes: string[] = [];
  const range = pkg?.deps["@supabase/server"];
  const min = range ? minVersion(range) : undefined;
  if (range && min && older(min, BRIDGE_MIN_VERSION) < 0)
    notes.push(`${pkg!.path} allows @supabase/server ${range}; the bridges need 1.6.0 or later`);
  if (pkg && !("@supabase/middleware" in pkg.deps)) notes.push("add @supabase/middleware as a direct dependency (the bridge imports it)");

  const out: Finding[] = [];
  const adapters = new Set<Adapter>();
  for (const m of imports) {
    const adapter = m[2] as Adapter;
    adapters.add(adapter);
    const bridge = BRIDGES[adapter];
    out.push({
      rule: rule.id,
      severity,
      message:
        `\`@supabase/server/adapters/${adapter}\` ${when}. Copy \`${bridge.file}\` from supabase/server examples/frameworks to \`${bridge.saveAs}\`` +
        (notes.length ? `; ${notes.join("; ")}` : "") +
        ".",
      file: f.path,
      line: lineAt(f.text, m.index),
    });
  }

  // Each registration's replacement depends on its auth value, which is what the migration can get wrong.
  const adapter = adapters.size === 1 ? [...adapters][0]! : undefined;
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
        line: lineAt(f.text, call.index),
      });
    }
  }
  return out;
}

/** `c.var.supabaseContext`, `event.context.supabaseContext`, `req.supabaseContext`, `c.get('supabaseContext')`. */
const CONTEXT_READ = /\.\s*supabaseContext\b|\.get\s*\(\s*["'`]supabaseContext["'`]\s*\)|\[\s*["'`]supabaseContext["'`]\s*\]/g;

/** Reads of the adapters' nested object. After the switch to a bridge nothing sets it, so they come back undefined. */
function contextReadFindings(f: SourceFile, rule: Rule, severity: Finding["severity"]): Finding[] {
  const code = stripJsComments(f.text);
  return [...code.matchAll(CONTEXT_READ)].map((m) => ({
    rule: rule.id,
    severity,
    message:
      "Reads the adapters' `supabaseContext`, which the bridge entries don't set. Use the flat keys (`c.var.supabase`, `c.var.supabaseAdmin`, `c.var.jwtClaims`); `userClaims` is gone, so `.id` becomes `jwtClaims.sub`, `.appMetadata` `.app_metadata`, `.userMetadata` `.user_metadata`.",
    file: f.path,
    line: lineAt(f.text, m.index),
  }));
}

const dependsOnServer = (project: Project) =>
  project.files.some((f) => /(^|\/)package\.json$/.test(f.path) && /"@supabase\/server"\s*:/.test(f.text));

export const serverAdapterRemoved: Rule = {
  id: "server-adapter-removed",
  severity: "error",
  title: "@supabase/server framework adapter (removed 2026-12-01)",
  why: "Supabase removes `@supabase/server/adapters/{hono,h3,elysia,nestjs}` on 2026-12-01, so an install or a Dependabot bump after that breaks the import. The migration has one silent trap: replacing `auth: 'user'` with `withClaims()` turns a 401 into a 200 for anonymous callers. Warning before the date, error from it.",
  fix: `Follow https://supabase.com/docs/reference/server/frameworks#moving-off-the-adapters. Need @supabase/server 1.6.0+ and Node 22+, add @supabase/middleware as a direct dependency, copy your framework's bridge from ${BRIDGES_URL} as is (comments included). Then: auth 'user' (or a bare withSupabase()) becomes \`toHono([withRequiredClaims(), withSupabaseClient()])\` with imports from '@supabase/server/middleware/required-claims' and '/middleware/client'; auth 'none' becomes \`toHono([withSupabaseClient()])\`; 'publishable' and 'secret' stay on withSupabase from '@supabase/server'. Rewrite \`c.var.supabaseContext.supabase\` to \`c.var.supabase\` and \`userClaims.id\` to \`jwtClaims.sub\` (field by field, no blanket rename). Then prove each gated endpoint still answers 401 without a token.`,
  check(project) {
    const sources = project.files.filter((f) => f.kind === "source");
    const imports = sources.flatMap((f) => adapterFindings(project, f, this));
    // Leftover reads matter in a project on @supabase/server, migrated or not.
    if (!imports.length && !dependsOnServer(project)) return [];
    const severity = removedBy(project.today) ? "error" : "warning";
    return [...imports, ...sources.flatMap((f) => contextReadFindings(f, this, severity))];
  },
};
