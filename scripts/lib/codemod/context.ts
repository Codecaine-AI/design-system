/**
 * Reads the context of a located literal: the CSS property (or JS key, or Tailwind prefix), the
 * selector (CSS selector chain, or the class string and enclosing object keys in JS), the
 * component (an HTML/JSX element or a selector's element type), and the theme it renders in.
 */

import type { Span } from "./locate.ts";
import { cssRegionAt, isCssAt, lineOf, lineRange, type SourceFile } from "./source.ts";
import type { Theme } from "./tokens.ts";

export interface Context {
  /** CSS property, JS key or variable, Tailwind prefix (`bg`, `text`), or null. */
  property: string | null;
  /** CSS selector chain (outermost first), or the element's classes and enclosing keys in JS. */
  selector: string | null;
  /** HTML/JSX element (`button`, `Button`) or the element type in the selector. */
  component: string | null;
  theme: Theme;
  /** Tailwind variants on the class: `hover`, `dark`, `focus-visible` ... */
  variants: string[];
  /** Custom property, SCSS or LESS variable the literal defines (`--background`). */
  definition: string | null;
  /** The literal sits in a data object (an object with id/type keys), not a style. */
  data: boolean;
  /** Every word that can hint a role: selector chain, role words of classes, tag attributes, keys, names. */
  hints: string;
}

