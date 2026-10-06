/**
 * Where each CSS custom property is read, so a definition takes the role its readers give it
 * (`color: var(--fl-muted)` makes `--fl-muted` text, whatever its name says).
 *
 * Readers, in every scanned file (comments blanked): a declaration or style key whose value holds
 * `var(--x)` (`border: 1px solid var(--x)`, `backgroundColor: "var(--x)"`), a utility class with
 * the variable in brackets or parentheses (`bg-[var(--x)]`, `text-(--x)`), another custom property
 * (`--y: var(--x)`, followed to its own readers), and for a Tailwind theme variable
 * (`--color-brand`) the utility classes that name it (`bg-brand`, `text-brand`). A reader with no
 * color role (`width`, `transition`, a JS value whose key says nothing) reads as `other`.
 */

import { propRoleOf, type ConsumerIndex } from "./color-role.ts";
import { lineOf, type SourceFile } from "./source.ts";

/** Utility roots that take a color, and the role each gives. */
const CLASS_ROLE: Record<string, string> = {
  bg: "background", from: "background", via: "background", to: "background",
  text: "text", placeholder: "text", decoration: "text", caret: "text",
  border: "border", "border-x": "border", "border-y": "border", "border-t": "border", "border-r": "border", "border-b": "border", "border-l": "border", "border-s": "border", "border-e": "border",
  ring: "border", "ring-offset": "border", outline: "border", divide: "border",
  fill: "svgFill", stroke: "svgStroke", accent: "accent",
  shadow: "shadow", "inset-shadow": "shadow", "drop-shadow": "shadow", "text-shadow": "shadow", "inset-ring": "border",
};
const CLASS_ROOTS = Object.keys(CLASS_ROLE).sort((a, b) => b.length - a.length).join("|");
/** A utility naming a theme color: `bg-brand`, `hover:text-card-foreground/80`, `!border-input`. */
const THEME_CLASS = new RegExp(`(?:^|[\\s"'\`{(,])(?:[^\\s"'\`]*?:)?!?-?(${CLASS_ROOTS})-([a-z][a-z0-9-]*?)(?:\\/[\\w.%\\[\\]]+)?!?(?=$|[\\s"'\`,;})\\]])`, "g");
/** Tailwind theme namespaces whose variables name utility colors, and the roots that read them. */
const THEME_NAMESPACES: Array<[RegExp, RegExp]> = [
  [/^--color-(.+)$/, /./],
  [/^--background-color-(.+)$/, /^(?:bg|from|via|to)$/],
  [/^--text-color-(.+)$/, /^text$/],
  [/^--border-color-(.+)$/, /^(?:border|divide)/],
];

/** Where a reader sits: `src/a.css:12`. */
type Where = string;
type Use = { role: string; at: Where } | { def: string; at: Where };
/** A reader inside `color-mix()` derives another color from the variable (`--muted: color-mix(in srgb, var(--fg) 7%, transparent)`): it gives no role. */
const MIX = "color-mix";

export interface Consumers extends ConsumerIndex {
  /** One place per role that reads `name` (directly or through other custom properties). */
  where(name: string): Map<string, Where>;
}

export function buildConsumers(files: SourceFile[]): Consumers {
  const uses = new Map<string, Use[]>();
  /** Theme color name -> utility root -> one place that uses it. */
  const classes = new Map<string, Map<string, Where>>();
  const add = (name: string, use: Use) => uses.set(name, [...(uses.get(name) ?? []), use]);
  for (const f of files) {
    const t = f.text;
    const at = (i: number) => `${f.rel}:${lineOf(f, i)}`;
    for (const m of t.matchAll(/var\(\s*(--[\w-]+)/g)) add(m[1], { ...reader(t, m.index!), at: at(m.index!) });
    for (const m of t.matchAll(/(?:^|[\s"'`{(,:])!?-?([a-z][a-z-]*?)-\(\s*(?:[a-z-]+:)?(--[\w-]+)\s*\)/g)) add(m[2], { role: CLASS_ROLE[m[1]] ?? "other", at: at(m.index!) });
    for (const m of t.matchAll(THEME_CLASS)) {
      const roots = classes.get(m[2]) ?? new Map<string, Where>();
      if (!roots.has(m[1])) roots.set(m[1], at(m.index!));
      classes.set(m[2], roots);
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
  return { rolesOf: (name) => new Set([...where(name).keys()].filter((r) => r !== MIX)), where: (name) => where(name) };
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

/**
 * What reads the `var(` at `at`: the utility class it sits in (`bg-[var(--x)]`), else the
 * declaration or key whose value holds it (the last `key:` since the statement or block began).
 * Inside `color-mix()` it reads as the mix, which gives no role.
 */
function reader(t: string, at: number): { role: string } | { def: string } {
  // A class token runs back to whitespace or a quote: `hover:bg-[color:var(--x)]`.
  let s = at;
  while (s > 0 && !/[\s"'`]/.test(t[s - 1]) && at - s < 200) s--;
  const token = t.slice(s, at);
  const cls = token.match(/^(?:[^\s:]*?:)*!?-?([a-z][a-z0-9-]*?)-[[(]/);
  if (cls && (token.includes("-[") || token.includes("-("))) return { role: inMix(token) ? MIX : (CLASS_ROLE[cls[1]] ?? "other") };
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
  const keys = [...seg.matchAll(/(?:^|[\s{;,(])(["'`]?)(--[\w-]+|-?[A-Za-z][\w-]*)\1\s*:(?!:)/g)];
  const key = keys.pop()?.[2];
  if (!key) return { role: "other" };
  if (key.startsWith("--")) return { def: key };
  return { role: propRoleOf(key) ?? "other" };
}
