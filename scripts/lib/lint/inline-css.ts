/**
 * Stylesheets a server-rendered entry module inlines into the page it returns (decision 30): a
 * file's text, read at run time, interpolated into a `<style>` block of the markup. Such a
 * `<style>` loads that file as surely as a `<link>` to it does.
 *
 * Reads: `readFileSync(…)`, `readFile(…)` (fs/promises), `Bun.file(…).text()`, and a default
 * import of the file's text (a Vite `?raw` or `?inline` query, Bun's `with { type: "text" }`).
 * The file is the read's first argument, from its string literals (through module-level
 * `const` bindings, up to three deep):
 * - a package specifier of a CSS file (`require.resolve("@codecaine-ai/design-system/tokens.css")`,
 *   `import.meta.resolve(…)`, `Bun.resolveSync(…)`), resolved from the module;
 * - the package root (`"@codecaine-ai/design-system/package.json"`) followed by a package path
 *   (`join(dirname(require.resolve(…)), "dist/css/tokens.css")`);
 * - a `/@codecaine-ai/design-system/<package path>` URL, resolved in the app's package;
 * - a relative path (`new URL("./ds/tokens.css", import.meta.url)`, `join(__dirname, "ds", "tokens.css")`).
 * Embedding: a binding that holds the text (`const tokens = readFileSync(…)`, `await readFile(…)`,
 * `await Bun.file(…).text()`, or a binding built from such bindings, `const css = fonts + tokens`)
 * or the read itself, written whole inside a `<style>` block: the whole interpolation
 * (`<style>${tokens}</style>`) or an operand of a `+` chain (`"<style>" + tokens + "</style>"`,
 * `${"\n" + tokens}`). A member access or call on the text (`tokens.slice(0, 0)`), a ternary,
 * any other operator, and an un-awaited `readFile()` or `.text()` (a promise) load nothing. Each
 * whole occurrence is one load, at its offset, in source order.
 *
 * Not followed: text returned by a function or held in an object, reads in other modules, and
 * paths built from values computed at run time (`process.cwd()`, environment variables).
 */

import { dirname, join, resolve } from "node:path";
import { PACKAGE_NAME } from "./types";
import { designSystemUrlPath, DS_URL_PREFIX, findPackageDir, isFile, realpathOrNull, resolveSpecifier, splitSpecifier } from "./workspace";

/** One inlined file: the specifier as written (or its package URL) and the file's real path. */
export interface InlineRead {
  spec: string;
  path: string;
}

export interface InlineLoad extends InlineRead {
  /** Offset of the interpolation in the module. */
  index: number;
}

const CSS_FILE = /\.css$/i;
/** Vite queries that return a stylesheet as text: `?raw` (as written), `?inline` (processed). */
const TEXT_QUERY = /[?&](?:raw|inline)(?:[&=#]|$)/;
const DEFAULT_IMPORT = /(?<![\w$.])import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"'\n]+)\2(\s*(?:with|assert)\s*\{\s*type\s*:\s*(["'])text\5\s*\})?/g;
const BINDING = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=(?![=>])/g;
/** A read call's name and `(`, matched where an operand's read starts (sticky). */
const READ_AT = /(?:readFileSync|readFile)\s*\(|Bun\s*\.\s*file\s*\(/y;
/** An identifier, for `exec` at a set `lastIndex`. */
const IDENT_AT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
/** A type assertion after an operand (`tokens as string`): no change to the value. */
const CAST = /\s+(?:as|satisfies)\s+[\w$.]+$/;
const MAX_ALIAS = 3;

/** Offset of the `)` matching the `(` at `open`, counting code characters only; -1 when unbalanced. */
function closeParen(text: string, inStr: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (inStr[i]) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === ")" ? i : -1;
    }
  }
  return -1;
}

/** Where the expression that starts at `start` ends: `;`, `,` or a closing bracket at depth 0, or a line break at depth 0 not followed by `.`/`?`/an operator. */
function expressionEnd(text: string, inStr: Uint8Array, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (inStr[i]) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ";" || c === ",")) return i;
    else if (depth === 0 && c === "\n") {
      const next = /\S/.exec(text.slice(i + 1, i + 200));
      if (!next || !/^[.?+:|&]/.test(next[0])) {
        const prev = text.slice(Math.max(start, i - 200), i).trimEnd();
        if (!/[+(,=:?|&]$/.test(prev)) return i;
      }
    }
  }
  return text.length;
}

