/**
 * Class contexts: the places in a source where a word reaches the DOM as a CSS class,
 * as opposed to any string that happens to hold it (`"shadow"` as a prop value, a
 * dead constant listing ds-* names).
 *
 * - JS/TS: the string characters of
 *   - `className=` / `class=` attribute values, and props that pass a class on
 *     (`sidebarClassName=`): a string, or every string in the `{…}` expression;
 *   - `className:` / `class:` property values (`createElement("div", { className: … })`);
 *   - the arguments of clsx, cn, classNames, cx, twMerge, twJoin, cva and tv calls;
 *   - `classList.add/toggle/replace(…)`, `setAttribute("class", …)` and `.className = …`;
 *   - `class="…"` / `className="…"` written inside a string or template literal (markup built as text).
 * - HTML, Vue, Svelte, Astro, Markdown: class attribute values (`class`, `className`,
 *   `:class`, `v-bind:class`, `class:list`; a quoted value or a `{…}` expression), plus
 *   the JS rules inside `<script>` blocks.
 * - CSS/SCSS: the arguments of `@apply`.
 */

import { lexJs, stripCss, stripHtml, type FileKind } from "../../scan-literals";

/** A half-open source span [start, end). */
export type Span = [number, number];

/** A source's class contexts, sorted and non-overlapping. */
export class ClassContexts {
  private readonly starts: number[];
  private readonly ends: number[];

  constructor(spans: Span[]) {
    const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const merged: Span[] = [];
    for (const s of sorted) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    this.starts = merged.map((s) => s[0]);
    this.ends = merged.map((s) => s[1]);
  }

  /** True when the character at `index` sits in a class context. */
  has(index: number): boolean {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] > index) hi = mid - 1;
      else if (this.ends[mid] <= index) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

const MAX_SPAN = 20_000;

