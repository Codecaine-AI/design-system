/**
 * Finds the exact source text of a scan-literals hit on its line. scan-literals reports a
 * normalized value (`#fff` -> `#ffffff`, a whole radius declaration value, a first font family);
 * the codemod needs the characters to replace and what kind of slot they sit in.
 */

import type { Hit } from "../../scan-literals.ts";
import { parseColor } from "./color.ts";
import { isCanvasValue } from "./slot.ts";
import { isCssAt, lineRange, type SourceFile } from "./source.ts";

/**
 * How a literal sits in the source, which decides the replacement form.
 * - text: inside CSS or inside a longer string: write `var(--ds-...)`
 * - wholeString: the literal is a whole JS string, quotes included: `"var(--ds-...)"` or `cssVar(...)`
 * - number: a bare JS number (`fontSize: 13`): `"var(--ds-...)"` or `cssVar(...)`
 * - attrBrace: a JSX attribute number (`fontSize={12}`): `"var(--ds-...)"`
 * - class: a Tailwind class: the design-system utility
 * - canvas: canvas 2D (`ctx.fillStyle`, `ctx.font`): var() does not resolve there
 */
export type Slot = "text" | "wholeString" | "number" | "attrBrace" | "class" | "canvas";

export interface Span {
  start: number;
  end: number;
  slot: Slot;
}

