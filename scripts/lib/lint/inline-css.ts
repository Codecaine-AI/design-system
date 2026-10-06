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
 * Embedding: a binding that holds the text (`const tokens = readFileSync(…)`, or a binding built
 * from such bindings, `const css = fonts + tokens`) or the read itself, written inside a `<style>`
 * block (`<style>${tokens}</style>`, `"<style>" + tokens + "</style>"`). Each occurrence is one
 * load, at its offset, in source order.
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
const READ_CALL = /(?<![\w$])(?:readFileSync|readFile)\s*\(|(?<![\w$.])Bun\s*\.\s*file\s*\(/g;
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
/** IDENT for `exec` at a set `lastIndex`. Separate: `matchAll` copies a regex's `lastIndex`, so IDENT's must stay 0. */
const IDENT_AT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
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

  /** Reads in a span (direct calls and names that hold text), in source order. */
  const textMap = new Map<string, InlineRead[]>();
  const readsIn = (start: number, end: number): Array<{ index: number; reads: InlineRead[] }> => {
    const found: Array<{ index: number; reads: InlineRead[] }> = [];
    const calls: Array<[number, number]> = [];
    for (const m of text.slice(start, end).matchAll(READ_CALL)) {
      const at = start + m.index!;
      if (inStr[at]) continue;
      const read = readAt(at, m[0].length);
      const close = closeParen(text, inStr, at + m[0].length - 1);
      calls.push([at, close === -1 ? at : close]);
      if (read) found.push({ index: at, reads: [read] });
    }
    for (const m of text.slice(start, end).matchAll(IDENT)) {
      const at = start + m.index!;
      if (inStr[at] || calls.some(([s, e]) => at > s && at <= e)) continue;
      const reads = textMap.get(m[0]);
      if (reads?.length) found.push({ index: at, reads });
    }
    return found.sort((x, y) => x.index - y.index);
  };

  // Default imports of a file's text.
  for (const m of text.matchAll(DEFAULT_IMPORT)) {
    if (inStr[m.index!] || !(TEXT_QUERY.test(m[3]) || m[4])) continue;
    const read = fileOf([m[3]]);
    if (read) textMap.set(m[1], [read]);
  }
  // Bindings that hold a file's text, or text built from such bindings, in source order.
  for (const { name, span } of bindings) {
    const reads = readsIn(span[0], span[1]).flatMap((f) => f.reads);
    if (reads.length && !textMap.has(name)) textMap.set(name, reads);
  }

  return (start, end) => readsIn(start, end).flatMap((f) => f.reads.map((r) => ({ ...r, index: f.index })));
}
