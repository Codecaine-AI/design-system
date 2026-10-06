/**
 * Tailwind v3: the app's tailwind.config.* (in the app root, else up to the repo root) uses the
 * preset @codecaine-ai/design-system/tailwind-v3-preset, and nothing in it undoes the preset.
 * Part of check 2 (wiring); wiring.ts calls checkPreset. Static analysis only: the app's config
 * never runs. Comments and string contents never count as code.
 *
 * - The exported config is the last `module.exports = …` or `export default …`, read through a
 *   `defineConfig(…)`-style wrapper and `const config = …` bindings.
 * - A later write to presets replaces the exported value: `module.exports.presets = …`,
 *   `exports.presets = …`, `config.presets = …` on the exported binding, or
 *   `Object.assign(module.exports, { presets })`. The last write must hold the preset.
 * - In an object literal the last `presets` key wins. A spread after it, or a spread when there is
 *   no presets key, could set presets and cannot be checked: a violation. A spread of a local
 *   object literal is read in place.
 * - presets holds the preset (`require("…")` or a name bound to it) and nothing else. Tailwind 3
 *   gives every other preset without its own `presets: []` the full default config, so another
 *   entry brings the default palette and scales back.
 * - No require or import of tailwindcss/colors, tailwindcss/defaultTheme, tailwindcss/defaultConfig
 *   or tailwindcss/stubs/*: they bring Tailwind's default palette and theme back.
 * - No `theme.<key>` outside theme.extend for a key the preset's theme sets (colors, spacing,
 *   fontSize, …, read from the build's dist/tailwind/preset-v3.cjs): it replaces the preset's scale.
 */

import { join } from "node:path";
import { lexJs } from "../../scan-literals";
import { DESIGN_SYSTEM_ROOT, resolvePath } from "../registry";
import type { AppContext, Finding } from "./types";
import { findTailwindConfig, isInside, lineAt, readText } from "./workspace";

// The config lookup lives in workspace.ts: the literal scan adds the same file (scanSetup).
export { findTailwindConfig, TW_CONFIGS } from "./workspace";

const PRESET = "@codecaine-ai/design-system/tailwind-v3-preset";
const MISSING = `add presets: [require("${PRESET}")] to the exported config`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PRESET_SPEC = `(?<q>["'])${esc(PRESET)}\\k<q>`;
const IDENT = /^[A-Za-z_$][\w$]*/;

/** A config's source, lexed: comments blanked, string contents marked. */
interface Lexed {
  text: string;
  inStr: Uint8Array;
  /** Bracket depth of each offset, code characters only. */
  depth: Int32Array;
}

function lex(raw: string): Lexed {
  const { text, inStr } = lexJs(raw);
  const depth = new Int32Array(text.length + 1);
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    depth[i] = d;
    if (inStr[i]) continue;
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") d = Math.max(0, d - 1);
  }
  depth[text.length] = d;
  return { text, inStr, depth };
}

/** Index of the bracket closing the one at `open` (code characters only), or -1. */
function closeOf(lx: Lexed, open: number): number {
  let depth = 0;
  for (let i = open; i < lx.text.length; i++) {
    if (lx.inStr[i]) continue;
    const ch = lx.text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") if (--depth === 0) return i;
  }
  return -1;
}

const skipWs = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
};

/** Trimmed top-level comma-separated spans [start, end) inside the bracket pair (open, close). */
function spansOf(lx: Lexed, open: number, close: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  const push = (a: number, b: number) => {
    a = skipWs(lx.text, a);
    while (b > a && /\s/.test(lx.text[b - 1])) b--;
    if (b > a) out.push([a, b]);
  };
  for (let i = open + 1; i < close; i++) {
    if (lx.inStr[i]) continue;
    const ch = lx.text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, close);
  return out;
}

/** One entry of an object literal: a spread, or a property (shorthand, `key: value` or a method). */
type Entry =
  | { kind: "spread"; start: number; expr: number }
  | { kind: "prop"; start: number; key: string | null; value: number; computed?: true };

