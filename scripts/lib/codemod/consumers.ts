/**
 * Where each CSS custom property is read, so a definition takes the role its readers give it
 * (`color: var(--fl-muted)` makes `--fl-muted` text, whatever its name says).
 *
 * Readers, in every scanned file (comments blanked): a declaration or style key whose value holds
 * `var(--x)` (`border: 1px solid var(--x)`, `backgroundColor: "var(--x)"`), a utility class with
 * the variable in brackets or parentheses (`bg-[var(--x)]`, `bg-[--x]`, `text-(--x)`), another
 * custom property (`--y: var(--x)`, followed to its own readers), and for a Tailwind theme variable
 * (`--color-brand`) the utility classes that name it (`bg-brand`, `text-brand`). In JS a key reads
 * only as the whole holder of the string (`{ color: "var(--x)" }`); a ternary, a call argument, a
 * JSX attribute or text reads as `other`, as does any reader with no color role.
 */

import { propRoleOf, type ConsumerIndex, type Reader } from "./color-role.ts";
import { readContext, selectorBranches } from "./context.ts";
import { stringAt } from "./slot.ts";
import { cssRegionAt, lineOf, type SourceFile } from "./source.ts";

/** Utility roots that take a color, and the role each gives. */
const CLASS_ROLE: Record<string, string> = {
  bg: "background", from: "background", via: "background", to: "background",
  text: "text", placeholder: "text", decoration: "text", caret: "text",
  border: "border", "border-x": "border", "border-y": "border", "border-t": "border", "border-r": "border", "border-b": "border", "border-l": "border", "border-s": "border", "border-e": "border",
  // The ring offset is the gap between an element and its ring: it paints the background's color.
  ring: "border", "ring-offset": "background", outline: "border", divide: "border",
  fill: "svgFill", stroke: "svgStroke", accent: "accent",
  shadow: "shadow", "inset-shadow": "shadow", "drop-shadow": "shadow", "text-shadow": "shadow", "inset-ring": "border",
};
const CLASS_ROOTS = Object.keys(CLASS_ROLE).sort((a, b) => b.length - a.length).join("|");
/** Up to four variants before a utility: `hover:`, `dark:md:`, `[&_svg]:`. */
const VARIANTS = "(?:[^\\s:]{1,64}:){0,4}!?-?";
/** One class token naming a theme color: `bg-brand`, `hover:text-card-foreground/80`, `!border-input`. */
const THEME_TOKEN = new RegExp(`^${VARIANTS}(${CLASS_ROOTS})-([a-z][a-z0-9-]*?)(?:\\/[\\w.%\\[\\]]+)?!?$`);
/** One class token reading a variable directly: `text-(--x)`, `bg-(color:--x)`, `bg-[--x]` (Tailwind v3). */
const VAR_TOKEN = new RegExp(`^${VARIANTS}([a-z][a-z-]*?)-(?:\\((?:[a-z-]+:)?(--[\\w-]+)\\)|\\[(?:[a-z-]+:)?(--[\\w-]+)\\])(?:\\/[\\w.%\\[\\]]+)?!?$`);
/** Tailwind theme namespaces whose variables name utility colors, and the roots that read them. */
const THEME_NAMESPACES: Array<[RegExp, RegExp]> = [
  [/^--color-(.+)$/, /./],
  [/^--background-color-(.+)$/, /^(?:bg|from|via|to)$/],
  [/^--text-color-(.+)$/, /^text$/],
  [/^--border-color-(.+)$/, /^(?:border|divide)/],
];

/** Where a reader sits: `src/a.css:12`. */
type Where = string;
/** A reader: its role, where it sits, and how to find the states it paints in (Tailwind variants, or the source position). */
type Use = { role: string; at: Where; variants?: string[]; f?: SourceFile; index?: number } | { def: string; at: Where };
/** A reader inside `color-mix()` derives another color from the variable (`--muted: color-mix(in srgb, var(--fg) 7%, transparent)`): it gives no role. */
const MIX = "color-mix";

export interface Consumers extends ConsumerIndex {
  /** One place per role that reads `name` (directly or through other custom properties). */
  where(name: string): Map<string, Where>;
  readers(name: string): Reader[];
}

/** Tailwind variants that paint only in an interaction state. */
const VARIANT_STATES: Record<string, string> = {
  hover: "hover", "group-hover": "hover", "peer-hover": "hover",
  active: "active", "group-active": "active",
  focus: "focus", "focus-visible": "focus", "focus-within": "focus", "group-focus": "focus",
};