const DARK = /data-theme\s*=\s*["']?dark|data-mode\s*=\s*["']?dark|(?:^|[\s.,(:])\.?dark(?:-mode|-theme)?(?![\w-])|\.theme-dark|prefers-color-scheme\s*:\s*dark|(?:^|[^\w])dark\s*[:=]\s*[{(]|\bdark(?:theme|palette|colors?)\b|\bnight\b/i;
const ELEMENTS = /(?:^|[\s>+~,(])(button|input|textarea|select|option|a|code|pre|kbd|samp|svg|path|rect|circle|text|table|th|td|tr|nav|aside|header|footer|dialog|body|html|label|li|ul|summary|details|mark)(?![\w-])/;
const STYLE_WORDS = new Set(["style", "styles", "sx", "css", "theme", "themes", "palette", "color", "colors", "token", "tokens", "vars", "chrome", "skin"]);
const DATA_KEYS = /(?:^|[\s,{])(?:id|type|parentId|geometry)\s*:/;

/** Words of a name, camelCase, snake_case and kebab-case split: `darkPanelBg` -> dark, panel, bg. */
const nameWords = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Any word of `s` names a style holder. */
const styleish = (s: string) => nameWords(s).some((w) => STYLE_WORDS.has(w));

/** Tailwind layout and type utilities say nothing about a color's role; drop them from hints. */
const UTILITY =
  /^-?(?:bg|text|border|ring|inset|backdrop|shadow|rounded|[pm][xytrblse]?|w|h|min|max|flex|grid|gap|items|justify|z|top|left|right|bottom|start|end|font|leading|tracking|truncate|overflow|absolute|relative|fixed|sticky|block|inline|hidden|pointer|cursor|transition|duration|ease|opacity|translate|scale|rotate|outline|divide|space|self|place|order|col|row|aspect|object|whitespace|break|select|animate|sr|size|shrink|grow|basis|uppercase|lowercase|capitalize|underline|italic|antialiased|blur|fill|stroke|list|isolate|contents|table|align|content|decoration|caret|accent|appearance|resize|snap|touch|will|line|tabular|origin|visible|invisible|container|mx|my)(?:-|$)/;
const COLOR_UTILITY = /^(?:bg|text|border|ring|fill|stroke|outline|divide|decoration)-(?!\[)([a-z][a-z-]*?)(?:-(?:50|[1-9]00|950))?(?:\/\S+)?$/;

/**
 * Role words from a class string: custom classes (`card-action`, `danger`) and the names in
 * semantic color utilities (`text-destructive` -> `destructive`). Variants and layout utilities go.
 */
export function classHints(classes: string): string {
  const out: string[] = [];
  for (const raw of classes.split(/\s+/)) {
    const cls = raw.split(":").pop()!.replace(/^!/, "");
    const color = cls.match(COLOR_UTILITY);
    if (color) out.push(color[1]);
    else if (cls && !UTILITY.test(cls) && /^[a-z][\w-]*$/i.test(cls)) out.push(cls);
  }
  return out.join(" ");
}

/** A JSX/HTML tag's text with its class string reduced to role words. */
function tagHints(text: string): string {
  return text
    .replace(/\b(?:className|class)\s*=\s*(?:\{\s*)?(["'`])([^"'`]*)(?:\1|$)/g, (_m, _q, cls: string) => ` ${classHints(cls)} `)
    .replace(/\s+/g, " ")
    .slice(-300);
}

/** Text from the innermost enclosing `;`, `{` or `}` up to `index` (one CSS declaration). */
function declarationBefore(text: string, index: number): { start: number; decl: string } {
  let k = index - 1;
  let depth = 0;
  while (k >= 0) {
    const ch = text[k];
    if (ch === ")") depth++;
    else if (ch === "(") depth--;
    else if (depth <= 0 && (ch === ";" || ch === "{" || ch === "}")) break;
    k--;
  }
  return { start: k + 1, decl: text.slice(k + 1, index) };
}

/** Preludes of every block enclosing `index`, innermost first. Inside a CSS region the walk stays in it. */
function enclosingPreludes(f: SourceFile, index: number, limit = 8): string[] {
  const t = f.text;
  const region = f.kind === "js" || f.kind === "html" ? cssRegionAt(f, index) : null;
  const floor = region ? region[0] : 0;
  const out: string[] = [];
  let depth = 0;
  for (let k = index - 1; k >= floor && out.length < limit; k--) {
    if (f.inStr && f.inStr[k] === 1 && !region) continue;
    const ch = t[k];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      let p = k - 1;
      while (p >= floor && !";{}".includes(t[p])) p--;
      const prelude = t.slice(p + 1, k).replace(/\s+/g, " ").trim();
      out.push(prelude.length > 120 ? prelude.slice(-120) : prelude);
    }
  }
  return out;
}

/** The JSX/HTML tag the literal sits in (as an attribute), and the tag's text up to the literal. */
function enclosingTag(f: SourceFile, index: number): { name: string; text: string } | null {
  const t = f.text;
  let depth = 0;
  let level = 0;
  for (let k = index - 1; k >= 0 && index - k < 4000; k--) {
    const ch = t[k];
    if (f.inStr && f.inStr[k] === 1) continue;
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      level = Math.min(level, depth);
    }
    if (depth !== level) continue;
    if (ch === ">" && t[k - 1] !== "=") return null;
    if (ch === "<") {
      const m = t.slice(k + 1, k + 64).match(/^([A-Za-z][\w.:-]*)/);
      return m ? { name: m[1], text: t.slice(k, index) } : null;
    }
  }
  return null;
}

/** JS key, variable or CSS property whose value holds `index`, on the same line. */
function ownerOnLine(f: SourceFile, index: number): string | null {
  const [ls] = lineRange(f, lineOf(f, index));
  const before = f.text.slice(ls, index);
  let best: string | null = null;
  for (const m of before.matchAll(/(['"]?)([-\w$]+)\1\s*(?::(?!:)|=(?![=>]))/g)) {
    const tail = before.slice(m.index! + m[0].length);
    if (!/[,;]/.test(tail.replace(/\([^()]*\)/g, "").replace(/(["'`])[^"'`]*\1/g, ""))) best = m[2];
  }
  return best;
}

const TW_PREFIX = /^!?-?((?:border|rounded|scroll-[mp]|inset|space|divide|gap|min-|max-)?[a-z]+(?:-[xytrblse])?)-/;

export function readContext(f: SourceFile, span: Span, opts: { defaultTheme: Theme }): Context {
  const t = f.text;
  const css = isCssAt(f, span.start);
  let property: string | null = null;
  let selector: string | null = null;
  let component: string | null = null;
  let definition: string | null = null;
  const variants: string[] = [];
  const hintParts: string[] = [];
  /** Text that may name a dark region: CSS selector chains, JS keys, a Tailwind `dark:` variant. */
  const darkParts: string[] = [];

  if (span.slot === "class") {
    const cls = f.src.slice(span.start, span.end);
    let v = span.start;
    while (v > 0 && !/[\s"'`{(,]/.test(f.src[v - 1])) v--;
    variants.push(...f.src.slice(v, span.start).split(":").filter(Boolean));
    property = cls.match(TW_PREFIX)?.[1] ?? null;
    // The class string: siblings tell the role (a button's bg, an input's border).
    let a = span.start;
    let b = span.end;
    while (a > 0 && !/["'`]/.test(f.src[a - 1]) && span.start - a < 600) a--;
    while (b < f.src.length && !/["'`]/.test(f.src[b]) && b - span.end < 600) b++;
    selector = f.src.slice(a, b).replace(/\s+/g, " ").trim();
    hintParts.push(classHints(selector), variants.join(" "));
    if (variants.includes("dark")) darkParts.push(".dark");
  }

  if (css) {
    const { start, decl } = declarationBefore(t, span.start);
    const m = decl.match(/^\s*([-\w$@]+)\s*:/);
    if (span.slot !== "class") property = m ? m[1] : property;
    if (m && /^(--|\$|@)/.test(m[1])) definition = m[1];
    const chain = enclosingPreludes(f, start).reverse();
    if (span.slot === "class") property = property ?? "@apply";
    selector = chain.join(" / ") || selector;
    const inner = chain[chain.length - 1] ?? "";
    component = inner.match(ELEMENTS)?.[1] ?? null;
    hintParts.push(...chain);
    darkParts.push(...chain);
  } else if (f.kind === "js" || f.kind === "html") {
    if (span.slot !== "class") property = ownerOnLine(f, span.start);
    if (property && /^(--|\$)/.test(property)) definition = property;
    const tag = enclosingTag(f, span.start);
    if (tag) {
      component = tag.name;
      hintParts.push(tagHints(tag.text));
    }
    // Enclosing object keys and variable names (`palette / dark / bg`); raw code around them is noise.
    const keys = (f.kind === "js" ? enclosingPreludes(f, span.start) : [])
      .map((p) => p.match(/(?:([\w$-]+)['"]?\s*[:=]\s*(?:\([^)]*\)\s*=>\s*\(?)?|(?:const|let|var)\s+([\w$]+)[^=]*=\s*)$/))
      .map((m) => m?.[1] ?? m?.[2])
      .filter((k): k is string => !!k)
      .reverse();
    if (span.slot !== "class") selector = keys.length ? keys.join(" / ") : null;
    hintParts.push(...keys);
    const darkKey = [...keys, property ?? ""].some((k) => nameWords(k).some((w) => w === "dark" || w === "night"));
    if (span.slot !== "class" && darkKey) darkParts.push(".dark");
  }

  const hints = [...hintParts, property ?? "", definition ?? ""].join(" ");
  const data = isDataObject(f, span, property);
  const dark = DARK.test(darkParts.join(" ")) || /(?:^|[/._-])dark(?:[/._-]|$)/i.test(f.rel);
  return { property, selector, component, theme: dark ? "dark" : opts.defaultTheme, variants, definition, data, hints };
}

/** A JS object that reads as data: its own keys include id/type/geometry and nothing around it says style. */
function isDataObject(f: SourceFile, span: Span, property: string | null): boolean {
  if (f.kind !== "js" || span.slot === "class" || !property) return false;
  const open = f.text.lastIndexOf("{", span.start);
  if (open < 0) return false;
  const preludes = enclosingPreludes(f, span.start, 3).join(" ");
  if (styleish(preludes)) return false;
  return DATA_KEYS.test(f.text.slice(open, span.start));
}
