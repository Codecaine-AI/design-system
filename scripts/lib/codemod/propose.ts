/**
 * Turns scan-literals hits into mapping rows: locate each literal, read its context, pick a token
 * and write the replacement in the form the slot needs.
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { collectFiles, HARD, scan, type Hit, type Options } from "../../scan-literals.ts";
import { parseColor } from "./color.ts";
import { pickColor, type ConsumerIndex } from "./color-role.ts";
import { buildConsumers } from "./consumers.ts";
import { readContext, type Context } from "./context.ts";
import { locate, type Span } from "./locate.ts";
import { pickClass, pickFamily, pickFontSize, pickRadius, pickSpacing, type Pick, type TailwindTarget } from "./size-role.ts";
import { cssPropertyName, jsClassSlot, jsSlot, markupSlot, typePosition, type Slot } from "./slot.ts";
import { cssRegionAt, kindOf, lineRange, prepareSource, type SourceFile } from "./source.ts";
import { fileSha, lineSha, type Row } from "./table.ts";
import { cssVarRef, type Theme, type TokenData } from "./tokens.ts";

/** scan-literals' generated-file header (its own constant is not exported). */
const GENERATED_HEADER = /@generated|do not edit|auto-?generated|this file (?:is|was) generated/i;
const COLORS = new Set(["hex", "rgb", "hsl", "oklch", "otherColorFn", "namedColor"]);
/** Default rows: every hard category, plus the soft color signals the standard bans. */
export const DEFAULT_CATEGORIES = [...HARD, "twPalette", "namedColor"];
export const ALL_CATEGORIES = [...DEFAULT_CATEGORIES, "twArbitraryVar", "pxSpacing", "otherFontSize"];

export interface ProposeOptions {
  appId: string;
  defaultTheme: Theme;
  categories: Set<string>;
  /**
   * The Tailwind that compiles the app's classes; class replacements target it. Default v4. "uno":
   * an UnoCSS host, which gets no class rewrites.
   */
  tailwind?: TailwindTarget;
  /** Where each custom property is read (built from the scanned files when propose runs). */
  consumers?: ConsumerIndex;
}

/**
 * How this file calls the package's `cssVar`: `cssVar`, its local alias (`import { cssVar as v }`),
 * `ns.cssVar` for a namespace import, or null when the file does not import it. Only a live import
 * declaration counts: one at the start of a statement, at the top level, outside comments and
 * strings (a commented-out import or import text in a string binds nothing).
 */
