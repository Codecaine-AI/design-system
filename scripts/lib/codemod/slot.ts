/**
 * Where a literal's value goes, and whether that place is known to reach CSS.
 *
 * JS: the holder of the literal's whole expression (walking out through ternaries, `||`, `??`,
 * `&&` and parentheses): an object key, an assignment, a call argument, a JSX attribute, a return
 * value. A value reaches CSS only in a CSS template, a JSX style object (`style={{…}}`), an object a
 * style-named holder or a CSSProperties type holds, `el.style.x = …`, `style.setProperty(…)`, or an
 * SVG presentation attribute of a DOM element. Everything else (settings, palettes, chart options,
 * canvas 2D, comparisons, call arguments, text) is not known to reach CSS.
 *
 * Markup (HTML, Vue, Svelte, Astro, Markdown): only <style> bodies, style attributes, class
 * attributes and SVG presentation attributes; never element text, other attributes, HTML's own
 * bgcolor or <font color>, script blocks or Markdown prose and code.
 */

import { attributeAt } from "./context.ts";
import type { Span } from "./locate.ts";
import { cssRegionAt, type SourceFile } from "./source.ts";

const QUOTE = /["'`]/;
const isId = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);

/** CSS properties (unprefixed, kebab-case) a literal's key or attribute may name. */
const CSS_PROPERTIES = new Set(
  (
    "accent-color align-content align-items align-self animation animation-delay animation-duration animation-timing-function " +
    "appearance aspect-ratio backdrop-filter background background-attachment background-blend-mode background-clip " +
    "background-color background-image background-origin background-position background-position-x background-position-y " +
    "background-repeat background-size block-size border border-block border-block-color border-block-end " +
    "border-block-end-color border-block-end-style border-block-end-width border-block-start border-block-start-color " +
    "border-block-start-style border-block-start-width border-block-style border-block-width border-bottom " +
    "border-bottom-color border-bottom-left-radius border-bottom-right-radius border-bottom-style border-bottom-width " +
    "border-collapse border-color border-end-end-radius border-end-start-radius border-image border-image-source " +
    "border-inline border-inline-color border-inline-end border-inline-end-color border-inline-end-style " +
    "border-inline-end-width border-inline-start border-inline-start-color border-inline-start-style " +
    "border-inline-start-width border-inline-style border-inline-width border-left border-left-color border-left-style " +
    "border-left-width border-radius border-right border-right-color border-right-style border-right-width border-spacing " +
    "border-start-end-radius border-start-start-radius border-style border-top border-top-color border-top-left-radius " +
    "border-top-right-radius border-top-style border-top-width border-width bottom box-shadow box-sizing caret-color clip-path " +
    "color color-scheme column-gap column-rule column-rule-color column-rule-style column-rule-width columns content cursor " +
    "display fill fill-opacity filter flex flex-basis flood-color flood-opacity font font-family font-feature-settings " +
    "font-size font-size-adjust font-stretch font-style font-variant font-variant-numeric font-variation-settings " +
    "font-weight gap grid-column-gap grid-gap grid-row-gap grid-template-columns grid-template-rows height inline-size inset " +
    "inset-block inset-block-end inset-block-start inset-inline inset-inline-end inset-inline-start left letter-spacing " +
    "lighting-color line-height list-style margin margin-block margin-block-end margin-block-start margin-bottom " +
    "margin-inline margin-inline-end margin-inline-start margin-left margin-right margin-top mask mask-image mask-position " +
    "mask-size max-block-size max-height max-inline-size max-width min-block-size min-height min-inline-size min-width " +
    "mix-blend-mode opacity outline outline-color outline-offset outline-style outline-width padding padding-block " +
    "padding-block-end padding-block-start padding-bottom padding-inline padding-inline-end padding-inline-start " +
    "padding-left padding-right padding-top right row-gap scroll-margin scroll-padding scrollbar-color stop-color " +
    "stop-opacity stroke stroke-dasharray stroke-opacity stroke-width tab-size tap-highlight-color text-decoration " +
    "text-decoration-color text-decoration-thickness text-emphasis-color text-fill-color text-indent text-shadow " +
    "text-stroke text-stroke-color text-underline-offset top transform transition translate width word-spacing z-index"
  ).split(" "),
);

