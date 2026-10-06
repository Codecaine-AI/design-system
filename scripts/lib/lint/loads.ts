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
 * - HTML `<link>`, `<style>` and `<script src>` in document order. A `<link>` counts
 *   when its rel holds `stylesheet` and not `alternate`, and it is not `disabled`.
 *   Nothing inside `<noscript>` or `<template>` loads.
 *
 * A root-absolute URL (`/src/site/styles.css`) resolves against the app's web root
 * (`run.serveRoot ?? run.cwd ?? app.root`), never against the importing file.
 *
 * Conditions: a stylesheet loaded under a media query or a `supports(…)` condition
 * keeps that condition on its loads (and on everything it imports): it does not apply
 * to every page view. A media list with `all` or `screen` (`only screen`) as one of
 * its items applies to every view, and so does `<link media="print"
 * onload="this.media='all'">` (the async pattern). `<style media>` passes its media
 * to its @imports.
 *
 * Compilation roots: Tailwind v4 (@tailwindcss/vite and /postcss) compiles each CSS
 * file a JS module imports or a page links, and each `<style>` block, on its own,
 * with its @import closure inlined. Every load records that root (`root`).
 *
 * An @import after a rule (anything but `@charset`, another `@import` or an `@layer`
 * statement) is ignored by browsers, postcss-import and Lightning CSS: it is not a
 * load; it is recorded in `inert`. Tailwind 4 inlines every `@import "…"` of a root
 * wherever it stands, so in a root whose closure imports Tailwind only a late
 * `@import url(…)` (which Tailwind leaves in place) is inert. Only .css/.pcss files and
 * `<style>` blocks are judged; Sass and Less have their own @import rules.
 *
 * A design-system file is recognized by the package it resolves into (the nearest
 * package.json named @codecaine-ai/design-system), by its package specifier, or, for
 * copied files, by the generated header. It is recorded, not followed. Tailwind's own
 * stylesheets and @codecaine-ai/text-measure's fonts.css are recorded under their own
 * kinds, which are not design-system kinds.
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
/**
 * Not design-system kinds: `tailwindcss` (the full import: `tailwindcss`, `tailwindcss/index.css`),
 * `tailwindcss-theme` (Tailwind's default theme: `tailwindcss/theme(.css)`), `tailwindcss-part`
 * (preflight, utilities), and `text-measure-fonts` (@codecaine-ai/text-measure's fonts.css).
 */
export type LoadKind = DsKind | "tailwindcss" | "tailwindcss-theme" | "tailwindcss-part" | "text-measure-fonts";

const DS_KINDS = new Set<LoadKind>(["fonts", "tokens", "tokens-dark-first", "host-contract", "host-contract-dark-first", "layout", "tw-strict", "tw-theme", "ds-other"]);
const TAILWIND_KINDS = new Set<LoadKind>(["tailwindcss", "tailwindcss-theme", "tailwindcss-part"]);

export interface Load {
  kind: LoadKind;
  spec: string;
  /** Absolute file that holds the import. */
  from: string;
  line: number;
  /** Real path of the resolved file; null when it does not resolve (or for Tailwind's own stylesheets). */
  path: string | null;
  /** A local file recognized as a copy of a design-system file by its header, not loaded from the package. */
  copied: boolean;
  /** The media or supports condition the load sits under (`print`, `supports(display: grid)`); absent when it always applies. */
  condition?: string;
  /**
   * The compilation root the load belongs to: the real path of the CSS file a JS import or an HTML
   * <link> reaches (a stylesheet imported straight from JS is its own root), or `<page>#style<n>`
   * for the n-th <style> block of a page.
   */
  root: string;
}

/** A design-system stylesheet (not Tailwind's, text-measure's, or any other recorded non-design-system load). */
export function isDsLoad(l: Load): boolean {
  return DS_KINDS.has(l.kind);
}

/** One of Tailwind's own stylesheets. */
export function isTailwindLoad(l: Pick<Load, "kind">): boolean {
  return TAILWIND_KINDS.has(l.kind);
}

