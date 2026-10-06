/**
 * Where a `--ds-layout-*` declaration sits, for the names check (decision 32, guide/layout.md
 * "To change a size for one app, override the token on the shell"). An override is shell-scoped when:
 * - CSS: every selector of the innermost style rule around it has a subject (its last compound
 *   selector) that carries the `ds-shell` class: `.docs-app.ds-shell { … }`,
 *   `.ds-shell[data-sidebar="collapsed"] { … }`, a nested `&.wide { … }` inside such a rule. At-rules
 *   (`@media`, `@supports`, `@layer`, `@container`) are transparent. `:root`, `.ds-shell .x` and a
 *   selector list with one such selector are not shell-scoped. `:is()` and `:where()` are lists too:
 *   `:is(.ds-shell, .x)` is not shell-scoped, `:where(.ds-shell, .app.ds-shell)` is. A pseudo-element
 *   (`.ds-shell::before`, `.ds-shell:after`) is another box, and `.ds-shell` in an attribute value
 *   (`[data-x=".ds-shell"]`) or in `:not()`/`:has()` says nothing. Read in CSS, SCSS and Less files, HTML
 *   `<style>` blocks and CSS held in one JS string (a template literal's interpolations are opaque).
 * - On the shell element: an HTML `style="…"` attribute or a JSX `style={{ … }}` object on a tag whose
 *   class carries `ds-shell`, or a Tailwind arbitrary property (`[--ds-layout-x:…]`) in a class string
 *   that also holds `ds-shell`.
 * - At run time: `<el>.style.setProperty("--ds-layout-…", …)` where `<el>` is `document.documentElement`
 *   (`…ownerDocument.documentElement`), `querySelector`/`closest` of a selector whose subject carries
 *   `ds-shell`, `getElementsByClassName("ds-shell")[0]`, or a name bound to one of these (`const shell =
 *   …`, up to three deep) or a ref attached to a tag that carries `ds-shell` (`ref={shellRef}`, read as
 *   `shellRef` or `shellRef.current`).
 */

const SHELL_CLASS = /(?<![\w-])ds-shell(?![\w-])/;
const SHELL_SELECTOR = /\.ds-shell(?![\w-])/;
const MAX_ALIAS = 3;

// ---------------------------------------------------------------------------
// Selectors

/** Splits at `sep` outside parentheses, brackets and quotes. */
function splitTop(text: string, sep: (c: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && sep(c)) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Branch lists: the element matches one of the branches. */
const BRANCH_LIST = /^(?:is|where|matches|-webkit-any|-moz-any)$/i;
/** Pseudo-elements, also in their legacy one-colon spelling: another box than the element. */
const PSEUDO_ELEMENT = /::|:(?:before|after|first-line|first-letter)(?![\w-])/i;

/**
 * A compound selector split into its own text and its functional pseudo-classes: the top level with
 * every `[…]` and `(…)` group blanked (a class in an attribute value or a group says nothing there),
 * and each `:name(…)` with its argument.
 */
function compoundParts(compound: string): { top: string; groups: Array<{ name: string; arg: string }> } {
  let top = "";
  const groups: Array<{ name: string; arg: string }> = [];
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (c !== "[" && c !== "(") {
      top += c;
      continue;
    }
    // Skip to the matching bracket, outside quotes.
    const close = c === "[" ? "]" : ")";
    let depth = 0;
    let quote = "";
    let j = i;
    for (; j < compound.length; j++) {
      const d = compound[j];
      if (quote) {
        if (d === "\\") j++;
        else if (d === quote) quote = "";
        continue;
      }
      if (d === '"' || d === "'") quote = d;
      else if (d === c) depth++;
      else if (d === close && --depth === 0) break;
    }
    if (c === "(") {
      const name = /:([\w-]+)$/.exec(top)?.[1];
      if (name) groups.push({ name, arg: compound.slice(i + 1, j) });
    }
    top += c === "[" ? "[]" : "()";
    i = j;
  }
  return { top, groups };
}

/**
 * True when every element the compound matches is the shell: `ds-shell` in its own classes, `&` for a
 * shell parent, or a branch list (`:is()`, `:where()`) whose every branch is the shell. A pseudo-element
 * (`.ds-shell::before`) is not the shell; `:not()`, `:has()` and other groups say nothing.
 */
function compoundIsShell(compound: string, parentShell: boolean): boolean {
  const { top, groups } = compoundParts(compound);
  if (PSEUDO_ELEMENT.test(top)) return false;
  if (SHELL_SELECTOR.test(top) || (parentShell && top.includes("&"))) return true;
  return groups.some((g) => BRANCH_LIST.test(g.name) && selectorListIsShell(g.arg, parentShell));
}

/** True when every selector of the list has a subject that is the shell (`&` stands for a parent that is, when `parentShell`). */
export function selectorListIsShell(list: string, parentShell: boolean): boolean {
  const selectors = splitTop(list, (c) => c === ",").map((s) => s.trim());
  if (!selectors.length || selectors.some((s) => !s)) return false;
  return selectors.every((sel) => {
    const compounds = splitTop(sel, (c) => /[\s>+~]/.test(c)).filter((c) => c.trim());
    return compoundIsShell(compounds[compounds.length - 1] ?? "", parentShell);
  });
}

