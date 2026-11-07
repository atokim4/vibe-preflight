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

export interface TableInfo {
  name: string;
  file: string;
  line: number;
  rls: boolean;
  policies: PolicyInfo[];
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

/** Replay all migrations in file-name order and return the final tables with their RLS state and policies. */
export function buildSchema(files: SourceFile[]): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    for (const st of splitSql(file)) {
      const s = st.norm;
      let m: RegExpExecArray | null;

      if ((m = new RegExp(`^create (?:(?:global |local )?(?:temporary |temp )|unlogged )?table (?:if not exists )?(${IDENT})\\s*\\(`).exec(s))) {
        const name = tableName(m[1]!);
        if (!tables.has(name)) tables.set(name, { name, file: st.file, line: st.line, rls: false, policies: [] });
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
        const rename = /^rename to "?([a-z_][a-z0-9_]*)"?/.exec(rest);
        if (rename) {
          tables.delete(t.name);
          t.name = `${t.name.split(".")[0]}.${rename[1]}`;
          tables.set(t.name, t);
        }
        continue;
      }
      if ((m = new RegExp(`^create policy ("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})(.*)$`).exec(s))) {
        const t = tables.get(tableName(m[2]!));
        if (!t) continue;
        const rest = m[3]!;
        const command = (/ for (all|select|insert|update|delete)\b/.exec(rest)?.[1] ?? "all") as PolicyInfo["command"];
        const rolesRaw = / to ([a-z_, "]+?)(?= using| with check|$)/.exec(rest)?.[1];
        t.policies.push({
          name: m[1]!.replace(/"/g, ""),
          command,
          roles: rolesRaw ? rolesRaw.split(",").map((r) => r.replace(/"/g, "").trim()) : ["public"],
          using: clause(rest, /\busing\s*\(/),
          withCheck: clause(rest, /\bwith check\s*\(/),
          file: st.file,
          line: st.line,
        });
        continue;
      }
      if ((m = new RegExp(`^drop policy (?:if exists )?("[^"]+"|[a-z_][a-z0-9_]*) on (${IDENT})`).exec(s))) {
        const t = tables.get(tableName(m[2]!));
        const name = m[1]!.replace(/"/g, "");
        if (t) t.policies = t.policies.filter((p) => p.name !== name);
      }
    }
  }
  return tables;
}