/** The kebab-case CSS property a key names (`backgroundColor`, `WebkitMaskImage`, `--x`), or null. */
export function cssPropertyName(key: string | null | undefined): string | null {
  if (!key) return null;
  if (/^--[\w-]+$/.test(key)) return key;
  const kebab = /[A-Z]/.test(key) ? key.replace(/^(Webkit|Moz|O|ms)(?=[A-Z])/, (m) => `-${m.toLowerCase()}`).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`) : key;
  return CSS_PROPERTIES.has(kebab.replace(/^-(?:webkit|moz|ms|o)-/, "")) ? kebab : null;
}

/** SVG presentation attributes that take a color, a font size or a family: CSS values, so var() resolves. */
const PRESENTATION = /^(?:fill|stroke|color|stop-color|flood-color|lighting-color|font-size|font-family)$/;
/** HTML's legacy color attributes (`<td bgcolor>`, `<font color>`): HTML parses them, so var() does not resolve. */
const LEGACY_COLOR = /^(?:font|basefont|body|table|tr|td|th|hr|marquee)$/i;

function presentation(name: string, tag: string): Slot | null {
  const k = kebab(name);
  if (k === "bgcolor" || (k === "color" && LEGACY_COLOR.test(tag))) return no(`the ${name} attribute of <${tag}> is HTML's own color, where var() does not resolve`);
  return PRESENTATION.test(k) ? { ok: true, property: k, how: `the ${k} attribute` } : null;
}
/** JSX attributes that take a style object. */
const STYLE_ATTR = /^(?:style|sx|css|[\w$]*Style)$/;
/** ECharts option keys named like styles (`itemStyle: { color }`): not CSS, unless the file uses recharts, whose props they are. */
const CHART_STYLE_KEY = /^(?:textStyle|itemStyle|lineStyle|areaStyle|crossStyle|handleStyle|moveHandleStyle|nodeStyle|edgeStyle|backgroundStyle|shadowStyle|dataBackground)$/;
const CSS_TYPE = /\bCSSProperties\b|\bCSS\.Properties\b/;

const nameWords = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A holder named for a style: `style`, `styles`, `chipStyle`, `STYLE`, `css`, `sx`. */
export function styleNamed(name: string | null | undefined): boolean {
  if (!name) return false;
  return nameWords(name).some((w) => w === "style" || w === "styles" || w === "css" || w === "sx");
}

