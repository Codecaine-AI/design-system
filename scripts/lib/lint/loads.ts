/**
 * The stylesheet load graph of an app: every design-system stylesheet the entry
 * stylesheet loads, in cascade order.
 *
 * From the entry (CSS, a JS/TS module, or an HTML page) the walk follows, depth
 * first and in source order:
 * - CSS `@import` (local files and workspace packages, any depth)
 * - JS/TS `import`/`export from` statements (at the top level, where a statement can
 *   start: an `import` line in JSX text is text) and `require` of CSS. An import with
 *   `?url`, `?raw` or `?inline` returns the file as a value and injects nothing, so it
 *   is not a load.
 * - `<link>` tags and `@import` inside string literals, only in the registered entry
 *   and only when it is a server-rendered HTML module (its strings hold `<!doctype
 *   html>` or `<html>`, as docs-mcp's home page does); elsewhere such a string is an
 *   export template or documentation, not the page's own stylesheet.
 * - local JS/TS imports up to JS_DEPTH modules deep (main.tsx -> App.tsx -> ...)
 * - HTML `<link rel="stylesheet">`, `<style>` and `<script src>` in document order
 *
 * A root-absolute URL (`/src/site/styles.css`) resolves against the app's web root
 * (`run.serveRoot ?? run.cwd ?? app.root`), never against the importing file.
 * A stylesheet loaded under a media query other than `all`/`screen`, or a
 * `supports(…)` condition, keeps that condition on its loads (and on everything it
 * imports): it does not apply to every page view.
 *
 * A design-system file is recognized by the package it resolves into (the nearest
 * package.json named @codecaine-ai/design-system), by its package specifier, or, for
 * copied files, by the generated header. It is recorded, not followed.
 */

import { basename, extname, relative } from "node:path";
import { lexJs, stripCss, stripHtml } from "../../scan-literals";
import { PACKAGE_NAME } from "./types";
import { lineAt, owningPackage, readText, realpathOrNull, resolveSpecifier, splitSpecifier, toPosix } from "./workspace";

export type DsKind =
  | "fonts"
  | "tokens"
  | "tokens-dark-first"
  | "host-contract"
  | "host-contract-dark-first"
  | "layout"
  | "tw-strict"
  | "tw-theme"
  | "ds-other";
export type LoadKind = DsKind | "tailwindcss";

export interface Load {
  kind: LoadKind;
  spec: string;
  /** Absolute file that holds the import. */
  from: string;
  line: number;
  /** Real path of the resolved file; null when it does not resolve (or for `tailwindcss`). */
  path: string | null;
  /** A local file recognized as a copy of a design-system file by its header, not loaded from the package. */
  copied: boolean;
  /** The media or supports condition the load sits under (`print`, `supports(display: grid)`); absent when it always applies. */
  condition?: string;
}

export interface Unresolved {
  spec: string;
  from: string;
  line: number;
}

export interface LoadGraph {
  entry: string | null;
  entryExists: boolean;
  /** Design-system stylesheets and `tailwindcss`, in load order. */
  loads: Load[];
  /** Stylesheet imports that do not resolve. */
  unresolved: Unresolved[];
  /** Every local file the walk read (entry first), real paths. */
  files: string[];
}

const JS_DEPTH = 3;
const MAX_DEPTH = 16;
const CSS_EXT = /\.(?:css|scss|sass|less|pcss|postcss)$/i;
const JS_EXT = /\.(?:[mc]?[jt]sx?)$/i;

const DS_SUBPATHS: Record<string, DsKind> = {
  "tokens.css": "tokens",
  "tokens-dark-first.css": "tokens-dark-first",
  "host-contract.css": "host-contract",
  "host-contract-dark-first.css": "host-contract-dark-first",
  "layout.css": "layout",
  "tailwind.css": "tw-theme",
  "tailwind-strict.css": "tw-strict",
  "fonts.css": "fonts",
};