/** The variants in front of a class token: `hover:dark:bg-x` -> ["hover", "dark"]. */
const variantsOf = (token: string): string[] => token.split(":").slice(0, -1).map((v) => v.replace(/^!/, ""));

/** The states a reader paints in: its class variants, or its rule's selector (`.btn:hover`), keys and classes. */
function useStates(use: Extract<Use, { role: string }>): string[] {
  if (use.variants) return [...new Set(use.variants.map((v) => VARIANT_STATES[v]).filter(Boolean))];
  if (!use.f || use.index === undefined) return [];
  const ctx = readContext(use.f, { start: use.index, end: use.index, slot: "text" }, { defaultTheme: "light" });
  const states = ctx.states.filter((x) => !x.startsWith("group:"));
  // A focus selector is a state too (`:focus-visible`), though no role family reads it as one.
  if (ctx.chain.some((prelude) => selectorBranches(prelude).every((b) => /:focus(?:-visible|-within)?(?![\w-])/.test(b)))) states.push("focus");
  return states;
}

export function buildConsumers(files: SourceFile[]): Consumers {
  const uses = new Map<string, Use[]>();
  /** Theme color name -> utility root -> one place that uses it. */
  const classes = new Map<string, Map<string, Where>>();
  /** Theme color name -> every utility class that names it, with its variants. */
  const classUses = new Map<string, Array<{ root: string; at: Where; variants: string[] }>>();
  const add = (name: string, use: Use) => uses.set(name, [...(uses.get(name) ?? []), use]);
  for (const f of files) {
    const t = f.text;
    const at = (i: number) => `${f.rel}:${lineOf(f, i)}`;
    for (const m of t.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const r = reader(f, m.index!);
      add(m[1], "role" in r ? { ...r, at: at(m.index!), f, index: m.index! } : { ...r, at: at(m.index!) });
    }
    // Class tokens: split at whitespace and quotes, then each tested whole (a long path string is one token, never rescanned).
    for (const m of t.matchAll(/[^\s"'`]+/g)) {
      let token = m[0].replace(/^[{(,]+|[,;})]+$/g, "");
      // A closing bracket belongs to the token only when it closes one of its own (`bg-[--b]`, not `["bg-x"]`).
      while (token.endsWith("]") && (token.match(/\[/g)?.length ?? 0) < (token.match(/\]/g)?.length ?? 0)) token = token.slice(0, -1).replace(/[,;})]+$/, "");
      if (token.length > 160 || !token.includes("-")) continue;
      const v = token.match(VAR_TOKEN);
      if (v) add(v[2] ?? v[3], { role: CLASS_ROLE[v[1]] ?? "other", at: at(m.index!), variants: variantsOf(token) });
      const c = token.match(THEME_TOKEN);
      if (!c) continue;
      const roots = classes.get(c[2]) ?? new Map<string, Where>();
      if (!roots.has(c[1])) roots.set(c[1], at(m.index!));
      classes.set(c[2], roots);
      classUses.set(c[2], [...(classUses.get(c[2]) ?? []), { root: c[1], at: at(m.index!), variants: variantsOf(token) }]);
    }
  }
  const memo = new Map<string, Map<string, Where>>();
  const where = (name: string, seen = new Set<string>()): Map<string, Where> => {
    const done = memo.get(name);
    if (done) return done;
    if (seen.has(name)) return new Map();
    seen.add(name);
    const out = new Map<string, Where>();
    const put = (role: string, w: Where) => {
      if (!out.has(role)) out.set(role, w);
    };
    for (const use of uses.get(name) ?? []) {
      if ("role" in use) put(use.role, use.at);
      else for (const [role] of where(use.def, seen)) put(role, `${use.at} (${use.def})`);
    }
    for (const [ns, roots] of THEME_NAMESPACES) {
      const key = name.match(ns)?.[1];
      if (!key) continue;
      for (const [root, w] of classes.get(key) ?? []) if (roots.test(root)) put(CLASS_ROLE[root] ?? "other", `${w} (${root}-${key})`);
    }
    if (seen.size === 1) memo.set(name, out);
    return out;
  };
  /** Every reader of `name`, followed through other custom properties, with its states (computed here, on demand). */
  const readers = (name: string, seen = new Set<string>()): Reader[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const out: Reader[] = [];
    for (const use of uses.get(name) ?? []) {
      if ("role" in use) {
        if (use.role !== MIX) out.push({ role: use.role, at: use.at, states: useStates(use) });
      } else for (const r of readers(use.def, seen)) out.push({ ...r, at: `${r.at} (${use.def})` });
    }
    for (const [ns, roots] of THEME_NAMESPACES) {
      const key = name.match(ns)?.[1];
      if (!key) continue;
      for (const u of classUses.get(key) ?? []) {
        if (roots.test(u.root)) out.push({ role: CLASS_ROLE[u.root] ?? "other", at: `${u.at} (${u.root}-${key})`, states: useStates({ role: "", at: u.at, variants: u.variants }) });
      }
    }
    return out;
  };
  return { rolesOf: (name) => new Set([...where(name).keys()].filter((r) => r !== MIX)), where: (name) => where(name), readers: (name) => readers(name) };
}

