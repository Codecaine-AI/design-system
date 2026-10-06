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
  /** Every word that can hint a role: selector chain, role words of classes, tag attribute names, keys, names. Never comments, attribute values or prose. */
  hints: string;
  /** The literal sits in CSS (a stylesheet, a <style> body, a CSS template): `selector` is a real selector chain. */
  inCss: boolean;
  /** JSX/HTML attribute the literal is the whole value of (`fill` in `fill="#fff"`), or null. */
  attribute: string | null;
}

/** Selector or key text that puts a region in dark: `[data-theme="dark"]`, any `data-*="dark"`, `.dark`, the media query, a `dark:` JS key. */
const DARK_MARKS = /data-[\w-]+\s*[~|^$*]?=\s*["']?dark(?![\w-])|(?:^|[\s.,(:>+~])\.?dark(?:-mode|-theme)?(?![\w-])|\.theme-dark(?![\w-])|prefers-color-scheme\s*:\s*dark|(?:^|[^\w])dark\s*[:=]\s*[{(]|\bdark(?:theme|palette|colors?)\b|(?<![\w-])night(?![\w-])/gi;
/**
 * ... and back to light: a theme attribute set to light (`[data-theme="light"]`, `data-mode`,
 * `data-color-scheme`; not `data-weight="light"`), a `.light` class on anything, `.theme-light`,
 * the media query.
 */
const LIGHT_MARKS = /data-(?:[\w-]*-)?(?:theme|mode|scheme|appearance)\s*[~|^$*]?=\s*["']?light(?![\w-])|\.light(?:-mode|-theme)?(?![\w-])|\.theme-light(?![\w-])|prefers-color-scheme\s*:\s*light/gi;

type Mark = { at: number; theme: Theme };

const flip = (t: Theme): Theme => (t === "dark" ? "light" : "dark");

/** Marks in one selector branch, in order. A mark inside `:not(…)` (nested too) counts for the other theme. */
function marksOf(branch: string): Mark[] {
  // `not (prefers-color-scheme: dark)` is the light media query, and the reverse.
  let text = branch.replace(/\bnot\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_m, t: string) => `(prefers-color-scheme: ${t.toLowerCase() === "dark" ? "light" : "dark"})`);
  const negated: Mark[] = [];
  for (let i = text.search(/:not\(/i); i !== -1; i = text.search(/:not\(/i)) {
    let depth = 0;
    let k = i + 4;
    for (; k < text.length; k++) {
      if (text[k] === "(") depth++;
      else if (text[k] === ")" && --depth === 0) break;
    }
    for (const m of marksOf(text.slice(i + 5, k))) negated.push({ at: i, theme: flip(m.theme) });
    text = text.slice(0, i) + " ".repeat(Math.min(k + 1, text.length) - i) + text.slice(k + 1);
  }
  const marks: Mark[] = [];
  for (const m of text.matchAll(DARK_MARKS)) marks.push({ at: m.index!, theme: "dark" });
  for (const m of text.matchAll(LIGHT_MARKS)) marks.push({ at: m.index!, theme: "light" });
  // `:not(.dark):not(.light)` names no theme.
  if (!(negated.some((m) => m.theme === "dark") && negated.some((m) => m.theme === "light"))) marks.push(...negated);
  return marks.sort((a, b) => a.at - b.at);
}

/** Splits a selector list at top-level commas (not inside parentheses or brackets). */
function branches(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of prelude) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * The theme a selector chain (outermost prelude first) puts its declarations in, or null when it
 * names none. The innermost mark wins, so `[data-theme="light"]` inside a dark-first app is light;
 * a mark inside `:not(…)` counts for the other theme (`html:not([data-theme="dark"]) .note` is
 * light); a selector list whose branches disagree (`.dark .card, .card`) names none.
 */
export function themeOf(chain: string | string[]): Theme | null {
  const preludes = typeof chain === "string" ? [chain] : chain;
  for (let i = preludes.length - 1; i >= 0; i--) {
    const themes = branches(preludes[i]).map((b) => marksOf(b).pop()?.theme ?? null);
    if (themes.every((t) => t === null)) continue;
    return themes.every((t) => t === themes[0]) ? themes[0] : null;
  }
  return null;
}
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

/** Attributes whose value is a state or variant keyword, not prose: their value is a hint too. */
const ENUM_ATTRS = /^(?:variant|tone|intent|severity|status|data-(?:state|status|variant|tone|active|selected))$/;

/**
 * Role words of a JSX/HTML tag: the tag name, the role words of its class string, and attribute
 * names (`aria-selected`). Attribute values (`title="Delete"`) and text are prose, not roles; only
 * state and variant attributes keep a one-word value (`variant="destructive"`).
 */
function tagHints(name: string, text: string): string {
  const out: string[] = [name];
  const attrs = text.slice(1 + name.length);
  // A quoted value may run to the end: the tag text stops at the literal (`className="border bg-[#…`).
  const ATTR = /([A-Za-z_:@][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|`([^`]*)`?|\{|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  let depth = 0;
  for (let i = 0; i < attrs.length; i++) {
    const ch = attrs[i];
    if (depth > 0 && (ch === '"' || ch === "'" || ch === "`")) {
      // A string inside an expression (`onClick={() => f("}", "danger")}`): skip it whole.
      let k = i + 1;
      while (k < attrs.length && attrs[k] !== ch) k += attrs[k] === "\\" ? 2 : 1;
      i = k;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 || !/[A-Za-z_:@]/.test(ch) || (i > 0 && /[-\w:.]/.test(attrs[i - 1]))) continue;
    ATTR.lastIndex = i;
    m = ATTR.exec(attrs);
    if (!m || m.index !== i) continue;
    const attr = m[1];
    const value = m[2] ?? m[3] ?? m[4];
    if (/^(?:className|class)$/.test(attr)) {
      const cls = value ?? attrs.slice(i).match(/^[\w-]+\s*=\s*\{\s*(["'`])([^"'`]*)/)?.[2] ?? "";
      out.push(classHints(cls));
    } else {
      out.push(attr);
      if (value !== undefined && ENUM_ATTRS.test(attr) && /^[a-z][\w-]*$/i.test(value.trim())) out.push(value.trim());
    }
    if (m[0].endsWith("{")) depth++;
    i = m.index + m[0].length - 1;
  }
  return out.join(" ").replace(/\s+/g, " ").slice(-300);
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
export function enclosingTag(f: SourceFile, index: number): { name: string; text: string } | null {
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

/**
 * The JSX attribute whose value starts at `index` (the quote or the `{` right after `name=`), at the
 * tag's own brace level, with the tag's name; null when `index` is not an attribute value.
 */
export function attributeAt(f: SourceFile, index: number): { name: string; tag: string } | null {
  const tag = enclosingTag(f, index);
  if (!tag || braceDepth(f, index - tag.text.length, index) !== 0) return null;
  const name = tag.text.match(/(?:^|\s)([A-Za-z_:@][-\w:.]*)\s*=\s*$/)?.[1];
  return name ? { name, tag: tag.name } : null;
}

/** `{` minus `}` between two offsets, outside strings. */
function braceDepth(f: SourceFile, from: number, to: number): number {
  let depth = 0;
  for (let k = Math.max(0, from); k < to; k++) {
    if (f.inStr && f.inStr[k] === 1) continue;
    if (f.text[k] === "{") depth++;
    else if (f.text[k] === "}") depth--;
  }
  return depth;
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
  let attribute: string | null = null;
  const hintParts: string[] = [];
  /** Text that may name a theme region: CSS selector chains, JS keys, a Tailwind `dark:` variant. */
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
  }

  if (css) {
    const { start, decl } = declarationBefore(t, span.start);
    const m = decl.match(/^\s*([-\w$@]+)\s*:/);
    if (span.slot !== "class") property = m ? m[1] : property;
    if (m && /^(--|\$|@)/.test(m[1])) definition = m[1];
    const chain = enclosingPreludes(f, start).reverse();
    if (span.slot === "class") property = property ?? "@apply";
    selector = chain.join(" / ") || selector;
    // The subject element: the last one in the innermost selector (`.nav li a` styles the `a`).
    const inner = chain[chain.length - 1] ?? "";
    component = [...inner.matchAll(new RegExp(ELEMENTS.source, "g"))].pop()?.[1] ?? null;
    hintParts.push(...chain);
    darkParts.push(...chain);
  } else if (f.kind === "js" || f.kind === "html") {
    if (span.slot !== "class") property = ownerOnLine(f, span.start);
    if (property && /^(--|\$)/.test(property)) definition = property;
    const tag = enclosingTag(f, span.start);
    if (tag) {
      component = tag.name;
      hintParts.push(tagHints(tag.name, tag.text));
      // An attribute value only at the tag's own level: `name = "…"` inside a `{…}` expression
      // (`onMouseEnter={() => { el.style.background = "#fff" }}`) is JS, not an attribute.
      if (span.slot !== "class" && braceDepth(f, span.start - tag.text.length, span.start) === 0) {
        attribute = tag.text.match(/(?:^|\s)([A-Za-z_:@][-\w:.]*)\s*=\s*$/)?.[1] ?? null;
      }
    }
    // Enclosing object keys and variable names (`palette / dark / bg`); raw code around them is noise.
    const keys = (f.kind === "js" ? enclosingPreludes(f, span.start) : [])
      .map((p) => p.match(/(?:([\w$-]+)['"]?\s*[:=]\s*(?:\([^)]*\)\s*=>\s*\(?)?|(?:const|let|var)\s+([\w$]+)[^=]*=\s*)$/))
      .map((m) => m?.[1] ?? m?.[2])
      .filter((k): k is string => !!k)
      .reverse();
    if (span.slot !== "class") selector = keys.length ? keys.join(" / ") : null;
    hintParts.push(...keys);
    if (span.slot !== "class") {
      // Keys outermost first, then the property: the innermost theme key wins. The literal's own
      // key never says light: `primary: { light: "#…" }` is a shade, not a theme.
      const names = [...keys, property ?? ""];
      names.forEach((k, i) => {
        const w = nameWords(k);
        const own = i === names.length - 1;
        if (w.some((x) => x === "dark" || x === "night")) darkParts.push(".dark");
        else if (!own && (k === "light" || (w[0] === "light" && w.length === 2 && /^(?:theme|mode|palette|colors?|scheme)$/.test(w[1])))) darkParts.push(".light");
      });
    }
  }
  // The class's own dark: variant is the innermost mark.
  if (span.slot === "class" && variants.includes("dark")) darkParts.push(".dark");

  const hints = [...hintParts, property ?? "", definition ?? ""].join(" ");
  const data = isDataObject(f, span, property);
  const marked = themeOf(darkParts);
  const theme = marked ?? (/(?:^|[/._-])dark(?:[/._-]|$)/i.test(f.rel) ? "dark" : opts.defaultTheme);
  return { property, selector, component, theme, variants, definition, data, hints, inCss: css, attribute };
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
