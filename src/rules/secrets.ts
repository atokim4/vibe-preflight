import type { Finding, Rule } from "../types.ts";
import { isClientFile, isTestFile, publicPrefixes } from "../context.ts";
import { basename, globToRegExp, lineAt, stripJsComments } from "../text.ts";

/** Names that are always secret, whatever the prefix. */
const SECRET_NAME = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES_URL|WEBHOOK_SIGNING|_SK$|SIGNING_KEY)/;
/** Names that are usually secret unless they are one of the keys meant for browsers. */
const MAYBE_SECRET_NAME = /(API_KEY|TOKEN|ACCESS_KEY|_KEY$)/;
const BROWSER_SAFE_NAME = /(ANON|PUBLISHABLE|PUBLIC_KEY|FIREBASE|MAPS|SITE_KEY|MEASUREMENT|POSTHOG|SENTRY_DSN|PUSHER_KEY|ALGOLIA_SEARCH|MAPBOX)/;

const BOOL_VALUE = /^\s*["']?(?:true|false|0|1|yes|no|on|off)?["']?\s*$/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Feature flags such as `NEXT_PUBLIC_AUTH_PASSWORD=true` or `NEXT_PUBLIC_PASSWORD_REQUIRE_NUMBERS === 'true'`
 * carry a secret-sounding word but only switch something on or off. True when every value the project gives the
 * variable is a boolean and the code (if it reads it) only compares it to "true"/"false".
 */
function isBooleanFlag(name: string, sources: string[], envs: string[]): boolean {
  const n = escapeRe(name);
  const assigned = envs.flatMap((t) => [...t.matchAll(new RegExp(`^\\s*(?:export\\s+)?${n}\\s*=(.*)$`, "gm"))].map((m) => m[1]!));
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

export const publicEnvSecret: Rule = {
  id: "public-env-secret",
  severity: "error",
  title: "Secret in a browser-exposed env variable (NEXT_PUBLIC_ / VITE_ / EXPO_PUBLIC_)",
  why: "Variables with these prefixes are copied into the JavaScript bundle at build time. Anyone can read them in the browser's dev tools.",
  fix: "Rename the variable without the public prefix, read it only in server code (route handler, server action, Edge Function), and rotate the key, because the old value has already shipped.",
  check(project) {
    const prefixes = publicPrefixes(project);
    const re = new RegExp(`\\b(?:${prefixes.join("|")})[A-Z0-9_]+`, "g");
    const first = new Map<string, { file: string; line: number }>();
    // Source files first, so a finding points at the code that reads the variable when there is one.
    const files = [...project.files.filter((f) => f.kind === "source" && !isTestFile(f)), ...project.files.filter((f) => f.kind === "env")];
    const sources: string[] = [];
    const envs: string[] = [];
    for (const f of files) {
      const text = f.kind === "source" ? stripJsComments(f.text) : f.text;
      (f.kind === "source" ? sources : envs).push(text);
      for (const m of text.matchAll(re)) if (!first.has(m[0])) first.set(m[0], { file: f.path, line: lineAt(text, m.index) });
    }
    const out: Finding[] = [];
    for (const [name, at] of first) {
      const bare = prefixes.reduce((n, p) => (n.startsWith(p) ? n.slice(p.length) : n), name);
      if ((SECRET_NAME.test(bare) || MAYBE_SECRET_NAME.test(bare)) && isBooleanFlag(name, sources, envs)) continue;
      if (SECRET_NAME.test(bare)) {
        out.push({ rule: this.id, severity: "error", message: `\`${name}\` looks like a secret and is exposed to the browser.`, ...at });
      } else if (MAYBE_SECRET_NAME.test(bare) && !BROWSER_SAFE_NAME.test(bare)) {
        out.push({
          rule: this.id,
          severity: "warning",
          message: `\`${name}\` is exposed to the browser. Fine for a publishable key, a leak if it's a paid API key (OpenAI, Resend, …).`,
          ...at,
        });
      }
    }
    return out;
  },
};

const SERVER_SECRET_REF = /\b([A-Z0-9_]*(?:SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET))\b|['"]service_role['"]/g;

export const serverSecretInClient: Rule = {
  id: "server-secret-in-client",
  severity: "error",
  title: "Supabase service_role key (or a Stripe secret) used in browser code",
  why: "The service_role key skips every RLS policy. In a Vite / Lovable / Bolt app the value lands in the bundle; in Next.js a client component gets `undefined`, so the code either leaks the key or quietly breaks.",
  fix: "Move the call to the server: a Next.js route handler or server action, or a Supabase Edge Function. The browser should only use the anon/publishable key, with RLS doing the access control.",
  check(project) {
    const out: Finding[] = [];
    for (const f of project.files) {
      if (!isClientFile(project, f)) continue;
      const code = stripJsComments(f.text);
      const seen = new Set<string>();
      for (const m of code.matchAll(SERVER_SECRET_REF)) {
        const what = m[1] ?? "service_role";
        if (seen.has(what)) continue;
        seen.add(what);
        out.push({
          rule: this.id,
          severity: this.severity,
          message: `${basename(f.path)} runs in the browser and uses ${m[1] ? `\`${what}\`` : "the `service_role` key"}.`,
          file: f.path,
          line: lineAt(f.text, m.index),
        });
      }
    }
    return out;
  },
};

/** Does a .gitignore ignore this root-level file name? Handles the common forms, including `!` negation. */
export function isIgnored(gitignore: string | undefined, name: string): boolean {
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

const TEMPLATE_ENV = /\.(example|sample|template|dist)$/;
const HAS_VALUE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/m;

/** Key formats that are real credentials wherever they appear. */
const REAL_KEY = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}|\bsb_secret_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}/;
const JWT_ANY = /\beyJ[A-Za-z0-9_-]+\.eyJ/;
const JWT = /\beyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g;

/** base64url to text with web APIs only (atob, TextDecoder), so the rule also runs in a browser. */
function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function jwtIssuer(payload: string): string | undefined {
  try {
    return (JSON.parse(decodeBase64Url(payload)) as { iss?: unknown }).iss as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Supabase CLI prints the same anon and service_role keys for every local stack (issuer "supabase-demo").
 * Starters commit them on purpose. A file is "local defaults" when it has at least one such key and no other JWT
 * or real-looking credential.
 */
export function onlyLocalSupabaseKeys(text: string): boolean {
  if (REAL_KEY.test(text)) return false;
  const issuers = [...text.matchAll(JWT)].map((m) => jwtIssuer(m[1]!));
  return issuers.length > 0 && issuers.every((iss) => iss === "supabase-demo");
}

type EnvValueKind = "secret" | "local-supabase" | "public-only";

const ENV_KIND_NOTE: Record<EnvValueKind, string> = {
  secret: "",
  "local-supabase": " Its keys are the public Supabase local-dev defaults, which is fine; make sure real project keys never go in this file.",
  "public-only": " It only sets browser-exposed variables, which ship in the bundle anyway; keep it that way, or real keys added later get committed too.",
};

/** What an env file holds: anything that may be a real secret, only Supabase local defaults, or only public variables. */
function envValueKind(text: string, prefixes: string[]): EnvValueKind {
  if (onlyLocalSupabaseKeys(text)) return "local-supabase";
  const names = [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S/gm)].map((m) => m[1]!);
  if (names.length > 0 && names.every((n) => prefixes.some((p) => n.startsWith(p))) && !REAL_KEY.test(text) && !JWT_ANY.test(text)) return "public-only";
  return "secret";
}

export const envFileCommitted: Rule = {
  id: "env-file-committed",
  severity: "error",
  title: "Env file with real values committed to git (or not covered by .gitignore)",
  why: "Whatever is in `.env` goes to GitHub, every clone and every fork, and stays in git history after you delete it.",
  fix: "Add `.env*` and `!.env.example` to `.gitignore`. If git already tracks the file, run `git rm --cached <file>`, commit, and rotate every key that was in it.",
  check(project) {
    const out: Finding[] = [];
    const prefixes = publicPrefixes(project);
    const push = (f: { path: string; text: string }, where: string) => {
      const kind = envValueKind(f.text, prefixes);
      out.push({
        rule: this.id,
        severity: kind === "secret" ? this.severity : "warning",
        message: `${where}.${ENV_KIND_NOTE[kind]}`,
        file: f.path,
        line: 1,
      });
    };
    for (const f of project.files) {
      if (f.kind !== "env" || TEMPLATE_ENV.test(f.path) || !HAS_VALUE.test(f.text)) continue;
      if (project.git) {
        // git knows the truth, including nested and global ignore rules.
        const tracked = project.git.tracked.has(f.path);
        if (!tracked && project.git.ignored.has(f.path)) continue;
        push(f, tracked ? `\`${f.path}\` is committed to git` : `\`${f.path}\` is not ignored by git, so \`git add .\` will commit it`);
        continue;
      }
      // No git repo: read the root .gitignore (root-level env files only).
      if (f.path.includes("/") || isIgnored(project.gitignore, f.path)) continue;
      push(f, project.gitignore ? `\`${f.path}\` is not in .gitignore, so \`git add .\` will commit it` : `\`${f.path}\` exists and the project has no .gitignore`);
    }
    return out;
  },
};
