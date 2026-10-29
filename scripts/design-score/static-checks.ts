/**
 * The static design:score checks: source files only, no browser.
 *
 *   S-color-literal    scan-literals' color categories (inline fails, definitions warn, var() fallbacks ignored)
 *   S-transition-all   transition: all / a shorthand naming no property / transition-all
 *   S-motion-literal   literal durations and cubic-bezier()/steps() easings, Tailwind duration-* / ease-[...]
 *   S-hover-unguarded  :hover rules outside @media (hover: hover)
 *   S-outline-none     outline none/0 with no :focus-visible replacement
 *
 * Files come from scan-literals' collectFiles (same skips: node_modules, dist, tests, generated files),
 * and comments are stripped with its stripCss/lexJs, so line numbers match the source.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

import { collectFiles, lexJs, scan, stripCss, type Options, type SkipStats } from "../scan-literals";
import type { CheckResult, RawFinding } from "./types";

interface Decl {
  prop: string;
  value: string;
  line: number;
}

export interface CssRule {
  selector: string;
  decls: Decl[];
  /** Preludes of the enclosing at-rules, outermost first ("@media (hover: hover)"). */
  at: string[];
  line: number;
}

/** A forgiving CSS parser: style rules (nesting resolved with &), their declarations and at-rule context. */
export function parseCss(src: string, lineComments = false): CssRule[] {
  const text = stripCss(src, lineComments);
  // Precompute line starts once: lineAt per declaration would be quadratic on big files.
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  type Frame = { at: boolean; prelude: string; rule: CssRule | null };
  const stack: Frame[] = [];
  const rules: CssRule[] = [];
  let start = 0;
  let quote: string | null = null;
  let paren = 0;
  const top = () => stack[stack.length - 1];
  const parentSelector = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.rule) return stack[i]!.rule!.selector;
    return null;
  };
  const atContext = () => stack.filter((f) => f.at).map((f) => f.prelude);
  const pushDecl = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const frame = top();
    if (!frame?.rule || !raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    const line = lineOf(from + lead);
    if (body.startsWith("@apply")) {
      frame.rule.decls.push({ prop: "@apply", value: body.slice(6).trim(), line });
      return;
    }
    const colon = body.indexOf(":");
    if (colon <= 0) return;
    frame.rule.decls.push({ prop: body.slice(0, colon).trim().toLowerCase(), value: body.slice(colon + 1).trim(), line });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    if (paren > 0) continue;
    if (c === "{") {
      const raw = text.slice(start, i);
      const prelude = raw.trim();
      // Declarations before a nested rule (`color: red; &:hover {`) were flushed at their `;`.
      const lead = raw.length - raw.trimStart().length;
      if (prelude.startsWith("@")) stack.push({ at: true, prelude, rule: null });
      else {
        const parent = parentSelector();
        const inKeyframes = atContext().some((a) => /^@(-\w+-)?keyframes/i.test(a));
        const selector = inKeyframes
          ? `@keyframes-step ${prelude}`
          : parent
            ? prelude
                .split(",")
                .map((part) => (part.includes("&") ? part.replace(/&/g, parent) : `${parent} ${part.trim()}`))
                .join(", ")
            : prelude;
        const rule: CssRule = { selector, decls: [], at: atContext(), line: lineOf(start + lead) };
        rules.push(rule);
        stack.push({ at: false, prelude, rule });
      }
      start = i + 1;
    } else if (c === "}") {
      pushDecl(start, i);
      stack.pop();
      start = i + 1;
    } else if (c === ";") {
      pushDecl(start, i);
      start = i + 1;
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------

const EASING_KEYWORDS = new Set(["ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end", "allow-discrete", "normal"]);

/** Splits at top-level commas. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Tokens of a value at depth 0 (function calls stay whole). */
function tokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** The value with every var(...) removed (a literal in a var() fallback is behind a token). */
function withoutVars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith("var(", i)) {
      let depth = 0;
      let k = i;
      for (; k < value.length; k++) {
        if (value[k] === "(") depth++;
        else if (value[k] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out += " ";
      i = k;
    } else out += value[i];
  }
  return out;
}

/** Whether a transition shorthand segment animates every property (names `all`, or names none). */
function segmentAnimatesAll(segment: string): boolean | null {
  const parts = tokens(segment.trim());
  if (!parts.length) return null;
  if (parts.includes("all")) return true;
  if (parts.length === 1 && parts[0] === "none") return false;
  let named = false;
  for (const part of parts) {
    if (/^var\(/.test(part)) {
      // var(--x-duration) / var(--x-ease…) are timing; anything else might be the property list.
      if (/duration|delay|ease|easing|timing|speed|motion/i.test(part)) continue;
      return null;
    }
    if (/^[\d.]+m?s$/.test(part) || /^calc\(/.test(part)) continue;
    if (/^(cubic-bezier|steps|linear)\(/.test(part)) continue;
    if (EASING_KEYWORDS.has(part)) continue;
    if (/^-?[a-z][a-z-]*$/i.test(part)) named = true;
  }
  return !named;
}

const MOTION_PROPS = new Set([
  "transition",
  "transition-duration",
  "transition-delay",
  "transition-timing-function",
  "animation",
  "animation-duration",
  "animation-delay",
  "animation-timing-function",
]);

const OUTLINE_NONE = (d: Decl) =>
  (d.prop === "outline" && /^(none|0(px)?)(\s|$|!)/.test(d.value)) ||
  (d.prop === "outline-style" && /^none\b/.test(d.value)) ||
  (d.prop === "outline-width" && /^0(px)?\b/.test(d.value));

/** The classes/ids named in a selector's last compound: the element the rule styles. */
function subjectKeys(selector: string): string[] {
  const last = selector.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
  return [...last.matchAll(/[.#][\w-]+|\[[^\]]+\]/g)].map((m) => m[0]);
}

const showsFocus = (d: Decl) =>
  /^(box-shadow|border|border-color|border-[a-z]+-color|background|background-color|outline-color|text-decoration)/.test(d.prop) ||
  (d.prop === "outline" && !OUTLINE_NONE(d)) ||
  (d.prop === "@apply" && /(^|\s)(ring|border|shadow|outline)-/.test(d.value));

/** Class names a CSS focus rule (:focus, :focus-visible, :focus-within) gives a visible change. */
export function focusRingClasses(rules: CssRule[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    if (!/:focus/.test(r.selector) || !r.decls.some(showsFocus)) continue;
    for (const part of r.selector.split(",")) {
      const subject = part.split(/:focus/)[0] ?? "";
      for (const m of subject.matchAll(/\.([\w-]+)/g)) out.add(m[1]!);
    }
  }
  return out;
}

function cssFindings(rel: string, rules: CssRule[]): Record<string, RawFinding[]> {
  const out: Record<string, RawFinding[]> = { "S-transition-all": [], "S-motion-literal": [], "S-hover-unguarded": [], "S-outline-none": [] };
  const add = (check: string, severity: "fail" | "warn", line: number, measured: string, expected: string, selector: string) =>
    out[check]!.push({ check, severity, selector, box: null, measured, expected, file: rel, line });
  // A focus rule that shows something: a ring, shadow, border or outline (inputs often use :focus).
  const focusVisibleRules = rules.filter((r) => /:focus/.test(r.selector) && r.decls.some(showsFocus));
  for (const rule of rules) {
    if (rule.selector.startsWith("@keyframes-step")) continue;
    const at = rule.at.join(" ");
    if (/@theme\b/.test(at)) continue;
    const reduced = /prefers-reduced-motion\s*:\s*reduce/.test(at);
    for (const d of rule.decls) {
      // S-transition-all
      if (d.prop === "transition-property" && tokens(d.value.replace(/,/g, " ")).includes("all")) add("S-transition-all", "fail", d.line, `transition-property: ${d.value}`, "name the properties that change", rule.selector);
      else if (d.prop === "transition") {
        const segs = splitTop(d.value);
        if (segs.some((s) => segmentAnimatesAll(s) === true)) add("S-transition-all", "fail", d.line, `transition: ${d.value}`, "name the properties that change (a shorthand with no property animates all)", rule.selector);
      } else if (d.prop === "@apply" && /(^|\s)transition-all(\s|$)/.test(d.value)) add("S-transition-all", "fail", d.line, `@apply ${d.value}`, "transition-colors / transition-opacity / transition-transform", rule.selector);
      // S-motion-literal
      if (MOTION_PROPS.has(d.prop) && !reduced) {
        const bare = withoutVars(d.value);
        const durations = [...bare.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].filter((m) => Number(m[1]) !== 0).map((m) => m[0]);
        const easings = [...bare.matchAll(/\b(cubic-bezier|steps)\([^)]*\)/g)].map((m) => m[0]);
        if (durations.length || easings.length)
          add("S-motion-literal", "fail", d.line, `${d.prop}: ${d.value}`, "var(--ds-motion-duration-*) and var(--ds-motion-easing-*)", rule.selector);
      }
      // S-outline-none
      if (OUTLINE_NONE(d)) {
        const sel = rule.selector;
        if (/::/.test(sel) && !/:focus/.test(sel)) continue;
        if (/tabindex=["']?-1/.test(sel)) continue;
        if (/:not\(:focus-visible\)/.test(sel)) continue;
        // A replacement in the same rule (ring as box-shadow, border change) counts.
        if (/:focus/.test(sel) && rule.decls.some(showsFocus)) continue;
        const keys = subjectKeys(sel.replace(/:[\w-]+(\([^)]*\))?/g, ""));
        const replaced = focusVisibleRules.some((fv) => fv !== rule && (keys.length === 0 ? true : keys.some((k) => fv.selector.includes(k))));
        if (!replaced) add("S-outline-none", "fail", d.line, `${sel} { ${d.prop}: ${d.value} }`, "a :focus-visible rule that shows a ring for this element", sel);
      }
    }
    // S-hover-unguarded
    if (/:hover/.test(rule.selector) && rule.decls.length && !/\(\s*(any-)?hover\s*:\s*hover\s*\)/.test(at)) {
      add("S-hover-unguarded", "warn", rule.line, rule.selector, "inside @media (hover: hover)", rule.selector);
    }
  }
  return out;
}

/** String-literal spans of lexed JS: [start, end) runs of inStr. */
function stringSpans(inStr: Uint8Array): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let s = -1;
  for (let i = 0; i <= inStr.length; i++) {
    const on = i < inStr.length && inStr[i] === 1;
    if (on && s < 0) s = i;
    else if (!on && s >= 0) {
      spans.push([s, i]);
      s = -1;
    }
  }
  return spans;
}

function jsFindings(rel: string, src: string, ringClasses: Set<string>): Record<string, RawFinding[]> {
  const out: Record<string, RawFinding[]> = { "S-transition-all": [], "S-motion-literal": [], "S-outline-none": [] };
  const { text, inStr } = lexJs(src);
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const add = (check: string, at: number, measured: string, expected: string) =>
    out[check]!.push({ check, severity: "fail", selector: null, box: null, measured, expected, file: rel, line: lineOf(at) });
  for (const [s, e] of stringSpans(inStr)) {
    const str = text.slice(s, e);
    if (str.length > 4000) continue;
    for (const m of str.matchAll(/(?<![\w:-])((?:[\w-]+:)*)transition-all(?![\w-])/g)) add("S-transition-all", s + m.index!, m[0], "transition-colors / transition-opacity / transition-transform");
    for (const m of str.matchAll(/(?<![\w-])((?:[\w-]+:)*)(duration|delay)-(\d+|\[[^\]]+\])(?![\w-])/g)) add("S-motion-literal", s + m.index!, m[0], "a motion-token utility (duration-(--ds-motion-duration-*))");
    for (const m of str.matchAll(/(?<![\w-])((?:[\w-]+:)*)ease-\[[^\]]+\](?![\w-])/g)) add("S-motion-literal", s + m.index!, m[0], "ease-(--ds-motion-easing-*)");
    for (const m of str.matchAll(/(?<![\w-])((?:[\w-]+:)*)outline-(none|hidden)(?![\w-])/g)) {
      const variant = m[1] ?? "";
      if (/focus-visible:|focus-within:/.test(variant)) {
        // focus-visible:outline-none is fine only with another focus-visible: utility (ring, shadow).
        const near = text.slice(Math.max(0, s - 300), Math.min(text.length, e + 300));
        const others = [...near.matchAll(/(?<![\w-])(?:[\w-]+:)*focus-visible:([\w-[\]()/.%]+)/g)].filter((x) => !/^outline-(none|hidden)$/.test(x[1]!));
        if (others.length) continue;
      } else {
        const near = text.slice(Math.max(0, s - 400), Math.min(text.length, e + 400));
        // A focus-visible: utility on the same element (same class string), or a wrapper's focus-within: nearby.
        if (/(?:^|\s)(?:[\w-]+:)*(?:focus-visible|group-focus-visible|peer-focus-visible|data-\[focus-visible\]):/.test(str)) continue;
        if (/(?:^|[\s"'`])(?:[\w-]+:)*(?:focus-within|has-focus-visible|has-\[:focus-visible\]):/.test(near)) continue;
        if (/(?:^|[\s"'`])(?:[\w-]+:)*focus:(?:ring|border|shadow|outline-(?!none|hidden))/.test(str)) continue;
        // A CSS focus rule for a class named next to it (a wrapper's :focus-within ring).
        if ([...near.matchAll(/[\w-]+/g)].some((w) => ringClasses.has(w[0]))) continue;
      }
      add("S-outline-none", s + m.index!, m[0], "a focus-visible: ring or outline next to it");
    }
  }
  // Inline style objects: transition: "all 150ms", transitionDuration: "200ms".
  for (const m of text.matchAll(/\btransition(Property)?\s*:\s*/g)) {
    const at = m.index! + m[0].length;
    const q = text[at];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    const end = text.indexOf(q, at + 1);
    if (end < 0 || end - at > 300) continue;
    const value = text.slice(at + 1, end);
    if (/^\s*all\b/.test(value) || (!m[1] && splitTop(value).some((seg) => segmentAnimatesAll(seg) === true))) add("S-transition-all", at, `${m[0]}${q}${value}${q}`, "name the properties that change");
    const bare = withoutVars(value);
    if ([...bare.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].some((x) => Number(x[1]) !== 0) || /cubic-bezier\(/.test(bare)) add("S-motion-literal", at, `${m[0]}${q}${value}${q}`, "var(--ds-motion-duration-*) and var(--ds-motion-easing-*)");
  }
  for (const m of text.matchAll(/\b(transitionDuration|animationDuration|transitionTimingFunction)\s*:\s*(["'`])([^"'`]{1,80})\2/g)) {
    if (/var\(/.test(m[3]!)) continue;
    if (/^0(m?s)?$/.test(m[3]!.trim())) continue;
    add("S-motion-literal", m.index!, m[0], "var(--ds-motion-*)");
  }
  return out;
}

const COLOR_CATEGORIES = new Set(["hex", "rgb", "hsl", "oklch", "otherColorFn"]);
const COLOR_IN_ARBITRARY = /#[0-9a-f]{3,8}\b|\b(rgb|hsl|oklch|oklab|lab|lch|hwb|color)\(/i;

export interface StaticRun {
  results: Record<string, CheckResult>;
  files: number;
}

/** Runs every static check over `dirs` (absolute). File paths in findings are relative to `repo`. */
export function runStaticChecks(repo: string, dirs: string[], excludes: string[] = [], cap = 25): StaticRun {
  const opts: Options = {
    roots: dirs,
    json: true,
    top: 0,
    hits: true,
    excludes,
    exts: new Set(["css", "scss", "ts", "tsx", "js", "jsx", "mjs", "html", "vue", "svelte"]),
    includeTests: false,
    includeSubmodules: false,
    keepComments: false,
    failAbove: null,
    verbose: false,
  };
  const all: Record<string, RawFinding[]> = { "S-color-literal": [], "S-transition-all": [], "S-motion-literal": [], "S-hover-unguarded": [], "S-outline-none": [] };

  // S-color-literal: scan-literals itself.
  const report = scan(opts);
  // Hit paths are relative to the roots' common folder, where a file root counts as its folder.
  const folders = report.roots.map((r) => (statSync(r).isFile() ? dirname(r) : r).split(sep));
  const first = folders[0] ?? [];
  let depth = 0;
  while (first[depth] !== undefined && folders.every((f) => f[depth] === first[depth])) depth++;
  const base = first.slice(0, depth).join(sep) || sep;
  for (const file of report.fileReports) {
    for (const hit of file.hits ?? []) {
      const isColor = COLOR_CATEGORIES.has(hit.category) || (hit.category === "twArbitrary" && COLOR_IN_ARBITRARY.test(hit.value));
      if (!isColor || hit.fallback) continue;
      const abs = join(base, file.path);
      all["S-color-literal"]!.push({
        check: "S-color-literal",
        severity: hit.def ? "warn" : "fail",
        selector: null,
        box: null,
        measured: hit.value,
        expected: hit.def ? "alias a --ds-color-* token instead of defining a palette value" : "a --ds-color-* token (var(--ds-color-…) or the Tailwind token class)",
        message: hit.def ? `color literal in a definition${hit.definition ? ` (${hit.definition})` : ""}` : `inline ${hit.category} literal`,
        file: relative(repo, abs),
        line: hit.line,
      });
    }
  }

  // The rest: our own parse of the same files.
  const stats: SkipStats = { dirs: 0, dotDirs: 0, submodules: 0, symlinks: 0, tests: 0, generated: 0, tooLarge: 0, excluded: 0, unreadable: 0 };
  const files = new Set<string>();
  for (const dir of dirs) for (const f of collectFiles(dir, opts, stats)) files.add(f);
  const sources = new Map<string, string>();
  const cssRules = new Map<string, CssRule[]>();
  for (const file of files) {
    try {
      sources.set(file, readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const ext = extname(file).slice(1).toLowerCase();
    if (ext === "css" || ext === "scss") cssRules.set(file, parseCss(sources.get(file)!, ext === "scss"));
  }
  const ringClasses = focusRingClasses([...cssRules.values()].flat());
  for (const file of files) {
    let src: string;
    if (!sources.has(file)) continue;
    src = sources.get(file)!;
    const rel = relative(repo, file);
    const ext = extname(file).slice(1).toLowerCase();
    const parts = cssRules.has(file) ? cssFindings(rel, cssRules.get(file)!) : /^(ts|tsx|js|jsx|mjs)$/.test(ext) ? jsFindings(rel, src, ringClasses) : {};
    for (const [check, list] of Object.entries(parts)) all[check]!.push(...list);
  }

  const results: Record<string, CheckResult> = {};
  for (const [check, list] of Object.entries(all)) {
    // Fails first, so the cap keeps the ones that decide the status.
    list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
    results[check] = {
      findings: list.slice(0, cap),
      cut: Math.max(0, list.length - cap),
      fails: list.filter((f) => f.severity === "fail").length,
      warns: list.filter((f) => f.severity === "warn").length,
    };
  }
  return { results, files: files.size };
}