/** Splits the argument list between `open` and `close` at its first top-level comma: the first argument's span. */
function firstArgument(text: string, inStr: Uint8Array, open: number, close: number): [number, number] {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    if (inStr[i]) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return [open + 1, i];
  }
  return [open + 1, close];
}

export interface InlineContext {
  /** Real path of the module. */
  file: string;
  /** Real path of the design-system package the app resolves (for `/@codecaine-ai/design-system/…` URLs). */
  designSystem?: string | null;
}

/**
 * Finds the inlined stylesheets of a module. `text` and `inStr` are lexJs's output for the
 * module's source. Returns a function from a `<style>` block's content span to its inline loads.
 */
export function inlineStylesheets(text: string, inStr: Uint8Array, ctx: InlineContext): (start: number, end: number) => InlineLoad[] {
  const hit = (spec: string, p: string): InlineRead | null => (isFile(p) && CSS_FILE.test(p) ? { spec, path: realpathOrNull(p) ?? p } : null);

  // Module-level bindings: name -> right-hand side span (the first declaration wins).
  const rhs = new Map<string, [number, number]>();
  const bindings: Array<{ name: string; span: [number, number] }> = [];
  for (const m of text.matchAll(BINDING)) {
    if (inStr[m.index!]) continue;
    const start = m.index! + m[0].length;
    const span: [number, number] = [start, expressionEnd(text, inStr, start)];
    bindings.push({ name: m[1], span });
    if (!rhs.has(m[1])) rhs.set(m[1], span);
  }

  /** The string literals of a span in order, `const` bindings it names substituted (up to MAX_ALIAS deep). */
  const literals = (start: number, end: number, depth: number, out: string[] = []): string[] => {
    let i = start;
    while (i < end) {
      if (inStr[i]) {
        let j = i;
        while (j < end && inStr[j]) j++;
        out.push(text.slice(i, j));
        i = j;
        continue;
      }
      IDENT_AT.lastIndex = i;
      const id = IDENT_AT.exec(text);
      if (!id || id.index >= end) break;
      // Only code between here and the identifier: a string before it is read on the next pass.
      const stringBefore = inStr.subarray(i, id.index + 1).indexOf(1);
      if (stringBefore !== -1) {
        i += stringBefore;
        continue;
      }
      const span = rhs.get(id[0]);
      if (span && depth < MAX_ALIAS && !(span[0] <= id.index && id.index < span[1])) literals(span[0], span[1], depth + 1, out);
      i = id.index + id[0].length;
    }
    return out;
  };

  /** The file a read's path argument names; null when it is not a CSS file the rules above can name. */
  const fileOf = (lits: string[]): InlineRead | null => {
    const parts = lits.map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const lit = parts[i];
      const parsed = splitSpecifier(lit.replace(/[?#].*$/, ""));
      if (parsed?.name === PACKAGE_NAME) {
        if (CSS_FILE.test(parsed.subpath)) {
          const p = resolveSpecifier(lit, ctx.file);
          return p ? hit(lit.replace(/[?#].*$/, ""), p) : null;
        }
        if (parsed.subpath === "" || parsed.subpath === "package.json") {
          const dir = findPackageDir(PACKAGE_NAME, dirname(ctx.file));
          const rest = parts.slice(i + 1).join("/").replace(/^(?:\.?\/)+/, "").replace(/\/{2,}/g, "/");
          return dir && rest ? hit(DS_URL_PREFIX + rest, join(dir, rest)) : null;
        }
      }
      const urlPath = designSystemUrlPath(lit);
      if (urlPath !== null) return ctx.designSystem ? hit(lit.replace(/[?#].*$/, ""), join(ctx.designSystem, urlPath)) : null;
    }
    const joined = parts.join("/").replace(/\/{2,}/g, "/").replace(/[?#].*$/, "");
    if (!CSS_FILE.test(joined) || joined.startsWith("/") || /^[a-z]+:/i.test(joined)) return null;
    return hit(joined, resolve(dirname(ctx.file), joined));
  };

  /** The read call whose name match starts at `index` (`readFileSync(`, `Bun.file(`): the file it reads. */
  const readAt = (index: number, matchLength: number): InlineRead | null => {
    const open = index + matchLength - 1;
    const close = closeParen(text, inStr, open);
    if (close === -1) return null;
    if (/^Bun/.test(text.slice(index, index + 3)) && !/^\s*\.\s*text\s*\(/.test(text.slice(close + 1, close + 40))) return null;
    const [a, b] = firstArgument(text, inStr, open, close);
    return fileOf(literals(a, b, 0));
  };

  /**
   * A read written as one whole operand: `readFileSync(…)` (or its `.toString()`), or an awaited `readFile(…)` or
   * `Bun.file(…).text()` (un-awaited they are promises). A receiver (`fs.`, `fsp.`) may stand before the
   * name. `[a, b)` is the trimmed operand. The read's offset and file; null when the operand is anything else.
   */
  const readOperand = (a: number, b: number): { index: number; read: InlineRead } | null => {
    const awaited = /^await\s+/.exec(text.slice(a, b));
    const start = a + (awaited?.[0].length ?? 0);
    const receiver = /^(?:[A-Za-z_$][\w$]*\s*\.\s*){0,2}/.exec(text.slice(start, b))![0];
    const at = start + (/^Bun\s*\./.test(receiver) ? 0 : receiver.length);
    READ_AT.lastIndex = at;
    const m = READ_AT.exec(text);
    if (!m || inStr[at]) return null;
    const close = closeParen(text, inStr, at + m[0].length - 1);
    if (close === -1) return null;
    let end = close + 1;
    if (/^Bun/.test(m[0])) {
      const call = /^\s*\.\s*text\s*\(\s*\)/.exec(text.slice(end, b));
      if (!call || !awaited) return null;
      end += call[0].length;
    } else if (/^readFileSync/.test(m[0])) {
      // A Buffer read without an encoding: `.toString()` gives the same text.
      end += /^\s*\.\s*toString\s*\(\s*(?:(["'])utf-?8\1\s*)?\)/i.exec(text.slice(end, b))?.[0].length ?? 0;
    } else if (!awaited) return null;
    if (text.slice(end, b).trim()) return null;
    const read = readAt(at, m[0].length);
    return read ? { index: at, read } : null;
  };

  /**
   * The operands of the `+` chain in `[start, end)`, or null when the span is not one: any other
   * operator at its top level (`?:`, `&&`, `-`, `*`, `,`, a unary `+`, `in`) changes or drops the text.
   * Brackets, strings and templates are opaque.
   */
  const concatOperands = (start: number, end: number): Array<[number, number]> | null => {
    const out: Array<[number, number]> = [];
    let depth = 0;
    let from = start;
    let operand = false;
    for (let i = start; i < end; i++) {
      if (inStr[i]) {
        operand = true;
        continue;
      }
      const c = text[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) return null;
      } else if (depth > 0 || /\s/.test(c)) continue;
      else if (c === "+") {
        if (!operand || text[i + 1] === "+" || text[i + 1] === "=") return null;
        out.push([from, i]);
        from = i + 1;
        operand = false;
        continue;
      } else if (/[-*/%<>=!&|^~?:,;@#]/.test(c)) return null;
      else if (/[A-Za-z_$]/.test(c) && !/[\w$]/.test(text[i - 1] ?? "")) {
        const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, end))![0];
        if (word === "in" || word === "instanceof" || word === "yield") return null;
        i += word.length - 1;
      }
      operand = true;
    }
    if (depth !== 0) return null;
    out.push([from, end]);
    return out;
  };

  /** The `}` closing the `{` at `open`, counting code characters only; -1 when unbalanced before `end`. */
  const closeBrace = (open: number, end: number): number => {
    let depth = 0;
    for (let i = open; i < end; i++) {
      if (inStr[i]) continue;
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    return -1;
  };

  /**
   * The interpolations of the template literal whose backtick is at `a`, when the operand `[a, b)` is
   * exactly that literal (or the literal runs past `b`, the end of a `<style>` block); null otherwise.
   */
  const templateParts = (a: number, b: number): Array<[number, number]> | null => {
    const parts: Array<[number, number]> = [];
    for (let i = a + 1; i < b; i++) {
      if (inStr[i]) continue;
      if (text[i] === "$" && text[i + 1] === "{") {
        const close = closeBrace(i + 1, b);
        if (close === -1) return parts;
        parts.push([i + 2, close]);
        i = close;
      } else if (text[i] === "`") return text.slice(i + 1, b).trim() ? null : parts;
      else return null;
    }
    return parts;
  };

  /**
   * The bindings and reads `[start, end)` emits whole: its operands when it is a `+` chain, each a
   * name that holds a file's text or a read (readOperand); a template literal operand gives its own
   * interpolations. A member access, a call on the text, a ternary or a nested expression gives none.
   */
  const wholeReads = (start: number, end: number, nested = 0): Array<{ index: number; reads: InlineRead[] }> => {
    const found: Array<{ index: number; reads: InlineRead[] }> = [];
    for (let [a, b] of concatOperands(start, end) ?? []) {
      while (a < b && !inStr[a] && /\s/.test(text[a])) a++;
      while (b > a && !inStr[b - 1] && /\s/.test(text[b - 1])) b--;
      if (a >= b || inStr[a]) continue;
      if (text[a] === "`") {
        if (nested < MAX_ALIAS) for (const [x, y] of templateParts(a, b) ?? []) found.push(...wholeReads(x, y, nested + 1));
        continue;
      }
      const cast = CAST.exec(text.slice(a, b));
      if (cast) b -= cast[0].length;
      const name = /^[A-Za-z_$][\w$]*$/.exec(text.slice(a, b))?.[0];
      const reads = name ? textMap.get(name) : undefined;
      if (reads?.length) found.push({ index: a, reads });
      else if (!name) {
        const r = readOperand(a, b);
        if (r) found.push({ index: r.index, reads: [r.read] });
      }
    }
    return found;
  };

  /**
   * Loads of a `<style>` block whose text is `[start, end)`: each interpolation of the literal that
   * holds the block (`<style>${tokens}</style>`), and the code after that literal closes, up to the
   * block's end (`"<style>" + tokens + "</style>"`).
   */
  const blockReads = (start: number, end: number): Array<{ index: number; reads: InlineRead[] }> => {
    const found: Array<{ index: number; reads: InlineRead[] }> = [];
    for (let i = start; i < end; i++) {
      if (inStr[i]) continue;
      if (text[i] === "$" && text[i + 1] === "{") {
        const close = closeBrace(i + 1, end);
        if (close === -1) break;
        found.push(...wholeReads(i + 2, close));
        i = close;
        continue;
      }
      if (/["'`]/.test(text[i])) found.push(...wholeReads(i, end)); // the literal's closing quote
      break;
    }
    return found;
  };

  // Default imports of a file's text.
  const textMap = new Map<string, InlineRead[]>();
  for (const m of text.matchAll(DEFAULT_IMPORT)) {
    if (inStr[m.index!] || !(TEXT_QUERY.test(m[3]) || m[4])) continue;
    const read = fileOf([m[3]]);
    if (read) textMap.set(m[1], [read]);
  }
  // Bindings that hold a file's text, or text built from such bindings, in source order.
  for (const { name, span } of bindings) {
    const reads = wholeReads(span[0], span[1]).flatMap((f) => f.reads);
    if (reads.length && !textMap.has(name)) textMap.set(name, reads);
  }

  return (start, end) => blockReads(start, end).flatMap((f) => f.reads.map((r) => ({ ...r, index: f.index })));
}