/** Whether text that ends inside a value leaves a `color-mix(` call open. */
function inMix(text: string): boolean {
  const open: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") open.push(text.slice(Math.max(0, i - 12), i).match(/[\w-]*$/)![0].toLowerCase());
    else if (text[i] === ")") open.pop();
  }
  return open.includes("color-mix");
}

/** A JS key that holds a whole value on its own: the text between the holder's start and the string is `key:` and nothing else. */
const JS_KEY = /^\s*(["'`]?)(--[\w-]+|-?[A-Za-z_$][\w$-]*)\1\s*:\s*$/;

/**
 * What reads the `var(` at `at`: the utility class it sits in (`bg-[var(--x)]`), else the
 * declaration or key whose value holds it. In CSS that is the last `key:` since the declaration
 * began; in JS the key the string is the whole value of, at an object or statement start. Inside
 * `color-mix()` it reads as the mix, which gives no role.
 */
function reader(f: SourceFile, at: number): { role: string } | { def: string } {
  const t = f.text;
  // A class token runs back to whitespace or a quote: `hover:bg-[color:var(--x)]`.
  let s = at;
  while (s > 0 && !/[\s"'`]/.test(t[s - 1]) && at - s < 200) s--;
  const token = t.slice(s, at);
  const cls = token.match(/^(?:[^\s:]{1,64}:){0,4}!?-?([a-z][a-z0-9-]*?)-[[(]/);
  if (cls && (token.includes("-[") || token.includes("-("))) return { role: inMix(token) ? MIX : (CLASS_ROLE[cls[1]] ?? "other") };
  if (f.kind === "js" && f.inStr && !cssRegionAt(f, at)) return jsReader(f, at);
  // The declaration: back to the `;`, `{` or `}` that starts it, outside parentheses.
  let depth = 0;
  let k = at - 1;
  for (; k >= 0 && at - k < 4000; k--) {
    const ch = t[k];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) continue;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
  }
  const seg = t.slice(k + 1, at);
  if (inMix(seg)) return { role: MIX };
  const keys = [...seg.matchAll(/(?:^|[\s{;,("'])(["'`]?)(--[\w-]+|-?[A-Za-z][\w-]*)\1\s*:(?!:)/g)];
  const key = keys.pop()?.[2];
  if (!key) return { role: "other" };
  if (key.startsWith("--")) return { def: key };
  return { role: propRoleOf(key) ?? "other" };
}

/**
 * A JS reader: the string holding the `var(` is the whole value of a key at an object or statement
 * start (`{ color: "var(--x)" }`, `, border: \`1px solid var(--x)\``). A ternary, a call
 * argument, an array element, a JSX attribute or text, or code around the string reads as `other`.
 */
function jsReader(f: SourceFile, at: number): { role: string } | { def: string } {
  const t = f.text;
  const range = stringAt(f, at);
  if (!range) return { role: "other" };
  const start = range[0];
  if (inMix(t.slice(start, at))) return { role: MIX };
  let depth = 0;
  let k = start - 1;
  for (; k >= 0 && start - k < 4000; k--) {
    if (f.inStr![k] === 1) continue;
    const ch = t[k];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === "," || ch === ";")) break;
  }
  if (k >= 0 && (t[k] === "(" || t[k] === "[")) return { role: "other" };
  const key = t.slice(k + 1, start).match(JS_KEY)?.[2];
  if (!key) return { role: "other" };
  if (key.startsWith("--")) return { def: key };
  return { role: propRoleOf(key) ?? "other" };
}