/**
 * The block preludes around `index` in CSS-like text, innermost first (`.ds-shell`, `@media (…)`).
 * Null when `index` is in no block.
 */
function preludes(text: string, index: number, lo = 0): string[] {
  const out: string[] = [];
  let depth = 0;
  let i = index - 1;
  while (i >= lo) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth > 0) depth--;
      else {
        let j = i - 1;
        while (j >= lo && text[j] !== "{" && text[j] !== "}" && text[j] !== ";") j--;
        out.push(text.slice(j + 1, i).trim());
        i = j;
        continue;
      }
    }
    i--;
  }
  return out;
}

/** True when the innermost style rule around `index` is shell-scoped (see the module comment). */
export function ruleIsShell(text: string, index: number, lo = 0): boolean {
  const chain = preludes(text, index, lo).reverse(); // outermost first
  let shell = false;
  let rules = 0;
  for (const p of chain) {
    if (p.startsWith("@")) continue; // @media, @supports, @layer, @container: transparent
    shell = selectorListIsShell(p, shell);
    rules++;
  }
  return rules > 0 && shell;
}

/**
 * The CSS a JS string holds up to `index`: walks back through the literal (an interpolation reads as
 * `0`) and stops at its opening quote. Returns the text and the offset of `index` in it.
 */
export function cssInString(text: string, inStr: Uint8Array, index: number): string {
  const chars: string[] = [];
  let interp = 0;
  for (let i = index - 1; i >= 0 && index - i < 20_000; i--) {
    if (inStr[i]) {
      if (interp === 0) chars.push(text[i]);
      continue;
    }
    const c = text[i];
    if (interp > 0) {
      if (c === "{" && text[i - 1] === "$") {
        interp--;
        i--;
        if (interp === 0) chars.push("0");
      } else if (c === "}") interp++;
      continue;
    }
    if (c === "}") {
      interp = 1;
      continue;
    }
    break; // the literal's opening quote (or the code before it)
  }
  return chars.reverse().join("");
}

// ---------------------------------------------------------------------------
// Tags

type Mode = "all" | "code" | "string";

/** Is the character at `i` one the scan reads in this mode? */
const reads = (mode: Mode, inStr: Uint8Array | null, i: number) => mode === "all" || !inStr || (mode === "string" ? inStr[i] === 1 : inStr[i] === 0);