export function cssVarBinding(f: SourceFile): string | null {
  if (f.kind !== "js" || !f.inStr) return null;
  const t = f.text;
  let depth = 0;
  let scanned = 0;
  // The clause never crosses another `from`: without semicolons, `import * as React from "react"`
  // must not run on into the next import.
  for (const m of t.matchAll(/\bimport\s+(?!type\b)((?:(?!\bfrom\b)[^;])*?)\s*\bfrom\s*(["'])@codecaine-ai\/design-system\2/g)) {
    const at = m.index!;
    for (; scanned < at; scanned++) {
      if (f.inStr[scanned] === 1) continue;
      if (t[scanned] === "{") depth++;
      else if (t[scanned] === "}") depth--;
    }
    const quote = at + m[0].length - "@codecaine-ai/design-system".length - 2;
    if (depth !== 0 || f.inStr.subarray(at, quote).some((x) => x === 1)) continue;
    const lead = t.slice(t.lastIndexOf("\n", at - 1) + 1, at);
    if (!/^\s*$/.test(lead) && !/;\s*$/.test(lead)) continue;
    const clause = m[1];
    const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (ns) return `${ns[1]}.cssVar`;
    for (const spec of clause.match(/\{([^}]*)\}/)?.[1].split(",") ?? []) {
      const named = spec.trim().match(/^cssVar(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (named) return named[1] ?? "cssVar";
    }
  }
  return null;
}

function pickFor(data: TokenData, f: SourceFile, hit: Hit, span: Span | null, ctx: Context, opts: ProposeOptions): Pick {
  const appId = opts.appId;
  if (COLORS.has(hit.category)) {
    const color = parseColor(hit.value);
    if (!color) return { path: null, method: null, deltaE: null, why: `color ${hit.value}: color space not parsed` };
    const [ls] = lineRange(f, hit.line);
    const before = span ? f.text.slice(ls, span.start) : "";
    const ringShadow = /(?:^|[\s:,"'`])0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+\d*\.?\d+px\s*$/.test(before);
    const pick: Pick = pickColor(data, color, ctx, { appId, file: f.rel, ringShadow, consumers: opts.consumers });
    if (pick.path && pick.keepAlpha !== undefined) {
      pick.css = `color-mix(in srgb, ${cssVarRef(pick.path)} ${Math.round(pick.keepAlpha * 1000) / 10}%, transparent)`;
    }
    return pick;
  }
  switch (hit.category) {
    case "twArbitrary":
    case "twArbitraryVar":
    case "twPalette": {
      const cls = span ? f.src.slice(span.start, span.end) : hit.value;
      const pick = pickClass(data, cls, ctx, { appId, file: f.rel, tailwind: opts.tailwind });
      if (pick.root) ctx.property = pick.root;
      return pick;
    }
    case "pxFontSize":
    case "otherFontSize":
      return pickFontSize(data, hit.value, ctx);
    case "radius":
      return pickRadius(hit.value);
    case "fontFamily":
      return pickFamily(hit.value);
    case "pxSpacing":
      return pickSpacing(data, hit.value);
  }
  return { path: null, method: null, deltaE: null, why: `category ${hit.category}` };
}

/**
 * Why a JS literal outside any string value cannot take a token, or null: a call (`d3.rgb(255, 0, 0)`),
 * an object key (`{ "#ffffff": "White" }`), a literal type (`tone: "#fff" | "#000"`, an interface
 * member). CSS regions inside JS are values.
 */
function jsNonValue(f: SourceFile, span: Span): string | null {
  if (f.kind !== "js" || cssRegionAt(f, span.start) || span.slot === "class" || span.slot === "canvas") return null;
  const t = f.text;
  if (span.slot === "text" && f.inStr && f.inStr[span.start] === 0) return "a JS expression, not a CSS string: edit by hand";
  if (span.slot !== "wholeString" && span.slot !== "number") return null;
  let a = span.start - 1;
  while (a >= 0 && /\s/.test(t[a])) a--;
  let b = span.end;
  while (b < t.length && /\s/.test(t[b])) b++;
  if ((t[a] === "{" || t[a] === ",") && t[b] === ":") return "an object key, not a value: edit by hand";
  if ((t[a] === "|" && t[a - 1] !== "|") || (t[b] === "|" && t[b + 1] !== "|")) return "a literal type, not a value: edit by hand";
  // An interface or type literal member (`interface P { tone: "#fff" }`).
  let depth = 0;
  for (let k = span.start - 1; k >= 0; k--) {
    if (f.inStr && f.inStr[k] === 1) continue;
    if (t[k] === "}") depth++;
    else if (t[k] === "{" && depth-- === 0) {
      let p = k - 1;
      while (p >= 0 && !";{}".includes(t[p])) p--;
      if (/\b(?:interface\s+[\w$]+|type\s+[\w$]+(?:<[^>]*>)?\s*=)[^{]*$/.test(t.slice(p + 1, k))) return "a type member, not a value: edit by hand";
      break;
    }
  }
  return null;
}

/**
 * The text that replaces the literal in its slot, or null with the reason. `cssVarFn` is the file's
 * binding for cssVar; `slot` says whether a JS or markup literal reaches CSS (null in a stylesheet).
 */
function replacementFor(f: SourceFile, span: Span | null, pick: Pick, ctx: Context, cssVarFn: string | null, slot: Slot | null): { text: string | null; why?: string } {
  if (!span) return { text: null, why: "not found on the line as written (channel triplet, numeric tuple, or a value split across lines): edit by hand" };
  if (span.slot === "class") {
    if (slot && !slot.ok) return { text: null, why: slot.why };
    return pick.utility ? { text: pick.utility } : { text: null };
  }
  // Where the value goes is said even for a row without a token: a hand edit needs it too.
  const placed = (): string | undefined => {
    if (ctx.data) return "sits in a data object (id/type keys), not a style: check before changing";
    if (span.slot === "canvas") return "canvas 2D does not resolve var(): read the token with getComputedStyle, or keep it";
    const nonValue = jsNonValue(f, span) ?? typePosition(f, span);
    if (nonValue) return nonValue;
    if (slot && !slot.ok) return slot.why;
    return undefined;
  };
  const refused = placed();
  if (!pick.path || refused) return { text: null, why: refused };
  if (pick.handEdit) return { text: null, why: "no ready replacement: the row is flagged, so applying it is a hand edit" };
  // A nearest pick is a guess; in JS it is proposed only where the slot names a CSS property.
  if (f.kind === "js" && pick.method === "nearest" && !cssRegionAt(f, span.start) && !(slot?.ok && slot.property)) {
    return { text: null, why: "a nearest-color pick in JS with no CSS property in its slot: edit by hand" };
  }
  const single = !pick.path.includes(",");
  const value = pick.css ?? cssVarRef(pick.path);
  switch (span.slot) {
    case "text":
      return { text: value };
    case "wholeString": {
      const call = cssVarFn && single && !pick.css ? `${cssVarFn}(${JSON.stringify(pick.path)})` : null;
      // A JSX attribute value (`fill="#fff"`) takes an expression only in braces.
      if (call) return { text: ctx.attribute ? `{${call}}` : call };
      const q = f.src[span.start] === "'" ? "'" : '"';
      return { text: `${q}${value}${q}` };
    }
    case "number":
      return { text: cssVarFn && single && !pick.css ? `${cssVarFn}(${JSON.stringify(pick.path)})` : JSON.stringify(value) };
    case "attrBrace":
      return { text: JSON.stringify(value) };
  }
  return { text: null };
}

/** Where to read context for a literal not found as written: after the line's own declaration name, if any. */
function contextAnchor(f: SourceFile, line: number): Span {
  const [ls, le] = lineRange(f, line);
  const m = f.text.slice(ls, le).match(/(?:--|\$)?[\w-]+\s*:\s*/);
  const at = m ? ls + m.index! + m[0].length : ls;
  return { start: at, end: at, slot: "text" };
}

/** Whether a JS or markup literal reaches CSS (or a class list); null for stylesheets and canvas (decided elsewhere). */
function slotOf(f: SourceFile, span: Span | null, ctx: Context): Slot | null {
  if (!span) return null;
  if (f.kind === "js") return span.slot === "canvas" ? null : span.slot === "class" ? jsClassSlot(f, span) : jsSlot(f, span, ctx.property);
  if (f.kind === "html") return markupSlot(f, span, ctx.property);
  return null;
}

export interface FileProposal {
  rows: Array<Omit<Row, "id">>;
  /** Hits whose category was left out, per category. */
  dropped: Record<string, number>;
}

export function proposeFile(data: TokenData, f: SourceFile, hits: Hit[], opts: ProposeOptions): FileProposal {
  const rows: Array<Omit<Row, "id">> = [];
  const dropped: Record<string, number> = {};
  const seen = new Map<string, number>();
  const cssVarFn = cssVarBinding(f);
  const byLine = new Map<number, Hit[]>();
  for (const hit of hits) byLine.set(hit.line, [...(byLine.get(hit.line) ?? []), hit]);
  for (const hit of hits) {
    // A definition hit is numbered among its own property's hits (locate matches it by name).
    const key = `${hit.line}\u0000${hit.category}\u0000${hit.value}\u0000${hit.definition ?? ""}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    if (!opts.categories.has(hit.category)) {
      dropped[hit.category] = (dropped[hit.category] ?? 0) + 1;
      continue;
    }
    const span = locate(f, hit, occurrence, byLine.get(hit.line));
    const [ls, le] = lineRange(f, hit.line);
    const ctx = readContext(f, span ?? contextAnchor(f, hit.line), { defaultTheme: opts.defaultTheme });
    const slot = slotOf(f, span, ctx);
    // The slot's CSS property (`background` for `background: on ? "#fff" : x` on its own line) when
    // the line alone did not name one.
    if (slot?.ok && slot.property && f.kind === "js" && !cssPropertyName(ctx.property)) {
      // A JS name the line gave (`$on` in `({ $on }) => …`) is not a definition once the slot names the property.
      if (ctx.definition && !ctx.definition.startsWith("--")) ctx.definition = null;
      ctx.property = slot.property;
      ctx.hints += ` ${slot.property}`;
    }
    const pick = pickFor(data, f, hit, span, ctx, opts);
    const rep = replacementFor(f, span, pick, ctx, cssVarFn, slot);
    const why = [pick.why, rep.why].filter(Boolean).join("; ");
    rows.push({
      file: f.rel,
      line: hit.line,
      column: span ? span.start - ls + 1 : null,
      lineSha: lineSha(f.src.slice(ls, le)),
      category: hit.category,
      kind: COLORS.has(hit.category) && hit.category !== "namedColor" ? (hit.def ? "definition" : hit.fallback ? "fallback" : "inline") : null,
      literal: span ? f.src.slice(span.start, span.end) : hit.value,
      context: { property: ctx.property, selector: ctx.selector, component: ctx.component, theme: ctx.theme },
      proposed: pick.path,
      replacement: rep.text,
      method: pick.method,
      deltaE: pick.deltaE,
      why,
      approve: "",
    });
  }
  // Source order: by line, then column (a literal not found as written goes last on its line).
  rows.sort((a, b) => a.line - b.line || (a.column ?? 1e9) - (b.column ?? 1e9));
  return { rows, dropped };
}

export interface ScanInput {
  root: string;
  paths: string[];
  exclude: string[];
  ext?: string;
}

/**
 * Runs scan-literals with hits over every path (one scan per path, so each report's file paths
 * resolve against that path) and proposes a row per hit. Files keep root-relative paths.
 */
export function propose(data: TokenData, input: ScanInput, opts: ProposeOptions): { rows: Row[]; dropped: Record<string, number>; files: Record<string, string> } {
  const rows: Array<Omit<Row, "id">> = [];
  const dropped: Record<string, number> = {};
  const files: Record<string, string> = {};
  const done = new Set<string>();
  const optionsFor = (abs: string): Options => ({
    roots: [abs], json: true, top: 0, hits: true, excludes: input.exclude, exts: extSet(input.ext),
    includeTests: false, includeSubmodules: false, keepComments: false, failAbove: null, verbose: false,
  });
  // Every scanned file, with literals or not, read once: a custom property's readers can sit in a file with no literal.
  const sources = new Map<string, SourceFile>();
  for (const p of input.paths) {
    const abs = resolve(input.root, p);
    const stats = { dirs: 0, dotDirs: 0, submodules: 0, symlinks: 0, tests: 0, generated: 0, tooLarge: 0, excluded: 0, unreadable: 0 };
    for (const file of collectFiles(abs, optionsFor(abs), stats)) {
      const kind = kindOf(file);
      if (!kind || sources.has(file)) continue;
      try {
        const size = statSync(file).size;
        if (size > 2 * 1024 * 1024) continue;
        const src = readFileSync(file, "utf8");
        // The files scan-literals skips as minified or generated are not read for readers either.
        if ((size > 100 * 1024 && src.length / src.split("\n").length > 300) || GENERATED_HEADER.test(src.slice(0, 500))) continue;
        sources.set(file, prepareSource(relative(input.root, file).split(sep).join("/"), src, kind));
      } catch {
        // Unreadable: scan-literals skips it too.
      }
    }
  }
  const consumers = opts.consumers ?? buildConsumers([...sources.values()]);
  for (const p of input.paths) {
    const abs = resolve(input.root, p);
    const report = scan(optionsFor(abs));
    const single = statSync(abs).isFile();
    for (const fr of [...report.fileReports].sort((a, b) => a.path.localeCompare(b.path))) {
      const file = single ? abs : join(abs, fr.path);
      if (done.has(file)) continue;
      done.add(file);
      const kind = kindOf(file);
      if (!kind || !fr.hits) continue;
      const rel = relative(input.root, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      const prepared = sources.get(file)?.src === src ? sources.get(file)! : prepareSource(rel, src, kind);
      const p = proposeFile(data, prepared, fr.hits, { ...opts, consumers });
      if (p.rows.length) files[rel] = fileSha(src);
      rows.push(...p.rows);
      for (const [c, n] of Object.entries(p.dropped)) dropped[c] = (dropped[c] ?? 0) + n;
    }
  }
  return { rows: rows.map((r, i) => ({ id: i + 1, ...r })), dropped, files };
}

const DEFAULT_EXTS = ["css", "scss", "sass", "less", "uss", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "html", "htm", "vue", "svelte", "astro"];

function extSet(ext?: string): Set<string> {
  if (!ext) return new Set(DEFAULT_EXTS);
  const list = ext.replace(/^\+/, "").split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  return new Set(ext.startsWith("+") ? [...DEFAULT_EXTS, ...list] : list);
}