const DS_FILES: Record<string, DsKind> = {
  "dist/css/tokens.css": "tokens",
  "dist/css/tokens-dark-first.css": "tokens-dark-first",
  "dist/css/host-contract.css": "host-contract",
  "dist/css/host-contract-dark-first.css": "host-contract-dark-first",
  "css/layout.css": "layout",
  "dist/tailwind/theme.css": "tw-theme",
  "dist/tailwind/strict.css": "tw-strict",
  "css/fonts.css": "fonts",
  "dist/css/fonts.css": "fonts",
};

/** Basenames a copied design-system file keeps; recognized only with the package's generated header. */
const COPIED: Record<string, DsKind> = {
  "tokens.css": "tokens",
  "tokens-dark-first.css": "tokens-dark-first",
  "host-contract.css": "host-contract",
  "host-contract-dark-first.css": "host-contract-dark-first",
  "layout.css": "layout",
  "fonts.css": "fonts",
  "theme.css": "tw-theme",
  "strict.css": "tw-strict",
};

const COPY_HEADER = /^\s*\/\*[\s*]*@codecaine-ai\/design-system\b/;

/** What a stylesheet specifier loads, or null for an ordinary file the walk follows. */
export function classify(spec: string, real: string | null): { kind: LoadKind; copied: boolean } | null {
  const pkgKind = (kind: LoadKind | null | undefined) => (kind ? { kind, copied: false } : null);
  const clean = spec.replace(/[?#].*$/, "");
  if (clean === "tailwindcss" || clean.startsWith("tailwindcss/")) return pkgKind("tailwindcss");
  const parsed = splitSpecifier(clean);
  if (parsed?.name === PACKAGE_NAME) return pkgKind(DS_SUBPATHS[parsed.subpath] ?? "ds-other");
  if (parsed?.name === "@codecaine-ai/text-measure" && parsed.subpath === "fonts.css") return pkgKind("fonts");
  if (!real) return null;
  const pkg = owningPackage(real);
  if (pkg?.name === PACKAGE_NAME) return pkgKind(DS_FILES[toPosix(relative(pkg.dir, real))] ?? (CSS_EXT.test(real) ? "ds-other" : null));
  if (pkg?.name === "@codecaine-ai/text-measure" && basename(real) === "fonts.css") return pkgKind("fonts");
  const copied = COPIED[basename(real)];
  if (copied) {
    // The package's own header: the file opens with a comment whose first word is the package name,
    // and holds no @import outside comments. A local wrapper that mentions the package and
    // @imports it is followed instead.
    const text = readText(real) ?? "";
    if (COPY_HEADER.test(text.slice(0, 200)) && !/@import\b/.test(stripCss(text, false))) return { kind: copied, copied: true };
  }
  return null;
}

interface Ref {
  spec: string;
  index: number;
  /** css: a stylesheet reference; js: a module import (followed when local) or an HTML <script src>. */
  as: "css" | "js";
  /** An HTML href/src or a CSS @import: a URL, document-relative before it is a package. */
  url?: boolean;
  /** Media or supports condition (see conditionOf). */
  condition?: string;
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["'])([^"'\n]+)\1(?:\s*\))?/g;
const CSS_IMPORT_BARE_URL = /@import\s+url\(\s*([^"')\s]+)\s*\)/g;
const LINK_TAG = /<link\b[^>]*>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
/** Vite query suffixes that return the file as a value (a URL or its text) instead of injecting it. */
const VALUE_QUERY = /[?&](?:url|raw|inline)(?:[&=#]|$)/;

/**
 * The condition a stylesheet applies under, from an @import's tail (`layer(x) supports(…) print`)
 * or a <link>'s media attribute. Undefined when it always applies: no media list, `all` or `screen`.
 */
export function conditionOf(tail: string): string | undefined {
  let t = tail.trim().replace(/;$/, "").trim();
  // Cascade layers and Tailwind v4's import options are not conditions.
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/^(?:(?:layer|source|prefix|theme)(?:\([^)]*\))?|important)(?![\w-])/i, "").trim();
  }
  if (!t || /^(?:all|screen)$/i.test(t)) return undefined;
  return t;
}

function cssRefs(text: string, offset = 0): Ref[] {
  const refs: Ref[] = [];
  // The tail ends at `;`; in markup held in a string (no `;` before </style>), at a tag, a line break or the string's end.
  const tail = (end: number) => conditionOf(text.slice(end, end + 300).split(/[;<\n`"']/)[0]);
  for (const m of text.matchAll(CSS_IMPORT)) refs.push({ spec: m[2], index: offset + m.index!, as: "css", url: true, condition: tail(m.index! + m[0].length) });
  for (const m of text.matchAll(CSS_IMPORT_BARE_URL)) refs.push({ spec: m[1], index: offset + m.index!, as: "css", url: true, condition: tail(m.index! + m[0].length) });
  return refs;
}

function linkRefs(text: string, offset = 0): Ref[] {
  const refs: Ref[] = [];
  for (const m of text.matchAll(LINK_TAG)) {
    const tag = m[0];
    const rel = tag.match(ATTR("rel"));
    if (!rel || !/stylesheet/i.test(rel[1] ?? rel[2] ?? rel[3] ?? "")) continue;
    const href = tag.match(ATTR("href"));
    const v = href && (href[1] ?? href[2] ?? href[3]);
    const media = tag.match(ATTR("media"));
    const condition = media ? conditionOf(media[1] ?? media[2] ?? media[3] ?? "") : undefined;
    if (v && !v.includes("${")) refs.push({ spec: v, index: offset + m.index!, as: "css", url: true, condition });
  }
  return refs;
}

const JS_IMPORT =
  /(?<![\w$.])(?:import\s+(?!type\b)(?:[\w$*{}\s,]+?\s+from\s+)?|export\s+(?!type\b)[\w$*{}\s,]+?\s+from\s+)(["'])([^"'\n]+)\1|(?<![\w$.])require\(\s*(["'])([^"'\n]+)\3\s*\)/g;

/** Characters a statement can follow on the same line: none (start of file), `;`, a closing bracket, the end of a string, a word. */
const ENDS_STATEMENT = /[;})\]"'`\w$]/;

/**
 * Where a static import can be a statement: at bracket depth 0 (counting code characters
 * only), after a character that ends a statement, or first on its line (ASI) unless a `.`
 * before it makes it a property. An `import` line in JSX text sits inside the component's
 * brackets. Brackets inside regex literals are counted too (lexJs does not mark them).
 */
function statementStarts(text: string, inStr: Uint8Array): (index: number) => boolean {
  const depth = new Int32Array(text.length + 1);
  const prev = new Int32Array(text.length + 1);
  const lineStart = new Uint8Array(text.length + 1);
  let d = 0;
  let last = -1;
  let fresh = 1;
  for (let i = 0; i < text.length; i++) {
    depth[i] = d;
    prev[i] = last;
    lineStart[i] = fresh;
    const ch = text[i];
    if (ch === "\n") fresh = 1;
    if (inStr[i]) {
      fresh = 0;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") d = Math.max(0, d - 1);
    if (!/\s/.test(ch)) {
      last = i;
      fresh = 0;
    }
  }
  return (index) => {
    if (depth[index] !== 0) return false;
    const p = prev[index];
    if (p === -1 || ENDS_STATEMENT.test(text[p])) return true;
    return lineStart[index] === 1 && text[p] !== ".";
  };
}

/** An HTML document in a JS module's strings: the module renders a page on the server. */
const INLINE_DOCUMENT = /<!doctype\s+html|<html[\s>]/i;

function jsRefs(src: string, inlineMarkup = false): Ref[] {
  const { text, inStr } = lexJs(src);
  const refs: Ref[] = [];
  const atStatement = statementStarts(text, inStr);
  for (const m of text.matchAll(JS_IMPORT)) {
    if (inStr[m.index!]) continue;
    const spec = m[2] ?? m[4];
    if (m[2] !== undefined && !atStatement(m.index!)) continue; // `import …` in JSX text or inside an expression
    if (VALUE_QUERY.test(spec)) continue;
    refs.push({ spec, index: m.index!, as: CSS_EXT.test(spec.replace(/[?#].*$/, "")) ? "css" : "js" });
  }
  // Inline HTML or CSS in string literals: the page a server-rendered entry module returns.
  if (inlineMarkup) for (const r of [...linkRefs(src), ...cssRefs(src)]) if (inStr[r.index]) refs.push(r);
  return refs.sort((a, b) => a.index - b.index);
}

function htmlRefs(src: string): Ref[] {
  const text = stripHtml(src);
  const refs: Ref[] = [...linkRefs(text)];
  for (const m of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) refs.push(...cssRefs(m[2], m.index! + m[1].length));
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const src = m[1].match(ATTR("src"));
    const v = src && (src[1] ?? src[2] ?? src[3]);
    if (v) refs.push({ spec: v, index: m.index!, as: "js", url: true });
    else for (const r of jsRefs(m[2])) refs.push({ ...r, index: r.index + m.index! + m[1].length });
  }
  return refs.sort((a, b) => a.index - b.index);
}

function refsOf(file: string, src: string, isEntry: boolean): Ref[] {
  const ext = extname(file).toLowerCase();
  if (CSS_EXT.test(file)) {
    const text = stripCss(src, ext !== ".css");
    return cssRefs(text);
  }
  if (JS_EXT.test(file)) {
    const inlineMarkup = isEntry && (() => {
      const { inStr } = lexJs(src);
      for (const m of src.matchAll(new RegExp(INLINE_DOCUMENT.source, "gi"))) if (inStr[m.index!]) return true;
      return false;
    })();
    return jsRefs(src, inlineMarkup);
  }
  if (/\.(?:html?|vue|svelte|astro)$/i.test(file)) return htmlRefs(src);
  return [];
}

export interface LoadGraphOptions {
  /** The app's web root: where a root-absolute URL (`/src/main.tsx`) points. */
  serveRoot?: string;
}

export function buildLoadGraph(entry: string | null, opts: LoadGraphOptions = {}): LoadGraph {
  const graph: LoadGraph = { entry, entryExists: false, loads: [], unresolved: [], files: [] };
  if (!entry) return graph;
  const real = realpathOrNull(entry);
  if (!real) return graph;
  graph.entry = real;
  graph.entryExists = true;
  const visited = new Set<string>();

  const visit = (file: string, jsDepth: number, depth: number, inherited: string | undefined) => {
    if (visited.has(file) || depth > MAX_DEPTH) return;
    visited.add(file);
    graph.files.push(file);
    const src = readText(file);
    if (src === null) return;
    for (const ref of refsOf(file, src, file === real)) {
      const line = lineAt(src, ref.index);
      const condition = [inherited, ref.condition].filter(Boolean).join(" and ") || undefined;
      const resolved = resolveSpecifier(ref.spec, file, ref.url === true, opts.serveRoot);
      const target = resolved ? realpathOrNull(resolved) : null;
      const isCss = ref.as === "css" || (target !== null && CSS_EXT.test(target));
      const cls = isCss ? classify(ref.spec, target) : null;
      const kind = cls?.kind;
      if (cls && kind) {
        const load: Load = { kind, spec: ref.spec, from: file, line, path: kind === "tailwindcss" ? null : target, copied: cls.copied };
        if (condition) load.condition = condition;
        graph.loads.push(load);
        if (kind !== "tailwindcss" && !target) graph.unresolved.push({ spec: ref.spec, from: file, line });
        continue;
      }
      if (!target) {
        if (isCss && !/^(?:https?:)?\/\//i.test(ref.spec)) graph.unresolved.push({ spec: ref.spec, from: file, line });
        continue;
      }
      // Third-party files: recorded only when they are design-system files (above).
      if (target.includes("/node_modules/")) continue;
      if (isCss) visit(target, jsDepth, depth + 1, condition);
      else if (JS_EXT.test(target) && (ref.spec.startsWith(".") || ref.spec.startsWith("/")) && jsDepth < JS_DEPTH) {
        visit(target, jsDepth + 1, depth + 1, condition);
      }
    }
  };
  visit(real, 0, 0, undefined);
  return graph;
}