/** Index of the bracket that closes the one at `open`, counting code characters only; -1 when none. */
function closeOf(text: string, inStr: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length && i < open + MAX_SPAN; i++) {
    if (inStr[i]) continue;
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Characters that leave an expression open across a line break, before or after it. */
const CONTINUES = /[?:+\-*/%&|^!~<>=.,(\[{]/;

/**
 * End of an assigned expression: `;` or `,` at bracket depth 0, an unmatched closing bracket,
 * or a line break at depth 0 that the expression does not continue across (an operator ends
 * the line before it, or starts the line after it: `sel\n  ? "a"\n  : "b"`).
 */
function expressionEnd(text: string, inStr: Uint8Array, from: number): number {
  let depth = 0;
  let last = ""; // previous significant code character
  for (let i = from; i < text.length && i < from + MAX_SPAN; i++) {
    if (inStr[i]) {
      last = "s";
      continue;
    }
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (--depth < 0) return i;
    } else if (depth === 0 && (ch === ";" || ch === ",")) return i;
    else if (depth === 0 && ch === "\n") {
      if (last === "" || CONTINUES.test(last)) continue;
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && !inStr[j] && CONTINUES.test(text[j]) && text[j] !== "," && text[j] !== "(" && text[j] !== "[" && text[j] !== "{") continue;
      return i;
    }
    if (!/\s/.test(ch)) last = ch;
  }
  return Math.min(text.length, from + MAX_SPAN);
}

/** The runs of string characters inside [start, end). */
function stringRuns(inStr: Uint8Array, start: number, end: number, out: Span[]): void {
  let i = start;
  while (i < end) {
    if (!inStr[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < end && inStr[j]) j++;
    out.push([i, j]);
    i = j;
  }
}

/** `className`, `class`, and component props that pass one on (`sidebarClassName`, `overlayClassName`). */
const CLASS_PROP = String.raw`(?:[A-Za-z]\w*ClassName|className|class)`;
const JSX_CLASS_ATTR = new RegExp(String.raw`(?<![\w$.:-])${CLASS_PROP}\s*=\s*`, "g");
const CLASS_CALL = /(?<![\w$.])(?:clsx|cn|classNames|classnames|cx|twMerge|twJoin|cva|tv)\s*\(/g;
const CLASS_LIST_CALL = /\.\s*classList\s*\.\s*(?:add|toggle|replace)\s*\(/g;
const SET_CLASS_ATTR = /\.\s*setAttribute\s*\(\s*(["'])class\1\s*,/g;
const CLASS_NAME_ASSIGN = /\.\s*className\s*(?:\+=|=(?!=))/g;
const CLASS_KEY = new RegExp(String.raw`(?<![\w$.:-])(?:${CLASS_PROP}|(["'])class(?:Name)?\1)\s*:(?!:)\s*`, "g");
const MARKUP_CLASS_ATTR = /(?<![\w$.:-])(?:className|class)\s*=\s*(\\?["'])/g;

/** Class-context spans of a JS/TS source. */
export function jsClassSpans(src: string, lexed: { text: string; inStr: Uint8Array } = lexJs(src), offset = 0): Span[] {
  const { text, inStr } = lexed;
  const spans: Span[] = [];
  const code = (i: number) => !inStr[i];

  for (const m of text.matchAll(JSX_CLASS_ATTR)) {
    if (!code(m.index!)) continue;
    const v = m.index! + m[0].length;
    const ch = text[v];
    if (ch === '"' || ch === "'") {
      let end = v + 1;
      while (end < text.length && inStr[end]) end++;
      spans.push([v + 1, end]);
    } else if (ch === "{") {
      const end = closeOf(text, inStr, v);
      if (end !== -1) stringRuns(inStr, v, end, spans);
    }
  }
  for (const re of [CLASS_CALL, CLASS_LIST_CALL, SET_CLASS_ATTR]) {
    for (const m of text.matchAll(re)) {
      if (!code(m.index!)) continue;
      const open = re === SET_CLASS_ATTR ? text.lastIndexOf("(", m.index! + m[0].length) : m.index! + m[0].length - 1;
      const end = closeOf(text, inStr, open);
      if (end !== -1) stringRuns(inStr, re === SET_CLASS_ATTR ? m.index! + m[0].length : open, end, spans);
    }
  }
  for (const re of [CLASS_NAME_ASSIGN, CLASS_KEY]) for (const m of text.matchAll(re)) {
    if (!code(m.index!)) continue;
    const from = m.index! + m[0].length;
    stringRuns(inStr, from, expressionEnd(text, inStr, from), spans);
  }
  // Markup written as text: the attribute sits inside a string; its value ends at the
  // same quote, back in that string (quotes of a `${…}` expression's own strings are code).
  for (const m of src.matchAll(MARKUP_CLASS_ATTR)) {
    if (!inStr[m.index!]) continue;
    const quote = m[1];
    const start = m.index! + m[0].length;
    let end = start;
    for (; end < src.length && end < start + MAX_SPAN; end++) {
      if (!inStr[end]) continue;
      if (src.startsWith(quote, end) && (quote.length === 2 || src[end - 1] !== "\\")) break;
    }
    stringRuns(inStr, start, end, spans);
  }
  return offset ? spans.map(([a, b]) => [a + offset, b + offset]) : spans;
}

const HTML_CLASS_ATTR = /(?<![\w-])(?::class|v-bind:class|class:list|className|class)\s*=\s*(?=["'{])/g;

/**
 * Value spans of the class attributes in HTML-like markup (comments blanked): a quoted value,
 * or a `{…}` expression (Svelte, Astro, JSX-style) up to its matching brace.
 */
export function htmlClassAttrSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(HTML_CLASS_ATTR)) {
    const v = m.index! + m[0].length;
    const q = text[v];
    if (q === '"' || q === "'") {
      const end = text.indexOf(q, v + 1);
      if (end !== -1) spans.push([v + 1, end]);
      continue;
    }
    let depth = 0;
    let quote = "";
    for (let i = v; i < text.length && i < v + MAX_SPAN; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        spans.push([v + 1, i]);
        break;
      }
    }
  }
  return spans;
}

/** Class contexts of one file. */
export function classContexts(src: string, kind: FileKind): ClassContexts {
  const spans: Span[] = [];
  if (kind === "js") spans.push(...jsClassSpans(src));
  else if (kind === "css" || kind === "scss") {
    const text = stripCss(src, kind === "scss");
    for (const m of text.matchAll(/@apply\s+([^;{}]+)/g)) {
      const start = m.index! + m[0].length - m[1].length;
      spans.push([start, start + m[1].length]);
    }
  } else if (kind === "html") {
    const text = stripHtml(src);
    spans.push(...htmlClassAttrSpans(text));
    for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
      spans.push(...jsClassSpans(m[2], lexJs(m[2]), m.index! + m[1].length));
    }
    for (const m of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
      const body = m[2];
      const base = m.index! + m[1].length;
      for (const a of body.matchAll(/@apply\s+([^;{}]+)/g)) {
        const start = base + a.index! + a[0].length - a[1].length;
        spans.push([start, start + a[1].length]);
      }
    }
  }
  return new ClassContexts(spans);
}