function entryAt(lx: Lexed, start: number): Entry {
  const { text } = lx;
  if (text.startsWith("...", start)) return { kind: "spread", start, expr: start + 3 };
  let key: string | null = null;
  let i = start;
  const q = text[i];
  if (q === '"' || q === "'" || q === "`") {
    let j = i + 1;
    while (j < text.length && lx.inStr[j]) j++;
    key = text.slice(i + 1, j);
    i = j + 1;
  } else if (q === "[") {
    // A computed key (`[name]: …`): its name is unknown.
    const close = closeOf(lx, i);
    const j = skipWs(text, close + 1);
    return { kind: "prop", start, key: null, value: text[j] === ":" ? skipWs(text, j + 1) : start, computed: true };
  } else {
    const m = /^(?:(?:get|set|async)\s+(?=[A-Za-z_$"'[]))?([A-Za-z_$][\w$]*|\d+)/.exec(text.slice(i, i + 200));
    if (!m) return { kind: "prop", start, key: null, value: start };
    key = m[1];
    i += m[0].length;
  }
  const j = skipWs(text, i);
  if (text[j] === ":") return { kind: "prop", start, key, value: skipWs(text, j + 1) };
  return { kind: "prop", start, key, value: start }; // shorthand `presets` or a method `presets() {…}`
}

/** What an expression is once wrappers and bindings are followed. */
type Value = { kind: "object" | "array"; open: number; close: number } | { kind: "other"; start: number };

/** Offset after the `=` of `name`'s declaration: the last top-level one, else the first. */
function declOf(lx: Lexed, name: string): number | null {
  const re = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${esc(name)}\\s*(?::[^=;]+)?=(?![=>])`, "g");
  let first: number | null = null;
  let top: number | null = null;
  for (const m of lx.text.matchAll(re)) {
    if (lx.inStr[m.index!]) continue;
    const after = m.index! + m[0].length;
    first ??= after;
    if (lx.depth[m.index!] === 0) top = after;
  }
  return top ?? first;
}

/** The value at `start`: object or array literals, through parens, wrapper calls and bindings. `names` collects the bindings followed. */
function resolve(lx: Lexed, start: number, names?: Set<string>, seen = 0): Value {
  const { text } = lx;
  const i = skipWs(text, start);
  if (seen > 6) return { kind: "other", start: i };
  const ch = text[i];
  if (ch === "{" || ch === "[") {
    const close = closeOf(lx, i);
    return close === -1 ? { kind: "other", start: i } : { kind: ch === "{" ? "object" : "array", open: i, close };
  }
  if (ch === "(") return resolve(lx, i + 1, names, seen + 1);
  const word = /^[\w$.]+/.exec(text.slice(i, i + 200))?.[0];
  if (!word) return { kind: "other", start: i };
  const j = skipWs(text, i + word.length);
  if (text[j] === "(") {
    // A wrapper (`defineConfig({…})`, `withMT(config)`): its first argument. require/import load another file.
    if (word === "require" || word === "import") return { kind: "other", start: i };
    const close = closeOf(lx, j);
    const first = close === -1 ? undefined : spansOf(lx, j, close)[0];
    return first ? resolve(lx, first[0], names, seen + 1) : { kind: "other", start: i };
  }
  if (!IDENT.test(word) || word.length !== IDENT.exec(word)![0].length) return { kind: "other", start: i };
  const decl = declOf(lx, word);
  if (decl === null) return { kind: "other", start: i };
  names?.add(word);
  return resolve(lx, decl, names, seen + 1);
}

/** The effective value of one property: nothing sets it, an expression sets it last, or something unreadable could. */
type Effective =
  | { kind: "none" }
  | { kind: "value"; at: number; why?: string }
  | { kind: "unknown"; at: number; label: string };

const NONE: Effective = { kind: "none" };
const snippet = (lx: Lexed, a: number, b: number) => {
  const s = lx.text.slice(a, b).replace(/\s+/g, " ").trim();
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** `key` in an object literal: the last key wins; a spread or a computed key may set it (a spread of a local object literal is read in place). */
function propOf(lx: Lexed, obj: { open: number; close: number }, key: string, seen = 0): Effective & { count: number } {
  let result: Effective = NONE;
  let count = 0;
  for (const [a, b] of spansOf(lx, obj.open, obj.close)) {
    const e = entryAt(lx, a);
    if (e.kind === "prop") {
      if (e.key === key) {
        result = { kind: "value", at: e.value };
        count++;
      } else if (e.computed) {
        result = { kind: "unknown", at: a, label: snippet(lx, a, b) };
      }
      continue;
    }
    const v = resolve(lx, e.expr);
    if (v.kind === "object" && seen < 4) {
      const inner = propOf(lx, v, key, seen + 1);
      if (inner.kind !== "none") result = inner;
      count += inner.count;
    } else {
      result = { kind: "unknown", at: a, label: snippet(lx, a, b) };
    }
  }
  if (result.kind === "value" && count > 1) result = { ...result, why: `the last ${key} key wins` };
  return { ...result, count };
}

/** The exported config: the last `module.exports =` / `export default` in code. */
interface Exported {
  /** Offset of the statement. */
  at: number;
  /** How many export statements the file has. */
  count: number;
  obj: { open: number; close: number } | null;
  /** Bindings the export reads (`export default config`): writes to them change the config. */
  names: Set<string>;
}

function exportedConfig(lx: Lexed): Exported | null {
  let last: RegExpMatchArray | null = null;
  let count = 0;
  for (const m of lx.text.matchAll(/(?<![\w$.])(?:module\s*\.\s*exports\s*=(?![=>])|export\s+default\s+)/g)) {
    if (lx.inStr[m.index!]) continue;
    last = m;
    count++;
  }
  if (!last) return null;
  const names = new Set<string>();
  const v = resolve(lx, last.index! + last[0].length, names);
  return { at: last.index!, count, obj: v.kind === "object" ? v : null, names };
}

/**
 * The effective value of `key` on the exported config: the exported object literal, then every
 * later write in source order (`module.exports.key =`, `exports.key =`, `<binding>.key =`,
 * `Object.assign(<target>, …)`). The last one wins.
 */
function effectiveProp(lx: Lexed, exp: Exported | null, key: string): Effective {
  const events: Array<{ at: number; eff: Effective }> = [];
  if (exp?.obj) {
    const base = propOf(lx, exp.obj, key);
    const eff: Effective = base.kind === "none" ? NONE : base.kind === "value" && !base.why && exp.count > 1 ? { ...base, why: "the last export wins" } : base;
    events.push({ at: exp.obj.open, eff });
  }
  const names = [...(exp?.names ?? [])].map(esc);
  const targets = ["module\\s*\\.\\s*exports", "exports", ...names].join("|");
  // A write to module.exports before the last `module.exports =` changes an object nobody exports;
  // a write to a binding counts after its object literal.
  const counts = (target: string, at: number) => {
    if (!exp) return true;
    if (/^(?:module|exports)\b/.test(target)) return at > exp.at;
    return exp.obj === null || at > exp.obj.open;
  };

  const assign = new RegExp(`(?<![\\w$.])(${targets})\\s*(?:\\.\\s*${esc(key)}|\\[\\s*(["'\`])${esc(key)}\\2\\s*\\])\\s*=(?![=>])`, "g");
  for (const m of lx.text.matchAll(assign)) {
    if (lx.inStr[m.index!] || !counts(m[1], m.index!)) continue;
    events.push({ at: m.index!, eff: { kind: "value", at: skipWs(lx.text, m.index! + m[0].length), why: `the last write to ${key} wins` } });
  }
  for (const m of lx.text.matchAll(/(?<![\w$.])Object\s*\.\s*assign\s*\(/g)) {
    if (lx.inStr[m.index!]) continue;
    const open = m.index! + m[0].length - 1;
    const close = closeOf(lx, open);
    if (close === -1) continue;
    const [target, ...sources] = spansOf(lx, open, close);
    const t = target ? lx.text.slice(target[0], target[1]).replace(/\s+/g, "") : "";
    if (!new RegExp(`^(?:${targets})$`).test(t) || !counts(t, m.index!)) continue;
    for (const [a, b] of sources) {
      const v = resolve(lx, a);
      if (v.kind !== "object") {
        events.push({ at: a, eff: { kind: "unknown", at: a, label: `Object.assign source ${snippet(lx, a, b)}` } });
        continue;
      }
      const p = propOf(lx, v, key);
      if (p.kind !== "none") events.push({ at: a, eff: p.kind === "value" ? { kind: "value", at: p.at, why: `the last write to ${key} wins` } : p });
    }
  }
  events.sort((x, y) => x.at - y.at);
  return events.length ? events[events.length - 1].eff : NONE;
}

/**
 * True when the entry is the preset: `require("…preset")` or a name bound to it, maybe with
 * `.default`, a type cast, or an interop fallback (`ds.default ?? ds`) whose sides are all the preset.
 */
function presetEntry(lx: Lexed, a: number, b: number, bindings: Set<string>): boolean {
  const isPreset = (expr: string): boolean => {
    let p = expr.trim();
    for (let prev = ""; prev !== p; ) {
      prev = p;
      p = p.replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]\s]+$/, "").replace(/!$/, "").replace(/\.default$/, "").replace(/^\((.*)\)$/s, "$1").trim();
    }
    const sides = p.split(/\s*(?:\?\?|\|\|)\s*/);
    if (sides.length > 1) return sides.every(isPreset);
    return new RegExp(`^require\\(\\s*${PRESET_SPEC}\\s*\\)$`).test(p) || bindings.has(p);
  };
  return isPreset(lx.text.slice(a, b));
}

const DEFAULT_MODULE = /(?<![\w$.])(?:require\s*\(\s*|import\s*\(\s*|from\s+|import\s+)(["'])(tailwindcss\/(?:colors|defaultTheme|defaultConfig|stubs\/[^"'\s]*|lib\/public\/(?:colors|default-theme|default-config))(?:\.js)?)\1/g;

export interface ConfigProblem {
  /** Offset into the config's source. */
  index: number;
  message: string;
}

/** Everything in a v3 config that keeps the preset from applying, in source order. `themeKeys`: the keys the preset's theme sets. */
export function presetProblems(raw: string, themeKeys: ReadonlySet<string>): ConfigProblem[] {
  const lx = lex(raw);
  const { text } = lx;
  const problems: ConfigProblem[] = [];

  // Names bound to the preset.
  const bindings = new Set<string>();
  for (const re of [
    new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*require\\(\\s*${PRESET_SPEC}\\s*\\)`, "g"),
    new RegExp(`(?<![\\w$.])import\\s+(?:\\*\\s+as\\s+)?([\\w$]+)\\s+from\\s+${PRESET_SPEC}`, "g"),
  ]) {
    for (const m of text.matchAll(re)) if (!lx.inStr[m.index!]) bindings.add(m[1]);
  }

  const exp = exportedConfig(lx);
  const presets = effectiveProp(lx, exp, "presets");
  if (presets.kind === "none") {
    // At a (maybe commented-out) presets in the exported object, else at the export.
    const inObj = exp?.obj ? raw.slice(exp.obj.open, exp.obj.close).indexOf("presets") : -1;
    problems.push({ index: inObj !== -1 ? exp!.obj!.open + inObj : exp?.at ?? 0, message: `does not use the preset: ${MISSING}` });
  } else if (presets.kind === "unknown") {
    problems.push({ index: presets.at, message: `${presets.label} could override presets and cannot be checked statically; set presets after it` });
  } else {
    const why = presets.why ? ` (${presets.why})` : "";
    const v = resolve(lx, presets.at);
    if (v.kind !== "array") {
      problems.push({ index: presets.at, message: `does not use the preset${why}: ${MISSING}` });
    } else {
      const entries = spansOf(lx, v.open, v.close);
      if (!entries.some(([a, b]) => presetEntry(lx, a, b, bindings))) problems.push({ index: presets.at, message: `does not use the preset${why}: ${MISSING}` });
      for (const [a, b] of entries) {
        if (presetEntry(lx, a, b, bindings)) continue;
        problems.push({ index: a, message: `presets also holds ${snippet(lx, a, b)}: another preset brings Tailwind's default theme back; keep only the design-system preset` });
      }
    }
  }

  for (const m of text.matchAll(DEFAULT_MODULE)) {
    if (lx.inStr[m.index!]) continue;
    const what = /colors/.test(m[2]) ? "palette" : "theme";
    problems.push({ index: m.index!, message: `loads ${m[2]}: it brings Tailwind's default ${what} back; use the design-system tokens` });
  }

  // theme.<key> outside extend, in the exported theme or written later (`module.exports.theme.colors = …`).
  const owned = (key: string | null): key is string => key !== null && key !== "extend" && themeKeys.has(key);
  const replaces = (key: string) => `theme.${key} replaces the preset's ${key}; move it under theme.extend`;
  const theme = effectiveProp(lx, exp, "theme");
  if (theme.kind === "value") {
    const t = resolve(lx, theme.at);
    const visit = (obj: { open: number; close: number }, seen: number) => {
      for (const [a] of spansOf(lx, obj.open, obj.close)) {
        const e = entryAt(lx, a);
        if (e.kind === "prop" && owned(e.key)) problems.push({ index: a, message: replaces(e.key) });
        else if (e.kind === "spread" && seen < 4) {
          const inner = resolve(lx, e.expr);
          if (inner.kind === "object") visit(inner, seen + 1);
        }
      }
    };
    if (t.kind === "object") visit(t, 0);
  }
  const targets = ["module\\s*\\.\\s*exports", "exports", ...[...(exp?.names ?? [])].map(esc)].join("|");
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(?:${targets})\\s*\\.\\s*theme\\s*\\.\\s*([\\w$]+)\\s*=(?![=>])`, "g"))) {
    if (!lx.inStr[m.index!] && owned(m[1])) problems.push({ index: m.index!, message: replaces(m[1]) });
  }

  return problems.sort((a, b) => a.index - b.index);
}

const themeKeyCache = new Map<string, Set<string>>();

/** The keys the build's Tailwind v3 preset sets in `theme` (theme.extend aside), read from its source without running it. */
export function presetThemeKeys(dsDir: string): Set<string> {
  const file = join(dsDir, "dist/tailwind/preset-v3.cjs");
  const cached = themeKeyCache.get(file);
  if (cached) return cached;
  const keys = new Set<string>();
  const raw = readText(file);
  if (raw !== null) {
    const lx = lex(raw);
    const theme = effectiveProp(lx, exportedConfig(lx), "theme");
    const t = theme.kind === "value" ? resolve(lx, theme.at) : null;
    if (t?.kind === "object") {
      for (const [a] of spansOf(lx, t.open, t.close)) {
        const e = entryAt(lx, a);
        if (e.kind === "prop" && e.key && e.key !== "extend") keys.add(e.key);
      }
    }
  }
  themeKeyCache.set(file, keys);
  return keys;
}

/** True when the config uses the preset and nothing in it undoes the preset (presetProblems finds nothing). */
export function exportsPreset(raw: string, themeKeys: ReadonlySet<string> = presetThemeKeys(DESIGN_SYSTEM_ROOT)): boolean {
  return presetProblems(raw, themeKeys).length === 0;
}

export function checkPreset(ctx: AppContext): Finding[] {
  const { app, appRoot } = ctx;
  const repoRoot = resolvePath(ctx.root, app.repo);
  const config = findTailwindConfig(appRoot, isInside(appRoot, repoRoot) ? repoRoot : appRoot);
  if (!config) return [{ file: app.root, line: 0, message: "Tailwind v3 app has no tailwind.config.* in the app root or above it in the repo" }];
  const raw = readText(config) ?? "";
  const file = ctx.rel(config);
  return presetProblems(raw, presetThemeKeys(ctx.ds.dir)).map((p) => ({ file, line: lineAt(raw, p.index), message: p.message }));
}
