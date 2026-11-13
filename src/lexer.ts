/**
 * Just enough lexing for the concurrency checks: string literals, bracket pairs and enclosing calls in JS/TS, and
 * string literals plus indentation blocks in Python. Offsets always refer to the original text.
 */

export interface Literal {
  start: number;
  end: number;
  /** The literal's contents, without quotes or prefixes. */
  value: string;
}

export interface Pair {
  open: number;
  close: number;
  char: "(" | "{" | "[";
}

export interface Lexed {
  literals: Literal[];
  /** The text with comments blanked and string contents blanked, so brackets inside strings don't count. */
  code: string;
  pairs: Pair[];
}

const blankRun = (s: string) => s.replace(/[^\n]/g, " ");

/** JS/TS: comments and strings (`'…'`, `"…"`, `` `…` `` with `${…}` kept as code) found in one pass. */
export function lexJs(src: string): Lexed {
  const literals: Literal[] = [];
  let code = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && (n === "/" || n === "*")) {
      const end = n === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : n === "/" ? end : end + 2;
      code += blankRun(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          value += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c !== "`" && src[j] === "\n") break;
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") {
          // Keep the interpolation as a placeholder; SQL checks only need the text around it.
          let depth = 0;
          let k = j + 1;
          for (; k < src.length; k++) {
            if (src[k] === "{") depth++;
            else if (src[k] === "}" && --depth === 0) break;
          }
          value += "$1";
          j = k + 1;
          continue;
        }
        value += src[j];
        j++;
      }
      const end = Math.min(j + 1, src.length);
      literals.push({ start: i, end, value });
      code += c + blankRun(src.slice(i + 1, end - 1)) + (end - 1 > i ? src[end - 1] : "");
      i = end;
    } else {
      code += c;
      i++;
    }
  }
  return { literals, code, pairs: bracketPairs(code) };
}

/** Python: `#` comments, and strings with optional r/b/f/u prefixes, single or triple quoted. */
export function lexPython(src: string): Lexed {
  const literals: Literal[] = [];
  let code = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      code += blankRun(src.slice(i, stop));
      i = stop;
      continue;
    }
    const prefix = /^[rRbBfFuU]{0,2}(?='|")/.exec(src.slice(i, i + 3));
    const prevIsWord = i > 0 && /[\w]/.test(src[i - 1]!);
    if (prefix && !(prefix[0] && prevIsWord)) {
      const q = i + prefix[0].length;
      const quote = src[q]!;
      const triple = src.slice(q, q + 3) === quote.repeat(3);
      const delim = triple ? quote.repeat(3) : quote;
      let j = q + delim.length;
      while (j < src.length && !src.startsWith(delim, j)) {
        if (src[j] === "\\") j++;
        else if (!triple && src[j] === "\n") break;
        j++;
      }
      const end = Math.min(j + delim.length, src.length);
      literals.push({ start: i, end, value: src.slice(q + delim.length, j) });
      code += src.slice(i, q + delim.length) + blankRun(src.slice(q + delim.length, j)) + src.slice(j, end);
      i = end;
      continue;
    }
    code += c;
    i++;
  }
  return { literals, code, pairs: bracketPairs(code) };
}

function bracketPairs(code: string): Pair[] {
  const pairs: Pair[] = [];
  const stack: { at: number; char: Pair["char"] }[] = [];
  const closer: Record<string, Pair["char"]> = { ")": "(", "}": "{", "]": "[" };
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") stack.push({ at: i, char: c });
    else if (c in closer) {
      // Skip a stray closer (regex literals, JSX text) rather than unwinding the whole stack.
      const k = stack.map((s) => s.char).lastIndexOf(closer[c]!);
      if (k === -1) continue;
      const top = stack[k]!;
      stack.length = k;
      pairs.push({ open: top.at, close: i, char: top.char });
    }
  }
  return pairs.sort((a, b) => a.open - b.open);
}

/** Bracket pairs around `pos`, innermost first. */
export function enclosing(lexed: Lexed, pos: number): Pair[] {
  return lexed.pairs.filter((p) => p.open < pos && p.close >= pos).sort((a, b) => b.open - a.open);
}

/** `a.b.c` (or `await a.b`, `this.pool`) right before `(`, `` ` `` or a type argument list at `pos`; undefined if none. */
export function calleeBefore(code: string, pos: number): string | undefined {
  const head = code.slice(Math.max(0, pos - 200), pos).replace(/<[^<>()]*>\s*$/, "");
  return /([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*$/.exec(head)?.[1]?.replace(/\s+|\?/g, "");
}

/** Split `pool.query` into receiver `pool` and method `query`. */
export function splitCallee(callee: string): { receiver: string; method: string } | undefined {
  const dot = callee.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return { receiver: callee.slice(0, dot), method: callee.slice(dot + 1) };
}

/** Python: indentation (in columns) of the line holding `pos`. */
export function indentAt(src: string, pos: number): { indent: number; lineStart: number } {
  const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
  return { indent: /^[ \t]*/.exec(src.slice(lineStart))![0].length, lineStart };
}

export interface PyBlock {
  /** The header line (`def f(conn):`, `async with conn.transaction():`). */
  header: string;
  start: number;
  indent: number;
}

/**
 * Python: the block headers that enclose `pos` (the `def`, `with`, `async with`, `class`… lines with less
 * indentation above it, each the nearest one at its level), innermost first.
 */
export function pyBlocksAround(src: string, code: string, pos: number): PyBlock[] {
  const out: PyBlock[] = [];
  let { indent, lineStart } = indentAt(code, pos);
  let cursor = lineStart;
  while (cursor > 0 && indent > 0) {
    const prevEnd = cursor - 1;
    const prevStart = code.lastIndexOf("\n", prevEnd - 1) + 1;
    const line = code.slice(prevStart, prevEnd);
    cursor = prevStart;
    if (!line.trim()) continue;
    const ind = /^[ \t]*/.exec(line)![0].length;
    if (ind < indent && /:\s*$/.test(line.trimEnd())) {
      out.push({ header: src.slice(prevStart, prevEnd).trim(), start: prevStart, indent: ind });
      indent = ind;
    } else if (ind < indent) {
      // A continuation line of a multi-line statement; keep walking up.
      continue;
    }
  }
  return out;
}

/** Python: the source of the block whose header starts at `start` (until the next line at its indentation or less). */
export function pyBlockText(code: string, block: PyBlock): string {
  const lines = code.slice(block.start).split("\n");
  const body = [lines[0]!];
  for (const line of lines.slice(1)) {
    if (line.trim() && /^[ \t]*/.exec(line)![0].length <= block.indent && !/^[ \t]*[)\]}]/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}