export interface Unresolved {
  spec: string;
  from: string;
  line: number;
}

export interface LoadGraph {
  entry: string | null;
  entryExists: boolean;
  /** Design-system stylesheets, Tailwind's stylesheets and text-measure's fonts.css, in load order. */
  loads: Load[];
  /** Recorded @imports (design-system, Tailwind, text-measure) after a rule: ignored, so not in `loads`. */
  inert: Load[];
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
const TEXT_MEASURE = "@codecaine-ai/text-measure";

/** The kind of a tailwindcss package subpath: "" and index(.css) are the full import, theme(.css) its default theme. */
function tailwindKind(subpath: string): LoadKind {
  const s = subpath.replace(/\.css$/, "");
  if (s === "" || s === "index") return "tailwindcss";
  return s === "theme" ? "tailwindcss-theme" : "tailwindcss-part";
}

/** What a stylesheet specifier loads, or null for an ordinary file the walk follows. */
export function classify(spec: string, real: string | null): { kind: LoadKind; copied: boolean } | null {
  const pkgKind = (kind: LoadKind | null | undefined) => (kind ? { kind, copied: false } : null);
  const clean = spec.replace(/[?#].*$/, "");
  const parsed = splitSpecifier(clean);
  if (parsed?.name === "tailwindcss") return pkgKind(tailwindKind(parsed.subpath));
  if (parsed?.name === PACKAGE_NAME) return pkgKind(DS_SUBPATHS[parsed.subpath] ?? "ds-other");
  if (parsed?.name === TEXT_MEASURE && parsed.subpath === "fonts.css") return pkgKind("text-measure-fonts");
  if (!real) return null;
  const pkg = owningPackage(real);
  if (pkg?.name === PACKAGE_NAME) return pkgKind(DS_FILES[toPosix(relative(pkg.dir, real))] ?? (CSS_EXT.test(real) ? "ds-other" : null));
  if (pkg?.name === "tailwindcss" && CSS_EXT.test(real)) return pkgKind(tailwindKind(toPosix(relative(pkg.dir, real))));
  if (pkg?.name === TEXT_MEASURE && basename(real) === "fonts.css") return pkgKind("text-measure-fonts");
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
  /** The compilation root of an @import in a <style> block: `<page>#style<n>`. */
  root?: string;
  /** An @import after a rule: ignored unless Tailwind compiles its root and inlines it. */
  late?: boolean;
  /** `@import url(…)`: Tailwind does not inline it, so it stays where it is. */
  urlForm?: boolean;
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["'])([^"'\n]+)\1(?:\s*\))?/g;
const CSS_IMPORT_BARE_URL = /@import\s+url\(\s*([^"')\s]+)\s*\)/g;
const LINK_TAG = /<link\b[^>]*>/gi;
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)<\/style\s*>/gi;
/** Vite query suffixes that return the file as a value (a URL or its text) instead of injecting it. */
const VALUE_QUERY = /[?&](?:url|raw|inline)(?:[&=#]|$)/;
/** Files whose @imports follow the CSS rule: only at the top, before any other rule. Sass and Less have their own. */
const PRELUDE_EXT = /\.(?:css|pcss|postcss)$/i;

/** A tag's attributes, names lower-cased; a bare attribute has the value "". */
function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = tag.replace(/^<[\w-]+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Splits at `sep` outside parentheses. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A media query list; undefined when it is empty or one of its queries is `all` or `screen` (`only screen`): it applies to every view. */
function mediaCondition(list: string): string | undefined {
  const t = list.trim();
  if (!t || splitTop(t, ",").some((q) => /^(?:only\s+)?(?:all|screen)$/i.test(q.trim()))) return undefined;
  return t;
}

/**
 * The condition a stylesheet applies under, from an @import's tail (`layer(x) supports(…) print`).
 * Undefined when it always applies: no supports(…) and a media list that applies to every view.
 */
export function conditionOf(tail: string): string | undefined {
  let t = tail.trim().replace(/;$/, "").trim();
  // Cascade layers and Tailwind v4's import options are not conditions.
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/^(?:(?:layer|source|prefix|theme)(?:\([^)]*\))?|important)(?![\w-])/i, "").trim();
  }
  let supports = "";
  if (/^supports\(/i.test(t)) {
    let depth = 0;
    let i = t.indexOf("(");
    for (; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")" && --depth === 0) break;
    }
    supports = t.slice(0, i + 1);
    t = t.slice(i + 1).trim();
  }
  return [supports, mediaCondition(t)].filter(Boolean).join(" ") || undefined;
}

/**
 * Where a stylesheet's import prelude ends: the offset of its first rule other than `@charset`,
 * `@import` or an `@layer` statement (`@layer a, b;`). Comments must already be blanked.
 */
function preludeEnd(text: string): number {
  const n = text.length;
  let i = 0;
  for (;;) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) return n;
    const m = /^@(?:import|charset|layer)(?![\w-])/i.exec(text.slice(i, i + 9));
    if (!m) return i;
    let j = i + m[0].length;
    let depth = 0;
    while (j < n) {
      const c = text[j];
      if (c === '"' || c === "'") {
        j++;
        while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      } else if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === ";" || c === "{" || c === "}")) break;
      j++;
    }
    if (j >= n) return n;
    if (text[j] !== ";") return i; // a block (`@layer base { … }`) is a rule
    i = j + 1;
  }
}

interface CssRefOptions {
  /** The <style> block's root. */
  root?: string;
  /** The <style> block's media condition, applied to each @import. */
  condition?: string;
  /** Mark @imports after the import prelude as late. */
  prelude?: boolean;
}

function cssRefs(text: string, offset = 0, opts: CssRefOptions = {}): Ref[] {
  const refs: Ref[] = [];
  const end = opts.prelude ? preludeEnd(text) : Infinity;
  // The tail ends at `;`; in markup held in a string (no `;` before </style>), at a tag, a line break or the string's end.
  const add = (spec: string, index: number, match: string) => {
    const own = conditionOf(text.slice(index + match.length, index + match.length + 300).split(/[;<\n`"']/)[0]);
    const ref: Ref = { spec, index: offset + index, as: "css", url: true, condition: [opts.condition, own].filter(Boolean).join(" and ") || undefined };
    if (opts.root) ref.root = opts.root;
    if (index >= end) ref.late = true;
    if (/^@import\s+url\(/i.test(match)) ref.urlForm = true;
    refs.push(ref);
  };
  for (const m of text.matchAll(CSS_IMPORT)) add(m[2], m.index!, m[0]);
  for (const m of text.matchAll(CSS_IMPORT_BARE_URL)) add(m[1], m.index!, m[0]);
  return refs.sort((a, b) => a.index - b.index);
}

/** The async pattern: once the file arrives, onload sets media to one that applies to every view, or rel to stylesheet. */
const ASYNC_MEDIA = /\.media\s*=\s*(["'])\s*(?:(?:only\s+)?(?:all|screen))?\s*\1/i;
const ASYNC_REL = /\.rel\s*=\s*(["'])\s*stylesheet\s*\1/i;

function linkRefs(text: string, offset = 0): Ref[] {
  const refs: Ref[] = [];
  for (const m of text.matchAll(LINK_TAG)) {
    const a = attrsOf(m[0]);
    const rel = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
    const onload = a.get("onload") ?? "";
    const stylesheet = rel.includes("stylesheet") || (rel.includes("preload") && ASYNC_REL.test(onload));
    // An alternate stylesheet applies only when the user picks it; a disabled one never.
    if (!stylesheet || rel.includes("alternate") || a.has("disabled")) continue;
    const href = a.get("href");
    if (!href || href.includes("${")) continue;
    const media = a.get("media");
    const condition = media === undefined || ASYNC_MEDIA.test(onload) ? undefined : mediaCondition(media);
    refs.push({ spec: href, index: offset + m.index!, as: "css", url: true, condition });
  }
  return refs;
}

/** Blanks `<noscript>` and `<template>` elements: nothing in them loads. Keeps offsets and newlines. */
function blankHidden(text: string): string {
  return text.replace(/<(noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (s) => s.replace(/[^\n]/g, " "));
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

/** `file` is set for the entry module when it renders a page: its strings' markup is then read too. */
function jsRefs(src: string, file?: string): Ref[] {
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
  if (file) {
    const markup = blankHidden(src);
    for (const r of linkRefs(markup)) if (inStr[r.index]) refs.push(r);
    const inBlock: Array<[number, number]> = [];
    let n = 0;
    for (const m of markup.matchAll(STYLE_BLOCK)) {
      if (!inStr[m.index!]) continue;
      const start = m.index! + m[1].length;
      inBlock.push([start, start + m[2].length]);
      const media = attrsOf(m[1]).get("media");
      const opts = { root: `${file}#style${++n}`, condition: media === undefined ? undefined : mediaCondition(media) };
      for (const r of cssRefs(m[2], start, opts)) if (inStr[r.index]) refs.push(r);
    }
    for (const r of cssRefs(markup)) {
      if (inStr[r.index] && !inBlock.some(([s, e]) => r.index >= s && r.index < e)) refs.push({ ...r, root: `${file}#inline` });
    }
  }
  return refs.sort((a, b) => a.index - b.index);
}

function htmlRefs(src: string, file: string): Ref[] {
  const text = blankHidden(stripHtml(src));
  const refs: Ref[] = [...linkRefs(text)];
  let n = 0;
  for (const m of text.matchAll(STYLE_BLOCK)) {
    const media = attrsOf(m[1]).get("media");
    const opts = { root: `${file}#style${++n}`, condition: media === undefined ? undefined : mediaCondition(media), prelude: true };
    refs.push(...cssRefs(m[2], m.index! + m[1].length, opts));
  }
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const v = attrsOf(m[1]).get("src");
    if (v) refs.push({ spec: v, index: m.index!, as: "js", url: true });
    else for (const r of jsRefs(m[2])) refs.push({ ...r, index: r.index + m.index! + m[1].length });
  }
  return refs.sort((a, b) => a.index - b.index);
}

function refsOf(file: string, src: string, isEntry: boolean): Ref[] {
  const ext = extname(file).toLowerCase();
  if (CSS_EXT.test(file)) {
    const text = stripCss(src, ext !== ".css");
    return cssRefs(text, 0, { prelude: PRELUDE_EXT.test(file) });
  }
  if (JS_EXT.test(file)) {
    const inlineMarkup = isEntry && (() => {
      const { inStr } = lexJs(src);
      for (const m of src.matchAll(new RegExp(INLINE_DOCUMENT.source, "gi"))) if (inStr[m.index!]) return true;
      return false;
    })();
    return jsRefs(src, inlineMarkup ? file : undefined);
  }
  if (/\.(?:html?|vue|svelte|astro)$/i.test(file)) return htmlRefs(src, file);
  return [];
}

export interface LoadGraphOptions {
  /** The app's web root: where a root-absolute URL (`/src/main.tsx`) points. */
  serveRoot?: string;
}

export function buildLoadGraph(entry: string | null, opts: LoadGraphOptions = {}): LoadGraph {
  const graph: LoadGraph = { entry, entryExists: false, loads: [], inert: [], unresolved: [], files: [] };
  if (!entry) return graph;
  const real = realpathOrNull(entry);
  if (!real) return graph;
  graph.entry = real;
  graph.entryExists = true;
  const visited = new Set<string>();
  const targetOf = (ref: Ref, from: string) => {
    const resolved = resolveSpecifier(ref.spec, from, ref.url === true, opts.serveRoot);
    return resolved ? realpathOrNull(resolved) : null;
  };

  // Tailwind inlines every `@import "…"` of a root's closure, wherever it stands, and compiles the
  // root when that closure imports Tailwind. In such a root only a late `@import url(…)` is ignored.
  const closureCache = new Map<string, boolean>();
  const importsTailwind = (refs: Ref[], from: string, seen: Set<string>): boolean => {
    for (const r of refs) {
      const target = targetOf(r, from);
      const cls = classify(r.spec, target);
      if (cls) {
        if (TAILWIND_KINDS.has(cls.kind)) return true;
      } else if (target && CSS_EXT.test(target) && !target.includes("/node_modules/") && closureImportsTailwind(target, seen)) return true;
    }
    return false;
  };
  const closureImportsTailwind = (file: string, seen = new Set<string>()): boolean => {
    const cached = closureCache.get(file);
    if (cached !== undefined) return cached;
    if (seen.has(file)) return false;
    seen.add(file);
    const src = readText(file);
    const result = src !== null && importsTailwind(refsOf(file, src, false), file, seen);
    closureCache.set(file, result);
    return result;
  };
  const rootCompiled = new Map<string, boolean>();
  /** Tailwind compiles the root: a CSS file root's closure, or a <style> block's @imports, import Tailwind. */
  const tailwindCompiles = (root: string, refs: Ref[], file: string): boolean => {
    let v = rootCompiled.get(root);
    if (v === undefined) {
      const block = refs.filter((r) => r.root === root);
      v = block.length ? importsTailwind(block, file, new Set()) : closureImportsTailwind(root);
      rootCompiled.set(root, v);
    }
    return v;
  };

  /** `root`: the compilation root of a stylesheet; null for a JS module or an HTML page. */
  const visit = (file: string, jsDepth: number, depth: number, inherited: string | undefined, root: string | null) => {
    if (visited.has(file) || depth > MAX_DEPTH) return;
    visited.add(file);
    graph.files.push(file);
    const src = readText(file);
    if (src === null) return;
    const refs = refsOf(file, src, file === real);
    for (const ref of refs) {
      const line = lineAt(src, ref.index);
      const condition = [inherited, ref.condition].filter(Boolean).join(" and ") || undefined;
      const target = targetOf(ref, file);
      const isCss = ref.as === "css" || (target !== null && CSS_EXT.test(target));
      // A stylesheet a JS import or an HTML link reaches starts its own root; an @import stays in its file's.
      const refRoot = root ?? ref.root ?? target ?? `${file}:${line}`;
      const inert = ref.late === true && (ref.urlForm === true || !tailwindCompiles(refRoot, refs, file));
      const cls = isCss ? classify(ref.spec, target) : null;
      if (cls) {
        const load: Load = { kind: cls.kind, spec: ref.spec, from: file, line, path: TAILWIND_KINDS.has(cls.kind) ? null : target, copied: cls.copied, root: refRoot };
        if (condition) load.condition = condition;
        if (inert) {
          graph.inert.push(load);
          continue;
        }
        graph.loads.push(load);
        if (DS_KINDS.has(cls.kind) && !target) graph.unresolved.push({ spec: ref.spec, from: file, line });
        continue;
      }
      if (inert) continue;
      if (!target) {
        if (isCss && !/^(?:https?:)?\/\//i.test(ref.spec)) graph.unresolved.push({ spec: ref.spec, from: file, line });
        continue;
      }
      // Third-party files: recorded only when they are design-system files (above).
      if (target.includes("/node_modules/")) continue;
      if (isCss) visit(target, jsDepth, depth + 1, condition, refRoot);
      else if (JS_EXT.test(target) && (ref.spec.startsWith(".") || ref.spec.startsWith("/")) && jsDepth < JS_DEPTH) {
        visit(target, jsDepth + 1, depth + 1, condition, null);
      }
    }
  };
  visit(real, 0, 0, undefined, CSS_EXT.test(real) ? real : null);
  return graph;
}
