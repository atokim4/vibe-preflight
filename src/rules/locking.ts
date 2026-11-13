import type { Finding, Project, Rule, SourceFile } from "../types.ts";
import { isTestFile } from "../context.ts";
import { lineAt } from "../text.ts";
import {
  calleeBefore,
  enclosing,
  lexJs,
  lexPython,
  pyBlocksAround,
  pyBlockText,
  splitCallee,
  type Lexed,
  type Literal,
  type PyBlock,
} from "../lexer.ts";

/**
 * A row lock lives until the end of the transaction (https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).
 * In autocommit every statement is its own transaction, so `SELECT … FOR UPDATE` releases the lock as soon as the
 * rows come back, and two requests that read-then-write the same row both pass their check.
 */
export const LOCKING_DOC = "https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS";
export const PG_TX_DOC = "https://node-postgres.com/features/transactions";

const LOCK_CLAUSE = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i;
const LOCK_CLAUSE_G = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/gi;

/**
 * The offset of the lock clause when `sql` is a plain SELECT that locks rows. A lock inside an UPDATE/DELETE
 * subquery (`UPDATE jobs … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`) or a data-modifying CTE is held by
 * the same statement that writes, so it's fine in autocommit and isn't returned.
 */
export function lockingSelect(sql: string): number | undefined {
  const s = sql.trimStart();
  const lead = sql.length - s.length;
  if (!/^\(?\s*(select|with)\b/i.test(s) || !/\bfrom\b/i.test(s)) return undefined;
  const m = LOCK_CLAUSE.exec(s);
  if (!m) return undefined;
  if (/^with\b/i.test(s) && /\b(?:update\s+[\w"]|delete\s+from\b|insert\s+into\b|merge\s+into\b)/i.test(s.replace(LOCK_CLAUSE_G, ""))) return undefined;
  return lead + m.index;
}

const JS_DB_METHODS = new Set([
  "query", "execute", "unsafe", "raw", "one", "oneOrNone", "many", "manyOrNone", "any", "none", "result",
  "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe",
]);
const PRISMA_METHODS = /^\$(query|execute)Raw(Unsafe)?$/;
/** Calls whose callback (or argument list) runs inside one transaction. */
const TX_CALLEE = /(?:^|\.)(?:\$transaction|transaction|begin|tx|txIf|withTransaction|inTransaction|runInTransaction|serializable)$/i;
const CONTROL = /\b(if|for|while|switch|catch|with|return|typeof|await)\s*$/;

interface JsFunction {
  bodyOpen: number;
  bodyClose: number;
  params: string;
}

/** The functions around `pos`, innermost first. Arrow functions with an expression body count from their `=>`. */
function jsFunctionsAround(lexed: Lexed, pos: number): JsFunction[] {
  const out: JsFunction[] = [];
  const { code } = lexed;
  for (const p of enclosing(lexed, pos)) {
    if (p.char !== "{") continue;
    const before = code.slice(0, p.open).trimEnd();
    if (before.endsWith("=>")) {
      const head = before.slice(0, -2).trimEnd();
      const params = head.endsWith(")") ? pairText(lexed, head.length - 1) : /([A-Za-z_$][\w$]*)$/.exec(head)?.[1] ?? "";
      out.push({ bodyOpen: p.open, bodyClose: p.close, params });
      continue;
    }
    // `function f(a, b) {`, `async handle(req): Promise<{ ok: boolean }> {`, `get x() {`
    const sig = /\)\s*(?::\s*[^{};=]*(?:\{[^{}]*\}[^{};=]*)?)?$/.exec(before);
    if (!sig) continue;
    const close = before.length - sig[0].length;
    const open = lexed.pairs.find((q) => q.close === close && q.char === "(");
    if (!open || CONTROL.test(code.slice(0, open.open))) continue;
    out.push({ bodyOpen: p.open, bodyClose: p.close, params: code.slice(open.open + 1, close) });
  }
  // Expression-bodied arrows: `(tx) => tx.$queryRaw…` without braces. Their parameters matter for the "passed in" test.
  const lineStart = code.lastIndexOf("\n", pos) + 1;
  for (const m of code.slice(Math.max(0, lineStart - 400), pos).matchAll(/\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>/g)) {
    out.push({ bodyOpen: -1, bodyClose: -1, params: m[1] ?? m[2] ?? "" });
  }
  return out;
}

function pairText(lexed: Lexed, close: number): string {
  const open = lexed.pairs.find((q) => q.close === close);
  return open ? lexed.code.slice(open.open + 1, close) : "";
}

const isParam = (fns: { params: string }[], name: string) => fns.some((f) => new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`).test(f.params));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&");
/** `pool` in `pool.query`, `this.pool` in `this.pool.query`, `db` in `db.client.query`. */
const baseName = (receiver: string) => (receiver.startsWith("this.") ? receiver.split(".").slice(0, 2).join(".") : receiver.split(".")[0]!);

/** True when `pos` sits inside the arguments of `prisma.$transaction(…)`, `db.transaction(…)`, `sql.begin(…)`, … */
function insideTxCall(lexed: Lexed, pos: number): boolean {
  return enclosing(lexed, pos).some((p) => p.char === "(" && TX_CALLEE.test(calleeBefore(lexed.code, p.open) ?? ""));
}

interface CallSite {
  /** Offset of the `(` (or the tag) of the call. */
  at: number;
  receiver: string;
  method: string;
}

/** The database call that runs this literal: `pool.query('…')`, `prisma.$queryRaw\`…\``, `db.execute(sql\`…\`)`. */
function jsCallFor(lexed: Lexed, lit: Literal): CallSite[] {
  const tag = calleeBefore(lexed.code, lit.start);
  const direct = tag && lexed.code.slice(0, lit.start).trimEnd().endsWith(tag.split(".").pop()!) ? splitCallee(tag) : undefined;
  if (direct && JS_DB_METHODS.has(direct.method)) return [{ at: lit.start, ...direct }];
  const parens = enclosing(lexed, lit.start).filter((p) => p.char === "(").slice(0, 2);
  for (const p of parens) {
    const c = splitCallee(calleeBefore(lexed.code, p.open) ?? "");
    if (c && JS_DB_METHODS.has(c.method)) return [{ at: p.open, ...c }];
  }
  // `const LOCK_ORDER = \`select … for update\``, run later as `client.query(LOCK_ORDER, [id])`.
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_$][\w$.]*\s*)?$/.exec(lexed.code.slice(Math.max(0, lit.start - 160), lit.start));
  if (!decl) return [];
  const sites: CallSite[] = [];
  for (const m of lexed.code.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\(\\s*(?:\\{\\s*text\\s*:\\s*)?${escape(decl[1]!)}(?![\\w$])`, "g"))) {
    const c = splitCallee(m[1]!);
    if (c && JS_DB_METHODS.has(c.method)) sites.push({ at: m.index! + m[1]!.length, ...c });
  }
  return sites;
}

interface ProjectHints {
  /** Identifiers created with `new Pool(…)` / `createPool(…)` somewhere in the project. */
  pools: Set<string>;
  /** Identifiers created with `new Client(…)`. */
  clients: Set<string>;
  /** Tagged-template clients: postgres.js `postgres(…)` and Neon `neon(…)`, where `` sql`…` `` runs the query itself. */
  sqlTags: Set<string>;
  sequelize: boolean;
}

function projectHints(project: Project, sources: SourceFile[]): ProjectHints {
  const pools = new Set<string>();
  const clients = new Set<string>();
  const sqlTags = new Set<string>();
  for (const f of sources) {
    for (const m of f.text.matchAll(/(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:postgres|neon)\s*\(/g)) sqlTags.add(m[1]!);
    for (const m of f.text.matchAll(/(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+(?:pg\.|postgres\.)?Pool\b|(?:mysql\.)?createPool\s*\(|postgres\s*\()/g)) pools.add(m[1]!);
    for (const m of f.text.matchAll(/(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:pg\.)?Client\b/g)) clients.add(m[1]!);
    for (const m of f.text.matchAll(/this\.(\w+)\s*=\s*new\s+(?:pg\.)?Pool\b/g)) pools.add(`this.${m[1]}`);
  }
  const pkg = project.files.filter((f) => f.path.endsWith("package.json")).map((f) => f.text).join("\n");
  return { pools, clients, sqlTags, sequelize: /"sequelize"\s*:/.test(pkg) };
}

/** BEGIN / START TRANSACTION sent through `receiver` inside the function body. */
function beganOn(lexed: Lexed, receiver: string, from: number, to: number): boolean {
  return lexed.literals.some((l) => {
    if (l.start < from || l.end > to || !/^\s*(begin|start\s+transaction)\b/i.test(l.value)) return false;
    return jsCallFor(lexed, l).some((c) => c.receiver === receiver);
  });
}

function finding(rule: Rule, f: SourceFile, offset: number, message: string, severity = rule.severity): Finding {
  return { rule: rule.id, severity, message, file: f.path, line: lineAt(f.text, offset) };
}

const fnName = (code: string, fn: JsFunction | undefined) => {
  if (!fn || fn.bodyOpen < 0) return "this file";
  const head = code.slice(Math.max(0, fn.bodyOpen - 300), fn.bodyOpen);
  const m = /(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*)?\([^()]*\)[^=]*=>\s*$|([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{]*)?$)/.exec(head);
  const name = m?.[1] ?? m?.[2] ?? m?.[3];
  return name && !/^(if|for|while|switch|catch)$/.test(name) ? `\`${name}\`` : "this function";
};

function checkJsLocks(rule: Rule, f: SourceFile, hints: ProjectHints): Finding[] {
  const lexed = lexJs(f.text);
  const out: Finding[] = [];
  const seen = new Set<number>();
  const report = (offset: number, message: string) => {
    if (seen.has(offset)) return;
    seen.add(offset);
    out.push(finding(rule, f, offset, message));
  };

  for (const lit of lexed.literals) {
    const rel = lockingSelect(lit.value);
    if (rel === undefined) continue;
    const at = lit.start + 1 + rel;
    for (const call of jsCallFor(lexed, lit)) {
      if (insideTxCall(lexed, call.at)) continue;
      const fns = jsFunctionsAround(lexed, call.at);
      const fn = fns.find((x) => x.bodyOpen >= 0);
      const [from, to] = fn ? [fn.bodyOpen, fn.bodyClose] : [0, f.text.length];
      const base = baseName(call.receiver);
      const body = lexed.code.slice(from, to);
      const where = fnName(lexed.code, fn);
      if (PRISMA_METHODS.test(call.method)) {
        if (isParam(fns, base)) continue;
        report(at, `\`${call.receiver}.${call.method}\` runs this FOR UPDATE outside \`$transaction(async (tx) => …)\`, so the row lock ends with the statement and a second request reads the same row unlocked.`);
        continue;
      }
      const localConn = new RegExp(`(?<![\\w$.])${escape(base)}\\s*=\\s*(?:await\\s+)?(?:[\\w$.]+\\.(?:connect|acquire|getConnection|reserve)\\s*\\(|new\\s+(?:pg\\.)?Client\\b)`).test(body);
      const pool = !localConn && (/pool/i.test(call.receiver) || hints.pools.has(base));
      const began = beganOn(lexed, call.receiver, from, to);
      if (pool) {
        report(
          at,
          began
            ? `\`${call.receiver}.query('BEGIN')\` and this FOR UPDATE can run on different pooled connections, so the lock may sit outside the transaction (or in one left open). Take one client with \`await ${call.receiver}.connect()\` and send BEGIN, the SELECT, the UPDATE and COMMIT on it.`
            : `\`${call.receiver}.${call.method}\` runs this FOR UPDATE on a pooled connection in autocommit: the row lock ends with the statement, before ${where} writes. Use one client from \`${call.receiver}.connect()\` inside BEGIN … COMMIT, or a single \`UPDATE … WHERE … RETURNING\`.`,
        );
        continue;
      }
      if (began) continue;
      if (!localConn && (isParam(fns, base) || base === "this")) continue; // a connection passed in: the caller may hold the transaction
      report(at, `No BEGIN on \`${call.receiver}\` in ${where}, so this FOR UPDATE runs in autocommit and the row lock ends with the statement. Send BEGIN first and COMMIT after the write, on the same client.`);
    }
  }

  // postgres.js / Neon: `` sql`SELECT … FOR UPDATE` `` is the query itself and runs in autocommit unless it's inside
  // `sql.begin(async (sql) => …)`. Builders with the same tag name (drizzle-orm, kysely) only build SQL, so a file that
  // imports `sql` from one of them is left out.
  const builderSql = /import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*["'](?:drizzle-orm[^"']*|kysely|slonik|@databases\/[^"']+)["']/.test(f.text);
  for (const lit of lexed.literals) {
    if (builderSql || f.text[lit.start] !== "`") continue;
    const rel = lockingSelect(lit.value);
    if (rel === undefined) continue;
    const tag = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^`;]*>)?\s*$/.exec(lexed.code.slice(Math.max(0, lit.start - 120), lit.start))?.[1];
    if (!tag || !hints.sqlTags.has(tag) || insideTxCall(lexed, lit.start)) continue;
    const fns = jsFunctionsAround(lexed, lit.start);
    if (isParam(fns, tag)) continue; // `async (sql) => …` callbacks and helpers that get the transaction passed in
    report(
      lit.start + 1 + rel,
      `\`${tag}\`…\`\` runs this FOR UPDATE in autocommit (postgres.js and Neon send each tagged query as its own transaction), so the row lock ends before ${fnName(lexed.code, fns.find((x) => x.bodyOpen >= 0))} acts on the rows. Wrap the SELECT and the writes in \`${tag}.begin(async (tx) => …)\`, or claim the rows in one \`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *\`.`,
    );
  }

  // Drizzle `.for('update')`, Knex `.forUpdate()`: query builders whose chain has to start on a transaction.
  // String contents are blanked in `code`, so the Drizzle mode is matched on the text (same offsets) and kept only where `code` has the call.
  for (const m of f.text.matchAll(/\.\s*for\s*\(\s*(["'`])(?:no key update|update|key share|share)\1\s*\)/gi)) {
    if (/^\.\s*for\s*\(/.test(lexed.code.slice(m.index!, m.index! + 24))) checkChain(m.index!, "drizzle");
  }
  for (const m of lexed.code.matchAll(/\.\s*(forUpdate|forShare|forNoKeyUpdate|forKeyShare)\s*\(/g)) checkChain(m.index!, "knex", m[1]);

  function checkChain(pos: number, kind: "drizzle" | "knex", method?: string) {
    if (insideTxCall(lexed, pos)) return;
    const chain = chainAt(lexed.code, pos);
    if (/\.\s*transacting\s*\(/.test(chain.text)) return;
    const root = chain.root;
    if (!root) return;
    const fns = jsFunctionsAround(lexed, pos);
    if (isParam(fns, root) || root === "this") return;
    const fn = fns.find((x) => x.bodyOpen >= 0);
    const body = lexed.code.slice(fn ? fn.bodyOpen : 0, fn ? fn.bodyClose : f.text.length);
    if (new RegExp(`(?<![\\w$.])${escape(root)}\\s*=\\s*(?:await\\s+)?[\\w$.]+\\.transaction\\s*\\(`).test(body)) return;
    report(
      pos,
      kind === "drizzle"
        ? `\`.for('update')\` on \`${root}\` outside \`${root}.transaction(async (tx) => …)\`: the query runs in autocommit and the lock ends with it. Build it on \`tx\` inside the transaction callback.`
        : `\`.${method}()\` on \`${root}\` without \`.transacting(trx)\` or \`knex.transaction(async (trx) => …)\`: the lock ends with the statement.`,
    );
  }

  // Sequelize: `lock: true` / `lock: t.LOCK.UPDATE` with no `transaction` option is a FOR UPDATE in autocommit.
  if (hints.sequelize || /sequelize/i.test(f.text)) {
    for (const m of lexed.code.matchAll(/\block\s*:\s*(?:true\b|[\w$.]*LOCK\.(?:UPDATE|SHARE|KEY_SHARE|NO_KEY_UPDATE)\b)/g)) {
      const obj = enclosing(lexed, m.index!).find((p) => p.char === "{");
      if (!obj || /\btransaction\b/.test(lexed.code.slice(obj.open, obj.close)) || insideTxCall(lexed, m.index!)) continue;
      report(m.index!, "`lock` without a `transaction` option: Sequelize sends SELECT … FOR UPDATE in autocommit, so the lock ends with the query. Pass `{ transaction: t, lock: t.LOCK.UPDATE }` inside `sequelize.transaction(async (t) => …)`.");
    }
  }
  return out;
}

/** The method chain a builder call at `pos` belongs to, and the identifier it starts on. */
function chainAt(code: string, pos: number): { text: string; root?: string } {
  let start = pos;
  let depth = 0;
  for (; start > 0; start--) {
    const c = code[start - 1]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ";" || c === "," || c === "=")) break;
  }
  let end = pos;
  depth = 0;
  for (; end < code.length; end++) {
    const c = code[end]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ";" || c === ",")) break;
  }
  const text = code.slice(start, end);
  const root = /^\s*(?:return\s+|await\s+|yield\s+)*([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  return { text, root: root && !/^(await|return|new|const|let)$/.test(root) ? root : undefined };
}

// ---- Python -----------------------------------------------------------------------------------------------------

const PY_DB_METHODS = new Set(["execute", "executemany", "fetch", "fetchrow", "fetchval", "fetchone", "fetchall", "run_sync"]);
const PY_TX_BLOCK = /^(?:async\s+)?with\b.*\.(?:transaction|begin|begin_nested|atomic)\s*\(|^(?:async\s+)?with\b.*\batomic\b/;
const PY_AUTOCOMMIT = /\bautocommit\s*=\s*True\b|set_autocommit\s*\(\s*True|isolation_level\s*=\s*["']AUTOCOMMIT["']|ISOLATION_LEVEL_AUTOCOMMIT/;
const OTHER_PY_DRIVER = /^\s*(?:import|from)\s+(?:psycopg2?|sqlalchemy|aiopg|databases|django|tortoise|peewee|pymysql|aiomysql|sqlite3|aiosqlite)\b/m;

interface PySite {
  at: number;
  receiver: string;
  method: string;
}

function pyCallFor(lexed: Lexed, lit: Literal): PySite[] {
  for (const p of enclosing(lexed, lit.start).filter((q) => q.char === "(").slice(0, 2)) {
    const c = splitCallee(calleeBefore(lexed.code, p.open) ?? "");
    if (c && PY_DB_METHODS.has(c.method)) return [{ at: p.open, ...c }];
  }
  const decl = /(?:^|\n)[ \t]*([A-Za-z_][\w]*)\s*(?::[^=\n]+)?=\s*(?:\(\s*)?$/.exec(lexed.code.slice(Math.max(0, lit.start - 120), lit.start));
  if (!decl) return [];
  const sites: PySite[] = [];
  for (const m of lexed.code.matchAll(new RegExp(`([A-Za-z_][\\w.]*)\\s*\\(\\s*(?:text\\s*\\(\\s*)?${escape(decl[1]!)}\\b`, "g"))) {
    const c = splitCallee(m[1]!);
    if (c && PY_DB_METHODS.has(c.method)) sites.push({ at: m.index! + m[1]!.length, ...c });
  }
  return sites;
}

const pyDef = (blocks: PyBlock[]) => blocks.find((b) => /^(?:async\s+)?def\b/.test(b.header));
const pyInTx = (blocks: PyBlock[]) => blocks.some((b) => PY_TX_BLOCK.test(b.header));

function checkPyLocks(rule: Rule, f: SourceFile, asyncpgProject: boolean, autocommit: boolean): Finding[] {
  const lexed = lexPython(f.text);
  const out: Finding[] = [];
  const asyncpg = /^\s*(?:import|from)\s+asyncpg\b/m.test(f.text) || (asyncpgProject && !OTHER_PY_DRIVER.test(f.text));
  for (const lit of lexed.literals) {
    const rel = lockingSelect(lit.value);
    if (rel === undefined) continue;
    const at = f.text.indexOf(lit.value, lit.start) + rel;
    for (const call of pyCallFor(lexed, lit)) {
      const blocks = pyBlocksAround(f.text, lexed.code, call.at);
      if (pyInTx(blocks)) continue;
      const def = pyDef(blocks);
      const defText = def ? pyBlockText(lexed.code, def) : lexed.code;
      if (asyncpg) {
        const base = call.receiver.startsWith("self.") ? call.receiver : call.receiver.split(".")[0]!;
        if (/pool/i.test(call.receiver)) {
          out.push(finding(rule, f, at, `\`${call.receiver}.${call.method}\` takes a connection for this one statement: asyncpg runs it in autocommit, so the FOR UPDATE lock ends before the write. Use \`async with ${call.receiver}.acquire() as conn, conn.transaction():\` around the SELECT and the UPDATE.`));
          continue;
        }
        if (new RegExp(`\\b${escape(base)}\\.transaction\\s*\\(`).test(defText)) continue;
        const params = def ? /\(([\s\S]*?)\)\s*(?:->[^:]+)?:\s*$/.exec(def.header)?.[1] ?? "" : "";
        if (new RegExp(`\\b${escape(base.replace(/^self\./, ""))}\\b`).test(params) && !base.startsWith("self.")) continue;
        out.push(finding(rule, f, at, `asyncpg is in autocommit unless you open \`async with ${call.receiver}.transaction():\`, so this FOR UPDATE releases its lock as soon as the row comes back.`));
        continue;
      }
      if (autocommit) {
        const params = def ? /\(([\s\S]*?)\)\s*(?:->[^:]+)?:\s*$/.exec(def.header)?.[1] ?? "" : "";
        const base = call.receiver.split(".")[0]!;
        if (base !== "self" && new RegExp(`\\b${escape(base)}\\b`).test(params)) continue; // the caller owns the connection and its transaction
        out.push(finding(rule, f, at, "This connection comes from a module that turns on autocommit, so this FOR UPDATE outside `with conn.transaction():` is its own transaction and the lock ends with the statement."));
      }
    }
  }
  if (autocommit && /\bsqlalchemy\b/.test(f.text)) {
    for (const m of lexed.code.matchAll(/\.with_for_update\s*\(/g)) {
      if (pyInTx(pyBlocksAround(f.text, lexed.code, m.index!)) && !/AUTOCOMMIT/.test(f.text)) continue;
      out.push(finding(rule, f, m.index!, "`with_for_update()` on an engine with AUTOCOMMIT isolation: every statement commits by itself, so the lock ends with the SELECT. Use the default isolation for this session (`engine.execution_options(isolation_level=\"READ COMMITTED\")`) and `with session.begin():`."));
    }
  }
  return out;
}

/**
 * Autocommit turned on for the app's own connections. Scripts, and admin connections to the `postgres` maintenance
 * database (opened in autocommit because CREATE DATABASE can't run in a transaction), don't say anything about how
 * the app runs its queries.
 */
function appAutocommit(f: SourceFile): boolean {
  if (/(^|\/)(scripts?|bin|tools|migrations?|alembic)\//.test(f.path) || /(^|\/)conftest\.py$/.test(f.path)) return false;
  return f.text.split("\n").some((line) => PY_AUTOCOMMIT.test(line) && !/["'\/]postgres["']|create\s+database/i.test(line));
}

/**
 * True when Python source `text` imports the module at `path` (`app/db.py` → `from app.db import …`, `from .db
 * import …`, `import db`). Autocommit set in a module the locking code never imports (an evals or admin helper)
 * says nothing about the connection that code uses.
 */
function importsModule(text: string, path: string): boolean {
  const parts = path.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/");
  const stem = escape(parts[parts.length - 1]!);
  const parent = parts.length > 1 ? escape(parts[parts.length - 2]!) : undefined;
  const from = new RegExp(`^\\s*from\\s+(?:[\\w.]*\\.)?${stem}\\s+import\\b|^\\s*import\\s+(?:[\\w.]*\\.)?${stem}\\b`, "m");
  const fromParent = parent ? new RegExp(`^\\s*from\\s+(?:[\\w.]*\\.)?${parent}\\s+import\\s+[^\\n]*\\b${stem}\\b`, "m") : undefined;
  return from.test(text) || (fromParent?.test(text) ?? false);
}

const pythonDeps = (project: Project) =>
  project.files
    .filter((f) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.cfg)$/.test(f.path))
    .map((f) => f.text)
    .join("\n");

export const forUpdateAutocommit: Rule = {
  id: "for-update-autocommit",
  severity: "error",
  title: "SELECT … FOR UPDATE outside a transaction",
  why: "A row lock lasts until the transaction ends. In autocommit each statement is its own transaction, so the lock is gone before the code writes, and two requests (a double tap, a webhook retry) both see 'pending' and both book, pay or award. `pool.query` is always its own connection, so a BEGIN sent through it doesn't help.",
  fix: `Run the SELECT … FOR UPDATE and the write in one transaction on one connection: node-postgres \`const c = await pool.connect()\` + BEGIN/COMMIT on \`c\` (${PG_TX_DOC}), \`prisma.$transaction(async (tx) => …)\`, \`db.transaction(async (tx) => …)\` (Drizzle), \`knex.transaction\`, \`async with conn.transaction():\` (asyncpg / psycopg). Often simpler: one \`UPDATE … SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING id\` and check the row count. Row locks: ${LOCKING_DOC}. Django's select_for_update() outside atomic() and Supabase .rpc() (one transaction per request) are already safe.`,
  check(project) {
    const sources = project.files.filter((f) => f.kind === "source" && !isTestFile(f));
    const hints = projectHints(project, sources);
    const out = sources.filter((f) => /\bfor\s+(?:no\s+key\s+)?(?:update|share)\b|\.for\s*\(|\.for(?:Update|Share|NoKeyUpdate|KeyShare)\s*\(|\block\s*:/i.test(f.text)).flatMap((f) => checkJsLocks(this, f, hints));
    const py = project.files.filter((f) => f.kind === "python" && !isTestFile(f));
    if (py.length) {
      const asyncpg = /\basyncpg\b/i.test(pythonDeps(project));
      const autocommitModules = py.filter(appAutocommit);
      out.push(
        ...py
          .filter((f) => /\bfor\s+(?:no\s+key\s+)?(?:update|share)\b|with_for_update/i.test(f.text))
          .flatMap((f) => checkPyLocks(this, f, asyncpg, autocommitModules.some((m) => m === f || importsModule(f.text, m.path)))),
      );
    }
    return out;
  },
};

// ---- check-then-act ---------------------------------------------------------------------------------------------

/** Seeds, migrations and one-off scripts run alone; a check-then-act there has nobody to race with. */
const ONE_OFF_PATH = /(^|\/)(scripts?|seeds?|seeders|migrations?|alembic)\//;

/** Columns whose value decides whether the request may proceed. */
const GUARD_COLUMNS = /^(status|state|is_paid|paid|is_used|used|redeemed|is_redeemed|claimed|is_claimed|booked|is_booked|processed|is_processed|balance|credits|stock|quantity|qty|available|seats|seats_left|remaining)$/i;

interface Update {
  table: string;
  /** Columns set to a value that doesn't depend on their current value. */
  absolute: string[];
  where: string;
}

/** `UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1` → table, absolute guard columns, where. */
export function parseUpdate(sql: string): Update | undefined {
  const m = /^\s*update\s+(?:only\s+)?(?:"?\w+"?\.)?"?(\w+)"?(?:\s+(?:as\s+)?\w+)?\s+set\s+([\s\S]+?)\s+where\s+([\s\S]+?)(?:\s+returning\b[\s\S]*)?;?\s*$/i.exec(sql);
  if (!m) return undefined;
  const absolute: string[] = [];
  for (const part of splitTop(m[2]!)) {
    const a = /^\s*"?(\w+)"?\s*=\s*([\s\S]+)$/.exec(part);
    if (!a || !GUARD_COLUMNS.test(a[1]!)) continue;
    if (new RegExp(`\\b${a[1]}\\b`, "i").test(a[2]!)) continue; // balance = balance - $1 is evaluated on the locked row
    absolute.push(a[1]!.toLowerCase());
  }
  return { table: m[1]!.toLowerCase(), absolute, where: m[3]! };
}

function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  return [...parts, cur];
}

/** `SELECT status, amount FROM orders WHERE …` → table and selected columns (`*` included), when it doesn't lock. */
function parseRead(sql: string): { table: string; columns: string } | undefined {
  if (LOCK_CLAUSE.test(sql)) return undefined;
  const m = /^\s*select\s+([\s\S]+?)\s+from\s+(?:"?\w+"?\.)?"?(\w+)"?/i.exec(sql);
  return m ? { columns: m[1]!.toLowerCase(), table: m[2]!.toLowerCase() } : undefined;
}

export const checkThenAct: Rule = {
  id: "check-then-act",
  severity: "warning",
  title: "Status read, then updated without re-checking it",
  why: "The code reads a status or balance, decides in JS/Python, then runs `UPDATE … WHERE id = $1`. Two requests at the same time both read 'pending' (or 100), both pass, and the order is paid twice or the wallet goes negative. A transaction alone doesn't stop it at READ COMMITTED.",
  fix: `Put the check into the write: \`UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING id\` and treat zero rows as "already done", or \`SET balance = balance - $2 WHERE id = $1 AND balance >= $2\`. Or read with SELECT … FOR UPDATE inside the transaction that writes. ${LOCKING_DOC}`,
  check(project) {
    const out: Finding[] = [];
    for (const f of project.files) {
      if ((f.kind !== "source" && f.kind !== "python") || isTestFile(f) || ONE_OFF_PATH.test(f.path) || !/\bupdate\b/i.test(f.text)) continue;
      const lexed = f.kind === "source" ? lexJs(f.text) : lexPython(f.text);
      const region = (pos: number): [number, number] => {
        if (f.kind === "source") {
          const fn = jsFunctionsAround(lexed, pos).find((x) => x.bodyOpen >= 0);
          return fn ? [fn.bodyOpen, fn.bodyClose] : [0, f.text.length];
        }
        const def = pyDef(pyBlocksAround(f.text, lexed.code, pos));
        return def ? [def.start, def.start + pyBlockText(lexed.code, def).length] : [0, f.text.length];
      };
      for (const lit of lexed.literals) {
        const upd = parseUpdate(lit.value);
        if (!upd || !upd.absolute.length) continue;
        const [from, to] = region(lit.start);
        if (/serializable/i.test(f.text.slice(from, to))) continue;
        const before = lexed.literals.filter((l) => l.start >= from && l.end <= lit.start);
        // A row this function inserted is invisible to other transactions until it commits: updating it isn't a race.
        if (before.some((l) => new RegExp(`^\\s*insert\\s+into\\s+(?:"?\\w+"?\\.)?"?${upd.table}"?[\\s(][\\s\\S]*\\breturning\\b`, "i").test(l.value))) continue;
        // The fix this rule suggests: the row was read with FOR UPDATE earlier in the same function (inside the transaction).
        if (before.some((l) => lockingSelect(l.value) !== undefined && new RegExp(`\\bfrom\\s+(?:"?\\w+"?\\.)?"?${upd.table}"?\\b`, "i").test(l.value))) continue;
        const reads = before.map((l) => parseRead(l.value)).filter((r) => r?.table === upd.table);
        const raw = f.text.slice(lit.start, lit.end);
        for (const col of upd.absolute) {
          if (new RegExp(`\\b${col}\\b`, "i").test(upd.where)) continue;
          // PATCH handlers: `status = ${body.status ?? existing.status}` writes back what the client sent; no decision is made on the read.
          if (new RegExp(`\\b${col}"?\\s*=\\s*\\$\\{[^}]*(?:\\?\\?|\\|\\||\\.\\s*${col}\\b)`, "i").test(raw)) continue;
          if (!reads.some((r) => r!.columns === "*" || new RegExp(`\\b${col}\\b`).test(r!.columns))) continue;
          out.push(
            finding(
              this,
              f,
              lit.start,
              `Reads \`${col}\` from \`${upd.table}\` and then sets it with an UPDATE whose WHERE doesn't check \`${col}\`: two concurrent requests both pass the check. Add \`AND ${col} = <expected>\` to the WHERE and act only when a row comes back.`,
            ),
          );
          break;
        }
      }
    }
    return out;
  },
};
