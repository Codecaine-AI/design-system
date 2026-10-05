#!/usr/bin/env bun
/**
 * Compiles tokens/ (DTCG-shaped JSON) into dist/ and the generated reference
 * table in guide/tokens.md.
 *
 *   bun scripts/build.ts           write every output
 *   bun scripts/build.ts --check   rebuild in memory; exit 1 and list stale files
 *
 * Zero dependencies. Deterministic: sorted output, no timestamps.
 *
 * Outputs
 *   dist/css/tokens.css        custom properties (base, --ds-<theme>-*, theme switch blocks) and color-scheme
 *   dist/css/tokens-dark-first.css  the same, with dark on :root (dark-first surfaces)
 *   dist/css/host-contract.css      agent-viewer host contract (--background, --trace-*, ...) mapped to --ds-*
 *   dist/css/host-contract-dark-first.css  the same, with dark on :root
 *   dist/tailwind/preset-v3.cjs     Tailwind v3 preset: the tailwind.css utility names for v3 apps
 *   dist/tailwind/theme.css    Tailwind v4 `@theme inline` mapping utilities onto --ds-* vars, and `dark:`
 *   dist/tailwind/strict.css   optional reset of Tailwind's default palette, type and shadow scales
 *   dist/js/index.js, .d.ts    resolved values (nested + flat) and cssVar()
 *   dist/json/*.json           base.json, <theme>.json (flat), tokens.json (nested)
 *   dist/guide/index.html      visual style guide (links ../css/tokens.css and ../../css/fonts.css)
 *   guide/tokens.md            the region between the GENERATED markers
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderHostContractCss } from "./lib/host-contract.ts";
import { renderTailwindV3Preset } from "./lib/tailwind-v3.ts";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export const ROOT = resolve(import.meta.dir, "..");
export const PREFIX = "ds";
export const DEFAULT_THEME = "light";
export const REQUIRED_THEMES = ["light", "dark"] as const;

export const TOKEN_TYPES = [
  "color",
  "dimension",
  "fontFamily",
  "fontWeight",
  "number",
  "duration",
  "cubicBezier",
  "shadow",
] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export type TokenValue = string | number;

export interface SourceFile {
  /** Path shown in messages, e.g. "tokens/base/space.tokens.json". */
  file: string;
  json: unknown;
}

export interface Sources {
  base: SourceFile[];
  /** One file per theme; the theme name is the file name before ".tokens.json". */
  themes: SourceFile[];
}

export interface Token {
  id: string;
  path: string[];
  type: TokenType;
  value: TokenValue;
  description?: string;
  file: string;
  /** Authoring position (file order, then key order): the reading order in docs. */
  order: number;
}

export interface Model {
  /** Theme names, default theme first, the rest sorted. */
  themes: string[];
  base: Map<string, Token>;
  theme: Record<string, Map<string, Token>>;
  basePaths: string[];
  themePaths: string[];
  resolved: { base: Map<string, TokenValue>; theme: Record<string, Map<string, TokenValue>> };
  groups: { base: Map<string, string>; theme: Map<string, string> };
}

export class TokenError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Token validation failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "TokenError";
    this.problems = problems;
  }
}

const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALIAS_RE = /\{([^{}]*)\}/g;
const WHOLE_ALIAS_RE = /^\{([^{}]+)\}$/;
const TOKEN_PROPS = new Set(["$value", "$type", "$description", "$extensions", "$deprecated"]);
const GROUP_PROPS = new Set(["$description", "$extensions"]);

/** Which token types an alias embedded inside a larger value may point at. */
const EMBEDDABLE: Partial<Record<TokenType, TokenType[]>> = {
  color: ["color"],
  shadow: ["color", "dimension"],
  dimension: ["dimension"],
  duration: ["duration"],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? `"${value}"` : typeof value;
}

/** Numeric value of a path segment like "10" or "0-5" (= 0.5); null for words. */
function segmentNumber(segment: string): number | null {
  return /^\d+(?:-\d+)?$/.test(segment) ? Number(segment.replace("-", ".")) : null;
}

/** Natural order for dotted paths: numeric segments by value, words by code point. */
export function comparePaths(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] === bs[i]) continue;
    const an = segmentNumber(as[i]);
    const bn = segmentNumber(bs[i]);
    if (an !== null && bn !== null && an !== bn) return an - bn;
    if (an !== null && bn === null) return -1;
    if (an === null && bn !== null) return 1;
    return as[i] < bs[i] ? -1 : 1;
  }
  return as.length - bs.length;
}

export function cssName(id: string, theme?: string): string {
  return `--${PREFIX}-${theme ? `${theme}-` : ""}${id.split(".").join("-")}`;
}

function aliasRefs(value: TokenValue): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(ALIAS_RE)].map((m) => m[1]);
}

/** Splits a function argument list at top-level commas. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Value validation (on fully resolved values)
// ---------------------------------------------------------------------------

const MIX_SPACES = new Set(["srgb", "srgb-linear", "display-p3", "lab", "oklab", "lch", "oklch", "hsl", "hwb", "xyz", "xyz-d50", "xyz-d65"]);

/** Returns a problem string, or null when `value` is a valid color. */
export function colorProblem(value: string): string | null {
  const s = value.trim();
  if (s.startsWith("#")) {
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(s)) return null;
    if (/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(s)) return `hex colors must be lowercase ("${s.toLowerCase()}")`;
    return `"${s}" is not #rrggbb or #rrggbbaa`;
  }
  if (/^(?:transparent|currentcolor)$/i.test(s)) return null;
  const rgb = /^rgba?\((.*)\)$/i.exec(s);
  if (rgb) {
    const parts = splitTopLevel(rgb[1]);
    if (parts.length !== 3 && parts.length !== 4) return `"${s}" needs 3 or 4 comma-separated arguments`;
    const channels = parts.slice(0, 3).map(Number);
    if (channels.some((c, i) => !/^\d+$/.test(parts[i]) || c > 255)) return `"${s}" channels must be integers 0-255`;
    if (parts.length === 3) {
      return `opaque "${s}" must be written as hex ("#${channels.map(toHex).join("")}")`;
    }
    const alpha = Number(parts[3]);
    if (!/^(?:0|1|0?\.\d+|1\.0+)$/.test(parts[3]) || alpha < 0 || alpha > 1) return `"${s}" alpha must be a number 0-1`;
    const scaled = alpha * 255;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) {
      return `"${s}" alpha ${parts[3]} is exact in 8 bits: write "#${channels.map(toHex).join("")}${toHex(Math.round(scaled))}"`;
    }
    return null;
  }
  const mix = /^color-mix\((.*)\)$/i.exec(s);
  if (mix) {
    const args = splitTopLevel(mix[1]);
    if (args.length !== 3) return `"${s}" color-mix needs "in <space>" and two colors`;
    const space = /^in\s+([a-z0-9-]+)$/i.exec(args[0]);
    if (!space || !MIX_SPACES.has(space[1].toLowerCase())) return `"${s}" has an unknown color-mix interpolation space`;
    const weights: number[] = [];
    for (const arg of args.slice(1)) {
      let color = arg;
      let pct: string | null = null;
      const trailing = /^(.*\S)\s+(\d+(?:\.\d+)?%)$/.exec(arg);
      const leading = /^(\d+(?:\.\d+)?%)\s+(.*)$/.exec(arg);
      if (trailing) [color, pct] = [trailing[1], trailing[2]];
      else if (leading) [pct, color] = [leading[1], leading[2]];
      if (pct !== null && Number(pct.slice(0, -1)) > 100) return `"${s}" mixes ${pct}, over 100%`;
      if (pct !== null) weights.push(Number(pct.slice(0, -1)));
      const inner = colorProblem(color);
      if (inner) return `in "${s}": ${inner}`;
    }
    if (weights.length === 2 && weights[0] + weights[1] === 0) return `"${s}" mixes 0% of both colors`;
    return null;
  }
  return `"${s}" is not a valid color (use #rrggbb, #rrggbbaa, rgba() for alphas not exact in 8 bits, color-mix() or transparent)`;
}

const DIMENSION_RE = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|ch|ex|lh|vw|vh|dvh|svh|lvh|vmin|vmax|%)$/;

