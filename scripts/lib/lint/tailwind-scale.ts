/**
 * Tailwind default-scale classes (AGENTS.md rule 3): the default palette, text
 * sizes, shadows, radius steps, font weights, line heights, tracking, blur, easing,
 * container sizes and animations. The design system's own utilities that share a
 * root (`text-ui-sm`, `rounded-pill`, `font-medium`, `tracking-normal`,
 * `ease-standard`, `bg-red-soft`, `max-w-lane-text`, `shadow-glass`) do not match.
 *
 * Where a class can appear:
 * - JS/TS: inside string and template literals. `ease-in`/`ease-out` in a string that
 *   also holds a CSS time (`"opacity 150ms ease-out"`) is a CSS value, not a class.
 * - CSS/SCSS: inside `@apply` only.
 * - HTML, Vue, Svelte, Astro, Markdown: in class attributes (`class`, `className`,
 *   `:class`, `class:list`) and in the string literals of `<script>` blocks.
 * The bare `shadow`, `inset-shadow`, `drop-shadow`, `blur` and `backdrop-blur` and the
 * numeric `leading-<n>` are common words or values, so they count only in class
 * contexts (class-context.ts). Bare `rounded` stays allowed: tailwind.css points
 * `--radius` at the design system's radius.
 *
 * Container sizes (`max-w-2xl`, `w-md`) and the default animations (`animate-spin`)
 * are on the list because tailwind-strict.css does not clear them: Tailwind compiles
 * them to its own values (42rem, `spin 1s linear infinite`), never to a token.
 */

import { lexJs, stripCss, stripHtml, type FileKind } from "../../scan-literals";
import { classContexts, HTML_CLASS_ATTR, type ClassContexts } from "./class-context";

const PRE = String.raw`(?<![\w\-/\[.$#@])!?`;
const POST = String.raw`(?![\w-])`;

const HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_ROOTS =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|placeholder|" +
  "caret|accent|shadow|inset-shadow|inset-ring|text-shadow|drop-shadow";
const CONTAINER_STEPS = "3xs|2xs|xs|sm|md|lg|xl|[2-7]xl";

interface Scale {
  scale: string;
  re: RegExp;
  /** Counts only in a class context (a common word or CSS value otherwise). */
  classOnly?: true;
}

const SCALES: Scale[] = [
  {
    scale: "palette color",
    re: new RegExp(`${PRE}((?:${COLOR_ROOTS})-(?:(?:${HUES})-(?:50|[1-9]00|950)|white|black)(?:/(?:\\d{1,3}|\\[[^\\]\\s]+\\]))?)${POST}`, "g"),
  },
  { scale: "text size", re: new RegExp(`${PRE}(text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:/[\\w.\\[\\]-]+)?)${POST}`, "g") },
  { scale: "shadow", re: new RegExp(`${PRE}((?:inset-shadow|drop-shadow|text-shadow|shadow)-(?:2xs|xs|sm|md|lg|xl|2xl|inner))${POST}`, "g") },
  { scale: "shadow", re: new RegExp(`${PRE}(inset-shadow|drop-shadow|shadow)${POST}`, "g"), classOnly: true },
  {
    scale: "radius step",
    re: new RegExp(`${PRE}(rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|ee|es))?-(?:xs|sm|md|lg|xl|2xl|3xl|4xl))${POST}`, "g"),
  },
  { scale: "font weight", re: new RegExp(`${PRE}(font-(?:thin|extralight|light|normal|extrabold|black))${POST}`, "g") },
  { scale: "line height", re: new RegExp(`${PRE}(leading-(?:tight|snug|normal|relaxed|loose))${POST}`, "g") },
  { scale: "line height", re: new RegExp(`${PRE}(leading-\\d+(?:\\.\\d+)?)${POST}`, "g"), classOnly: true },
  { scale: "tracking", re: new RegExp(`${PRE}(tracking-(?:tighter|tight|wide|wider|widest))${POST}`, "g") },
  { scale: "blur", re: new RegExp(`${PRE}((?:backdrop-)?blur-(?:xs|sm|md|lg|xl|2xl|3xl))${POST}`, "g") },
  { scale: "blur", re: new RegExp(`${PRE}((?:backdrop-)?blur)${POST}`, "g"), classOnly: true },
  { scale: "easing", re: new RegExp(`${PRE}(ease-(?:in-out|in|out))${POST}`, "g") },
  { scale: "container size", re: new RegExp(`${PRE}((?:max-w|min-w|w|basis)-(?:${CONTAINER_STEPS}))${POST}`, "g") },
  { scale: "animation", re: new RegExp(`${PRE}(animate-(?:spin|ping|pulse|bounce))${POST}`, "g") },
];

const CSS_TIME = /(?<![\w.-])\d*\.?\d+m?s(?![\w-])|cubic-bezier/;

export interface TwHit {
  className: string;
  scale: string;
  /** Offset into the source. */
  index: number;
}

/** Hits in `text`; `accept` sees the offset into `text`, `offset` maps it to the source. */
function matchAll(text: string, accept: (index: number, s: Scale) => boolean, offset = 0): TwHit[] {
  const hits: TwHit[] = [];
  for (const s of SCALES) {
    for (const m of text.matchAll(s.re)) {
      const index = m.index! + (m[0].startsWith("!") ? 1 : 0);
      if (accept(index, s)) hits.push({ className: m[1], scale: s.scale, index: offset + index });
    }
  }
  return hits;
}

/** JS/TS source (or a `<script>` body at `offset` in `ctx`'s file): string literals, bare forms in class contexts only. */
function inJsStrings(src: string, ctx: ClassContexts, offset = 0): TwHit[] {
  const { text, inStr } = lexJs(src);
  const stringAround = (i: number) => {
    let a = i;
    let b = i;
    while (a > 0 && inStr[a - 1]) a--;
    while (b < src.length && inStr[b]) b++;
    return src.slice(a, b);
  };
  return matchAll(
    text,
    (i, s) => inStr[i] === 1 && (!s.classOnly || ctx.has(offset + i)) && !(s.scale === "easing" && CSS_TIME.test(stringAround(i))),
    offset,
  );
}

function inApply(text: string, offset = 0): TwHit[] {
  const hits: TwHit[] = [];
  for (const m of text.matchAll(/@apply\s+([^;{}]+)/g)) {
    const start = m.index! + m[0].length - m[1].length;
    hits.push(...matchAll(m[1], () => true, offset + start));
  }
  return hits;
}

/** Tailwind default-scale classes in one file, sorted by position. */
export function findDefaultScaleClasses(src: string, kind: FileKind): TwHit[] {
  let hits: TwHit[] = [];
  if (kind === "js") hits = inJsStrings(src, classContexts(src, kind));
  else if (kind === "css" || kind === "scss") hits = inApply(stripCss(src, kind === "scss"));
  else if (kind === "html") {
    const ctx = classContexts(src, kind);
    const text = stripHtml(src);
    for (const m of text.matchAll(HTML_CLASS_ATTR)) {
      const value = m[1] ?? m[2] ?? m[4] ?? "";
      const start = m.index! + m[0].indexOf(value, m[0].indexOf("="));
      hits.push(...matchAll(value, () => true, start));
    }
    for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) hits.push(...inJsStrings(m[2], ctx, m.index! + m[1].length));
    for (const m of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) hits.push(...inApply(m[2], m.index! + m[1].length));
  }
  return hits.sort((a, b) => a.index - b.index);
}
