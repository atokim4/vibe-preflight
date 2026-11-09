import type { Project, SourceFile } from "./types.ts";
import type { ApiRole, TablePrivilege } from "./sql.ts";
import { isClientFile, isTestFile } from "./context.ts";
import { lineAt, stripJsComments } from "./text.ts";

/** One `supabase.from('<table>')` call and what it does to the table. */
export interface TableCall {
  table: string;
  file: string;
  line: number;
  /** The role PostgREST runs the request as: the user's session, or the service role key. */
  role: Extract<ApiRole, "authenticated" | "service_role">;
  /** Runs in the browser bundle. */
  client: boolean;
  privileges: TablePrivilege[];
}

const FROM = /\.\s*from\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g;
/** `supabase.storage.from('avatars')`, `Array.from('abc')`, `Buffer.from('x')`, `.schema('billing').from('t')`. */
const NOT_A_TABLE = /(?:\bstorage|\bArray|\bBuffer|Uint8Array|\bschema\s*\(\s*["'`](?!public["'`])[^)]*\))\s*$/;
const METHOD = /\.\s*(select|insert|update|upsert|delete)\s*\(/g;
/** Clients built with the service role key run as `service_role`, which skips RLS but still needs grants. */
const SERVICE_KEY = /SERVICE_ROLE|service_role|serviceRole|SUPABASE_SECRET_KEY|sb_secret_/;

/** The query chain after `.from(…)`: up to the end of the statement. */
function chainAfter(code: string, start: number): string {
  const rest = code.slice(start, start + 800);
  const end = rest.search(/;|\n\s*\n|\.\s*from\s*\(|\b(?:const|let|var|return|if|for)\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * What a call needs on the table. Postgres checks SELECT on every column a filter reads, so `update` and `delete`
 * (always filtered in supabase-js code) and `upsert` (ON CONFLICT reads the key) need SELECT too.
 */
function privilegesFor(chain: string): TablePrivilege[] {
  const needed = new Set<TablePrivilege>();
  for (const m of chain.matchAll(METHOD)) {
    const method = m[1]!;
    if (method === "upsert") ["insert", "update", "select"].forEach((p) => needed.add(p as TablePrivilege));
    else needed.add(method as TablePrivilege);
    if (method === "update" || method === "delete") needed.add("select");
  }
  // `.from('t')` with no method yet is usually a builder passed on and read later.
  if (!needed.size) needed.add("select");
  return [...needed];
}

function callsIn(project: Project, file: SourceFile): TableCall[] {
  const code = stripJsComments(file.text);
  const client = isClientFile(project, file);
  const role = !client && SERVICE_KEY.test(code) ? "service_role" : "authenticated";
  const calls: TableCall[] = [];
  for (const m of code.matchAll(FROM)) {
    if (NOT_A_TABLE.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    calls.push({
      table: `public.${m[2]}`,
      file: file.path,
      line: lineAt(code, m.index),
      role,
      client,
      privileges: privilegesFor(chainAfter(code, m.index + m[0].length)),
    });
  }
  return calls;
}

const cache = new WeakMap<Project, TableCall[]>();

/** Every `.from('<table>')` in app code (tests excluded). */
export function tableCalls(project: Project): TableCall[] {
  let calls = cache.get(project);
  if (!calls) {
    calls = project.files.filter((f) => f.kind === "source" && !isTestFile(f)).flatMap((f) => callsIn(project, f));
    cache.set(project, calls);
  }
  return calls;
}