/** The opening tag `<x …>` around `index` (start and end offsets); null when `index` is not inside one. */
export function tagAround(text: string, inStr: Uint8Array | null, index: number): [number, number] | null {
  const mode: Mode = !inStr ? "all" : inStr[index] ? "string" : "code";
  let depth = 0;
  let start = -1;
  for (let i = index - 1; i >= 0 && index - i < 20_000; i--) {
    if (!reads(mode, inStr, i)) continue;
    const c = text[i];
    if (c === "}" || c === ")") depth++;
    else if (c === "{" || c === "(") depth--;
    if (depth > 0) continue;
    if (c === ">" && text[i - 1] !== "=") return null;
    if (c === "<" && /[A-Za-z]/.test(text[i + 1] ?? "")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let i = start + 1; i < text.length && i - start < 20_000; i++) {
    if (!reads(mode, inStr, i)) continue;
    const c = text[i];
    if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") depth--;
    else if (c === ">" && depth <= 0 && text[i - 1] !== "=") return i >= index ? [start, i] : null;
  }
  return null;
}

const CLASS_ATTR = /(?<![\w-])class(?:Name)?\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*'|`[^`]*`)/g;

/** True when the tag's class attribute holds `ds-shell`. */
export function tagIsShell(text: string, span: [number, number]): boolean {
  for (const m of text.slice(span[0], span[1] + 1).matchAll(CLASS_ATTR)) if (SHELL_CLASS.test(m[1])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Declarations on the shell element

/** An HTML `style="…"` attribute (or markup in a JS string) on a tag whose class holds `ds-shell`. */
export function inShellStyleAttribute(text: string, inStr: Uint8Array | null, index: number): boolean {
  const span = tagAround(text, inStr, index);
  if (!span) return false;
  const before = text.slice(span[0], index);
  const attr = /(?<![\w-])style\s*=\s*(["'])[^"']*$/.exec(before);
  return attr !== null && tagIsShell(text, span);
}

/** A Tailwind arbitrary property `[--ds-x:…]` in a class string that also holds `ds-shell`. */
export function inShellClassString(text: string, inStr: Uint8Array | null, index: number): boolean {
  if (text[index - 1] !== "[") return false;
  let s = index;
  let e = index;
  if (inStr) {
    if (!inStr[index]) return false;
    while (s > 0 && inStr[s - 1]) s--;
    while (e < text.length && inStr[e]) e++;
  } else {
    while (s > 0 && !/["'\n]/.test(text[s - 1])) s--;
    while (e < text.length && !/["'\n]/.test(text[e])) e++;
  }
  return SHELL_CLASS.test(text.slice(s, e).replace(/\[[^\]]*\]/g, " "));
}

/** A key of the `style={{ … }}` object of a JSX tag whose class holds `ds-shell`. */
export function inShellStyleObject(text: string, inStr: Uint8Array, index: number): boolean {
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= 0 && index - i < 20_000; i--) {
    if (inStr[i]) continue;
    const c = text[i];
    if (c === "}" || c === ")" || c === "]") depth++;
    else if (c === "{" || c === "(" || c === "[") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1 || text[open] !== "{") return false;
  const m = /(?<![\w-])style\s*=\s*\{\s*$/.exec(text.slice(Math.max(0, open - 200), open));
  if (!m) return false;
  const span = tagAround(text, inStr, open);
  return span !== null && tagIsShell(text, span);
}

// ---------------------------------------------------------------------------
// setProperty receivers

/** The receiver of `<el>.style.setProperty(` whose `setProperty` starts at `at`: `<el>` as written; null when the call is not on `.style`. */
function receiverOf(text: string, inStr: Uint8Array, at: number): string | null {
  const before = text.slice(Math.max(0, at - 400), at);
  const m = /([\s\S]*?)[?!]?\s*\.\s*style\s*[?!]?\s*\??\.\s*$/.exec(before);
  if (!m) return null;
  let end = at - (before.length - m[1].length); // offset just after the receiver
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  let i = end - 1;
  for (; i >= 0; i--) {
    if (inStr[i]) continue;
    const c = text[i];
    if (c === ")" || c === "]") {
      let depth = 0;
      for (; i >= 0; i--) {
        if (inStr[i]) continue;
        if (text[i] === ")" || text[i] === "]") depth++;
        else if ((text[i] === "(" || text[i] === "[") && --depth === 0) break;
      }
      continue;
    }
    if (/[\w$.?!<>]/.test(c) || (/\s/.test(c) && /^\s*[.?]/.test(text.slice(i, end)))) continue;
    break;
  }
  const expr = text.slice(i + 1, end).trim();
  return expr || null;
}

/** A receiver expression without whitespace, non-null assertions, `as` casts and enclosing parentheses. */
function normalize(expr: string): string {
  // Outside quotes: drop casts, whitespace, `!` and optional chaining. Selector strings keep their spaces.
  let s = "";
  let quote = "";
  const code = expr.replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]|]+/g, "");
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      s += c;
      if (c === "\\") s += code[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if (/\s/.test(c) || (c === "!" && code[i + 1] !== "=") || (c === "?" && code[i + 1] === ".")) continue;
    s += c;
  }
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0 && i < s.length - 1) closesAtEnd = false;
    }
    if (!closesAtEnd) break;
    s = s.slice(1, -1);
  }
  return s;
}

const DOCUMENT_ELEMENT = /^(?:(?:window|globalThis|self)\.)?document\.documentElement$|\.ownerDocument\.documentElement$/;
const QUERY = /\.(?:querySelector|closest)(?:<[^>]*>)?\((["'`])([^"'`]*)\1\)$/;
const QUERY_ALL = /\.querySelectorAll(?:<[^>]*>)?\((["'`])([^"'`]*)\1\)(?:\[0\]|\.item\(0\))$/;
const BY_CLASS = /\.getElementsByClassName\((["'`])([^"'`]*)\1\)(?:\[0\]|\.item\(0\))$/;
const NAME = /^([A-Za-z_$][\w$]*)(?:\.current)?$/;

export function makeReceiverCheck(text: string, inStr: Uint8Array) {
  const bindings = new Map<string, string>();
  for (const m of text.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=(?![=>])([^;\n]*)/g)) {
    if (inStr[m.index!] || bindings.has(m[1])) continue;
    bindings.set(m[1], m[2]);
  }
  const refShell = new Map<string, boolean>();
  const refOnShell = (name: string): boolean => {
    let v = refShell.get(name);
    if (v !== undefined) return v;
    v = false;
    for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])ref\s*=\s*\{\s*${name.replace(/\$/g, "\\$")}\s*\}`, "g"))) {
      if (inStr[m.index!]) continue;
      const span = tagAround(text, inStr, m.index!);
      if (span && tagIsShell(text, span)) {
        v = true;
        break;
      }
    }
    refShell.set(name, v);
    return v;
  };
  const isShell = (expr: string, depth: number): boolean => {
    const s = normalize(expr);
    if (DOCUMENT_ELEMENT.test(s)) return true;
    const q = QUERY.exec(s) ?? QUERY_ALL.exec(s);
    if (q) return selectorListIsShell(q[2], false);
    const c = BY_CLASS.exec(s);
    if (c) return c[2].split(/\s+/).includes("ds-shell");
    const n = NAME.exec(s);
    if (!n) return false;
    if (refOnShell(n[1])) return true;
    const bound = bindings.get(n[1]);
    return bound !== undefined && depth < MAX_ALIAS && isShell(bound, depth + 1);
  };
  /** True when the `setProperty` call whose name starts at `at` sets the property on the shell element or the root element. */
  return (at: number): boolean => {
    const receiver = receiverOf(text, inStr, at);
    return receiver !== null && isShell(receiver, 0);
  };
}
