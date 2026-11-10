import type { Finding, Rule, SourceFile } from "../types.ts";
import { blank, lineAt } from "../text.ts";

/**
 * Supabase blocks direct INSERT/UPDATE on pg_cron's `cron.job` table, because it skips the checks the pg_cron
 * functions make (https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed).
 * Jobs are created with cron.schedule / cron.schedule_in_database and changed with cron.alter_job.
 */
const CHANGELOG = "https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed";

/** `insert into cron.job`, `UPDATE ONLY "cron"."job"`; not cron.job_run_details. */
const DIRECT_WRITE = /^(insert\s+into|update)\s+(?:only\s+)?"?cron"?\s*\.\s*"?job"?(?![\w$"])/i;

/** PL/pgSQL words that can sit in front of a statement inside a DO block or function body. */
const PLPGSQL_LEAD = /^(?:(?:begin|then|else|loop|exception\s+when\s+[\w\s]+?\s+then)\s+)+/i;

interface Span {
  start: number;
  end: number;
}

/** A dollar-quote tag (`$$`, `$body$`) starting at `i`, if there is one. */
function dollarTag(src: string, i: number): string | undefined {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))?.[0];
}

/** Index just past the quoted run that starts at `i` (`'…'`, `"…"`, `$tag$…$tag$`), or undefined if `i` starts none. */
function skipQuoted(src: string, i: number): { end: number; body?: Span } | undefined {
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
    if (!tag) return undefined;
    const close = src.indexOf(tag, i + tag.length);
    const bodyEnd = close === -1 ? src.length : close;
    return { end: close === -1 ? src.length : close + tag.length, body: { start: i + tag.length, end: bodyEnd } };
  }
  return undefined;
}

