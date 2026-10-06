/**
 * One scanned source file, prepared the way scan-literals reads it: comments blanked (lengths and
 * newlines kept, so offsets match the original; in JS also the CSS comments inside CSS template
 * literals), string positions marked for JS, and <style> ranges for HTML. The locator and the context reader both work on this.
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
  /**
   * [start, end) of each region that reads as CSS: HTML <style> bodies (outside comments and
   * Markdown code), JS template literals holding CSS rules, and the <style> bodies and style="…"
   * values of HTML held in a JS template.
   */
  styles: Array<[number, number]>;
  /** Markup only: [start, end) of each <script> block body. */
  scripts: Array<[number, number]>;
  /** Markdown only: [start, end) of fenced, indented and inline code. */
  code: Array<[number, number]>;
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
  const scripts: Array<[number, number]> = [];
  const code = kind === "html" && /\.mdx?$/i.test(rel) ? markdownCode(src) : [];
  if (kind === "html") {
    // Found in the comment-blanked text with Markdown code blanked too: a `<style>` in a comment or
    // in backticks opens nothing.
    let plain = text;
    for (const [a, b] of code) plain = plain.slice(0, a) + plain.slice(a, b).replace(/[^\n]/g, " ") + plain.slice(b);
    for (const m of plain.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
      const start = m.index! + m[1].length;
      styles.push([start, start + m[2].length]);
    }
    for (const m of plain.matchAll(/(<script\b[^>]*>)([\s\S]*?)(?:<\/script>|$)/gi)) {
      const start = m.index! + m[1].length;
      scripts.push([start, start + m[2].length]);
    }
  }
  if (inStr) {
    styles.push(...cssTemplates(src, inStr));
    // A CSS comment inside a template is string text to the JS lexer: blank it too, so its words
    // never become role hints and its colors are never edited.
    text = blankCssComments(text, styles);
  }
  return { rel, kind, src, text, inStr, starts, styles, scripts, code };
}

/**
 * Markdown code: fenced blocks (``` or ~~~ at any indent, so fences inside list items count),
 * indented blocks (4 spaces or a tab after a blank line), and inline code spans.
 */
export function markdownCode(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let fence: { at: number; mark: string } | null = null;
  let indented = false;
  let prevBlank = true;
  let at = 0;
  for (const line of src.split("\n")) {
    const end = at + line.length;
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence.mark[0] && m[1].length >= fence.mark.length && /^\s*[`~]+\s*$/.test(line)) {
        out.push([fence.at, end]);
        fence = null;
      }
    } else if (m) fence = { at, mark: m[1] };
    else if (/^(?: {4}|\t)/.test(line) && line.trim() && (prevBlank || indented)) {
      out.push([at, end]);
      indented = true;
    } else {
      if (line.trim()) indented = false;
      for (const c of line.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) out.push([at + c.index!, at + c.index! + c[0].length]);
    }
    prevBlank = !line.trim();
    at = end + 1;
  }
  if (fence) out.push([fence.at, src.length]);
  return out;
}

/** CSS comments inside each region blanked the way scan-literals strips a stylesheet (strings and url() kept). */
function blankCssComments(text: string, regions: Array<[number, number]>): string {
  let out = text;
  for (const [a, b] of regions) out = out.slice(0, a) + stripCss(out.slice(a, b), false) + out.slice(b);
  return out;
}

/** Words that make a block's prelude JS, not a selector. */
const JS_PRELUDE = /\b(?:const|let|var|function|return|import|export|if|else|for|while|switch|new|typeof|class|interface|type|async|await)\b/;

/**
 * Whether text holds a CSS rule: a selector (no JS keyword, no `=` outside brackets, no `=>`, no
 * call `name(…)`), a brace, and declarations (`prop: value`, not a JS object's `key: "v", key2: …`).
 */
export function holdsCssRule(text: string): boolean {
  for (const m of text.matchAll(/([^{};]*)\{([^{}]*)\}/g)) {
    const selector = m[1].replace(/\[[^\]]*\]/g, "[]").trim();
    const body = m[2];
    if (!selector || JS_PRELUDE.test(selector) || /=>|=/.test(selector) || /(?:^|[^:\w-])[\w$]+\s*\([^)]*\)\s*$/.test(selector)) continue;
    if (!/(?:^|[;\s])(?:--[\w-]+|-?[a-z][a-z0-9-]*)\s*:\s*[^;]/.test(body)) continue;
    // A JS object: comma-separated keys, or quoted values only, and no `;`.
    if (!body.includes(";") && (/,\s*["']?[A-Za-z_$][\w$-]*["']?\s*:/.test(body) || /:\s*["'`][^"'`]*["'`]\s*,?\s*$/.test(body.trim()))) continue;
    return true;
  }
  return false;
}

/**
 * JS template literals that read as CSS. A template holding CSS rules is CSS from its opening to its
 * closing backtick; a template holding HTML is CSS only in its <style> bodies and style="…" values.
 */
function cssTemplates(src: string, inStr: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i < src.length; i++) {
    const runStart = inStr[i] === 1 && (i === 0 || inStr[i - 1] === 0);
    const runEnd = inStr[i] === 1 && (i + 1 === src.length || inStr[i + 1] === 0);
    if (runStart && open === -1 && src[i - 1] === "`") open = i;
    if (runEnd && open !== -1 && src[i + 1] === "`") {
      // ${...} interpolations (outside the string) read as a plain word, so their braces do not count.
      let body = "";
      for (let k = open; k <= i; k++) body += inStr[k] === 1 ? src[k] : "x";
      // An SVG document in a string (a data-URL cursor, a static render) is an image: var() never reaches it.
      if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(body)) {
        open = -1;
        continue;
      }
      if (/<\/?[a-z][\w-]*[\s>/]/i.test(body)) {
        for (const m of body.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
          const start = open + m.index! + m[1].length;
          out.push([start, start + m[2].length]);
        }
        for (const m of body.matchAll(/\sstyle\s*=\s*(["'])([^"']*)\1/gi)) {
          const start = open + m.index! + m[0].length - m[2].length - 1;
          out.push([start, start + m[2].length]);
        }
      } else if (holdsCssRule(body)) out.push([open, i + 1]);
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