const HEX = /(?<![&\w$\\/])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN =
  /(?<![\w-])(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi;
const COLOR_CATEGORY = new Set(["hex", "rgb", "hsl", "oklch", "otherColorFn", "namedColor"]);
/** scan-literals' VAR_GROUP: a var() with up to two levels of nested parentheses. */
const VAR_GROUP = /var\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gi;
/** scan-literals blanks @font-face blocks before reading declarations (outside JS). */
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi;
const fontFaces = new WeakMap<SourceFile, Array<[number, number]>>();

function fontFaceRanges(f: SourceFile): Array<[number, number]> {
  let r = fontFaces.get(f);
  if (!r) {
    r = f.kind === "js" || f.kind === "json" ? [] : [...f.text.matchAll(FONT_FACE)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
    fontFaces.set(f, r);
  }
  return r;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function normalizeHex(h: string): string {
  const s = h.toLowerCase();
  if (s.length === 4 || s.length === 5) return "#" + s.slice(1).split("").map((ch) => ch + ch).join("");
  return s;
}

/**
 * Property groups whose declaration value carries the literal, per scan-literals category. A custom
 * property's definition carries one too (`--radius: 8px`, `--mono: "SFMono-Regular", monospace`):
 * scan-literals counts it like the declaration that reads it.
 */
const DECL_NAMES: Record<string, RegExp> = {
  radius: /^(?:border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|border(?:Top|Bottom|Start|End)?(?:Left|Right|Start|End)?Radius|--[\w-]+)$/,
  fontFamily: /^(?:font-family|fontFamily|-unity-font(?:-definition)?|font|--[\w-]+)$/,
  fontSize: /^(?:font-size|fontSize|font|--[\w-]+)$/,
  spacing: /^(?:padding|margin|gap|row-gap|column-gap|rowGap|columnGap|(?:padding|margin)(?:-[a-z-]+|[A-Z]\w*)|--[\w-]+)$/,
};

const PROP_RE = /(?<![\w$-])(['"]?)([-\w]+)\1\s*:(?!:)/g;
const ATTR_RE = /(?<![\w$.-])(fontSize|font-size|fontFamily|font-family)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(-?\d+(?:\.\d+)?)\s*\}|\{\s*["'`]([^"'`]*)["'`]\s*\})/g;

interface Decl {
  name: string;
  /** Value span in the file and how it is written. */
  start: number;
  end: number;
  vkind: "css" | "quoted" | "expr" | "attr" | "attrBrace" | "canvas";
}

/** Declarations (CSS, JS objects, JSX/HTML attributes, canvas fonts) that start on one line. */
function declsOnLine(f: SourceFile, line: number): Decl[] {
  const [ls, le] = lineRange(f, line);
  const t = f.text;
  const out: Decl[] = [];
  const lineText = t.slice(ls, le);
  const faces = fontFaceRanges(f);
  for (const m of lineText.matchAll(PROP_RE)) {
    const colon = ls + m.index! + m[0].length;
    // A descriptor inside @font-face (`font-family: "Inter"`) names the face: not a style.
    if (faces.some(([a, b]) => colon > a && colon < b)) continue;
    let i = colon;
    while (i < le && (t[i] === " " || t[i] === "\t")) i++;
    const inJsString = f.inStr !== null && f.inStr[colon - 1] === 1;
    const css = isCssAt(f, colon);
    if (css || inJsString || f.kind === "html") {
      // CSS value: up to ; { } or the end of the line, the end of the JS string, or the end of an
      // HTML style="" attribute.
      if (css && isSelector(t, colon)) continue;
      const stop = css ? ";{}" : inJsString ? ";{}" : ";{}\"'<>";
      let k = i;
      while (k < le && !stop.includes(t[k]) && !(inJsString && f.inStr![k] === 0)) k++;
      out.push({ name: m[2], ...trimmed(t, i, k), vkind: "css" });
    } else if ("'\"`".includes(t[i])) {
      const q = t[i];
      let k = i + 1;
      while (k < le && t[k] !== q) k += t[k] === "\\" ? 2 : 1;
      out.push({ name: m[2], start: i + 1, end: Math.min(k, le), vkind: "quoted" });
    } else {
      let k = i;
      let depth = 0;
      while (k < le) {
        const ch = t[k];
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") {
          if (depth === 0) break;
          depth--;
        } else if ((ch === "," || ch === "}" || ch === ";") && depth === 0) break;
        k++;
      }
      out.push({ name: m[2], ...trimmed(t, i, k), vkind: "expr" });
    }
  }
  if (f.kind === "js" || f.kind === "html") {
    for (const m of lineText.matchAll(ATTR_RE)) {
      const at = ls + m.index!;
      const body = m[0];
      const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
      const offset = body.lastIndexOf(value);
      out.push({ name: m[1], start: at + offset, end: at + offset + value.length, vkind: m[4] !== undefined ? "attrBrace" : "attr" });
    }
    for (const m of lineText.matchAll(/\.font\s*=\s*(['"`])([^'"`\n]*)\1/g)) {
      const start = ls + m.index! + m[0].indexOf(m[1]) + 1;
      out.push({ name: "font", start, end: start + m[2].length, vkind: "canvas" });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function trimmed(t: string, a: number, b: number): { start: number; end: number } {
  let s = a;
  let e = b;
  while (s < e && /\s/.test(t[s])) s++;
  while (e > s && /\s/.test(t[e - 1])) e--;
  const imp = t.slice(s, e).match(/\s*!important$/i);
  if (imp) e -= imp[0].length;
  return { start: s, end: e };
}

/** In CSS, `a:hover {` is a selector, not a declaration. */
function isSelector(t: string, from: number): boolean {
  for (let k = from; k < t.length; k++) {
    if (t[k] === "{") return true;
    if (t[k] === ";" || t[k] === "}") return false;
  }
  return false;
}

function firstFamily(value: string): string {
  const first = value.split(",")[0].trim().replace(/^\\?['"]|\\?['"]$/g, "").trim();
  return first.toLowerCase().replace(/\s+/g, " ");
}

/** Color properties whose values scan-literals reads named colors from (its PROP_KIND color list). */
const COLOR_PROPS =
  /^(?:color|background(?:-color)?|backgroundColor|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Color)?|outline(?:-color)?|outlineColor|fill|stroke|caret-color|caretColor|accent-color|accentColor|text-decoration-color|textDecorationColor|stop-color|stopColor|box-shadow|boxShadow|text-shadow|textShadow|column-rule-color|shadowColor|flood-color|floodColor|-unity-background-image-tint-color|-unity-text-outline-color)$/;
/** Color attributes scan-literals reads named colors from. */
const COLOR_ATTR_RE = /(?<![\w$.-])(fill|stroke|stop-color|stopColor|bgcolor)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])([^"'`]*)\4\s*\})/g;

/**
 * Character ranges scan-literals never reads colors from on this line: the Tailwind arbitrary
 * classes it reported (it blanks every one before matching colors, so `bg-[#fff]` is a class hit,
 * not a hex hit).
 */
function tailwindMasks(f: SourceFile, lineHits: readonly Hit[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const h of lineHits) {
    if (h.category !== "twArbitrary" && h.category !== "twArbitraryVar") continue;
    if (seen.has(h.value)) continue;
    seen.add(h.value);
    for (const s of candidates(f, h, [])) out.push([s.start, s.end]);
  }
  return out;
}

const masked = (masks: Array<[number, number]>, a: number, b: number) => masks.some(([x, y]) => a < y && b > x);

/** Every candidate span for a hit on its line, in source order. `lineHits` are all hits on the line. */
function candidates(f: SourceFile, hit: Hit, lineHits: readonly Hit[]): Span[] {
  const [ls, le] = lineRange(f, hit.line);
  const lineText = f.text.slice(ls, le);
  const spans: Span[] = [];
  const add = (start: number, end: number) => spans.push({ start, end, slot: "text" });
  const cssFile = f.kind === "css" || f.kind === "scss";
  const masks = COLOR_CATEGORY.has(hit.category) ? tailwindMasks(f, lineHits) : [];
  switch (hit.category) {
    case "hex":
      for (const m of lineText.matchAll(HEX)) {
        const i = ls + m.index!;
        const j = i + m[0].length;
        if (f.inStr && !f.inStr[i + 1]) continue;
        if (masked(masks, i, j)) continue;
        // The places scan-literals skips: an ID selector in CSS, a link target or url() elsewhere.
        if ((cssFile || isCssAt(f, i)) && isSelector(f.text, j)) continue;
        if (!cssFile && (/(?:href|to|id|for|xlink:href)\s*=\s*\{?\s*["'`]$/.test(f.text.slice(Math.max(0, i - 24), i)) || /url\(\s*['"]?$/.test(f.text.slice(Math.max(0, i - 24), i)))) continue;
        if (normalizeHex(m[0]) === hit.value) add(i, j);
      }
      break;
    case "rgb":
    case "hsl":
    case "oklch":
    case "otherColorFn":
      for (const m of lineText.matchAll(COLOR_FN)) {
        const i = ls + m.index!;
        if (masked(masks, i, i + m[0].length)) continue;
        if (m[0].replace(/\s+/g, " ").toLowerCase() === hit.value) add(i, i + m[0].length);
      }
      break;
    case "namedColor": {
      // Only where scan-literals reads named colors (classifyProp), so occurrences line up: color
      // declaration values without var() groups, url() and (outside a JS string value) quoted text;
      // a JS expression's whole quoted words; whole color attribute values. Never a selector
      // (`.swatch.white`), a class, an interpolated value, or another key's value (`label: "black"`).
      const word = new RegExp(`(?<![\\w-])${esc(hit.value)}(?![\\w-])`, "gi");
      const addWord = (i: number, len: number) => {
        if (!masked(masks, i, i + len)) add(i, i + len);
      };
      for (const d of declsOnLine(f, hit.line)) {
        if (!COLOR_PROPS.test(d.name) || d.vkind === "attr" || d.vkind === "attrBrace" || d.vkind === "canvas") continue;
        const value = f.text.slice(d.start, d.end);
        if (value.includes("${")) continue;
        if (d.vkind === "expr") {
          for (const m of value.matchAll(/(['"])([a-zA-Z]+)\1/g)) if (m[2].toLowerCase() === hit.value) addWord(d.start + m.index! + 1, m[2].length);
          continue;
        }
        if (f.kind === "html" && /\?|===|!==|&&|\|\||=>/.test(value)) continue;
        let words = value.replace(VAR_GROUP, (x) => " ".repeat(x.length)).replace(/url\([^)]*\)/gi, (x) => " ".repeat(x.length));
        if (d.vkind !== "quoted") words = words.replace(/(['"])[^'"]*\1/g, (x) => " ".repeat(x.length));
        for (const m of words.matchAll(word)) addWord(d.start + m.index!, m[0].length);
      }
      if (f.kind === "js" || f.kind === "html") {
        for (const m of lineText.matchAll(COLOR_ATTR_RE)) {
          const value = m[2] ?? m[3] ?? m[5] ?? "";
          const offset = m[0].lastIndexOf(value);
          const a = ls + m.index! + offset;
          const lead = value.length - value.trimStart().length;
          if (value.trim().toLowerCase() === hit.value) addWord(a + lead, value.trim().length);
        }
      }
      spans.sort((a, b) => a.start - b.start);
      break;
    }
    case "twArbitrary":
    case "twArbitraryVar":
    case "twPalette": {
      const after = hit.category === "twPalette" ? "(?![\\w\\-/])" : "(?!:)";
      for (const m of lineText.matchAll(new RegExp(`(?<![\\w\\-/\\[\\].$#@])${esc(hit.value)}${after}`, "g"))) {
        spans.push({ start: ls + m.index!, end: ls + m.index! + m[0].length, slot: "class" });
      }
      break;
    }
    default: {
      const group = hit.category === "radius" ? "radius" : hit.category === "fontFamily" ? "fontFamily" : hit.category === "pxSpacing" ? "spacing" : "fontSize";
      for (const d of declsOnLine(f, hit.line)) {
        if (!DECL_NAMES[group].test(d.name)) continue;
        const span = matchDecl(f, hit, d);
        if (span) spans.push(span);
      }
    }
  }
  return spans;
}

/** The part of a declaration value that is the hit's literal, or null when it does not match. */
function matchDecl(f: SourceFile, hit: Hit, d: Decl): Span | null {
  const value = f.text.slice(d.start, d.end);
  const slot = d.vkind === "canvas" ? "canvas" : d.vkind === "expr" ? "number" : d.vkind === "attrBrace" ? "attrBrace" : "text";
  const isShorthand = d.name === "font";
  if (hit.category === "radius" || hit.category === "pxSpacing") {
    const written = d.vkind === "expr" ? (/^-?\d+(?:\.\d+)?$/.test(value) ? `${value}px` : null) : value.replace(/\s+/g, " ");
    return written === hit.value ? { start: d.start, end: d.end, slot } : null;
  }
  if (hit.category === "fontFamily") {
    if (isShorthand) {
      const m = value.match(/(?:^|\s)\d*\.?\d+(?:px|rem|em|pt|%)(?:\s*\/\s*[\w.%-]+)?\s+(.+)$/);
      if (!m || firstFamily(m[1]) !== hit.value) return null;
      const start = d.start + value.length - m[1].length;
      return { start, end: d.end, slot };
    }
    return firstFamily(value) === hit.value ? { start: d.start, end: d.end, slot } : null;
  }
  // pxFontSize / otherFontSize: the size token inside the value.
  if (d.vkind === "expr" || d.vkind === "attrBrace") {
    if (!/^-?\d+(?:\.\d+)?$/.test(value) || `${value}px` !== hit.value) return null;
    if (d.vkind === "attrBrace") {
      // fontSize={12}: the braces go too, so the attribute can take a string.
      const open = f.src.lastIndexOf("{", d.start);
      const close = f.src.indexOf("}", d.end);
      return { start: open, end: close + 1, slot };
    }
    return { start: d.start, end: d.end, slot };
  }
  const re = isShorthand ? /(?:^|\s)(\d*\.?\d+)(px|rem|em|pt|%)/ : /^(-?\d*\.?\d+)(px|rem|em|pt|%)?$/;
  const m = value.match(re);
  if (!m) return null;
  const written = `${m[1]}${m[2] ?? "px"}`;
  if (written !== hit.value) return null;
  const start = d.start + (m.index ?? 0) + m[0].length - (m[1].length + (m[2]?.length ?? 0));
  return { start, end: start + m[1].length + (m[2]?.length ?? 0), slot };
}

/**
 * The span of the `occurrence`-th match of a hit on its line (hits with the same line, category
 * and value are numbered in source order; `lineHits` are every hit on the line, so colors inside
 * reported Tailwind classes are skipped the way scan-literals skips them), with the slot refined: a whole JS string, canvas 2D, or
 * a Tailwind opacity modifier folded into the class. Null when the literal is not on the line
 * (a value split across lines, a channel triplet, a numeric palette tuple).
 */
export function locate(f: SourceFile, hit: Hit, occurrence: number, lineHits: readonly Hit[] = []): Span | null {
  const span = candidates(f, hit, lineHits)[occurrence];
  if (!span) return null;
  if (span.slot === "class") {
    // bg-[#fff]/50: an opacity modifier belongs to a color literal (scan-literals leaves it out of
    // arbitrary values). On any other value it is something else (text-[13px]/5 is a line height).
    const mod = f.src.slice(span.end).match(/^\/(?:\d{1,3}|\[[^\]\s]+\])/);
    const inner = hit.value.match(/\[(?:color:)?([^\]]+)\]/)?.[1]?.replace(/_/g, " ");
    if (mod && hit.category === "twArbitrary" && inner && parseColor(inner)) span.end += mod[0].length;
    return span;
  }
  if (span.slot !== "text") return span;
  // The whole statement decides: `ctx.fillStyle = on ? "#fff" : "#000"`, `ctx.strokeStyle = c || "#fff"`.
  if (isCanvasValue(f, span)) return { ...span, slot: "canvas" };
  if (f.inStr && f.inStr[span.start] === 1) {
    let a = span.start;
    let b = span.end;
    while (a > 0 && f.inStr[a - 1] === 1) a--;
    while (b < f.src.length && f.inStr[b] === 1) b++;
    const q = f.src[a - 1];
    if (a === span.start && b === span.end && "'\"`".includes(q) && f.src[b] === q) {
      return { start: a - 1, end: b + 1, slot: "wholeString" };
    }
  }
  return span;
}
