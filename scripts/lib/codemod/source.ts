/**
 * One scanned source file, prepared the way scan-literals reads it: comments blanked (lengths and
 * newlines kept, so offsets match the original), string positions marked for JS, and <style>
 * ranges for HTML. The locator and the context reader both work on this.
 */

import { lexJs, stripCss, stripHtml, type FileKind } from "../../scan-literals.ts";

export interface SourceFile {
  /** Root-relative path with forward slashes. */
  rel: string;
  kind: FileKind;
  src: string;
  /** Comment-blanked text, same length as src. */
  text: string;
  /** JS only: 1 where the character sits inside a string or template literal. */
  inStr: Uint8Array | null;
  starts: number[];
  /** [start, end) of each region that reads as CSS: HTML <style> bodies, JS template literals holding CSS rules. */
  styles: Array<[number, number]>;
}

const KIND_BY_EXT: Record<string, FileKind> = {
  css: "css", uss: "css", scss: "scss", sass: "scss", less: "scss",
  ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js",
  html: "html", htm: "html", vue: "html", svelte: "html", astro: "html", md: "html", mdx: "html",
  json: "json", jsonc: "json",
};

export function kindOf(path: string): FileKind | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return KIND_BY_EXT[ext] ?? null;
}

export function prepareSource(rel: string, src: string, kind: FileKind): SourceFile {
  let text = src;
  let inStr: Uint8Array | null = null;
  if (kind === "js") ({ text, inStr } = lexJs(src));
  else if (kind === "html") text = stripHtml(src);
  else if (kind === "css" || kind === "scss") text = stripCss(src, kind === "scss");
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  const styles: Array<[number, number]> = [];
  if (kind === "html") {
    for (const m of src.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
      const start = m.index! + m[1].length;
      styles.push([start, start + m[2].length]);
    }
  }
  if (inStr) styles.push(...cssTemplates(src, inStr));
  return { rel, kind, src, text, inStr, starts, styles };
}

/** A selector, a brace and a declaration: `.dark .panel { background: #151b23; }`. */
const CSS_RULE = /[^{};]+\{[^{}]*?[-\w]+\s*:[^{}]*\}/;

/** JS template literals (from the opening to the closing backtick) whose text holds a CSS rule. */
function cssTemplates(src: string, inStr: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i < src.length; i++) {
    const runStart = inStr[i] === 1 && (i === 0 || inStr[i - 1] === 0);
    const runEnd = inStr[i] === 1 && (i + 1 === src.length || inStr[i + 1] === 0);
    if (runStart && open === -1 && src[i - 1] === "`") open = i;
    if (runEnd && open !== -1 && src[i + 1] === "`") {
      if (CSS_RULE.test(src.slice(open, i + 1))) out.push([open, i + 1]);
      open = -1;
    }
  }
  return out;
}

/** [start, end) offsets of a 1-based line, without its newline. */
export function lineRange(f: SourceFile, line: number): [number, number] {
  const start = f.starts[line - 1] ?? f.src.length;
  const next = f.starts[line];
  return [start, next === undefined ? f.src.length : next - 1];
}

export function lineOf(f: SourceFile, index: number): number {
  let lo = 0;
  let hi = f.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f.starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The CSS region (an HTML <style> body or a JS CSS template) holding `index`, or null. */
export function cssRegionAt(f: SourceFile, index: number): [number, number] | null {
  return f.styles.find(([a, b]) => index >= a && index < b) ?? null;
}

/** True when `index` reads as CSS: a CSS file, an HTML <style> body, or CSS inside a JS template. */
export function isCssAt(f: SourceFile, index: number): boolean {
  return f.kind === "css" || f.kind === "scss" || cssRegionAt(f, index) !== null;
}
