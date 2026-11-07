/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Replace a range with spaces, keeping newlines so offsets and line numbers stay valid. */
export function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/**
 * Remove comments from JS/TS source, keeping offsets. Strings and template literals are kept as they are
 * (a `//` inside a URL string is not a comment). Regex literals are not special-cased; that is fine for the
 * patterns the rules look for.
 */
export function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
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

/** True when the file starts with the directive (after comments and blank lines). */
export function hasDirective(src: string, directive: "use client" | "use server"): boolean {
  const body = stripJsComments(src).trimStart();
  return body.startsWith(`"${directive}"`) || body.startsWith(`'${directive}'`);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
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