/** Comments replaced by spaces; strings and dollar-quoted bodies kept, so offsets stay valid. */
function blankSqlComments(src: string): string {
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
      // Comments inside a dollar body are code too (a DO block or a function), so blank them recursively.
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

/** Statements in `src[from, to)`, split on top-level `;`, with the dollar-quoted bodies inside each. */
function statements(src: string, from: number, to: number): { span: Span; bodies: Span[] }[] {
  const out: { span: Span; bodies: Span[] }[] = [];
  let start = from;
  let bodies: Span[] = [];
  let i = from;
  const push = (end: number) => {
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

/** Splits on top-level commas (outside quotes and parentheses). */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
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

/** The text inside the parentheses that open at `s[open]`, and the index after the closing one. */
function parenthesized(s: string, open: number): { inner: string; after: number } | undefined {
  if (s[open] !== "(") return undefined;
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
  return undefined;
}

const column = (raw: string) => raw.replace(/"/g, "").trim().toLowerCase();
/** cron.job columns that map onto pg_cron function parameters. */
const PARAMS: Record<string, string> = {
  jobname: "job_name",
  schedule: "schedule",
  command: "command",
  database: "database",
  username: "username",
  active: "active",
};
const MAX_ARG = 48;
const shorten = (value: string, name: string) => (value.length > MAX_ARG ? `<${name}>` : value);

/** `insert into cron.job (cols) values (…)` → the cron.schedule call that does the same. */
export function insertRewrite(stmt: string): string | undefined {
  const head = /^insert\s+into\s+(?:only\s+)?"?cron"?\s*\.\s*"?job"?\s*/i.exec(stmt);
  if (!head) return undefined;
  const cols = parenthesized(stmt, head[0].length);
  if (!cols) return undefined;
  const valuesAt = /^\s*values\s*/i.exec(stmt.slice(cols.after));
  if (!valuesAt) return undefined;
  const vals = parenthesized(stmt, cols.after + valuesAt[0].length);
  if (!vals) return undefined;
  // One row only; `on conflict …` / `returning …` may follow (cron.schedule with an existing name updates that job).
  const rest = stmt.slice(vals.after).trim();
  if (rest && !/^(on\s+conflict|returning)\b/i.test(rest)) return undefined;

  const names = splitTopLevel(cols.inner).map(column);
  const values = splitTopLevel(vals.inner);
  if (names.length !== values.length) return undefined;
  const row = new Map<string, string>();
  for (const [k, name] of names.entries()) {
    if (name === "jobid") continue; // pg_cron assigns it
    if (!(name in PARAMS)) return undefined; // nodename / nodeport: no function parameter for those
    row.set(name, values[k]!);
  }
  const schedule = row.get("schedule");
  const command = row.get("command");
  if (!schedule || !command) return undefined;
  const v = (name: string) => shorten(row.get(name)!, name);
  const name = row.get("jobname");
  const extras = ["username", "active"].filter((k) => row.has(k));
  if (!row.has("database") && !extras.length) {
    return name ? `select cron.schedule(${v("jobname")}, ${v("schedule")}, ${v("command")});` : `select cron.schedule(${v("schedule")}, ${v("command")});`;
  }
  if (!name) return undefined; // schedule_in_database needs a job name
  const database = row.has("database") ? v("database") : "current_database()";
  const named = extras.map((k) => `${k} := ${v(k)}`);
  return `select cron.schedule_in_database(${[v("jobname"), v("schedule"), v("command"), database, ...named].join(", ")});`;
}

/** `update cron.job set … where …` → cron.alter_job, once per matching job. */
export function updateRewrite(stmt: string): string | undefined {
  const m = /^update\s+(?:only\s+)?"?cron"?\s*\.\s*"?job"?\s+set\s+([\s\S]*?)(?:\s+where\s+([\s\S]*?))?\s*(?:returning\b[\s\S]*)?$/i.exec(stmt.trim());
  if (!m) return undefined;
  const named: string[] = [];
  for (const item of splitTopLevel(m[1]!)) {
    const eq = /^("?[A-Za-z_]+"?)\s*=\s*([\s\S]+)$/.exec(item);
    if (!eq) return undefined;
    const col = column(eq[1]!);
    // jobname has no alter_job parameter (rename = unschedule + schedule); nodename/nodeport neither.
    if (col === "jobname" || !(col in PARAMS)) return undefined;
    named.push(`${col} := ${shorten(eq[2]!.trim(), col)}`);
  }
  if (!named.length) return undefined;
  const where = m[2]?.trim();
  const byId = where && /^"?jobid"?\s*=\s*(\d+)$/i.exec(where);
  if (byId) return `select cron.alter_job(${byId[1]}, ${named.join(", ")});`;
  return `select cron.alter_job(jobid, ${named.join(", ")}) from cron.job${where ? ` where ${where}` : ""};`;
}

function cronFindings(file: SourceFile, rule: Rule): Finding[] {
  const src = blankSqlComments(file.text);
  const out: Finding[] = [];
  /** `plpgsql`: the range is a DO block or function body, where a bare `select` must be `perform`. */
  const visit = (from: number, to: number, plpgsql: boolean) => {
    for (const { span, bodies } of statements(src, from, to)) {
      const raw = src.slice(span.start, span.end);
      let lead = raw.search(/\S/);
      if (plpgsql) lead += PLPGSQL_LEAD.exec(raw.slice(lead))?.[0].length ?? 0;
      const at = span.start + lead;
      const stmt = src.slice(at, span.end);
      const write = DIRECT_WRITE.exec(stmt);
      if (write) {
        const insert = /^insert/i.test(write[1]!);
        let rewrite = insert ? insertRewrite(stmt) : updateRewrite(stmt);
        if (rewrite && plpgsql) rewrite = rewrite.replace(/^select /, "perform ");
        const verb = insert ? "insert into" : "update";
        const fallback = insert
          ? "use `select cron.schedule('<name>', '<schedule>', $$<command>$$);` instead"
          : "use `select cron.alter_job(<jobid>, schedule := …, command := …, active := …);` instead (a rename is cron.unschedule + cron.schedule)";
        out.push({
          rule: rule.id,
          severity: rule.severity,
          message: `\`${verb} cron.job\` writes the pg_cron table directly, which Supabase blocks; ${rewrite ? `rewrite as \`${rewrite}\`` : fallback}.`,
          file: file.path,
          line: lineAt(file.text, at),
        });
        continue;
      }
      // DO blocks, functions and cron commands carry statements in dollar-quoted bodies.
      // DO blocks are PL/pgSQL; a function or procedure only when it says so (a `language sql` body takes `select`).
      const procedural = /^do\b/i.test(stmt) || (/^create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(stmt) && /\blanguage\s+'?plpgsql\b/i.test(stmt));
      for (const b of bodies) visit(b.start, b.end, procedural);
    }
  };
  visit(0, src.length, false);
  return out;
}

/** Migrations and seeds under any supabase/ folder (monorepos too). */
const isSupabaseSql = (f: SourceFile) => /(^|\/)supabase\/(?:migrations\/[^/]+|seed|seeds?\/[^/]+)\.sql$/.test(f.path);

export const cronJobDirectWrite: Rule = {
  id: "cron-job-direct-write",
  severity: "warning",
  title: "Direct INSERT/UPDATE on pg_cron's cron.job table",
  why: `Supabase doesn't allow writing \`cron.job\` rows directly, because that skips the checks pg_cron's functions make (${CHANGELOG}). The migration or seed fails with a permission error on a Supabase project, often only in CI or on the first deploy.`,
  fix: "Create jobs with `select cron.schedule('<name>', '<schedule>', $$<command>$$);` (a name that exists updates that job, so it's safe to rerun), or `cron.schedule_in_database(...)` for another database or user. Change one with `select cron.alter_job(<jobid>, schedule := …, command := …, active := …);`, or for a name `select cron.alter_job(jobid, active := false) from cron.job where jobname = '<name>';`. Remove one with `select cron.unschedule('<name>');`.",
  check(project) {
    // Other SQL (Prisma or Drizzle migrations, schema.sql) only when the project uses Supabase: self-hosted
    // pg_cron allows the direct writes.
    return project.files
      .filter((f) => f.kind === "sql" && (isSupabaseSql(f) || project.usesSupabase))
      .flatMap((f) => cronFindings(f, this));
  },
};
