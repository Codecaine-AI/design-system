/**
 * Reads the context of a located literal: the CSS property (or JS key, or Tailwind prefix), the
 * selector (CSS selector chain, or the class string and enclosing object keys in JS), the
 * component (an HTML/JSX element or a selector's element type), and the theme it renders in.
 */

import { parseColor, type Rgba } from "./color.ts";
import type { Span } from "./locate.ts";
import { cssRegionAt, isCssAt, lineOf, lineRange, type SourceFile } from "./source.ts";
import { TAILWIND_PALETTE } from "./tailwind-palette.ts";
import type { Theme } from "./tokens.ts";

/** The background the literal's own block, style object or class string paints. */
export interface Surface {
  /** Where it was read: `the rule's background`, `the style object's background`, `the class string`. */
  source: string;
  /** The value as written: `#1b1b1c`, `var(--accent)`, `bg-blue-600`. */
  text: string;
  /** The color when the value is one literal color (alpha kept), else null. */
  color: Rgba | null;
  /** Other backgrounds the same class string paints in a state (`hover:bg-transparent`): the fill is not stable. */
  alternates?: Surface[];
}

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
  /** The hints that are not the CSS selector chain: names, keys, classes, the tag. */
  ownHints: string;
  /** CSS selector chain, outermost prelude first ([] outside CSS): a word in it holds only when every branch of a prelude's list has it. */
  chain: string[];
  /** The literal sits in CSS (a stylesheet, a <style> body, a CSS template): `selector` is a real selector chain. */
  inCss: boolean;
  /** JSX/HTML attribute the literal is the whole value of (`fill` in `fill="#fff"`), or null. */
  attribute: string | null;
  /**
   * States that hold where the literal paints (`selected`, `active`, `hover`, a data-state value):
   * a state attribute counts only by its own static value (`aria-selected="true"`, not
   * `aria-selected={x}`), and a selector list only when every branch has the state.
   */
  states: string[];
  /** The background of the literal's own rule, style object or class string, if it names one. */
  surface: Surface | null;
  /** The SVG element whose paint is never seen as color that holds the literal: `mask`, `clipPath`, or a paint server a mask uses. */
  maskedBy: string | null;
  /** An enclosing block that sets `color-scheme` where the token theme does not switch (`.code { color-scheme: dark }`). */
  island: { scheme: Theme; prelude: string } | null;
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
export function branches(prelude: string): string[] {
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
  /^-?(?:bg|text|border|ring|inset|backdrop|shadow|rounded|[pm][xytrblse]?|w|h|min|max|flex|grid|gap|items|justify|z|top|left|right|bottom|start|end|font|leading|tracking|truncate|overflow|absolute|relative|fixed|sticky|block|inline|hidden|pointer|cursor|transition|duration|ease|opacity|translate|scale|rotate|outline|divide|space|self|place|order|col|row|aspect|object|whitespace|break|select|animate|sr|size|shrink|grow|basis|uppercase|lowercase|capitalize|underline|italic|antialiased|blur|drop|fill|stroke|list|isolate|contents|table|align|content|decoration|caret|accent|appearance|resize|snap|touch|will|line|tabular|origin|visible|invisible|container|mx|my)(?:-|$)/;
const COLOR_UTILITY = /^(?:bg|text|border|ring|fill|stroke|outline|divide|decoration)-(?!\[)([a-z][a-z-]*?)(?:-(?:50|[1-9]00|950))?(?:\/\S+)?$/;

/** Color utility values that name no role: `text-current`, `border-inherit`, `bg-transparent`. */
const NO_ROLE_COLOR = /^(?:current|inherit|transparent)$/;

/**
 * The static text of a class value written in a template literal (or a window of one): what lies
 * outside its `${…}` interpolations (also a template language's `{…}`), each chunk on its own. An
 * interpolation still open at the end drops the rest; text before an unmatched `}` was inside one.
 * A condition is never a class.
 */
export function staticChunks(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "}") {
      // The window opened inside an interpolation: all before this was its code.
      chunks.length = 0;
      chunk = "";
      continue;
    }
    if (value[i] === "$" && value[i + 1] === "{") continue;
    if (value[i] !== "{") {
      chunk += value[i];
      continue;
    }
    chunks.push(chunk);
    chunk = "";
    let depth = 0;
    let quote = "";
    let j = i;
    for (; j < value.length; j++) {
      const c = value[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (j >= value.length) return chunks; // open to the end
    i = j;
  }
  chunks.push(chunk);
  return chunks;
}

/**
 * Role words from a class string: custom classes (`card-action`, `danger`) and the names in
 * semantic color utilities (`text-destructive` -> `destructive`). Variants and layout utilities go,
 * and so does every `${…}` interpolation of a template-literal class value (staticChunks).
 */
export function classHints(classes: string): string {
  const out: string[] = [];
  for (const raw of staticChunks(classes).join(" ").split(/\s+/)) {
    const cls = raw.split(":").pop()!.replace(/^!/, "");
    const color = cls.match(COLOR_UTILITY);
    if (color) {
      if (!NO_ROLE_COLOR.test(color[1])) out.push(color[1]);
    } else if (cls && !UTILITY.test(cls) && /^[a-z][\w-]*$/i.test(cls)) out.push(cls);
  }
  return out.join(" ");
}

/** Attributes whose value is a variant keyword, not prose: their value is a hint too. */
const ENUM_ATTRS = /^(?:variant|tone|intent|severity|status|data-(?:status|variant|tone))$/;

/** State words a name, class or key may carry on its own (`tab-active`, `selectedBg`, `:hover`). */
const FREE_STATES = new Set(["active", "selected", "current", "checked", "pressed", "dragging", "drop", "target", "hover"]);
/**
 * State groups a family reads: any member says the group (`.tab.active` and `.tab[aria-selected="true"]`
 * are both selected). A selector list holds a group when every branch has a member of it. An open
 * popover (`data-state="open"`) is not a selected row.
 */
export const STATE_GROUPS: Record<string, string[]> = {
  selected: ["active", "selected", "current", "checked", "pressed"],
  outline: ["active", "selected", "current", "checked", "dragging", "drop", "target"],
  hover: ["hover"],
};
const groupsOf = (words: Set<string>) => Object.keys(STATE_GROUPS).filter((g) => STATE_GROUPS[g].some((w) => words.has(w)));
/** Values of `data-state` that name a state of a group. */
const DATA_STATES = new Set(["active", "checked", "selected", "current", "pressed"]);

/**
 * The state an attribute asserts with `value` (`true` for a bare attribute): a state word, null
 * when it is a state attribute that is off (`aria-selected="false"`, `data-state="closed"`), bare
 * (`[aria-selected]` matches "false" too) or not known statically, undefined when the attribute
 * names no state.
 */
export function attributeState(name: string, value: string | true | undefined): string | null | undefined {
  const n = name.toLowerCase();
  const aria = n.match(/^aria-(selected|current|pressed|checked)$/);
  if (aria) return typeof value === "string" && !/^(?:false|0|off|no|mixed)?$/i.test(value.trim()) ? aria[1] : null;
  if (n === "data-state") return typeof value === "string" && DATA_STATES.has(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
  const flag = n.match(/^(?:data-)?(active|selected|current|checked|pressed)$/);
  if (flag) return value === true || (typeof value === "string" && /^(?:|true)$/i.test(value.trim())) ? flag[1] : null;
  return undefined;
}

/** A selector with its `:not(…)` and `:has(…)` groups (nested too) removed: what they name is not this element's state. */
export function withoutNot(sel: string): string {
  let text = sel;
  for (let i = text.search(/:(?:not|has)\(/i); i !== -1; i = text.search(/:(?:not|has)\(/i)) {
    let depth = 0;
    let k = text.indexOf("(", i);
    for (; k < text.length; k++) {
      if (text[k] === "(") depth++;
      else if (text[k] === ")" && --depth === 0) break;
    }
    text = text.slice(0, i) + " " + text.slice(k + 1);
  }
  return text;
}

/**
 * A selector prelude as the branches a rule applies to: the list split at top-level commas, each
 * branch without its `:not(…)`/`:has(…)` groups, and `:is(…)`/`:where(…)` spread into one branch
 * per argument (`.tab:is(.active, :hover)` is `.tab.active` and `.tab:hover`).
 */
export function selectorBranches(prelude: string): string[] {
  const out: string[] = [];
  const queue = branches(prelude).map(withoutNot);
  while (queue.length && out.length + queue.length < 64) {
    const b = queue.shift()!;
    const i = b.search(/:(?:is|where|matches|-webkit-any)\(/i);
    if (i < 0) {
      out.push(b);
      continue;
    }
    let depth = 0;
    let k = b.indexOf("(", i);
    const open = k;
    for (; k < b.length; k++) {
      if (b[k] === "(") depth++;
      else if (b[k] === ")" && --depth === 0) break;
    }
    for (const arg of branches(b.slice(open + 1, k))) queue.push(b.slice(0, i) + arg.trim() + b.slice(k + 1));
  }
  return [...out, ...queue];
}

/** States one selector branch asserts: state attributes by their value, other words as written. */
function branchStates(branch: string): Set<string> {
  const out = new Set<string>();
  const rest = withoutNot(branch).replace(/\[\s*([\w-]+)\s*(?:[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*(?:[is]\s*)?\]/g, (m, name: string, v1?: string, v2?: string, v3?: string) => {
    const value = m.includes("=") ? (v1 ?? v2 ?? v3 ?? "") : true;
    const state = attributeState(name, value);
    if (state === undefined) return ` ${name} `;
    if (state) out.add(state);
    return " ";
  });
  for (const w of nameWords(rest)) if (FREE_STATES.has(w)) out.add(w);
  return out;
}

/**
 * States a CSS selector chain asserts: a prelude counts when every branch of its list holds the
 * state (`.tab.active, .tab:hover` asserts neither), and a chain holds what any of its levels does.
 */
function chainStates(chain: string[]): Set<string> {
  const out = new Set<string>();
  for (const prelude of chain) {
    if (/^@/.test(prelude.trim())) continue;
    const per = selectorBranches(prelude).map(branchStates);
    for (const s of per[0] ?? []) if (per.every((x) => x.has(s))) out.add(s);
    for (const g of Object.keys(STATE_GROUPS)) if (per.length && per.every((x) => groupsOf(x).includes(g))) out.add(`group:${g}`);
  }
  return out;
}

/**
 * State words in names, keys, class words and variants (`data-[state=active]` gives its value).
 * `not-*` and `has-*` variants, and arbitrary aria/data variants, assert nothing.
 */
function wordStates(parts: string[], variants: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const w of nameWords(parts.join(" "))) if (FREE_STATES.has(w)) out.add(w);
  for (const v of variants) {
    if (/^(?:(?:group|peer)(?:-[\w]+)?-)?(?:not|has|in)-/.test(v) || /^(?:not|has)\b/.test(v)) continue;
    const data = v.match(/^(?:group-|peer-)?data-\[\s*state\s*=\s*["']?(\w+)["']?\s*\]$/);
    if (data && DATA_STATES.has(data[1].toLowerCase())) out.add(data[1].toLowerCase());
    else if (!/^(?:group-|peer-)?(?:data|aria)-\[/.test(v)) for (const w of nameWords(v)) if (FREE_STATES.has(w)) out.add(w);
  }
  return out;
}

/** A template literal's text after its opening backtick, up to the closing one (or the end of `text`), interpolations kept. */
function templateText(text: string): string {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0) {
      if (c === "\\") i++;
      else if (c === "`") return text.slice(0, i);
      else if (c === "$" && text[i + 1] === "{") {
        depth = 1;
        i++;
      }
    } else if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return text;
}

/**
 * Role words of a JSX/HTML tag: the tag name, the role words of its class string, and attribute
 * names. Attribute values (`title="Delete"`) and text are prose, not roles; only variant attributes
 * keep a one-word value (`variant="destructive"`). A state attribute (`aria-selected`,
 * `data-state`, `selected`) is never a word: it gives a state only by its own static value, so
 * `data-state={x} onAnimationEnd` asserts nothing.
 */
function tagHints(name: string, text: string): { hints: string; classes: string; states: string[] } {
  const out: string[] = [name];
  const classes: string[] = [];
  const states: string[] = [];
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
    let value: string | true | undefined = m[2] ?? m[3] ?? m[4];
    // `aria-pressed={true}`: a literal in braces is static too; a bare attribute is true.
    if (value === undefined && m[0].endsWith("{")) {
      const lit = attrs.slice(m.index + m[0].length).match(/^\s*(?:(true|false)|(["'`])(\w*)\2)\s*\}/);
      value = lit ? (lit[1] ?? lit[3]) : undefined;
    } else if (value === undefined) value = m[0].includes("=") ? m[0].slice(m[0].indexOf("=") + 1).trim() : true;
    const state = attributeState(attr, value);
    if (/^(?:className|class)$/.test(attr)) {
      // `className={`…`}`: the whole literal (classHints reads its static chunks); `{"…"}`: the string.
      const open = attrs.slice(i).match(/^[\w-]+\s*=\s*\{\s*(["'`])/);
      const literal = open ? attrs.slice(i + open[0].length) : "";
      const cls = typeof value === "string" ? value : !open ? "" : open[1] === "`" ? templateText(literal) : literal.match(/^[^"'`]*/)![0];
      const words = classHints(cls);
      out.push(words);
      classes.push(words);
    } else if (state !== undefined) {
      if (state) states.push(state);
    } else {
      out.push(attr);
      if (typeof value === "string" && ENUM_ATTRS.test(attr) && /^[a-z][\w-]*$/i.test(value.trim())) out.push(value.trim());
    }
    if (m[0].endsWith("{")) depth++;
    i = m.index + m[0].length - 1;
  }
  return { hints: out.join(" ").replace(/\s+/g, " ").slice(-300), classes: classes.join(" "), states };
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

/** Every block enclosing `index` (its prelude and its `{`), innermost first. Inside a CSS region the walk stays in it. */
function enclosingBlocks(f: SourceFile, index: number, limit = 8): Array<{ prelude: string; open: number }> {
  const t = f.text;
  const region = f.kind === "js" || f.kind === "html" ? cssRegionAt(f, index) : null;
  const floor = region ? region[0] : 0;
  const out: Array<{ prelude: string; open: number }> = [];
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
      out.push({ prelude: prelude.length > 120 ? prelude.slice(-120) : prelude, open: k });
    }
  }
  return out;
}

/** Preludes of every block enclosing `index`, innermost first. */
function enclosingPreludes(f: SourceFile, index: number, limit = 8): string[] {
  return enclosingBlocks(f, index, limit).map((b) => b.prelude);
}

const declCache = new WeakMap<SourceFile, Map<number, Array<{ prop: string; value: string }>>>();

/**
 * The block's own declarations (`prop: value`), nested blocks skipped: a CSS block splits at `;`,
 * a JS object at `,` (strings skipped, except in a CSS region, which is string text to the lexer).
 */
function ownDeclarations(f: SourceFile, open: number, js: boolean): Array<{ prop: string; value: string }> {
  let cache = declCache.get(f);
  if (!cache) declCache.set(f, (cache = new Map()));
  const key = js ? -open - 1 : open;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = f.text;
  const skipStrings = js && !cssRegionAt(f, open);
  const out: Array<{ prop: string; value: string }> = [];
  let depth = 0;
  let start = open + 1;
  const flush = (end: number) => {
    const m = t.slice(start, end).match(/^\s*(["'`]?)(--[\w-]+|-?[A-Za-z_$][\w$-]*)\1\s*:(?!:)\s*([\s\S]*?)\s*$/);
    if (m) out.push({ prop: m[2], value: m[3] });
  };
  for (let k = open + 1; k < t.length && k - open < 20000; k++) {
    if (skipStrings && f.inStr && f.inStr[k] === 1) continue;
    const ch = t[k];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) {
        flush(k);
        break;
      }
      // A nested CSS rule ended: the next declaration starts after it.
      if (--depth === 0 && ch === "}" && !js) start = k + 1;
    } else if (depth === 0 && ch === (js ? "," : ";")) {
      flush(k);
      start = k + 1;
    }
  }
  cache.set(key, out);
  return out;
}

/** A prelude every branch of which is the document root (`:root`, `html`, `body`, `:host`). */
function rootPrelude(prelude: string): boolean {
  return branches(prelude).every((b) => /^\s*(?::root|html|body|:host)(?![\w-])/i.test(b));
}

/** `color-scheme: dark` (or `only dark`) marks its block dark, `light` light; `light dark` and `normal` mark nothing. */
function schemeOf(decls: Array<{ prop: string; value: string }>): Theme | null {
  const d = [...decls].reverse().find((x) => x.prop.toLowerCase() === "color-scheme");
  if (!d) return null;
  const w = d.value.toLowerCase().split(/[\s!]+/);
  const dark = w.includes("dark");
  const light = w.includes("light");
  return dark === light ? null : dark ? "dark" : "light";
}

const BG_PROP = /^(?:background|background-color|backgroundColor|bg)$/;
/** A custom property that names the page's own background (`--background`, `--bg`, `--page-bg`), not a card's or an editor's. */
const PAGE_BG_NAME = /^--(?:color-)?(?:(?:page|app|body|main)-)?(?:background|bg)(?:-(?:page|app|body|main|color))?$/;

function surfaceFromDecls(decls: Array<{ prop: string; value: string }>, source: string): Surface | null {
  const d = [...decls].reverse().find((x) => BG_PROP.test(x.prop)) ?? [...decls].reverse().find((x) => PAGE_BG_NAME.test(x.prop));
  if (!d) return null;
  const v = d.value.replace(/\s*!important\s*$/, "").trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
  return { source: `${source} ${d.prop}`, text: v, color: parseColor(v) };
}

/** A class split into variants and the class itself, at colons outside brackets (`dark:bg-[color:red]`). */
function splitVariants(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === ":" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The color a `bg-…` class paints (`bg-[#111]`, `bg-blue-600/50`, `bg-white`), or null. */
function bgClassColor(value: string): Rgba | null {
  const arb = value.match(/^\[(?:color:)?(.+)\](\/\d{1,3})?$/);
  const pal = value.match(/^([a-z]+-(?:50|[1-9]00|950)|white|black)(\/\d{1,3})?$/);
  const raw = arb ? arb[1].replace(/_/g, " ") : pal ? TAILWIND_PALETTE[pal[1]] : null;
  const c = raw ? parseColor(raw) : null;
  const mod = (arb ?? pal)?.[2];
  return c ? { ...c, a: c.a * (mod ? Number(mod.slice(1)) / 100 : 1) } : null;
}

/** The background a class string paints in the literal's own theme variant: unprefixed `bg-*`, or `dark:bg-*` for a `dark:` class. */
function surfaceFromClasses(classes: string, variants: string[]): Surface | null {
  const dark = variants.includes("dark");
  let found: Surface | null = null;
  const alternates: Surface[] = [];
  for (const raw of classes.split(/\s+/)) {
    const parts = splitVariants(raw);
    const cls = parts.pop()!.replace(/^!|!$/g, "");
    const m = cls.match(/^bg-(.+)$/);
    if (!m || parts.includes("dark") !== dark) continue;
    const s = { source: `the class string's ${cls}`, text: cls, color: bgClassColor(m[1]) };
    if (parts.length === (dark ? 1 : 0)) found = s;
    else alternates.push(s);
  }
  return found ? { ...found, alternates } : null;
}

type SvgTag = { at: number; end: number; name: string; close: boolean; attrs: string };
const svgCache = new WeakMap<SourceFile, { tags: SvgTag[]; masks: Array<[number, number]> }>();
/** Elements whose paint is never seen as color (mask, clipPath) and the paint servers a mask may use. */
const SVG_PAINT = ["mask", "clipPath", "pattern", "linearGradient", "radialGradient"];

/**
 * The end (just past `>`) of the tag whose name ends at `from`, reading quotes, `{…}` expressions
 * at any depth and template literals (`<mask style={{ maskType: "alpha" }}>`), or -1.
 */
function tagEnd(t: string, from: number): { end: number; self: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let k = from; k < t.length && k - from < 4000; k++) {
    const ch = t[k];
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "<" && depth === 0) return null;
    else if (ch === ">" && depth === 0 && t[k - 1] !== "=") return { end: k + 1, self: t[k - 1] === "/" };
  }
  return null;
}

/** The mask, clipPath and paint-server tags of a markup or JSX file, in order, and the ranges masks cover. */
function svgPaintTags(f: SourceFile) {
  let hit = svgCache.get(f);
  if (!hit) {
    const tags: SvgTag[] = [];
    const t = f.text;
    // HTML names are case-insensitive (`<clippath>`, `<MASK>`); in JSX `<Mask>` is a component.
    const re = new RegExp(`<(\\/?)(${SVG_PAINT.join("|")})(?=[\\s/>])`, f.kind === "html" ? "gi" : "g");
    for (const m of t.matchAll(re)) {
      const e = tagEnd(t, m.index! + m[0].length);
      if (!e || e.self) continue;
      const name = SVG_PAINT.find((x) => x.toLowerCase() === m[2].toLowerCase())!;
      tags.push({ at: m.index!, end: e.end, name, close: m[1] === "/", attrs: t.slice(m.index! + m[0].length, e.end - 1) });
    }
    const masks: Array<[number, number]> = [];
    const open: SvgTag[] = [];
    for (const tag of tags) {
      if (!tag.close) open.push(tag);
      else {
        const i = open.map((x) => x.name).lastIndexOf(tag.name);
        if (i < 0) continue;
        if (open[i].name === "mask") masks.push([open[i].at, tag.end]);
        open.splice(i);
      }
    }
    for (const o of open) if (o.name === "mask") masks.push([o.at, t.length]);
    svgCache.set(f, (hit = { tags, masks }));
  }
  return hit;
}

/**
 * The SVG element whose paint nobody sees as color that holds `index`: a `<mask>` (only its
 * luminance and alpha count), a `<clipPath>` (only its geometry), or a paint server (`<pattern>`,
 * `<linearGradient>`, `<radialGradient>`) a mask in the file references.
 */
function maskedAt(f: SourceFile, index: number): string | null {
  if (f.kind !== "js" && f.kind !== "html") return null;
  const { tags, masks } = svgPaintTags(f);
  const stack: SvgTag[] = [];
  for (const tag of tags) {
    if (tag.at >= index) break;
    if (!tag.close) {
      if (tag.end <= index) stack.push(tag);
    } else {
      const i = stack.map((s) => s.name).lastIndexOf(tag.name);
      if (i >= 0) stack.splice(i);
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const { name, attrs } = stack[i];
    if (name === "mask" || name === "clipPath") return name;
    // A paint server counts when a mask references its id (`url(#hatch)`, `url(#${hatchId})`).
    const id = attrs.match(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*([\w$.]+)\s*\})/);
    const ref = id?.[1] ?? id?.[2] ?? id?.[3];
    if (!ref) continue;
    const needle = id![3] ? ref : `#${ref}`;
    if (masks.some(([a, b]) => f.text.slice(a, b).includes(needle))) return name;
  }
  return null;
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
      if (!m) return null;
      // In JS, `a<b; c = "#fff"` and `if (n<min) c = "#fff"` are comparisons, not tags.
      if (f.kind === "js" && !jsxTagText(f, k, index, m[1].length)) return null;
      return { name: m[1], text: t.slice(k, index) };
    }
  }
  return null;
}

/**
 * Whether [lt, index) reads as the start of a JSX opening tag: the name ends at a space, `/` or
 * `>`, and outside strings and `{…}` there is no `;`, `,` or unmatched `)`/`]` (which a comparison
 * followed by more code has).
 */
function jsxTagText(f: SourceFile, lt: number, index: number, nameLength: number): boolean {
  const t = f.text;
  if (!/[\s/>]/.test(t[lt + 1 + nameLength] ?? "")) return false;
  let braces = 0;
  let parens = 0;
  for (let k = lt + 1 + nameLength; k < index; k++) {
    if (f.inStr && f.inStr[k] === 1) continue;
    const ch = t[k];
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    if (braces > 0) continue;
    if (ch === "(" || ch === "[") parens++;
    else if (ch === ")" || ch === "]") {
      if (--parens < 0) return false;
    } else if (ch === ";" || ch === ",") return false;
  }
  return true;
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
  /** CSS selector preludes, outermost first. */
  const chainParts: string[] = [];
  /** Text that may name a theme region: CSS selector chains, JS keys, a Tailwind `dark:` variant. */
  const darkParts: string[] = [];
  /** Names, keys, class words and the tag name: their state words hold as written. */
  const stateWords: string[] = [];
  const states = new Set<string>();
  /** States only the selector chain gave: their groups come from the every-branch rule, not one by one. */
  const chainOnly = new Set<string>();
  let surface: Surface | null = null;
  let maskedBy: string | null = null;
  let island: { scheme: Theme; prelude: string } | null = null;

  if (span.slot === "class") {
    const cls = f.src.slice(span.start, span.end);
    let v = span.start;
    while (v > 0 && !/[\s"'`{(,]/.test(f.src[v - 1])) v--;
    variants.push(...splitVariants(f.src.slice(v, span.start)).filter(Boolean));
    property = cls.match(TW_PREFIX)?.[1] ?? null;
    // The class string: siblings tell the role (a button's bg, an input's border).
    let a = span.start;
    let b = span.end;
    // In CSS the class string is the @apply declaration only: it stops at `;`, `{` or `}`.
    const stop = css ? /["'`;{}]/ : /["'`]/;
    while (a > 0 && !stop.test(f.src[a - 1]) && span.start - a < 600) a--;
    while (b < f.src.length && !stop.test(f.src[b]) && b - span.end < 600) b++;
    selector = f.src.slice(a, b).replace(/\s+/g, " ").trim();
    hintParts.push(classHints(selector), variants.join(" "));
    stateWords.push(classHints(selector));
    for (const s of wordStates([], variants)) states.add(s);
    surface = surfaceFromClasses(selector, variants);
  }

  if (css) {
    const { start, decl } = declarationBefore(t, span.start);
    const m = decl.match(/^\s*([-\w$@]+)\s*:/);
    if (span.slot !== "class") property = m ? m[1] : property;
    if (m && /^(--|\$|@)/.test(m[1])) definition = m[1];
    const blocks = enclosingBlocks(f, start).reverse();
    const chain = blocks.map((b) => b.prelude);
    if (span.slot === "class") property = property ?? "@apply";
    selector = chain.join(" / ") || selector;
    // The subject element: the last one in the innermost selector (`.nav li a` styles the `a`), the
    // same in every branch of its list (`a, .chip` styles no one element).
    const subjects = branches(chain[chain.length - 1] ?? "").map((b) => [...b.matchAll(new RegExp(ELEMENTS.source, "g"))].pop()?.[1] ?? null);
    component = subjects.every((x) => x === subjects[0]) ? subjects[0] : null;
    chainParts.push(...chain);
    for (const s of chainStates(chain)) {
      if (!states.has(s)) chainOnly.add(s);
      states.add(s);
    }
    // `color-scheme: dark` marks a block dark only where the tokens switch too: on the root, or with
    // a theme selector. Elsewhere it switches the browser's colors, not the tokens: an island.
    blocks.forEach((b, i) => {
      const scheme = schemeOf(ownDeclarations(f, b.open, false));
      const switches = !!scheme && (rootPrelude(chain[i]) || themeOf(chain[i]) !== null);
      darkParts.push(switches ? `.${scheme}` : chain[i]);
      if (scheme && !switches) island = { scheme, prelude: chain[i] };
    });
    if (span.slot !== "class" && blocks.length) surface = surfaceFromDecls(ownDeclarations(f, blocks[blocks.length - 1].open, false), "the rule's");
  } else if (f.kind === "js" || f.kind === "html") {
    if (span.slot !== "class") property = ownerOnLine(f, span.start);
    if (property && /^(--|\$)/.test(property)) definition = property;
    const tag = enclosingTag(f, span.start);
    if (tag) {
      component = tag.name;
      const th = tagHints(tag.name, tag.text);
      hintParts.push(th.hints);
      stateWords.push(tag.name, th.classes);
      for (const s of th.states) states.add(s);
      // An attribute value only at the tag's own level: `name = "…"` inside a `{…}` expression
      // (`onMouseEnter={() => { el.style.background = "#fff" }}`) is JS, not an attribute.
      if (span.slot !== "class" && braceDepth(f, span.start - tag.text.length, span.start) === 0) {
        attribute = tag.text.match(/(?:^|\s)([A-Za-z_:@][-\w:.]*)\s*=\s*$/)?.[1] ?? null;
      }
    }
    const blocks = f.kind === "js" ? enclosingBlocks(f, span.start) : [];
    // Enclosing object keys and variable names (`palette / dark / bg`); raw code around them is noise.
    const keys = blocks
      .map((b) => b.prelude.match(/(?:([\w$-]+)['"]?\s*[:=]\s*(?:\([^)]*\)\s*=>\s*\(?)?|(?:const|let|var)\s+([\w$]+)[^=]*=\s*)$/))
      .map((m) => m?.[1] ?? m?.[2])
      .filter((k): k is string => !!k)
      .reverse();
    if (span.slot !== "class") selector = keys.length ? keys.join(" / ") : null;
    hintParts.push(...keys);
    stateWords.push(...keys);
    // The literal's own object (`{ background: "#111", color: "#fff" }`), not a function body.
    const object = blocks[0];
    if (span.slot !== "class" && object && /[{(:=,[?]$|\breturn$/.test(t.slice(Math.max(0, object.open - 8), object.open).trimEnd())) {
      surface = surfaceFromDecls(ownDeclarations(f, object.open, true), "the style object's");
    }
    // A style attribute's element can paint its background with a class: `<div className="bg-blue-600" style={{ color: "#fff" }}>`.
    if (span.slot !== "class" && !surface && tag) {
      const cls = tag.text.match(/\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])([^"'`]*)\3)/);
      const list = cls?.[1] ?? cls?.[2] ?? cls?.[4];
      if (list) surface = surfaceFromClasses(list, []);
    }
    maskedBy = maskedAt(f, span.start);
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

  const own = [...hintParts, property ?? "", definition ?? ""];
  const hints = [...hintParts, ...chainParts, property ?? "", definition ?? ""].join(" ");
  for (const s of wordStates([...stateWords, property ?? "", definition ?? ""])) states.add(s);
  // Words outside the selector chain hold as written: each says its groups.
  for (const g of groupsOf(new Set([...states].filter((s) => !s.startsWith("group:") && !chainOnly.has(s))))) states.add(`group:${g}`);
  const data = isDataObject(f, span, property);
  const marked = themeOf(darkParts);
  const theme = marked ?? (/(?:^|[/._-])dark(?:[/._-]|$)/i.test(f.rel) ? "dark" : opts.defaultTheme);
  return { property, selector, component, theme, variants, definition, data, hints, ownHints: own.join(" "), chain: chainParts, inCss: css, attribute, states: [...states], surface, maskedBy, island };
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