const kebab = (name: string) => name.replace(/^(?:v-bind)?:/, "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// ---------------------------------------------------------------------------
// JS strings and brackets

/** The index of the quote that opens the string or template run reaching back from `a`, or -1. */
function stringStart(f: SourceFile, a: number): number {
  const s = f.inStr!;
  for (;;) {
    while (a > 0 && s[a - 1] === 1) a--;
    const q = f.src[a - 1];
    if (q !== undefined && QUOTE.test(q)) return a - 1;
    if (q !== "}") return -1;
    // The end of a ${…} inside a template: skip back over the interpolation.
    let depth = 0;
    let j = a - 1;
    for (; j >= 0; j--) {
      if (s[j] === 1) continue;
      if (f.src[j] === "}") depth++;
      else if (f.src[j] === "{" && --depth === 0) break;
    }
    if (j < 1 || f.src[j - 1] !== "$") return -1;
    a = j - 1;
  }
}

/** The index just past the quote that closes the string or template run from `b`, or -1. */
function stringEnd(f: SourceFile, b: number): number {
  const s = f.inStr!;
  const n = f.src.length;
  for (;;) {
    while (b < n && s[b] === 1) b++;
    const q = f.src[b];
    if (q !== undefined && QUOTE.test(q)) return b + 1;
    if (q !== "$" || f.src[b + 1] !== "{") return -1;
    let depth = 0;
    let j = b + 1;
    for (; j < n; j++) {
      if (s[j] === 1) continue;
      if (f.src[j] === "{") depth++;
      else if (f.src[j] === "}" && --depth === 0) break;
    }
    if (j >= n) return -1;
    b = j + 1;
  }
}

/** [start, end) of the whole JS string or template literal holding `i`, quotes included, or null. */
export function stringAt(f: SourceFile, i: number): [number, number] | null {
  if (!f.inStr || f.inStr[i] !== 1) return null;
  const a = stringStart(f, i);
  const b = stringEnd(f, i);
  return a < 0 || b < 0 ? null : [a, b];
}

/** [start, end) of the literal's whole JS value: the string or template holding it, or the span itself. */
export function valueRange(f: SourceFile, span: Span): [number, number] {
  return stringAt(f, span.start) ?? [span.start, span.end];
}

const prevSig = (f: SourceFile, i: number) => {
  let k = i - 1;
  while (k >= 0 && /\s/.test(f.text[k])) k--;
  return k;
};
const nextSig = (f: SourceFile, i: number) => {
  let k = i;
  while (k < f.text.length && /\s/.test(f.text[k])) k++;
  return k;
};

/** The unmatched `(`, `[` or `{` enclosing `from` (outside strings), or -1. */
function enclosingOpen(f: SourceFile, from: number): number {
  let depth = 0;
  for (let k = from - 1; k >= 0; k--) {
    if (f.inStr![k] === 1) continue;
    const ch = f.text[k];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

/** The index of the bracket closing the one at `open`, or -1. */
function matchingClose(f: SourceFile, open: number): number {
  let depth = 0;
  for (let k = open; k < f.text.length; k++) {
    if (f.inStr![k] === 1) continue;
    const ch = f.text[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ")" || ch === "]" || ch === "}") && --depth === 0) return k;
  }
  return -1;
}

/** Depth-0 commas between an opener and `to`: the argument index. */
function commasBetween(f: SourceFile, open: number, to: number): number {
  let depth = 0;
  let n = 0;
  for (let k = open + 1; k < to; k++) {
    if (f.inStr![k] === 1) continue;
    const ch = f.text[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) n++;
  }
  return n;
}

/** Words before a `(` that make it a group, not a call. */
const NOT_CALLEE = /^(?:return|typeof|await|void|delete|yield|in|of|case|else|do|new|throw|instanceof)$/;

/** The callee before a call's `(` (`a.b.c`, `useMemo`) and where it starts; name "" for a plain group. */
function calleeBefore(f: SourceFile, open: number): { name: string; start: number } {
  let k = prevSig(f, open);
  // Type arguments: `useMemo<CSSProperties>(…)`.
  if (f.text[k] === ">" && f.text[k - 1] !== "=") {
    let depth = 0;
    for (; k >= 0; k--) {
      if (f.text[k] === ">") depth++;
      else if (f.text[k] === "<" && --depth === 0) break;
    }
    k = prevSig(f, k);
  }
  const end = k + 1;
  while (k >= 0 && (isId(f.text[k]) || f.text[k] === "." || (f.text[k] === "?" && f.text[k + 1] === "."))) k--;
  const name = f.text.slice(k + 1, end).replace(/\?\./g, ".");
  // `...(` spreads a group; `return (` groups.
  return NOT_CALLEE.test(name) || !/[\w$]/.test(name) ? { name: "", start: open } : { name, start: k + 1 };
}

/** Statement text from the last `;` or unmatched opener before `eq` up to `eq` (the left side of an `=`). */
function leftSide(f: SourceFile, eq: number): string {
  let depth = 0;
  let k = eq - 1;
  for (; k >= 0; k--) {
    if (f.inStr![k] === 1) continue;
    const ch = f.text[k];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && ch === ";") break;
    else if (depth === 0 && ch === "=" && f.text[k + 1] !== ">" && !/[=!<>]/.test(f.text[k - 1] ?? "") && f.text[k + 1] !== "=") break;
  }
  return f.src.slice(k + 1, eq);
}

/** An unclosed `<` right after a name between the statement start and `vs`: a type argument (`useState<"#fff">`). */
function inTypeArgs(f: SourceFile, vs: number): boolean {
  let depth = 0;
  let angle = 0;
  for (let k = vs - 1; k >= 0; k--) {
    if (f.inStr![k] === 1) continue;
    const ch = f.text[k];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) return false;
      depth--;
    } else if (depth > 0) continue;
    else if (ch === ";" || (ch === "=" && f.text[k + 1] !== ">" && f.text[k + 1] !== "=" && !/[=!<>]/.test(f.text[k - 1] ?? ""))) return false;
    else if (ch === ">" && f.text[k - 1] !== "=") angle++;
    else if (ch === "<") {
      if (angle > 0) angle--;
      else return isId(f.text[k - 1]) || f.text[k - 1] === ".";
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Holders

export type Holder =
  | { kind: "key"; key: string | null; open: number }
  | { kind: "assign"; lhs: string }
  | { kind: "attr"; name: string; tag: string }
  | { kind: "arg"; callee: string; calleeStart: number; index: number; open: number }
  | { kind: "array"; open: number }
  | { kind: "spread"; open: number }
  | { kind: "arrow"; at: number }
  | { kind: "return"; at: number }
  | { kind: "template"; start: number; end: number }
  | { kind: "type"; why: string }
  | { kind: "other"; why: string };

type Boundary = { at: number; kind: "colon" | "assign" | "arrow" | "open" | "comma" | "semi" | "start" };

/**
 * What ends the expression that starts at `vs`, walking back: an unpaired `:` (a key or an
 * annotation; ternary colons pair with their `?`), an `=`, an `=>`, an unmatched opener, a `,` or a `;`.
 */
function boundaryBefore(f: SourceFile, vs: number): Boundary {
  const t = f.text;
  let depth = 0;
  const marks: Array<{ at: number; q: boolean; optional?: boolean }> = [];
  let stop: Boundary = { at: -1, kind: "start" };
  for (let k = vs - 1; k >= 0; k--) {
    if (f.inStr![k] === 1) continue;
    const ch = t[k];
    if (ch === ")" || ch === "]" || ch === "}") {
      depth++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      stop = { at: k, kind: "open" };
      break;
    }
    if (depth > 0) continue;
    if (ch === ";") {
      stop = { at: k, kind: "semi" };
      break;
    }
    if (ch === ",") {
      stop = { at: k, kind: "comma" };
      break;
    }
    if (ch === "=") {
      if (t[k + 1] === ">") {
        stop = { at: k, kind: "arrow" };
        break;
      }
      if (t[k + 1] === "=" || /[=!<>]/.test(t[k - 1] ?? "")) continue;
      stop = { at: k, kind: "assign" };
      break;
    }
    if (ch === "?") {
      if (t[k + 1] === "." || t[k + 1] === "?" || t[k - 1] === "?") continue;
      marks.push({ at: k, q: true });
      continue;
    }
    if (ch === ":" && t[k - 1] !== ":" && t[k + 1] !== ":") {
      // `a?: T`: an optional member's annotation, never a ternary colon.
      if (t[k - 1] === "?") {
        marks.push({ at: k, q: false, optional: true });
        k--;
      } else marks.push({ at: k, q: false });
    }
  }
  // Left to right, a `?` opens a ternary and the next `:` closes it; the rightmost unpaired `:` ends the expression.
  let open = 0;
  let colon = -1;
  for (const m of marks.reverse()) {
    if (m.q) open++;
    else if (open > 0 && !m.optional) open--;
    else colon = m.at;
  }
  return colon >= 0 ? { at: colon, kind: "colon" } : stop;
}

/** An object or class body that is a type: an interface, a type literal alias, a class. */
function isTypeBody(f: SourceFile, open: number): boolean {
  let p = open - 1;
  while (p >= 0 && !";{}".includes(f.text[p])) p--;
  return /\b(?:interface\s+[\w$]+|type\s+[\w$]+(?:<[^>]*>)?\s*=|class\s+[\w$]+)[^{]*$/.test(f.text.slice(p + 1, open));
}

/** The key before the colon at `c`, where the key starts, and whether it is a type annotation. */
function keyBefore(f: SourceFile, c: number): { key: string | null; start: number } | { type: string } | null {
  const t = f.text;
  if (t[c - 1] === "?") return { type: "an optional member's type, not a value" };
  const q = prevSig(f, c);
  if (q < 0) return null;
  if (t[q] === ")") return { type: "a return type, not a value" };
  if (QUOTE.test(t[q])) {
    const a = f.inStr![q - 1] === 1 ? stringStart(f, q - 1) : q - 1;
    return a < 0 ? null : { key: f.src.slice(a + 1, q), start: a };
  }
  if (t[q] === "]") {
    let depth = 0;
    let k = q;
    for (; k >= 0; k--) {
      if (f.inStr![k] === 1) continue;
      if (t[k] === "]") depth++;
      else if (t[k] === "[" && --depth === 0) break;
    }
    return { key: null, start: k };
  }
  if (!isId(t[q])) return null;
  let k = q;
  while (k > 0 && isId(t[k - 1])) k--;
  return { key: t.slice(k, q + 1), start: k };
}

/**
 * The holder of the JS expression in [vs, ve): what the value is assigned to, keyed under, passed
 * to or returned from. `attribute` is the JSX attribute whose quoted value starts at `vs`, if any.
 */
export function holderOf(f: SourceFile, vs: number, ve: number): Holder {
  const t = f.text;
  for (let guard = 0; guard < 6; guard++) {
    // A JSX attribute value (`fill="#fff"`, `fontSize={12}`): its `>` is the tag's, not a comparison.
    const quoted = /["'`{]/.test(t[vs] ?? "") ? attributeAt(f, vs) : null;
    if (quoted) return { kind: "attr", name: quoted.name, tag: quoted.tag };
    if (inTypeArgs(f, vs)) return { kind: "type", why: "a type argument, not a value" };
    const n = nextSig(f, ve);
    const after = t.slice(n, n + 11);
    if (/^(?:===?|!==?|<=?|>=?|instanceof\b|in\b)/.test(after) && !after.startsWith("=>")) return { kind: "other", why: "compared, not a CSS value" };
    if (/^\?(?![.?])/.test(after)) return { kind: "other", why: "a condition, not a CSS value" };
    if (/^[.[]/.test(after) && !/^\.\d/.test(after)) return { kind: "other", why: "a method call or an index on the literal, not a CSS value" };
    const p = prevSig(f, vs);
    const two = t.slice(Math.max(0, p - 2), p + 1);
    if (/(?:===?|!==?|[^=]<=?|[^=]>=?)$/.test(two) && !two.endsWith("=>")) return { kind: "other", why: "compared, not a CSS value" };
    const word = t.slice(Math.max(0, p - 12), p + 1).match(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/)?.[1];
    if (word === "as" || word === "satisfies" || word === "extends" || word === "keyof") return { kind: "type", why: "a type, not a value" };
    if (word === "case") return { kind: "other", why: "a switch case, not a CSS value" };
    if (word === "return") return { kind: "return", at: p - 5 };
    if (word === "in" || word === "instanceof" || word === "typeof") return { kind: "other", why: "compared, not a CSS value" };

    const b = boundaryBefore(f, vs);
    const seg = t.slice(b.at + 1, vs);
    const kw = seg.match(/^\s*(return|throw|yield|default|export|await|new|void|delete)\b/)?.[1];
    if (kw === "return") return { kind: "return", at: b.at + 1 + seg.indexOf("return") };
    if (kw) return { kind: "other", why: `after \`${kw}\`, not a CSS value` };
    switch (b.kind) {
      case "colon": {
        const k = keyBefore(f, b.at);
        if (!k) return { kind: "other", why: "a label, not a CSS value" };
        if ("type" in k) return { kind: "type", why: k.type };
        const w = t.slice(Math.max(0, k.start - 16), k.start).match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
        if (w && /^(?:const|let|var|readonly|declare|public|private|protected|static|abstract|accessor)$/.test(w)) return { kind: "type", why: "a type annotation, not a value" };
        const open = enclosingOpen(f, k.start);
        if (open < 0) return { kind: "other", why: "a label, not a CSS value" };
        if (t[open] === "(" || t[open] === "[") return { kind: "type", why: "a parameter's type, not a value" };
        if (isTypeBody(f, open)) return { kind: "type", why: "a type member, not a value" };
        return { kind: "key", key: k.key, open };
      }
      case "assign": {
        const attr = attributeAt(f, vs);
        if (attr) return { kind: "attr", name: attr.name, tag: attr.tag };
        return { kind: "assign", lhs: leftSide(f, b.at) };
      }
      case "arrow":
        return { kind: "arrow", at: b.at };
      case "open": {
        const o = b.at;
        if (t[o] === "{") {
          if (t[o - 1] === "$") {
            // A ${…} interpolation: the template holds the value.
            const start = stringStart(f, o - 1);
            const end = stringEnd(f, matchingClose(f, o) + 1);
            if (start < 0 || end < 0) return { kind: "other", why: "a template interpolation" };
            return { kind: "template", start, end };
          }
          const attr = attributeAt(f, o);
          if (attr) return { kind: "attr", name: attr.name, tag: attr.tag };
          // `{ ...(on ? { color: "#fff" } : {}) }`: a spread's object merges into this one.
          if (/^\s*\.\.\.\s*$/.test(seg)) return { kind: "spread", open: o };
          return { kind: "other", why: "JSX text or a block, not a style" };
        }
        if (t[o] === "[") {
          const before = t[prevSig(f, o)];
          if (isId(before) || before === ")" || before === "]") return { kind: "other", why: "an index, not a CSS value" };
          return { kind: "array", open: o };
        }
        const callee = calleeBefore(f, o);
        if (/^(?:if|while|for|switch|catch|with)$/.test(callee.name)) return { kind: "other", why: "a condition, not a CSS value" };
        if (!callee.name) {
          // A parenthesized group: its holder holds the value.
          const close = matchingClose(f, o);
          if (close < 0) return { kind: "other", why: "an unclosed group" };
          vs = o;
          ve = close + 1;
          continue;
        }
        return { kind: "arg", callee: callee.name, calleeStart: callee.start, index: commasBetween(f, o, vs), open: o };
      }
      case "comma": {
        const o = enclosingOpen(f, b.at);
        if (o < 0) return { kind: "other", why: "a declaration list or a sequence, not a CSS value" };
        if (t[o] === "[") return { kind: "array", open: o };
        if (t[o] === "(") {
          const callee = calleeBefore(f, o);
          if (!callee.name) return { kind: "other", why: "a sequence or a parameter list, not a CSS value" };
          return { kind: "arg", callee: callee.name, calleeStart: callee.start, index: commasBetween(f, o, vs), open: o };
        }
        if (t[o] === "{" && /^\s*\.\.\.\s*$/.test(seg)) return { kind: "spread", open: o };
        return { kind: "other", why: "a list item, not a CSS value" };
      }
      default:
        return { kind: "other", why: "a statement, not a CSS value" };
    }
  }
  return { kind: "other", why: "nested too deep to read" };
}

// ---------------------------------------------------------------------------
// Canvas 2D

const CANVAS_PROP = /\.\s*(?:fillStyle|strokeStyle|shadowColor|font|filter|letterSpacing|wordSpacing)\s*$/;

/**
 * Whether the literal's expression is assigned to a canvas 2D property (`ctx.fillStyle = a ? "#fff"
 * : "#000"`, `ctx.strokeStyle = pen.color || "#fff"`) or is a gradient stop (`addColorStop(0, "#fff")`):
 * var() does not resolve there.
 */
export function isCanvasValue(f: SourceFile, span: Span): boolean {
  if (f.kind !== "js" || !f.inStr || cssRegionAt(f, span.start)) return false;
  const [vs, ve] = valueRange(f, span);
  const h = holderOf(f, vs, ve);
  // `el.style.filter = …` and `el.style.font = …` are CSS, not canvas.
  if (h.kind === "assign") return CANVAS_PROP.test(h.lhs) && !/\.style\s*\.\s*[\w$]+\s*$/.test(h.lhs);
  return h.kind === "arg" && /(?:^|\.)addColorStop$/.test(h.callee) && h.index === 1;
}

// ---------------------------------------------------------------------------
// Does it reach CSS?

export type Slot = { ok: true; property: string | null; how: string } | { ok: false; why: string };

const no = (why: string): Slot => ({ ok: false, why: `not known to reach CSS (${why}): edit by hand` });

function importsFrom(f: SourceFile, pkg: RegExp): boolean {
  for (const m of f.text.matchAll(/\bfrom\s*(["'])([^"'\n]+)\1/g)) if (pkg.test(m[2])) return true;
  return false;
}

/** The name and type a declaration or assignment's left side gives (`const chipStyle: CSSProperties`, `this.style.color`). */
function leftName(lhs: string): { name: string | null; type: string } {
  // The left side can run back over earlier statements without semicolons: the last declaration
  // is ours only when nothing but its type follows its name.
  const decl = [...lhs.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*/g)].pop();
  if (decl) {
    const rest = lhs.slice(decl.index! + decl[0].length);
    if (/^(?::[\s\S]*)?$/.test(rest.trim())) return { name: decl[1], type: rest.replace(/^\s*:/, "") };
  }
  return { name: lhs.match(/([\w$]+)\s*$/)?.[1] ?? null, type: "" };
}

/** The function an arrow at `arrow` (the `=` of `=>`) belongs to: where it starts, and its return type text. */
function arrowStart(f: SourceFile, arrow: number): { start: number; returnType: string } {
  const t = f.text;
  let k = prevSig(f, arrow);
  let returnType = "";
  if (t[k] !== ")" && !isId(t[k])) return { start: k + 1, returnType };
  if (t[k] !== ")") {
    // `x => …`, or a return type `(…): T => …`.
    let a = k;
    while (a > 0 && /[\w$.<>[\]\s|,]/.test(t[a - 1]) && t[a - 1] !== ")") a--;
    const colon = prevSig(f, a);
    if (t[colon] === ":" && t[prevSig(f, colon)] === ")") {
      returnType = f.src.slice(colon + 1, arrow);
      k = prevSig(f, colon);
    } else {
      let s = k;
      while (s > 0 && isId(t[s - 1])) s--;
      return { start: s, returnType };
    }
  }
  let depth = 0;
  for (; k >= 0; k--) {
    if (f.inStr![k] === 1) continue;
    if (t[k] === ")") depth++;
    else if (t[k] === "(" && --depth === 0) break;
  }
  let start = k;
  const before = t.slice(Math.max(0, k - 8), k);
  const m = before.match(/async\s*$/);
  if (m) start -= m[0].length;
  return { start, returnType };
}

/** The function a `return` at `at` returns from: its name, the text before its body, and (for an arrow) where the arrow starts. */
function returningFunction(f: SourceFile, at: number): { prelude: string; arrow: number | null } | null {
  let from = at;
  for (let hop = 0; hop < 12; hop++) {
    const o = enclosingOpen(f, from);
    if (o < 0) return null;
    if (f.text[o] !== "{") {
      from = o;
      continue;
    }
    let p = o - 1;
    while (p >= 0 && !";{}".includes(f.text[p])) p--;
    const prelude = f.src.slice(p + 1, o);
    if (/\b(?:if|for|while|switch|catch|with)\s*\([\s\S]*\)\s*$|\b(?:else|try|finally|do)\s*$/.test(prelude) || /^\s*$/.test(prelude)) {
      from = o;
      continue;
    }
    const arrow = /=>\s*$/.test(f.text.slice(p + 1, o)) ? f.text.lastIndexOf("=>", o) : null;
    return { prelude, arrow };
  }
  return null;
}

const WRAPPERS = /^(?:(?:React\.)?useMemo|Object\.freeze|freeze|structuredClone)$/;

/** Whether the object literal opening at `open` is a CSS object, and how. */
function cssObject(f: SourceFile, open: number): Slot {
  let vs = open;
  let ve = matchingClose(f, open) + 1;
  for (let hop = 0; hop < 10; hop++) {
    if (ve > 0 && /^\s*(?:as|satisfies)\s+(?:React\.)?CSS(?:Properties|\.Properties)\b/.test(f.text.slice(ve, ve + 60))) return { ok: true, property: null, how: "a CSSProperties object" };
    const h = holderOf(f, vs, ve);
    switch (h.kind) {
      case "attr":
        // style={{…}} on an element, or a component's style prop (recharts' contentStyle, a Box's style).
        return STYLE_ATTR.test(h.name) ? { ok: true, property: null, how: `a JSX ${h.name} object` } : no(`the ${h.name} prop of <${h.tag}> is not a style`);
      case "key": {
        const key = h.key ?? "";
        if (CHART_STYLE_KEY.test(key) && !(importsFrom(f, /^recharts$/) && !importsFrom(f, /echarts/))) return no(`${key} is a chart option, not CSS`);
        if (styleNamed(key)) return { ok: true, property: null, how: `the ${key} object` };
        if (h.open < 0) return no(`an object under ${key}`);
        // A nested selector (`"&:hover": {…}`) or a plain group key: the parent object decides.
        vs = h.open;
        ve = matchingClose(f, h.open) + 1;
        continue;
      }
      case "assign": {
        const { name, type } = leftName(h.lhs);
        if (CSS_TYPE.test(type)) return { ok: true, property: null, how: "a CSSProperties object" };
        if (styleNamed(name)) return { ok: true, property: null, how: `the ${name} object` };
        return no(`an object held by ${name ?? "a variable"}`);
      }
      case "arg": {
        if (/^Object\.assign$/.test(h.callee) && h.index > 0 && /\.style\s*$/.test(f.text.slice(h.open + 1, f.text.indexOf(",", h.open)))) return { ok: true, property: null, how: "Object.assign onto a style" };
        if (/^(?:css|sx|style)$/.test(h.callee)) return { ok: true, property: null, how: `an argument to ${h.callee}()` };
        // `useMemo<CSSProperties>(() => ({…}))`.
        if (CSS_TYPE.test(f.text.slice(h.calleeStart, h.open))) return { ok: true, property: null, how: "a CSSProperties object" };
        if (WRAPPERS.test(h.callee)) {
          // useMemo(() => ({…}), deps), Object.freeze({…}): the call's holder decides.
          vs = h.calleeStart;
          ve = matchingClose(f, h.open) + 1;
          continue;
        }
        return no(`an argument to ${h.callee}()`);
      }
      case "array":
      case "spread":
        vs = h.open;
        ve = matchingClose(f, h.open) + 1;
        continue;
      case "arrow": {
        const fn = arrowStart(f, h.at);
        if (CSS_TYPE.test(fn.returnType)) return { ok: true, property: null, how: "returned as CSSProperties" };
        vs = fn.start;
        ve = nextFunctionEnd(f, h.at, ve);
        continue;
      }
      case "return": {
        const fn = returningFunction(f, h.at);
        if (!fn) return no("a function's return value");
        if (CSS_TYPE.test(fn.prelude)) return { ok: true, property: null, how: "returned as CSSProperties" };
        const name = fn.prelude.match(/function\s*\*?\s*([\w$]+)/)?.[1] ?? fn.prelude.match(/([\w$]+)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)/)?.[1] ?? fn.prelude.match(/([\w$]+)\s*\([^)]*\)\s*(?::[^{]*)?$/)?.[1];
        if (styleNamed(name)) return { ok: true, property: null, how: `returned by ${name}()` };
        if (fn.arrow !== null) {
          const a = arrowStart(f, fn.arrow);
          vs = a.start;
          ve = nextFunctionEnd(f, fn.arrow, ve);
          continue;
        }
        return no(`returned by ${name ?? "a function"}()`);
      }
      case "template":
        return no("an object inside a template");
      case "type":
        return no(h.why);
      default:
        return no(h.why);
    }
  }
  return no("held too far out to read");
}

/** Where an arrow function's body ends (for the neighbour check of its holder): past the value end we already know. */
function nextFunctionEnd(f: SourceFile, arrow: number, known: number): number {
  const body = nextSig(f, arrow + 2);
  if (f.text[body] === "{" || f.text[body] === "(") {
    const close = matchingClose(f, body);
    return close < 0 ? known : Math.max(known, close + 1);
  }
  return known;
}

/** A JSX/DOM attribute or style-property slot that takes a CSS value. */
function attrSlot(name: string, tag: string, property: string | null): Slot {
  const intrinsic = /^[a-z]/.test(tag) && !tag.includes(".");
  if (!intrinsic) return no(`the ${name} prop of <${tag}> (a component)`);
  const p = presentation(name, tag);
  if (p) return p;
  if (kebab(name) === "style") return { ok: true, property, how: "a style attribute" };
  return no(`the ${name} attribute is not a style`);
}

/**
 * Whether a JS literal (not a Tailwind class) reaches CSS. `property` is the CSS property the slot
 * names (null when the slot does not say, as in a CSS template the caller reads itself).
 */
export function jsSlot(f: SourceFile, span: Span, ctxProperty: string | null): Slot {
  if (cssRegionAt(f, span.start)) return { ok: true, property: ctxProperty, how: "a CSS template" };
  if (!f.inStr) return no("not JS");
  let [vs, ve] = valueRange(f, span);
  for (let hop = 0; hop < 4; hop++) {
    const t = f.text;
    // A tagged CSS template: css`…`, styled.div`…`, keyframes`…`, createGlobalStyle`…`.
    if (t[vs] === "`" && /(?:\bcss|\bstyled(?:\.[\w$]+|\([^)]*\))(?:\.attrs\([^)]*\))?|\bkeyframes|\bcreateGlobalStyle|\binjectGlobal)$/.test(t.slice(Math.max(0, vs - 60), vs))) {
      return { ok: true, property: ctxProperty, how: "a CSS template" };
    }
    const h = holderOf(f, vs, ve);
    switch (h.kind) {
      case "attr":
        return attrSlot(h.name, h.tag, ctxProperty);
      case "key": {
        const prop = cssPropertyName(h.key);
        if (!prop) return no(h.key ? `${h.key} is not a CSS property` : "a computed key");
        const obj = cssObject(f, h.open);
        return obj.ok ? { ok: true, property: prop, how: obj.how } : obj;
      }
      case "assign": {
        const style = h.lhs.match(/\.style\s*(?:\.\s*([\w$]+)|\[\s*(["'`])([^"'`]+)\2\s*\])\s*$/);
        if (style) {
          const name = style[1] ?? style[3];
          if (name === "cssText") return { ok: true, property: ctxProperty, how: "style.cssText" };
          const prop = cssPropertyName(name);
          return prop ? { ok: true, property: prop, how: `style.${name}` } : no(`style.${name} is not a CSS property`);
        }
        const { name, type } = leftName(h.lhs);
        if (/\bCSSProperties\s*\[/.test(type) || /\bProperty\.[A-Z]\w*/.test(type)) return { ok: true, property: ctxProperty, how: "typed as a CSS value" };
        if (/^\s*(?:export\s+)?(?:declare\s+)?type\s+[\w$]+/.test(h.lhs.split(/[\n;]/).pop() ?? "")) return no("a literal type alias");
        return no(`assigned to ${name ?? "a variable"}`);
      }
      case "arg": {
        if (/(?:^|\.)setProperty$/.test(h.callee) && h.index === 1) {
          const first = f.src.slice(h.open + 1, f.text.indexOf(",", h.open)).trim().match(/^["'`](--[\w-]+|[a-z-]+)["'`]$/)?.[1] ?? null;
          return { ok: true, property: first ?? ctxProperty, how: "style.setProperty" };
        }
        if (/(?:^|\.)setAttribute$/.test(h.callee) && h.index === 1) {
          const first = f.src.slice(h.open + 1, f.text.indexOf(",", h.open)).trim().match(/^["'`]([\w:-]+)["'`]$/)?.[1] ?? "";
          if (first === "style") return { ok: true, property: ctxProperty, how: "setAttribute(\"style\")" };
          if (PRESENTATION.test(first)) return { ok: true, property: first, how: `setAttribute("${first}")` };
        }
        return no(`an argument to ${h.callee}()`);
      }
      case "template":
        if (cssRegionAt(f, h.start + 1)) return { ok: true, property: ctxProperty, how: "a CSS template" };
        vs = h.start;
        ve = h.end;
        continue;
      case "array":
        return no("an array element");
      case "spread":
        return no("a spread value");
      case "arrow":
      case "return":
        return no("a function's return value");
      default:
        return no(h.why);
    }
  }
  return no("nested too deep to read");
}

/** Why a JS literal sits in a type rather than a value (`type Tone = "#fff"`, `x: "#fff"`, `useState<"#fff">`), or null. */
export function typePosition(f: SourceFile, span: Span): string | null {
  if (f.kind !== "js" || !f.inStr || cssRegionAt(f, span.start)) return null;
  const [vs, ve] = valueRange(f, span);
  let h = holderOf(f, vs, ve);
  for (let hop = 0; hop < 8; hop++) {
    if (h.kind === "type") return `${h.why}: edit by hand`;
    if (h.kind === "assign") return /^\s*(?:export\s+)?(?:declare\s+)?type\s+[\w$]+/.test(h.lhs.split(/[\n;]/).pop() ?? "") ? "a literal type alias, not a value: edit by hand" : null;
    if (h.kind !== "key" || h.open < 0) return null;
    h = holderOf(f, h.open, matchingClose(f, h.open) + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markup

/** [start, end) of each fenced code block (``` or ~~~) in a Markdown file. */
const fences = new WeakMap<SourceFile, Array<[number, number]>>();

function markdownCode(f: SourceFile): Array<[number, number]> {
  let r = fences.get(f);
  if (r) return r;
  r = [];
  if (/\.mdx?$/i.test(f.rel)) {
    let open: { at: number; mark: string } | null = null;
    let at = 0;
    for (const line of f.src.split("\n")) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (m) {
        if (!open) open = { at, mark: m[1] };
        else if (m[1][0] === open.mark[0] && m[1].length >= open.mark.length && /^ {0,3}[`~]+\s*$/.test(line)) {
          r.push([open.at, at + line.length]);
          open = null;
        }
      } else if (!open) {
        // Inline code spans on a prose line.
        for (const c of line.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) r.push([at + c.index!, at + c.index! + c[0].length]);
      }
      at += line.length + 1;
    }
    if (open) r.push([open.at, f.src.length]);
  }
  fences.set(f, r);
  return r;
}

/** The attribute of an HTML/Vue/Svelte tag whose value holds `i`, and the tag, or null when `i` is not in a tag. */
function markupAttribute(f: SourceFile, i: number): { name: string | null; tag: string } | null {
  const t = f.text;
  for (let p = t.lastIndexOf("<", i - 1); p >= 0 && i - p < 4000; p = t.lastIndexOf("<", p - 1)) {
    const tag = t.slice(p + 1, p + 64).match(/^([A-Za-z][\w.:-]*)/)?.[1];
    if (!tag) continue;
    let q: string | null = null;
    for (let k = p + 1; k < i; k++) {
      const ch = t[k];
      if (q) {
        if (ch === q) q = null;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ">") return null;
    }
    // The name runs back to a space or template syntax (`{{/if}}class="…"`): only its name characters count.
    const name = t.slice(p, i).match(/([A-Za-z_:@][\w:.@-]*)\s*=\s*(?:"[^"]*|'[^']*|[^\s"'<>=`]*)$/)?.[1] ?? null;
    return { name, tag };
  }
  return null;
}

/** Whether a literal in an HTML, Vue, Svelte, Astro or Markdown file sits in a style. Class spans need a class attribute. */
export function markupSlot(f: SourceFile, span: Span, ctxProperty: string | null): Slot {
  if (markdownCode(f).some(([a, b]) => span.start >= a && span.start < b)) return { ok: false, why: "Markdown code, not a style: never changed" };
  if (cssRegionAt(f, span.start)) return { ok: true, property: ctxProperty, how: "a <style> block" };
  const attr = markupAttribute(f, span.start);
  if (!attr || !attr.name) return { ok: false, why: `${/\.mdx?$/i.test(f.rel) ? "Markdown prose" : "element text or a script block"}, not a style: edit by hand` };
  const name = attr.name.replace(/^(?:v-bind:|:|bind:)/, "").replace(/^style:.*/, "style").replace(/^class:.*/, "class");
  if (span.slot === "class") {
    return /^(?:class|className)$/.test(name) ? { ok: true, property: ctxProperty, how: "a class attribute" } : { ok: false, why: `the ${attr.name} attribute is not a class list: edit by hand` };
  }
  if (name === "style") return { ok: true, property: ctxProperty, how: "a style attribute" };
  const p = presentation(name, attr.tag);
  if (p) return p;
  return { ok: false, why: `the ${attr.name} attribute is not a style: edit by hand` };
}