/** Characters that would end a declaration, open a block or comment, or add !important. */
function unsafeCss(value: string): string | null {
  if (/[;{}<>!\\\n\r]/.test(value)) return `"${value}" contains a character that is not allowed in a token value (; { } < > ! \\ or a line break)`;
  if (value.includes("/*") || value.includes("*/")) return `"${value}" contains a CSS comment`;
  if (!balanced(value)) return `"${value}" has unbalanced parentheses`;
  if ((value.match(/"/g) ?? []).length % 2 || (value.match(/'/g) ?? []).length % 2) return `"${value}" has an unbalanced quote`;
  return null;
}

export function valueProblem(type: TokenType, value: TokenValue): string | null {
  if (typeof value === "string") {
    const unsafe = unsafeCss(value);
    if (unsafe) return unsafe;
  }
  switch (type) {
    case "color":
      return typeof value === "string" ? colorProblem(value) : `color must be a string, got ${describeValue(value)}`;
    case "dimension": {
      if (typeof value !== "string") return `dimension must be a CSS string like "4px", got ${describeValue(value)}`;
      const s = value.trim();
      if (s === "0" || DIMENSION_RE.test(s)) return null;
      if (/^(?:calc|min|max|clamp)\(.*\)$/.test(s) && balanced(s)) return null;
      return `"${s}" is not a dimension (number with a unit, or calc/min/max/clamp)`;
    }
    case "fontFamily": {
      if (typeof value !== "string" || !value.trim()) return "fontFamily must be a non-empty CSS font stack";
      const families = splitTopLevel(value);
      if (families.some((f) => !f)) return `"${value}" has an empty family`;
      if ((value.match(/"/g) ?? []).length % 2 || (value.match(/'/g) ?? []).length % 2) return `"${value}" has an unbalanced quote`;
      return null;
    }
    case "fontWeight":
      return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1000
        ? null
        : `fontWeight must be a JSON number 1-1000, got ${describeValue(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `number must be a JSON number, got ${describeValue(value)}`;
    case "duration":
      return typeof value === "string" && /^(?:\d+|\d*\.\d+)(?:ms|s)$/.test(value)
        ? null
        : `duration must be like "150ms" or "2s", got ${describeValue(value)}`;
    case "cubicBezier": {
      if (typeof value !== "string") return `cubicBezier must be a CSS easing string, got ${describeValue(value)}`;
      if (/^(?:linear|ease|ease-in|ease-out|ease-in-out)$/.test(value)) return null;
      const m = /^cubic-bezier\(([^)]*)\)$/.exec(value);
      if (!m) return `"${value}" is not an easing (ease, ease-in, ease-out, ease-in-out, linear or cubic-bezier(x1, y1, x2, y2))`;
      const parts = splitTopLevel(m[1]);
      if (parts.length !== 4 || parts.some((part) => !/^-?(?:\d+|\d*\.\d+)$/.test(part))) return `"${value}" needs four numbers`;
      const nums = parts.map(Number);
      if (nums[0] < 0 || nums[0] > 1 || nums[2] < 0 || nums[2] > 1) return `"${value}" x values must be within 0-1`;
      return null;
    }
    case "shadow":
      return typeof value === "string" && value.trim() ? shadowProblem(value) : "shadow must be a non-empty CSS box-shadow string";
  }
}

const SHADOW_LENGTH_RE = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|ch|ex|lh|vw|vh|dvh|svh|lvh|vmin|vmax)$/;

function isShadowLength(word: string): boolean {
  return word === "0" || SHADOW_LENGTH_RE.test(word) || (/^(?:calc|min|max|clamp)\(.*\)$/.test(word) && balanced(word));
}

/** Splits at top-level whitespace (outside parentheses and quotes). */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

/**
 * Returns a problem string, or null when `value` is a CSS box-shadow: "none", or comma-separated layers
 * of 2 to 4 adjacent lengths (x, y, blur >= 0, spread), at most one color and an optional `inset`.
 */
export function shadowProblem(value: string): string | null {
  const s = value.trim();
  if (s === "none") return null;
  const layers = splitTopLevel(s);
  for (const [n, layer] of layers.entries()) {
    const at = layers.length > 1 ? `layer ${n + 1} of "${s}"` : `"${s}"`;
    if (!layer) return `${at} is empty`;
    if (layer === "none") return `${at}: "none" must be the whole value`;
    const words = splitWords(layer);
    const lengths: number[] = []; // word positions
    let colors = 0;
    let insets = 0;
    for (const [i, word] of words.entries()) {
      if (word === "inset") insets++;
      else if (isShadowLength(word)) lengths.push(i);
      else if (/^-?(?:\d|\.\d)/.test(word)) return `${at}: "${word}" is not a length (a number needs a unit)`;
      else {
        const problem = colorProblem(word);
        if (problem) return `in ${at}: ${problem}`;
        colors++;
      }
    }
    if (lengths.length < 2 || lengths.length > 4) return `${at} needs 2 to 4 lengths (x, y, blur, spread), got ${lengths.length}`;
    if (lengths[lengths.length - 1] - lengths[0] !== lengths.length - 1) return `${at}: the lengths must be adjacent`;
    if (lengths.length >= 3 && words[lengths[2]].startsWith("-")) return `${at}: blur ${words[lengths[2]]} is negative`;
    if (colors > 1) return `${at} has ${colors} colors; a layer takes at most one`;
    if (insets > 1) return `${at} repeats inset`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The only files the build reads: tokens/base/<name>.tokens.json and tokens/themes/<theme>.tokens.json. */
const TOKEN_FILE_RE = /^tokens\/(?:base|themes)\/[^/]+\.tokens\.json$/;

export interface DuplicateKey {
  /** Dotted path of the object that holds the key twice; "" for the file root. */
  path: string;
  key: string;
  /** 1-based line of the repeated key. */
  line: number;
}

/**
 * Keys that appear twice in one JSON object. JSON.parse keeps only the last of them, so this reads the raw
 * text. `text` must be valid JSON (JSON.parse accepted it).
 */
export function duplicateKeys(text: string): DuplicateKey[] {
  type Frame = { object: true; keys: Set<string>; key: string; expectKey: boolean } | { object: false; index: number };
  const found: DuplicateKey[] = [];
  const stack: Frame[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    else if (ch === "{") stack.push({ object: true, keys: new Set(), key: "", expectKey: true });
    else if (ch === "[") stack.push({ object: false, index: 0 });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.object) top.expectKey = true;
      else if (top) top.index++;
    } else if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.object && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) {
          const path = stack.slice(0, -1).map((f) => (f.object ? f.key : String(f.index))).join(".");
          found.push({ path, key, line });
        }
        top.keys.add(key);
        top.key = key;
        top.expectKey = false;
      }
      i = end; // JSON strings hold no raw line breaks
    }
  }
  return found;
}

export function readSources(root: string = ROOT): Sources {
  const problems: string[] = [];
  for (const path of listFiles(join(root, "tokens"), "tokens/")) {
    if (path.endsWith(".json") && !TOKEN_FILE_RE.test(path)) {
      problems.push(`${path}: not read by the build; token files are tokens/base/<name>.tokens.json and tokens/themes/<theme>.tokens.json`);
    }
  }
  const read = (dir: string): SourceFile[] =>
    listFiles(join(root, dir), `${dir}/`)
      .filter((path) => TOKEN_FILE_RE.test(path))
      .sort()
      .flatMap((file) => {
        const text = readFileSync(join(root, file), "utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (error) {
          problems.push(`${file}: invalid JSON (${(error as Error).message})`);
          return [];
        }
        const duplicates = duplicateKeys(text);
        for (const { path, key, line } of duplicates) {
          problems.push(`${file}: ${path ? `${path}.` : ""}${key}: duplicate key "${key}" on line ${line} (JSON.parse keeps only the last)`);
        }
        return duplicates.length ? [] : [{ file, json }];
      });
  const sources = { base: read("tokens/base"), themes: read("tokens/themes") };
  if (problems.length) throw new TokenError(problems);
  return sources;
}

interface Collected {
  tokens: Token[];
  groups: Map<string, string>;
}

function collect(file: string, json: unknown, problems: string[], counter = { next: 0 }): Collected {
  const tokens: Token[] = [];
  const groups = new Map<string, string>();
  const walk = (node: unknown, path: string[]): void => {
    const where = `${file}: ${path.join(".") || "(root)"}`;
    if (!isPlainObject(node)) {
      problems.push(`${where}: expected an object, got ${describeValue(node)}`);
      return;
    }
    const keys = Object.keys(node);
    const children = keys.filter((k) => !k.startsWith("$"));
    const meta = keys.filter((k) => k.startsWith("$"));
    const hasValue = "$value" in node;
    const hasType = "$type" in node;

    if (!hasValue && hasType && children.length > 0) {
      problems.push(`${where}: $type on a group is not supported; put $type on each token`);
    } else if (hasValue || hasType) {
      if (path.length === 0) {
        problems.push(`${where}: the file root must be a group, not a token`);
        return;
      }
      if (children.length) problems.push(`${where}: a token cannot also hold child keys (${children.join(", ")})`);
      for (const k of meta) if (!TOKEN_PROPS.has(k)) problems.push(`${where}: unknown token property ${k}`);
      if (!hasValue) problems.push(`${where}: missing $value`);
      if (!hasType) problems.push(`${where}: missing $type`);
      if (!hasValue || !hasType) return;
      const type = node.$type;
      const value = node.$value;
      const description = node.$description;
      let ok = true;
      if (typeof type !== "string" || !(TOKEN_TYPES as readonly string[]).includes(type)) {
        problems.push(`${where}: unknown $type ${describeValue(type)} (allowed: ${TOKEN_TYPES.join(", ")})`);
        ok = false;
      }
      if (typeof value !== "string" && typeof value !== "number") {
        problems.push(`${where}: $value must be a string or a number, got ${describeValue(value)}`);
        ok = false;
      }
      if (description !== undefined && typeof description !== "string") {
        problems.push(`${where}: $description must be a string`);
      }
      if (ok) {
        tokens.push({
          id: path.join("."),
          path,
          type: type as TokenType,
          value: value as TokenValue,
          description: typeof description === "string" ? description : undefined,
          file,
          order: counter.next++,
        });
      }
      return;
    }

    for (const k of meta) if (!GROUP_PROPS.has(k) && k !== "$type") problems.push(`${where}: unknown group property ${k}`);
    if (typeof node.$description === "string" && path.length) groups.set(path.join("."), node.$description);
    if (children.length === 0) problems.push(`${where}: empty group`);
    for (const key of children) {
      if (!KEY_RE.test(key)) {
        problems.push(`${file}: ${[...path, key].join(".")}: invalid key "${key}" (lowercase letters, digits, single hyphens)`);
        continue;
      }
      walk(node[key], [...path, key]);
    }
  };
  walk(json, []);
  return { tokens, groups };
}

/** Merges collected files into one scope, reporting duplicate paths and token/group clashes. */
function mergeScope(parts: Collected[], problems: string[]): { tokens: Map<string, Token>; groups: Map<string, string> } {
  const tokens = new Map<string, Token>();
  const groups = new Map<string, string>();
  for (const part of parts) {
    for (const token of part.tokens) {
      const existing = tokens.get(token.id);
      if (existing) problems.push(`duplicate path ${token.id}: defined in ${existing.file} and ${token.file}`);
      else tokens.set(token.id, token);
    }
    for (const [id, text] of part.groups) if (!groups.has(id)) groups.set(id, text);
  }
  const groupOwners = new Map<string, Token>();
  for (const token of tokens.values()) {
    for (let i = 1; i < token.path.length; i++) {
      const prefix = token.path.slice(0, i).join(".");
      if (!groupOwners.has(prefix)) groupOwners.set(prefix, token);
    }
  }
  for (const token of tokens.values()) {
    const owner = groupOwners.get(token.id);
    if (owner) problems.push(`duplicate path ${token.id}: a token in ${token.file} and a group in ${owner.file} (${owner.id})`);
  }
  return { tokens, groups };
}

function sortedMap<V>(map: Map<string, V>): Map<string, V> {
  return new Map([...map.entries()].sort(([a], [b]) => comparePaths(a, b)));
}

/** Validates every rule and resolves aliases. Throws TokenError listing every problem found. */
export function loadModel(sources: Sources): Model {
  const problems: string[] = [];

  // Base: deep-merge every file.
  const counter = { next: 0 };
  const base = mergeScope(sources.base.map((s) => collect(s.file, s.json, problems, counter)), problems);

  // Themes: one file each.
  const themeTokens: Record<string, Map<string, Token>> = Object.create(null);
  const groupsByTheme: Record<string, Map<string, string>> = Object.create(null);
  for (const source of sources.themes) {
    const name = source.file.split("/").pop()!.replace(/\.tokens\.json$/, "");
    if (!KEY_RE.test(name)) {
      problems.push(`${source.file}: theme name "${name}" must be lowercase letters, digits and hyphens`);
      continue;
    }
    if (themeTokens[name]) {
      problems.push(`${source.file}: theme ${name} is defined twice`);
      continue;
    }
    const merged = mergeScope([collect(source.file, source.json, problems, { next: 0 })], problems);
    themeTokens[name] = merged.tokens;
    groupsByTheme[name] = merged.groups;
  }
  for (const required of REQUIRED_THEMES) {
    if (!themeTokens[required]) problems.push(`missing theme file tokens/themes/${required}.tokens.json`);
  }
  const themes = [
    ...(themeTokens[DEFAULT_THEME] ? [DEFAULT_THEME] : []),
    ...Object.keys(themeTokens).filter((t) => t !== DEFAULT_THEME).sort(),
  ];
  // Group descriptions come from the default theme first, like token descriptions.
  const themeGroups = new Map<string, string>();
  for (const theme of themes) for (const [id, text] of groupsByTheme[theme]) if (!themeGroups.has(id)) themeGroups.set(id, text);

  // Theme parity: same key set, same type per key.
  const reference = themes[0];
  if (reference) {
    for (const other of themes.slice(1)) {
      const a = themeTokens[reference];
      const b = themeTokens[other];
      for (const [id, token] of a) {
        const twin = b.get(id);
        if (!twin) problems.push(`theme key mismatch: ${id} is in ${reference} but missing from ${other}`);
        else if (twin.type !== token.type) problems.push(`theme key mismatch: ${id} is a ${token.type} in ${reference} but a ${twin.type} in ${other}`);
      }
      for (const id of b.keys()) {
        if (!a.has(id)) problems.push(`theme key mismatch: ${id} is in ${other} but missing from ${reference}`);
      }
    }
  }

  // A theme path may not reuse or nest a base path.
  const basePrefixes = new Set<string>();
  for (const token of base.tokens.values()) {
    for (let i = 1; i <= token.path.length; i++) basePrefixes.add(token.path.slice(0, i).join("."));
  }
  const themeIds = new Set(themes.flatMap((t) => [...themeTokens[t].keys()]));
  for (const id of [...themeIds].sort(comparePaths)) {
    const parts = id.split(".");
    const clash = basePrefixes.has(id) || parts.some((_, i) => base.tokens.has(parts.slice(0, i + 1).join(".")));
    if (clash) problems.push(`duplicate path ${id}: used by a theme file and by tokens/base`);
  }

  // Aliases: syntax, existence, type compatibility.
  const lookupIn = (scope: Map<string, Token> | null) => (ref: string): Token | undefined =>
    scope?.get(ref) ?? base.tokens.get(ref);
  const checkAliases = (token: Token, lookup: (ref: string) => Token | undefined, scopeLabel: string) => {
    const where = `${token.file}: ${token.id}`;
    const whole = typeof token.value === "string" ? WHOLE_ALIAS_RE.exec(token.value) : null;
    for (const ref of aliasRefs(token.value)) {
      if (!ref.split(".").every((seg) => KEY_RE.test(seg))) {
        problems.push(`${where}: malformed alias {${ref}}`);
        continue;
      }
      const target = lookup(ref);
      if (!target) {
        problems.push(`${where}: unresolved alias {${ref}}${scopeLabel === "base" && themeIds.has(ref) ? " (base tokens cannot reference theme tokens)" : ""}`);
        continue;
      }
      if (whole) {
        if (target.type !== token.type) problems.push(`${where}: alias {${ref}} is a ${target.type}, but this token is a ${token.type}`);
      } else {
        const allowed = EMBEDDABLE[token.type];
        if (!allowed) problems.push(`${where}: a ${token.type} can only alias a whole value ("{${ref}}")`);
        else if (!allowed.includes(target.type)) problems.push(`${where}: embedded alias {${ref}} is a ${target.type}; a ${token.type} can embed ${allowed.join(" or ")}`);
      }
    }
  };
  for (const token of base.tokens.values()) checkAliases(token, lookupIn(null), "base");
  for (const theme of themes) for (const token of themeTokens[theme].values()) checkAliases(token, lookupIn(themeTokens[theme]), theme);

  // Resolution with cycle detection.
  const reportedCycles = new Set<string>();
  const resolveScope = (
    label: string,
    scope: Map<string, Token>,
    outside: Map<string, TokenValue> | null,
  ): Map<string, TokenValue> => {
    const done = new Map<string, TokenValue | undefined>();
    const visiting: string[] = [];
    const resolveId = (id: string): TokenValue | undefined => {
      if (!scope.has(id)) return outside?.get(id);
      if (done.has(id)) return done.get(id);
      const at = visiting.indexOf(id);
      if (at !== -1) {
        const cycle = [...visiting.slice(at), id];
        const key = `${label}:${[...new Set(cycle)].sort().join("|")}`;
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          problems.push(`alias cycle in ${label}: ${cycle.join(" -> ")}`);
        }
        return undefined;
      }
      visiting.push(id);
      const token = scope.get(id)!;
      let result: TokenValue | undefined;
      if (typeof token.value !== "string") {
        result = token.value;
      } else {
        const whole = WHOLE_ALIAS_RE.exec(token.value);
        if (whole) {
          result = resolveId(whole[1]);
        } else {
          let failed = false;
          const text = token.value.replace(ALIAS_RE, (_, ref: string) => {
            const value = resolveId(ref);
            if (value === undefined) failed = true;
            return String(value);
          });
          result = failed ? undefined : text;
        }
      }
      visiting.pop();
      done.set(id, result);
      return result;
    };
    const out = new Map<string, TokenValue>();
    for (const id of scope.keys()) {
      const value = resolveId(id);
      if (value !== undefined) out.set(id, value);
    }
    return out;
  };
  const resolvedBase = resolveScope("base", base.tokens, null);
  const resolvedThemes: Record<string, Map<string, TokenValue>> = Object.create(null);
  for (const theme of themes) resolvedThemes[theme] = resolveScope(theme, themeTokens[theme], resolvedBase);

  // Value checks on resolved values.
  const checkValues = (tokens: Map<string, Token>, resolved: Map<string, TokenValue>, label: string) => {
    for (const token of tokens.values()) {
      const value = resolved.get(token.id);
      if (value === undefined) continue;
      const problem = valueProblem(token.type, value);
      if (problem) {
        const kind = token.type === "color" ? "invalid color" : `invalid ${token.type}`;
        problems.push(`${token.file}: ${token.id}${label}: ${kind}: ${problem}`);
      }
    }
  };
  checkValues(base.tokens, resolvedBase, "");
  for (const theme of themes) checkValues(themeTokens[theme], resolvedThemes[theme], themes.length > 1 ? ` (${theme})` : "");

  // CSS variable names must be unique across base, theme and theme-qualified vars.
  const names = new Map<string, string>();
  const claim = (name: string, origin: string) => {
    const existing = names.get(name);
    if (existing && existing !== origin) problems.push(`CSS variable ${name} is produced by both ${existing} and ${origin}`);
    else names.set(name, origin);
  };
  for (const id of [...base.tokens.keys()].sort(comparePaths)) claim(cssName(id), `base token ${id}`);
  for (const id of [...themeIds].sort(comparePaths)) claim(cssName(id), `theme token ${id}`);
  for (const theme of themes) {
    for (const id of [...themeTokens[theme].keys()].sort(comparePaths)) claim(cssName(id, theme), `${theme} token ${id}`);
  }

  if (problems.length) throw new TokenError([...new Set(problems)]);

  const sortedThemes: Record<string, Map<string, Token>> = Object.create(null);
  const sortedResolved: Record<string, Map<string, TokenValue>> = Object.create(null);
  for (const theme of themes) {
    sortedThemes[theme] = sortedMap(themeTokens[theme]);
    sortedResolved[theme] = sortedMap(resolvedThemes[theme]);
  }
  return {
    themes,
    base: sortedMap(base.tokens),
    theme: sortedThemes,
    basePaths: [...base.tokens.keys()].sort(comparePaths),
    themePaths: [...themeTokens[themes[0]].keys()].sort(comparePaths),
    resolved: { base: sortedMap(resolvedBase), theme: sortedResolved },
    groups: { base: sortedMap(base.groups), theme: sortedMap(themeGroups) },
  };
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** A token's CSS value: aliases become var() references (theme-qualified inside a theme). */
export function cssValue(model: Model, token: Token, theme?: string): string {
  if (typeof token.value === "number") return String(token.value);
  return token.value.replace(ALIAS_RE, (_, ref: string) => {
    const themed = theme !== undefined && model.theme[theme].has(ref);
    return `var(${cssName(ref, themed ? theme : undefined)})`;
  });
}

/** The selector of a theme's switch block; `first` is the theme on :root. */
export function themeSelector(theme: string, first: string = DEFAULT_THEME): string {
  const own = `[data-theme="${theme}"], .${theme}`;
  return theme === first ? `:root, ${own}` : own;
}

/** Theme switch blocks in cascade order: `first` (on :root) before the others, so a data-theme or class on :root wins. */
export function themeOrder(model: Model, first: string): string[] {
  if (!model.themes.includes(first)) throw new TokenError([`unknown theme ${first}`]);
  return [first, ...model.themes.filter((t) => t !== first)];
}

/** `color-scheme` for a theme block: scrollbars, form controls and the default canvas follow the theme. */
export function colorScheme(theme: string): string | null {
  return theme === "light" || theme === "dark" ? theme : null;
}

export const GENERATED_NOTE = "Generated by scripts/build.ts from tokens/. Do not edit; change tokens/ and run `bun run build`.";

/** dist/css/tokens.css (`first` = the default theme) or tokens-dark-first.css (`first` = "dark"). */
export function renderTokensCss(model: Model, first: string = model.themes[0]): string {
  const order = themeOrder(model, first);
  const others = order.slice(1);
  const lines: string[] = [
    "/*",
    ` * @codecaine-ai/design-system tokens${first === model.themes[0] ? "" : `, ${first} first`}.`,
    ` * ${GENERATED_NOTE}`,
    " *",
    " * Custom properties, plus color-scheme in each theme block. Importing this file sets no other",
    ` * property: it gives the root color-scheme ${first}, so scrollbars, form controls and the default`,
    " * canvas follow the theme.",
    " * :root holds every base token and every theme token qualified by theme",
    ` * (${model.themes.map((t) => `--${PREFIX}-${t}-*`).join(", ")}). The blocks after it point the`,
    ` * unqualified --${PREFIX}-* names at one theme. :root gets ${first}; ${others.map((t) => `data-theme="${t}" or class="${t}"`).join(", ")}`,
    ` * switches an element and everything inside it, and data-theme="${first}" or class="${first}" switches a region back.`,
    " */",
    "",
    ":root {",
    "  /* base */",
  ];
  for (const token of model.base.values()) lines.push(`  ${cssName(token.id)}: ${cssValue(model, token)};`);
  for (const theme of model.themes) {
    lines.push("", `  /* ${theme} */`);
    for (const token of model.theme[theme].values()) lines.push(`  ${cssName(token.id, theme)}: ${cssValue(model, token, theme)};`);
  }
  lines.push("}");
  for (const theme of order) {
    lines.push("", `${themeSelector(theme, first)} {`);
    const scheme = colorScheme(theme);
    if (scheme) lines.push(`  color-scheme: ${scheme};`);
    for (const id of model.themePaths) lines.push(`  ${cssName(id)}: var(${cssName(id, theme)});`);
    lines.push("}");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Tailwind v4
// ---------------------------------------------------------------------------

export interface TailwindEntry {
  /** Theme variable, e.g. "--background-color-page". */
  key: string;
  /** Value written into @theme, e.g. "var(--ds-color-surface-page)". */
  value: string;
  /** Token the key reads. */
  token: string;
  /** Example utilities, e.g. ["bg-page"]. */
  utilities: string[];
}

const HUES = new Set(["gray", "blue", "teal", "green", "yellow", "orange", "red", "violet", "pink", "amber"]);

/** Theme color token -> Tailwind namespace + key. null = not exposed as a utility. */
function tailwindColor(id: string): { ns: string; key: string } | null {
  const [root, group, ...rest] = id.split(".");
  if (root !== "color") return null;
  switch (group) {
    case "notion":
      return null; // compat palette: CSS vars only
    case "surface":
      return { ns: "--background-color", key: rest.join("-") };
    case "fill":
      return { ns: "--background-color", key: rest[0] === "accent" ? "accent-soft" : rest.join("-") };
    case "text":
      return { ns: "--text-color", key: rest.join("-") };
    case "border":
      return { ns: "--border-color", key: rest[0] === "default" ? "rule" : rest[0] === "guide" ? "guide" : `rule-${rest.join("-")}` };
    case "focus-ring":
      return { ns: "--color", key: "focus" };
    case "category":
      return { ns: "--color", key: `cat-${rest[0]}${rest[1] === "text" ? "" : `-${rest.slice(1).join("-")}`}` };
    case "annotation":
      return { ns: "--color", key: rest[0] === "accent" ? "annotation" : `annotation-${rest.join("-")}` };
    case "glass":
      return { ns: "--color", key: rest[0] === "bg" ? "glass" : `glass-${rest.join("-")}` };
    case "status":
      return { ns: "--color", key: rest[1] === "text" ? rest[0] : rest.join("-") };
    default:
      if (HUES.has(group)) return { ns: "--color", key: rest[0] === "text" ? group : `${group}-${rest.join("-")}` };
      return { ns: "--color", key: [group, ...rest].join("-") };
  }
}

const COLOR_UTILITY: Record<string, string[]> = {
  "--background-color": ["bg"],
  "--text-color": ["text"],
  "--border-color": ["border"],
  "--color": ["bg", "text", "border"],
};

const PADDING_SIDES: Record<string, string> = { x: "px", y: "py", top: "pt", bottom: "pb", left: "pl", right: "pr" };

/**
 * Layout tokens -> Tailwind keys, by the words in the token name:
 * lane.* -> --container-lane-* (max-w-lane-text); *padding-<side> -> --padding-* (px-content-x);
 * *height -> --height-* (h-topbar); *size -> --size-* (size-sidebar-icon);
 * *width -> --container-* (w-sidebar, max-w-sidebar); anything else -> --spacing-*.
 */
function tailwindLayout(id: string): { key: string; utilities: string[] } | null {
  const [, area, ...rest] = id.split(".");
  if (!area || !rest.length) return null;
  const words = rest.join("-").split("-");
  const name = (drop: string) => [area, ...words.filter((w) => w !== drop)].join("-");
  if (area === "lane") return { key: `--container-lane-${words.join("-")}`, utilities: [`max-w-lane-${words.join("-")}`] };
  const padding = words.indexOf("padding");
  if (padding !== -1) {
    const key = name("padding");
    return { key: `--padding-${key}`, utilities: [`${Object.hasOwn(PADDING_SIDES, words[padding + 1] ?? "") ? PADDING_SIDES[words[padding + 1]] : "p"}-${key}`] };
  }
  if (words.includes("height")) return { key: `--height-${name("height")}`, utilities: [`h-${name("height")}`] };
  if (words.includes("size")) return { key: `--size-${name("size")}`, utilities: [`size-${name("size")}`] };
  if (words.includes("width")) return { key: `--container-${name("width")}`, utilities: [`w-${name("width")}`, `max-w-${name("width")}`] };
  return { key: `--spacing-${[area, ...words].join("-")}`, utilities: [`p-${[area, ...words].join("-")}`, `gap-${[area, ...words].join("-")}`] };
}

export function tailwindEntries(model: Model): TailwindEntry[] {
  const entries: TailwindEntry[] = [];
  const add = (key: string, token: string, utilities: string[]) =>
    entries.push({ key, value: `var(${cssName(token)})`, token, utilities });

  for (const id of model.themePaths) {
    const token = model.theme[model.themes[0]].get(id)!;
    if (token.type === "color") {
      const mapped = tailwindColor(id);
      if (mapped) add(`${mapped.ns}-${mapped.key}`, id, COLOR_UTILITY[mapped.ns].map((u) => `${u}-${mapped.key}`));
    } else if (token.type === "shadow" && id.startsWith("shadow.")) {
      const key = id.slice("shadow.".length).split(".").join("-");
      add(`--shadow-${key}`, id, [`shadow-${key}`]);
    }
  }

  for (const id of model.basePaths) {
    const p = id.split(".");
    const last = p.slice(-1)[0];
    if (id === "space.1") add("--spacing", id, ["p-1", "gap-2", "w-7"]);
    else if (id === "radius.base") {
      for (const step of ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]) add(`--radius-${step}`, id, [`rounded-${step}`]);
    } else if (id === "radius.pill") add("--radius-pill", id, ["rounded-pill"]);
    else if (p[0] === "font" && p[1] === "family") add(`--font-${last}`, id, [`font-${last}`]);
    else if (p[0] === "font" && p[1] === "weight") add(`--font-weight-${last}`, id, [`font-${last}`]);
    else if (p[0] === "font" && p[1] === "size") add(`--text-${last}`, id, [`text-${last}`]);
    else if (p[0] === "line-height") {
      const key = last === "tight" ? "title" : last;
      add(`--leading-${key}`, id, [`leading-${key}`]);
    } else if (p[0] === "letter-spacing") add(`--tracking-${last}`, id, [`tracking-${last}`]);
    else if (p[0] === "motion" && p[1] === "easing") add(`--ease-${last}`, id, [`ease-${last}`]);
    else if (p[0] === "z") add(`--z-index-${p.slice(1).join("-")}`, id, [`z-${p.slice(1).join("-")}`]);
    else if (p[0] === "blur") add(`--blur-${p.slice(1).join("-")}`, id, [`blur-${p.slice(1).join("-")}`, `backdrop-blur-${p.slice(1).join("-")}`]);
    else if (p[0] === "border" && p[1] === "width" && last !== "none") add(`--border-width-${last}`, id, [`border-${last}`]);
    else if (id === "focus.ring.offset") add("--outline-offset-focus", id, ["outline-offset-focus"]);
    else if (p[0] === "layout") {
      const mapped = tailwindLayout(id);
      if (mapped) add(mapped.key, id, mapped.utilities);
    }
  }

  // Font-size companions: a size utility sets its paired leading / tracking / weight.
  const pair = (size: string, prop: string, token: string) => {
    if (model.base.has(`font.size.${size}`) && model.base.has(token)) add(`--text-${size}--${prop}`, token, [`text-${size}`]);
  };
  pair("reading", "line-height", "line-height.reading");
  pair("code", "line-height", "line-height.code");
  pair("title", "line-height", "line-height.tight");
  pair("title", "letter-spacing", "letter-spacing.title");
  pair("title", "font-weight", "font.weight.bold");
  return entries;
}

function tailwindProblems(entries: TailwindEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const existing = seen.get(entry.key);
    if (existing) problems.push(`Tailwind key ${entry.key} is produced by both ${existing} and ${entry.token}`);
    else seen.set(entry.key, entry.token);
  }
  // One utility name must not resolve through two namespaces (e.g. bg-x from --background-color-x and --color-x).
  const keysIn = (ns: string) => new Set(entries.filter((e) => e.key.startsWith(`${ns}-`) && !e.key.includes("--", 2)).map((e) => e.key.slice(ns.length + 1)));
  const colors = keysIn("--color");
  const textColors = keysIn("--text-color");
  const textSizes = new Set(entries.filter((e) => e.token.startsWith("font.size.") && !e.key.includes("--", 2)).map((e) => e.key.slice("--text-".length)));
  for (const ns of ["--background-color", "--text-color", "--border-color"]) {
    for (const key of keysIn(ns)) if (colors.has(key)) problems.push(`Tailwind utility name "${key}" is defined in both ${ns} and --color`);
  }
  for (const key of textSizes) {
    if (colors.has(key) || textColors.has(key)) problems.push(`Tailwind text-${key} would be both a font size and a color`);
  }
  return problems;
}

export function renderTailwindCss(model: Model): string {
  const entries = tailwindEntries(model);
  const problems = tailwindProblems(entries);
  if (problems.length) throw new TokenError(problems);
  // Each entry lands in the first section whose filter matches.
  const placed = new Set<TailwindEntry>();
  const section = (title: string, filter: (e: TailwindEntry) => boolean) => {
    const chosen = entries.filter((e) => !placed.has(e) && filter(e));
    for (const e of chosen) placed.add(e);
    return chosen.length ? ["", `  /* ${title} */`, ...chosen.map((e) => `  ${e.key}: ${e.value};`)] : [];
  };
  const lines = [
    "/*",
    " * @codecaine-ai/design-system Tailwind v4 theme.",
    ` * ${GENERATED_NOTE}`,
    " *",
    " * Import order:",
    ...TAILWIND_IMPORTS.map((line) => ` *   ${line}`),
    " *",
    " * `inline`: utilities read the --ds-* custom properties directly, so they follow data-theme.",
    " * Utility names are listed in guide/tokens.md.",
    " */",
    "@theme inline {",
    ...section("surfaces and fills (bg-*)", (e) => e.key.startsWith("--background-color-")),
    ...section("text (text-*)", (e) => e.key.startsWith("--text-color-")),
    ...section("borders (border-*)", (e) => e.key.startsWith("--border-color-")),
    ...section("colors (bg-*, text-*, border-*, ring-*, fill-*, ...)", (e) => e.key.startsWith("--color-")),
    ...section("spacing: p-1 = 4px", (e) => e.key === "--spacing"),
    ...section("radius: every step is the one app radius", (e) => e.key.startsWith("--radius-")),
    ...section("border widths", (e) => e.key.startsWith("--border-width-")),
    ...section("focus", (e) => e.key.startsWith("--outline-offset-")),
    ...section("font families", (e) => e.key.startsWith("--font-") && !e.key.startsWith("--font-weight-")),
    ...section("font weights", (e) => e.key.startsWith("--font-weight-")),
    ...section("font sizes", (e) => e.key.startsWith("--text-")),
    ...section("line heights", (e) => e.key.startsWith("--leading-")),
    ...section("letter spacing", (e) => e.key.startsWith("--tracking-")),
    ...section("shadows", (e) => e.key.startsWith("--shadow-")),
    ...section("blur", (e) => e.key.startsWith("--blur-")),
    ...section("easing", (e) => e.key.startsWith("--ease-")),
    ...section("z-index", (e) => e.key.startsWith("--z-index-")),
    ...section("layout", (e) => ["--container-", "--height-", "--size-", "--padding-", "--spacing-"].some((ns) => e.key.startsWith(ns))),
    ...section("other", () => true),
    "}",
  ];
  if (model.base.has("radius.base")) {
    lines.push(
      "",
      "/* Bare `rounded` reads --radius. `reference` keeps Tailwind from emitting a global --radius. */",
      "@theme inline reference {",
      `  --radius: var(${cssName("radius.base")});`,
      "}",
    );
  }
  const variant = darkVariant(model);
  if (variant) {
    lines.push(
      "",
      "/* `dark:` matches the dark theme's own selectors (and everything inside them), like the --ds-* variables, instead of the OS setting. */",
      variant,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Import order for the generated headers (no comment markers: the lines sit inside a comment). */
const TAILWIND_IMPORTS = [
  '@import "tailwindcss";',
  '@import "@codecaine-ai/design-system/tokens.css";',
  '@import "@codecaine-ai/design-system/tailwind-strict.css";   (optional, new apps)',
  '@import "@codecaine-ai/design-system/tailwind.css";',
];

/**
 * Redefines Tailwind's `dark:` (by default `@media (prefers-color-scheme: dark)`) as the dark theme block's
 * selectors: `[data-theme="dark"]` or `.dark` on the element or an ancestor.
 */
export function darkVariant(model: Model): string | null {
  if (!model.themes.includes("dark")) return null;
  const own = ['[data-theme="dark"]', ".dark"];
  return `@custom-variant dark (&:where(${own.flatMap((selector) => [selector, `${selector} *`]).join(", ")}));`;
}

/**
 * Tailwind default-theme namespaces cleared by dist/tailwind/strict.css. tailwind.css then adds the
 * design-system keys back, so only design-system utilities remain in these namespaces. Spacing,
 * breakpoints, containers and animations are kept.
 */
export const TAILWIND_STRICT_RESETS: ReadonlyArray<[namespace: string, removes: string]> = [
  ["--color-*", "the palette: bg-red-500, text-gray-700, bg-white"],
  ["--font-*", "font families (font-sans, font-mono and font-serif come back from tailwind.css)"],
  ["--font-weight-*", "font weights: font-light, font-black"],
  ["--text-*", "text sizes: text-sm, text-lg"],
  ["--leading-*", "line heights: leading-tight, leading-loose"],
  ["--tracking-*", "letter spacing: tracking-wide"],
  ["--radius-*", "radius steps (every rounded-* step comes back as the one radius)"],
  ["--shadow-*", "shadows: shadow-sm, shadow-lg"],
  ["--inset-shadow-*", "inset shadows: inset-shadow-sm"],
  ["--drop-shadow-*", "drop shadows: drop-shadow-md"],
  ["--text-shadow-*", "text shadows: text-shadow-sm"],
  ["--blur-*", "blur steps: blur-md, backdrop-blur-sm"],
  ["--ease-*", "easings: ease-in, ease-out, ease-in-out"],
];

export function renderTailwindStrictCss(): string {
  const width = Math.max(...TAILWIND_STRICT_RESETS.map(([namespace]) => namespace.length));
  return [
    "/*",
    " * @codecaine-ai/design-system strict reset for Tailwind v4 (optional; for new apps).",
    ` * ${GENERATED_NOTE}`,
    " *",
    " * Clears Tailwind's default palette, type, radius, shadow, blur and easing scales, so bg-red-500,",
    " * text-sm and shadow-lg stop generating and only the design-system utilities remain.",
    " * Import it after tailwindcss and before tailwind.css; after tailwind.css it would clear the",
    " * design-system keys too:",
    ...TAILWIND_IMPORTS.map((line) => ` *   ${line}`),
    " */",
    "@theme {",
    ...TAILWIND_STRICT_RESETS.map(([namespace, removes]) => `  ${`${namespace}:`.padEnd(width + 1)} initial; /* ${removes} */`),
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// JSON and JS
// ---------------------------------------------------------------------------

type Nested = { [key: string]: Nested | TokenValue };

function nest(flat: Map<string, TokenValue>): Nested {
  const out: Nested = {};
  for (const [id, value] of flat) {
    const path = id.split(".");
    let node = out;
    for (const seg of path.slice(0, -1)) {
      if (!Object.hasOwn(node, seg)) node[seg] = {};
      node = node[seg] as Nested;
    }
    node[path[path.length - 1]] = value;
  }
  return out;
}

function flatObject(flat: Map<string, TokenValue>): Record<string, TokenValue> {
  return Object.fromEntries(flat);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function scopes(model: Model): Array<[string, Map<string, TokenValue>]> {
  return [["base", model.resolved.base], ...model.themes.map((t) => [t, model.resolved.theme[t]] as [string, Map<string, TokenValue>])];
}

export function renderJs(model: Model): string {
  const nested = Object.fromEntries(scopes(model).map(([name, map]) => [name, nest(map)]));
  const flat = Object.fromEntries(scopes(model).map(([name, map]) => [name, flatObject(map)]));
  return [
    `// @codecaine-ai/design-system. ${GENERATED_NOTE}`,
    "",
    `export const themes = Object.freeze(${JSON.stringify(model.themes)});`,
    `export const defaultTheme = ${JSON.stringify(model.themes[0])};`,
    "",
    "/** Resolved values, nested: tokens.base.space[1], tokens.light.color.surface.page. */",
    `export const tokens = ${JSON.stringify(nested, null, 2)};`,
    "",
    '/** Resolved values by dotted path: flat.base["space.1"], flat.dark["color.surface.page"]. */',
    `export const flat = ${JSON.stringify(flat, null, 2)};`,
    "",
    "const basePaths = new Set(Object.keys(flat.base));",
    `const themePaths = new Set(Object.keys(flat[${JSON.stringify(model.themes[0])}]));`,
    "",
    "/**",
    ' * CSS custom property name for a token path: cssVarName("color.surface.page") -> "--ds-color-surface-page".',
    ' * Pass a theme to pin a theme token to one theme: cssVarName("color.surface.page", "dark") -> "--ds-dark-color-surface-page".',
    " * Throws on an unknown path or theme.",
    " */",
    "export function cssVarName(path, theme) {",
    "  if (theme !== undefined && !themes.includes(theme)) throw new Error(`Unknown theme: ${theme}`);",
    `  const name = String(path).split(".").join("-");`,
    `  if (basePaths.has(path)) return \`--${PREFIX}-\${name}\`;`,
    `  if (themePaths.has(path)) return theme === undefined ? \`--${PREFIX}-\${name}\` : \`--${PREFIX}-\${theme}-\${name}\`;`,
    "  throw new Error(`Unknown token path: ${path}`);",
    "}",
    "",
    '/** cssVar("space.2") -> "var(--ds-space-2)". Same arguments as cssVarName. */',
    "export function cssVar(path, theme) {",
    "  return `var(${cssVarName(path, theme)})`;",
    "}",
    "",
    "export default tokens;",
    "",
  ].join("\n");
}

function tsLiteralType(value: Nested | TokenValue, indent: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  const inner = Object.entries(value)
    .map(([key, child]) => `${indent}  readonly ${JSON.stringify(key)}: ${tsLiteralType(child, `${indent}  `)};`)
    .join("\n");
  return `{\n${inner}\n${indent}}`;
}

function unionType(items: string[]): string {
  return items.length ? items.map((i) => `\n  | ${JSON.stringify(i)}`).join("") : " never";
}

export function renderDts(model: Model): string {
  const nested: Nested = Object.fromEntries(scopes(model).map(([name, map]) => [name, nest(map)]));
  const flatType = (map: Map<string, TokenValue>) =>
    `{\n${[...map].map(([id, value]) => `    readonly ${JSON.stringify(id)}: ${typeof value === "number" ? value : JSON.stringify(value)};`).join("\n")}\n  }`;
  return [
    `// @codecaine-ai/design-system. ${GENERATED_NOTE}`,
    "",
    `export type ThemeName = ${model.themes.map((t) => JSON.stringify(t)).join(" | ")};`,
    `export type BaseTokenPath =${unionType(model.basePaths)};`,
    `export type ThemeTokenPath =${unionType(model.themePaths)};`,
    "export type TokenPath = BaseTokenPath | ThemeTokenPath;",
    "",
    `export declare const themes: readonly [${model.themes.map((t) => JSON.stringify(t)).join(", ")}];`,
    `export declare const defaultTheme: ${JSON.stringify(model.themes[0])};`,
    "",
    "/** Resolved values, nested: tokens.base.space[1], tokens.light.color.surface.page. */",
    `export declare const tokens: ${tsLiteralType(nested, "")};`,
    "",
    "/** Resolved values by dotted path. */",
    "export declare const flat: {",
    ...scopes(model).map(([name, map]) => `  readonly ${JSON.stringify(name)}: ${flatType(map)};`),
    "};",
    "",
    `/** CSS custom property name: "--${PREFIX}-color-surface-page", or "--${PREFIX}-dark-color-surface-page" with a theme. */`,
    `export declare function cssVarName(path: TokenPath, theme?: ThemeName): \`--${PREFIX}-\${string}\`;`,
    `/** var() reference to a token: cssVar("space.2") === "var(--${PREFIX}-space-2)". */`,
    `export declare function cssVar(path: TokenPath, theme?: ThemeName): \`var(--${PREFIX}-\${string})\`;`,
    "",
    "declare const _default: typeof tokens;",
    "export default _default;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Docs ordering
// ---------------------------------------------------------------------------

/** Display order of theme groups in the guide and in guide/tokens.md. */
const THEME_GROUP_ORDER = [
  "color.surface", "color.text", "color.border", "color.fill", "color.accent", "color.link", "color.focus-ring", "color.selection",
  "color.gray", "color.blue", "color.teal", "color.green", "color.yellow", "color.orange", "color.red", "color.violet", "color.pink", "color.amber",
  "color.status", "color.category", "color.chart", "color.diff", "color.syntax", "color.code", "color.annotation", "color.glass", "color.backdrop", "color.notion",
  "shadow",
];
const BASE_GROUP_ORDER = [
  "space", "radius", "border", "focus", "font.family", "font.size", "font.weight", "line-height", "letter-spacing",
  "motion.duration", "motion.easing", "z", "blur", "layout.lane",
];
/** Base groups that read as a scale: listed by value, not by authoring order. */
const SCALE_GROUPS = new Set(["space", "radius", "border", "font.size", "motion.duration", "z"]);

/** Group key for docs: the longest listed group that contains the path, else its first two segments. */
function docGroup(id: string, order: string[]): string {
  const match = order.filter((g) => id === g || id.startsWith(`${g}.`)).sort((a, b) => b.length - a.length)[0];
  if (match) return match;
  const parts = id.split(".");
  return parts.length > 2 ? parts.slice(0, 2).join(".") : parts[0];
}

/** Groups in display order; tokens in authoring order, or by value for scale groups. */
function groupIds(ids: string[], order: string[], tokens: Map<string, Token>, resolved: Map<string, TokenValue>): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const group = docGroup(id, order);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(id);
  }
  const rank = (g: string) => {
    const i = order.indexOf(g);
    return i === -1 ? order.length : i;
  };
  const magnitude = (id: string) => {
    const value = resolved.get(id)!;
    return typeof value === "number" ? value : pxOf(value) ?? msOf(value) ?? Number.NaN;
  };
  for (const [group, members] of groups) {
    const byValue = SCALE_GROUPS.has(group) && members.every((id) => !Number.isNaN(magnitude(id)));
    members.sort((a, b) => (byValue ? magnitude(a) - magnitude(b) : 0) || tokens.get(a)!.order - tokens.get(b)!.order);
  }
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || comparePaths(a, b));
}

function pxOf(value: TokenValue): number | null {
  if (typeof value !== "string") return null;
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
}

function msOf(value: TokenValue): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(value);
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : null;
}

// ---------------------------------------------------------------------------
// guide/tokens.md generated region
// ---------------------------------------------------------------------------

export const MD_BEGIN = "<!-- BEGIN GENERATED: token reference (scripts/build.ts) -->";
export const MD_END = "<!-- END GENERATED: token reference -->";

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mdCode(value: TokenValue): string {
  return `\`${mdCell(String(value))}\``;
}

export function renderTokenReference(model: Model): string {
  const out: string[] = [];
  const baseCount = model.basePaths.length;
  const themeCount = model.themePaths.length;
  out.push(
    `${baseCount} base tokens and ${themeCount} theme tokens (${model.themes.join(" and ")}), ${baseCount + themeCount * (model.themes.length + 1)} CSS custom properties in total. Theme values show the authored value: \`{path}\` is an alias, emitted as \`var()\`.`,
    "",
    "### Base tokens",
    "",
  );
  for (const [group, ids] of groupIds(model.basePaths, BASE_GROUP_ORDER, model.base, model.resolved.base)) {
    const description = model.groups.base.get(group);
    out.push(`#### \`${group}\``, "");
    if (description) out.push(description, "");
    out.push("| Token | CSS variable | Type | Value | Description |", "| --- | --- | --- | --- | --- |");
    for (const id of ids) {
      const token = model.base.get(id)!;
      out.push(`| \`${id}\` | \`${cssName(id)}\` | ${token.type} | ${mdCode(token.value)} | ${mdCell(token.description ?? "")} |`);
    }
    out.push("");
  }
  out.push("### Theme tokens", "");
  const [first, ...rest] = model.themes;
  for (const [group, ids] of groupIds(model.themePaths, THEME_GROUP_ORDER, model.theme[model.themes[0]], model.resolved.theme[model.themes[0]])) {
    const description = model.groups.theme.get(group);
    out.push(`#### \`${group}\``, "");
    if (description) out.push(description, "");
    out.push(
      `| Token | CSS variable | ${model.themes.map((t) => t[0].toUpperCase() + t.slice(1)).join(" | ")} | Description |`,
      `| --- | --- | ${model.themes.map(() => "---").join(" | ")} | --- |`,
    );
    for (const id of ids) {
      const token = model.theme[first].get(id)!;
      const values = [first, ...rest].map((t) => mdCode(model.theme[t].get(id)!.value));
      out.push(`| \`${id}\` | \`${cssName(id)}\` | ${values.join(" | ")} | ${mdCell(token.description ?? "")} |`);
    }
    out.push("");
  }
  out.push(
    "### Tailwind utilities",
    "",
    "Keys written by `dist/tailwind/theme.css`. Each reads the token's `--ds-*` variable, so utilities follow `data-theme`.",
    "",
    '`theme.css` also redefines `dark:` as `[data-theme="dark"]` or `.dark` on the element or an ancestor, instead of the OS setting. `dist/tailwind/strict.css` (`@codecaine-ai/design-system/tailwind-strict.css`, imported before `tailwind.css`) clears Tailwind\'s default palette, type, radius, shadow, blur and easing scales, so only the utilities below remain.',
    "",
    "| Theme key | Token | Example utilities |",
    "| --- | --- | --- |",
  );
  for (const entry of tailwindEntries(model)) {
    out.push(`| \`${entry.key}\` | \`${entry.token}\` | ${entry.utilities.map((u) => `\`${u}\``).join(", ")} |`);
  }
  return out.join("\n");
}

export function renderTokensMd(model: Model, existing: string | null): string {
  const region = `${MD_BEGIN}\n\n${renderTokenReference(model)}\n\n${MD_END}`;
  if (existing === null) {
    return `# Tokens\n\nSee README.md. The reference below is generated by \`bun run build\`.\n\n## Reference\n\n${region}\n`;
  }
  const start = existing.indexOf(MD_BEGIN);
  const end = existing.indexOf(MD_END);
  if (start === -1 || end === -1 || end < start) {
    throw new TokenError([`guide/tokens.md must contain the markers\n    ${MD_BEGIN}\n    ${MD_END}`]);
  }
  return `${existing.slice(0, start)}${region}${existing.slice(end + MD_END.length)}`;
}

// ---------------------------------------------------------------------------
// dist/guide/index.html
// ---------------------------------------------------------------------------

const GUIDE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ds-color-surface-page);
  color: var(--ds-color-text-body);
  font-family: var(--ds-font-family-sans);
  font-size: var(--ds-font-size-ui-lg);
  line-height: var(--ds-line-height-ui);
}
::selection { background: var(--ds-color-selection); }
:focus-visible { outline: var(--ds-border-width-focus) solid var(--ds-color-focus-ring); outline-offset: var(--ds-focus-ring-offset); }
a { color: var(--ds-color-link); }
code {
  font-family: var(--ds-font-family-mono);
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  border-radius: var(--ds-radius-base);
  background: var(--ds-color-fill-chip);
  color: var(--ds-color-code-chip-ink);
  overflow-wrap: anywhere;
}
.g-shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
.g-nav {
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  padding: var(--ds-space-4) var(--ds-space-2);
  background: var(--ds-color-surface-sidebar);
  border-right: var(--ds-border-width-hairline) solid var(--ds-color-border-default);
}
.g-nav-title { padding: 0 var(--ds-space-2) var(--ds-space-3); color: var(--ds-color-text-ink); font-weight: var(--ds-font-weight-semibold); }
.g-nav-label {
  padding: var(--ds-space-3) var(--ds-space-2) var(--ds-space-1);
  color: var(--ds-color-text-muted);
  font-size: var(--ds-font-size-micro); font-weight: var(--ds-font-weight-semibold);
  letter-spacing: var(--ds-letter-spacing-micro); text-transform: uppercase;
}
.g-nav a {
  display: block; padding: var(--ds-space-1) var(--ds-space-2);
  border-radius: var(--ds-radius-base);
  color: var(--ds-color-text-body); text-decoration: none; font-size: var(--ds-font-size-ui-sm);
  transition: background var(--ds-motion-duration-fast) var(--ds-motion-easing-standard);
}
.g-nav a:hover { background: var(--ds-color-fill-hover); }
.g-main { min-width: 0; padding: var(--ds-space-6) var(--ds-space-10) var(--ds-space-16); }
.g-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--ds-space-6); max-width: 1100px; }
.g-top h1 {
  margin: 0 0 var(--ds-space-2);
  color: var(--ds-color-text-ink);
  font-size: var(--ds-font-size-title); line-height: var(--ds-line-height-tight);
  letter-spacing: var(--ds-letter-spacing-title); font-weight: var(--ds-font-weight-bold);
}
.g-lede { margin: 0; max-width: var(--ds-layout-lane-text); color: var(--ds-color-text-muted); }
.g-button {
  display: inline-flex; align-items: center; gap: var(--ds-space-2);
  padding: var(--ds-space-1-5) var(--ds-space-3);
  border: var(--ds-border-width-hairline) solid var(--ds-color-border-default);
  border-radius: var(--ds-radius-base);
  background: var(--ds-color-surface-panel); color: var(--ds-color-text-ink);
  font: inherit; font-size: var(--ds-font-size-ui-sm); cursor: pointer; white-space: nowrap;
}
.g-button:hover { background: var(--ds-color-fill-hover); }
section { max-width: 1100px; }
h2 {
  margin: var(--ds-space-12) 0 var(--ds-space-1);
  color: var(--ds-color-text-ink);
  font-size: 1.5rem; font-weight: var(--ds-font-weight-semibold); line-height: var(--ds-line-height-tight);
}
h3 {
  margin: var(--ds-space-8) 0 var(--ds-space-2);
  color: var(--ds-color-text-muted);
  font-size: var(--ds-font-size-ui-2xs); font-weight: var(--ds-font-weight-semibold);
  letter-spacing: var(--ds-letter-spacing-micro); text-transform: uppercase;
}
.g-note { margin: 0 0 var(--ds-space-3); max-width: var(--ds-layout-lane-text); color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-md); }
table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  background: var(--ds-color-surface-panel);
  border: var(--ds-border-width-hairline) solid var(--ds-color-border-default);
  border-radius: var(--ds-radius-base);
  font-size: var(--ds-font-size-ui-md); line-height: var(--ds-line-height-reading);
}
th {
  padding: var(--ds-space-1) var(--ds-space-3); text-align: left; vertical-align: bottom;
  color: var(--ds-color-text-muted); font-weight: var(--ds-font-weight-medium);
  border-bottom: var(--ds-border-width-hairline) solid var(--ds-color-border-default);
}
td { padding: var(--ds-space-2) var(--ds-space-3); vertical-align: middle; border-top: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); }
tr:first-child td { border-top: 0; }
td.g-name { width: 30%; color: var(--ds-color-text-ink); }
table.g-fixed { table-layout: fixed; }
table.g-fixed td { overflow: hidden; }
table.g-fixed td.g-name { width: auto; }
td.g-name small { display: block; margin-top: var(--ds-space-0-5); color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-xs); }
td[data-theme] { background: var(--ds-color-surface-page); color: var(--ds-color-text-body); }
.g-chip { display: flex; align-items: center; gap: var(--ds-space-3); min-width: 0; }
.g-swatch { flex: none; width: 44px; height: 28px; border-radius: var(--ds-radius-base); }
.g-swatch > span {
  display: block; width: 100%; height: 100%; border-radius: inherit;
  box-shadow: inset 0 0 0 var(--ds-border-width-hairline) var(--ds-color-border-default);
}
.g-val { min-width: 0; font-size: var(--ds-font-size-ui-xs); line-height: 1.4; }
.g-val code { font-size: inherit; }
.g-val small { display: block; color: var(--ds-color-text-muted); overflow-wrap: anywhere; }
.g-hues td { padding: var(--ds-space-2); text-align: center; }
.g-hues th { text-align: center; }
.g-hues td.g-name, .g-hues th:first-child { text-align: left; }
.g-tile {
  display: inline-grid; place-items: center; width: 40px; height: 28px;
  border-radius: var(--ds-radius-base); font-weight: var(--ds-font-weight-semibold);
}
.g-scale-row { display: grid; grid-template-columns: 220px 120px minmax(0, 1fr); align-items: center; gap: var(--ds-space-4); }
.g-bar { height: 10px; border-radius: var(--ds-radius-base); background: var(--ds-color-accent); }
.g-box {
  width: 72px; height: 44px;
  background: var(--ds-color-surface-page);
  border: var(--ds-border-width-hairline) solid var(--ds-color-border-default);
}
.g-pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--ds-space-4); }
.g-pair > div { padding: var(--ds-space-6); border: var(--ds-border-width-hairline) solid var(--ds-color-border-default); border-radius: var(--ds-radius-base); background: var(--ds-color-surface-page); }
.g-card { padding: var(--ds-space-4); border-radius: var(--ds-radius-base); background: var(--ds-color-surface-panel); color: var(--ds-color-text-ink); }
.g-track { position: relative; height: 28px; border-radius: var(--ds-radius-base); background: var(--ds-color-surface-page); border: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); }
.g-dot { position: absolute; top: 7px; left: 8px; width: 12px; height: 12px; border-radius: var(--ds-radius-pill); background: var(--ds-color-accent); }
.g-motion:hover .g-dot, .g-motion:focus-within .g-dot { transform: translateX(calc(min(420px, 40vw))); }
.g-specimen { color: var(--ds-color-text-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-glass-stage {
  position: relative; padding: var(--ds-space-8);
  border-radius: var(--ds-radius-base);
  background: repeating-linear-gradient(135deg, var(--ds-color-blue-solid) 0 18px, var(--ds-color-yellow-solid) 18px 36px, var(--ds-color-pink-solid) 36px 54px);
}
.g-glass {
  padding: var(--ds-space-4); max-width: 320px;
  border: var(--ds-border-width-hairline) solid var(--ds-color-glass-border);
  border-radius: var(--ds-radius-base);
  background: var(--ds-color-glass-bg);
  box-shadow: var(--ds-shadow-glass);
  backdrop-filter: blur(var(--ds-blur-glass)); -webkit-backdrop-filter: blur(var(--ds-blur-glass));
  color: var(--ds-color-text-ink);
}
@media (max-width: 860px) {
  .g-shell { grid-template-columns: minmax(0, 1fr); }
  .g-nav { display: none; }
  .g-main { padding: var(--ds-space-6) var(--ds-space-4); }
}
`;

const GUIDE_JS = `
(function () {
  var root = document.documentElement;
  var button = document.getElementById("g-theme-toggle");
  var saved = null;
  try { saved = localStorage.getItem("ds-guide-theme"); } catch (e) {}
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  function label() { button.textContent = root.getAttribute("data-theme") === "dark" ? "Switch to light" : "Switch to dark"; }
  label();
  button.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("ds-guide-theme", next); } catch (e) {}
    label();
  });
})();
`;

function themeLabel(theme: string): string {
  return theme[0].toUpperCase() + theme.slice(1);
}

function authoredNote(model: Model, theme: string, id: string): string {
  const token = model.theme[theme].get(id)!;
  const resolved = model.resolved.theme[theme].get(id)!;
  const authored = String(token.value);
  const whole = WHOLE_ALIAS_RE.exec(authored);
  if (whole) return `<code>${escapeHtml(String(resolved))}</code><small>= ${escapeHtml(whole[1])}</small>`;
  if (authored !== String(resolved)) return `<code>${escapeHtml(authored)}</code><small>${escapeHtml(String(resolved))}</small>`;
  return `<code>${escapeHtml(authored)}</code>`;
}

function colorRows(model: Model, ids: string[]): string {
  const head = `<tr><th>Token</th>${model.themes.map((t) => `<th>${themeLabel(t)}</th>`).join("")}</tr>`;
  const rows = ids.map((id) => {
    const token = model.theme[model.themes[0]].get(id)!;
    const cells = model.themes
      .map((t) => `<td data-theme="${t}"><div class="g-chip"><span class="g-swatch"><span style="background: var(${cssName(id)})"></span></span><span class="g-val">${authoredNote(model, t, id)}</span></div></td>`)
      .join("");
    return `<tr><td class="g-name"><code>${cssName(id)}</code>${token.description ? `<small>${escapeHtml(token.description)}</small>` : ""}</td>${cells}</tr>`;
  });
  return `<table>${head}${rows.join("")}</table>`;
}

function hueTable(model: Model): string {
  const hues = [...HUES].filter((h) => model.theme[model.themes[0]].has(`color.${h}.text`));
  const parts = ["text", "solid", "soft", "line"];
  const head = `<tr><th>Hue</th>${model.themes.map((t) => parts.map((p) => `<th>${themeLabel(t)} ${p}</th>`).join("")).join("")}</tr>`;
  const rows = hues.map((hue) => {
    const cells = model.themes.map((t) => parts.map((part) => {
      const id = `color.${hue}.${part}`;
      if (!model.theme[t].has(id)) return `<td data-theme="${t}"></td>`;
      const v = `var(${cssName(id)})`;
      const title = escapeHtml(String(model.resolved.theme[t].get(id)));
      const text = model.theme[t].has(`color.${hue}.text`) ? `var(${cssName(`color.${hue}.text`)})` : "inherit";
      const glyph = cssName(model.theme[t].has(`color.${hue}.on-solid`) ? `color.${hue}.on-solid` : "color.text.on-solid");
      const sample =
        part === "text" ? `<span class="g-tile" style="color: ${v}">Aa</span>`
        : part === "solid" ? `<span class="g-tile" style="background: ${v}; color: var(${glyph})">A</span>`
        : part === "soft" ? `<span class="g-tile" style="background: ${v}; color: ${text}">Aa</span>`
        : `<span class="g-tile" style="background: var(--ds-color-surface-panel); box-shadow: inset 0 0 0 var(--ds-border-width-hairline) ${v}"></span>`;
      return `<td data-theme="${t}" title="${title}">${sample}</td>`;
    }).join("")).join("");
    return `<tr><td class="g-name"><code>color.${hue}</code></td>${cells}</tr>`;
  });
  return `<table class="g-hues">${head}${rows.join("")}</table>`;
}

function baseRows(model: Model, ids: string[], sample: (id: string) => string): string {
  const rows = ids.map((id) => {
    const token = model.base.get(id)!;
    const resolved = model.resolved.base.get(id)!;
    const value = WHOLE_ALIAS_RE.test(String(token.value)) ? `${escapeHtml(String(resolved))} <small>= ${escapeHtml(String(token.value).slice(1, -1))}</small>` : escapeHtml(String(resolved));
    return `<tr><td class="g-name"><code>${cssName(id)}</code>${token.description ? `<small>${escapeHtml(token.description)}</small>` : ""}</td><td class="g-val">${value}</td><td>${sample(id)}</td></tr>`;
  });
  return `<table class="g-fixed"><colgroup><col style="width: 34%"><col style="width: 18%"><col></colgroup><tr><th>Token</th><th>Value</th><th>Sample</th></tr>${rows.join("")}</table>`;
}

const SPECIMEN = "Sphinx of black quartz, judge my vow. 0123456789";

/** Inter and IBM Plex Mono for the guide: the package's own css/fonts.css, relative to dist/guide/. */
export const GUIDE_FONTS_HREF = "../../css/fonts.css";

export function renderGuideHtml(model: Model): string {
  const v = (id: string) => `var(${cssName(id)})`;
  const sections: Array<{ id: string; title: string; body: string }> = [];
  const colorGroups = groupIds(model.themePaths.filter((id) => model.theme[model.themes[0]].get(id)!.type === "color"), THEME_GROUP_ORDER, model.theme[model.themes[0]], model.resolved.theme[model.themes[0]]);
  const hueGroups = new Set([...HUES].map((h) => `color.${h}`));

  // Colors: roles first, then the hue table, then the rest.
  const roleGroups = colorGroups.filter(([g]) => !hueGroups.has(g) && !["color.status", "color.category", "color.chart", "color.diff", "color.syntax", "color.code", "color.annotation", "color.glass", "color.backdrop", "color.notion"].includes(g));
  sections.push({
    id: "color-roles",
    title: "Color roles",
    body: `<p class="g-note">Semantic roles: what apps use. Each cell paints with the unqualified <code>--ds-*</code> var inside a <code>data-theme</code> cell, so light and dark render side by side.</p>${roleGroups.map(([g, ids]) => `<h3>${escapeHtml(g)}</h3>${model.groups.theme.get(g) ? `<p class="g-note">${escapeHtml(model.groups.theme.get(g)!)}</p>` : ""}${colorRows(model, ids)}`).join("")}`,
  });
  sections.push({
    id: "hues",
    title: "Hues",
    body: `<p class="g-note">Categorical color only. <code>text</code> is text-safe on page, panel and its own <code>soft</code>; <code>solid</code> is a tile whose glyph is <code>on-solid</code> (white or ink, whichever meets 4.5:1 on it); <code>soft</code> an opaque tint; <code>line</code> a hairline over a panel. Hover a cell for its value.</p>${hueTable(model)}${colorGroups.filter(([g]) => hueGroups.has(g)).map(([g, ids]) => `<h3>${escapeHtml(g)}</h3>${colorRows(model, ids)}`).join("")}`,
  });
  for (const [g, ids] of colorGroups.filter(([group]) => !hueGroups.has(group) && !roleGroups.some(([r]) => r === group))) {
    sections.push({
      id: g.replace(/\./g, "-"),
      title: g.replace(/^color\./, "").replace(/^./, (c) => c.toUpperCase()),
      body: `${model.groups.theme.get(g) ? `<p class="g-note">${escapeHtml(model.groups.theme.get(g)!)}</p>` : ""}${colorRows(model, ids)}`,
    });
  }

  // Shadows and glass.
  const shadows = model.themePaths.filter((id) => model.theme[model.themes[0]].get(id)!.type === "shadow");
  if (shadows.length) {
    sections.push({
      id: "shadow",
      title: "Shadows and glass",
      body: `${shadows.map((id) => `<h3><code>${cssName(id)}</code></h3><div class="g-pair">${model.themes.map((t) => `<div data-theme="${t}"><div class="g-card" style="box-shadow: ${v(id)}">${themeLabel(t)}: <code>${escapeHtml(String(model.theme[t].get(id)!.value))}</code></div></div>`).join("")}</div>`).join("")}${model.theme[model.themes[0]].has("color.glass.bg") && model.base.has("blur.glass") ? `<h3>Glass panel</h3><div class="g-pair">${model.themes.map((t) => `<div data-theme="${t}"><div class="g-glass-stage"><div class="g-glass"><strong>${themeLabel(t)} glass</strong><br><code>--ds-color-glass-bg</code>, <code>--ds-blur-glass</code>, <code>--ds-shadow-glass</code></div></div></div>`).join("")}</div>` : ""}`,
    });
  }

  // Base scales.
  const baseGroups = groupIds(model.basePaths, BASE_GROUP_ORDER, model.base, model.resolved.base);
  const byGroup = new Map(baseGroups);
  const take = (group: string) => {
    const ids = byGroup.get(group) ?? [];
    byGroup.delete(group);
    return ids;
  };
  const byPx = (ids: string[]) => [...ids].sort((a, b) => (pxOf(model.resolved.base.get(a)!) ?? 0) - (pxOf(model.resolved.base.get(b)!) ?? 0) || comparePaths(a, b));

  const typeBody: string[] = [];
  const families = take("font.family");
  if (families.length) typeBody.push(`<h3>Families</h3>${baseRows(model, families, (id) => `<div class="g-specimen" style="font-family: ${v(id)}; font-size: 18px">${SPECIMEN}</div>`)}`);
  const sizes = byPx(take("font.size"));
  if (sizes.length) typeBody.push(`<h3>Sizes</h3>${baseRows(model, sizes, (id) => `<div class="g-specimen" style="font-size: ${v(id)}">${SPECIMEN}</div>`)}`);
  const weights = take("font.weight");
  if (weights.length) typeBody.push(`<h3>Weights</h3>${baseRows(model, weights, (id) => `<div class="g-specimen" style="font-weight: ${v(id)}; font-size: 18px">${SPECIMEN}</div>`)}`);
  const leading = take("line-height");
  if (leading.length) typeBody.push(`<h3>Line heights</h3>${baseRows(model, leading, (id) => `<div style="line-height: ${v(id)}; max-width: 360px; font-size: var(--ds-font-size-ui-md); color: var(--ds-color-text-ink); background: var(--ds-color-surface-page)">Two lines of sample text that wrap so the line box is visible in the sample column.</div>`)}`);
  const tracking = take("letter-spacing");
  if (tracking.length) typeBody.push(`<h3>Letter spacing</h3>${baseRows(model, tracking, (id) => `<div class="g-specimen" style="letter-spacing: ${v(id)}; ${id.includes("micro") ? "text-transform: uppercase; font-size: var(--ds-font-size-micro); font-weight: var(--ds-font-weight-semibold);" : "font-size: 18px;"}">${id.includes("micro") ? "Section label" : "Page title"}</div>`)}`);
  if (typeBody.length) {
    sections.push({
      id: "type",
      title: "Type",
      body: `<p class="g-note">Inter for UI and reading, IBM Plex Mono for code. Apps load the faces with <code>@codecaine-ai/design-system/fonts.css</code> before <code>tokens.css</code>; the font files ship in the package and are byte-identical to <code>@codecaine-ai/text-measure</code>'s, so canvas text measurement matches. Without the faces the stacks fall back to system fonts.</p>${typeBody.join("")}`,
    });
  }

  const space = byPx(take("space"));
  if (space.length) sections.push({ id: "space", title: "Spacing", body: `<p class="g-note">4px grid with 2px and 6px half steps. Tailwind: <code>p-1</code> = <code>--ds-space-1</code>.</p>${baseRows(model, space, (id) => `<div class="g-bar" style="width: ${v(id)}"></div>`)}` });
  const radius = take("radius");
  if (radius.length) sections.push({ id: "radius", title: "Radius", body: baseRows(model, radius, (id) => `<div class="g-box" style="border-radius: ${v(id)}"></div>`) });
  const borders = [...take("border"), ...take("focus")];
  if (borders.length) {
    sections.push({
      id: "border",
      title: "Borders and focus",
      body: baseRows(model, borders, (id) =>
        id.startsWith("focus.")
          ? `<button class="g-button" style="outline: var(--ds-border-width-focus) solid var(--ds-color-focus-ring); outline-offset: ${v(id)}">Focused</button>`
          : `<div class="g-box" style="border: ${v(id)} solid var(--ds-color-text-ink); border-radius: var(--ds-radius-base)"></div>`),
    });
  }
  const durations = take("motion.duration");
  const easings = take("motion.easing");
  if (durations.length || easings.length) {
    const slow = durations.find((id) => id.endsWith(".slow")) ?? durations[durations.length - 1];
    const standard = easings.find((id) => id.endsWith(".standard")) ?? easings[0];
    sections.push({
      id: "motion",
      title: "Motion",
      body: `<p class="g-note">Hover a row to play it.</p>${durations.length ? `<h3>Durations</h3>${baseRows(model, [...durations].sort((a, b) => (msOf(model.resolved.base.get(a)!) ?? 0) - (msOf(model.resolved.base.get(b)!) ?? 0)), (id) => `<div class="g-motion" tabindex="0"><div class="g-track"><span class="g-dot" style="transition: transform ${v(id)} ${standard ? v(standard) : "ease"}"></span></div></div>`)}` : ""}${easings.length ? `<h3>Easings</h3>${baseRows(model, easings, (id) => `<div class="g-motion" tabindex="0"><div class="g-track"><span class="g-dot" style="transition: transform ${slow ? `calc(${v(slow)} * 3)` : "780ms"} ${v(id)}"></span></div></div>`)}` : ""}`,
    });
  }
  const z = take("z");
  if (z.length) sections.push({ id: "z", title: "Z-index", body: baseRows(model, [...z].sort((a, b) => Number(model.resolved.base.get(a)) - Number(model.resolved.base.get(b))), () => "") });
  const blur = take("blur");
  if (blur.length) sections.push({ id: "blur", title: "Blur", body: baseRows(model, blur, (id) => `<div style="width: 120px; height: 28px; border-radius: var(--ds-radius-base); background: var(--ds-color-blue-solid); filter: blur(calc(${v(id)} / 4))"></div>`) });
  const layoutIds = [...byGroup.keys()].filter((g) => g === "layout" || g.startsWith("layout.")).flatMap((g) => take(g));
  if (layoutIds.length) {
    sections.push({
      id: "layout",
      title: "Layout",
      body: `<p class="g-note">Lane measures cap content; app-shell sizes come from <code>tokens/base/app-shell.tokens.json</code>. Bars are capped at the column width.</p>${baseRows(model, layoutIds, (id) => {
        const value = String(model.resolved.base.get(id));
        return /(?:px|ch|rem)$/.test(value) ? `<div class="g-bar" style="width: ${v(id)}; max-width: 100%; background: var(--ds-color-teal-solid)"></div>` : "";
      })}`,
    });
  }
  for (const [group, ids] of byGroup) {
    if (!ids.length) continue;
    sections.push({ id: group.replace(/\./g, "-"), title: group, body: baseRows(model, ids, () => "") });
  }

  const nav = [
    `<div class="g-nav-title">Design system</div>`,
    `<div class="g-nav-label">Sections</div>`,
    ...sections.map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`),
  ].join("");
  const counts = `${model.basePaths.length} base and ${model.themePaths.length} theme tokens, ${model.themes.join(" and ")}.`;
  return `<!doctype html>
<html lang="en" data-theme="${model.themes[0]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Style guide · @codecaine-ai/design-system</title>
<!-- ${GENERATED_NOTE} -->
<link rel="stylesheet" href="${GUIDE_FONTS_HREF}">
<link rel="stylesheet" href="../css/tokens.css">
<style>${GUIDE_CSS}</style>
</head>
<body>
<div class="g-shell">
<nav class="g-nav" aria-label="Sections">${nav}</nav>
<main class="g-main">
<div class="g-top">
<div>
<h1>Style guide</h1>
<p class="g-lede">@codecaine-ai/design-system: the one look shared by Codecaine and Lascari AI apps. ${escapeHtml(counts)} Every value on this page is a <code>--ds-*</code> custom property from <code>dist/css/tokens.css</code>.</p>
</div>
<button type="button" class="g-button" id="g-theme-toggle">Switch to dark</button>
</div>
${sections.map((s) => `<section id="${s.id}"><h2>${escapeHtml(s.title)}</h2>${s.body}</section>`).join("\n")}
</main>
</div>
<script>${GUIDE_JS}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build, check, write
// ---------------------------------------------------------------------------

export const TOKENS_MD = "guide/tokens.md";

/** Every output, path relative to the package root -> content. */
export function buildOutputs(root: string = ROOT, sources?: Sources): Map<string, string> {
  const model = loadModel(sources ?? readSources(root));
  const files = new Map<string, string>();
  files.set("dist/css/tokens.css", renderTokensCss(model));
  files.set("dist/css/tokens-dark-first.css", renderTokensCss(model, "dark"));
  files.set("dist/css/host-contract.css", renderHostContractCss(model));
  files.set("dist/css/host-contract-dark-first.css", renderHostContractCss(model, "dark"));
  files.set("dist/tailwind/preset-v3.cjs", renderTailwindV3Preset(model));
  files.set("dist/tailwind/theme.css", renderTailwindCss(model));
  files.set("dist/tailwind/strict.css", renderTailwindStrictCss());
  files.set("dist/js/index.js", renderJs(model));
  files.set("dist/js/index.d.ts", renderDts(model));
  files.set("dist/json/base.json", json(flatObject(model.resolved.base)));
  for (const theme of model.themes) files.set(`dist/json/${theme}.json`, json(flatObject(model.resolved.theme[theme])));
  files.set("dist/json/tokens.json", json(Object.fromEntries(scopes(model).map(([name, map]) => [name, nest(map)]))));
  files.set("dist/guide/index.html", renderGuideHtml(model));
  const mdPath = join(root, TOKENS_MD);
  files.set(TOKENS_MD, renderTokensMd(model, existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null));
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Files under `dir`, as `prefix` + relative path. Skips dotfiles and dot-folders (.DS_Store, ._* AppleDouble files). */
function listFiles(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

/** Files under dist/ (and guide/tokens.md) that differ from a fresh build, are missing, or are leftovers. */
export function staleFiles(root: string = ROOT, outputs: Map<string, string> = buildOutputs(root)): string[] {
  const stale: string[] = [];
  for (const [path, content] of outputs) {
    const full = join(root, path);
    if (!existsSync(full)) stale.push(`${path} (missing)`);
    else if (readFileSync(full, "utf8") !== content) stale.push(`${path} (out of date)`);
  }
  for (const path of listFiles(join(root, "dist"), "dist/")) {
    if (!outputs.has(path)) stale.push(`${path} (not produced by the build)`);
  }
  return stale.sort();
}

export function writeOutputs(root: string = ROOT, outputs: Map<string, string> = buildOutputs(root)): string[] {
  const written: string[] = [];
  for (const [path, content] of outputs) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    if (!existsSync(full) || readFileSync(full, "utf8") !== content) {
      writeFileSync(full, content);
      written.push(path);
    }
  }
  for (const path of listFiles(join(root, "dist"), "dist/")) {
    if (!outputs.has(path)) {
      rmSync(join(root, path));
      written.push(`${path} (removed)`);
    }
  }
  return written;
}

export function main(argv: string[] = process.argv.slice(2), root: string = ROOT): number {
  const check = argv.includes("--check");
  try {
    const outputs = buildOutputs(root);
    if (check) {
      const stale = staleFiles(root, outputs);
      if (stale.length) {
        console.error(`design-system: build outputs are stale (run \`bun run build\`):\n${stale.map((s) => `  ${s}`).join("\n")}`);
        return 1;
      }
      console.log(`design-system: ${outputs.size} build outputs are up to date.`);
      return 0;
    }
    const written = writeOutputs(root, outputs);
    console.log(written.length ? `design-system: wrote ${written.length} file(s):\n${written.map((w) => `  ${w}`).join("\n")}` : "design-system: outputs already up to date.");
    return 0;
  } catch (error) {
    if (error instanceof TokenError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(main());
