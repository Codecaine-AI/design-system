/**
 * Tailwind default-scale classes (AGENTS.md rule 3): the default palette, text
 * sizes, shadows, radius steps, font weights, line heights, tracking, blur and
 * easing steps. The design system's own utilities that share a root
 * (`text-ui-sm`, `rounded-pill`, `font-medium`, `tracking-normal`, `ease-standard`,
 * `bg-red-soft`) do not match.
 *
 * Where a class can appear:
 * - JS/TS: inside string and template literals only. `ease-in`/`ease-out` in a
 *   string that also holds a CSS time (`"opacity 150ms ease-out"`) is a CSS value,
 *   not a class, and is skipped.
 * - CSS/SCSS: inside `@apply` only.
 * - HTML, Vue, Svelte, Astro, Markdown: in class attributes (`class`, `className`,
 *   `:class`, `class:list`) and in the string literals of `<script>` blocks.
 * Bare `shadow`, `rounded` and `blur` are not flagged: as words they are too common.
 */

import { lexJs, stripCss, stripHtml, type FileKind } from "../../scan-literals";

const PRE = String.raw`(?<![\w\-/\[.$#@])!?`;
const POST = String.raw`(?![\w-])`;

const HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_ROOTS =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|placeholder|" +
  "caret|accent|shadow|inset-shadow|inset-ring|text-shadow|drop-shadow";

const SCALES: Array<{ scale: string; re: RegExp }> = [
  {
    scale: "palette color",
    re: new RegExp(`${PRE}((?:${COLOR_ROOTS})-(?:(?:${HUES})-(?:50|[1-9]00|950)|white|black)(?:/(?:\\d{1,3}|\\[[^\\]\\s]+\\]))?)${POST}`, "g"),
  },
  { scale: "text size", re: new RegExp(`${PRE}(text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:/[\\w.\\[\\]-]+)?)${POST}`, "g") },
  { scale: "shadow", re: new RegExp(`${PRE}((?:inset-shadow|drop-shadow|text-shadow|shadow)-(?:2xs|xs|sm|md|lg|xl|2xl|inner))${POST}`, "g") },
  {
    scale: "radius step",
    re: new RegExp(`${PRE}(rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|ee|es))?-(?:xs|sm|md|lg|xl|2xl|3xl|4xl))${POST}`, "g"),
  },
  { scale: "font weight", re: new RegExp(`${PRE}(font-(?:thin|extralight|light|normal|extrabold|black))${POST}`, "g") },
  { scale: "line height", re: new RegExp(`${PRE}(leading-(?:tight|snug|normal|relaxed|loose))${POST}`, "g") },
  { scale: "tracking", re: new RegExp(`${PRE}(tracking-(?:tighter|tight|wide|wider|widest))${POST}`, "g") },
  { scale: "blur", re: new RegExp(`${PRE}((?:backdrop-)?blur-(?:xs|sm|md|lg|xl|2xl|3xl))${POST}`, "g") },
  { scale: "easing", re: new RegExp(`${PRE}(ease-(?:in-out|in|out))${POST}`, "g") },
];

const CSS_TIME = /(?<![\w.-])\d*\.?\d+m?s(?![\w-])|cubic-bezier/;

export interface TwHit {
  className: string;
  scale: string;
  /** Offset into the source. */
  index: number;
}

function matchAll(text: string, accept: (index: number, scale: string) => boolean, offset = 0): TwHit[] {
  const hits: TwHit[] = [];
  for (const { scale, re } of SCALES) {
    for (const m of text.matchAll(re)) {
      const index = m.index! + (m[0].startsWith("!") ? 1 : 0);
      if (accept(index, scale)) hits.push({ className: m[1], scale, index: offset + index });
    }
  }
  return hits;
}

function inJsStrings(src: string, offset = 0): TwHit[] {
  const { text, inStr } = lexJs(src);
  const stringAround = (i: number) => {
    let a = i;
    let b = i;
    while (a > 0 && inStr[a - 1]) a--;
    while (b < src.length && inStr[b]) b++;
    return src.slice(a, b);
  };
  return matchAll(text, (i, scale) => inStr[i] === 1 && !(scale === "easing" && CSS_TIME.test(stringAround(i))), offset);
}

function inApply(text: string, offset = 0): TwHit[] {
  const hits: TwHit[] = [];
  for (const m of text.matchAll(/@apply\s+([^;{}]+)/g)) {
    const start = m.index! + m[0].length - m[1].length;
    hits.push(...matchAll(m[1], () => true, offset + start));
  }
  return hits;
}

const CLASS_ATTR = /(?<![\w-])(?::class|v-bind:class|class:list|className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])([^"'`]*)\3\s*\})/g;

/** Tailwind default-scale classes in one file, sorted by position. */
export function findDefaultScaleClasses(src: string, kind: FileKind): TwHit[] {
  let hits: TwHit[] = [];
  if (kind === "js") hits = inJsStrings(src);
  else if (kind === "css" || kind === "scss") hits = inApply(stripCss(src, kind === "scss"));
  else if (kind === "html") {
    const text = stripHtml(src);
    for (const m of text.matchAll(CLASS_ATTR)) {
      const value = m[1] ?? m[2] ?? m[4] ?? "";
      const start = m.index! + m[0].indexOf(value, m[0].indexOf("="));
      hits.push(...matchAll(value, () => true, start));
    }
    for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) hits.push(...inJsStrings(m[2], m.index! + m[1].length));
    for (const m of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) hits.push(...inApply(m[2], m.index! + m[1].length));
  }
  return hits.sort((a, b) => a.index - b.index);
}
