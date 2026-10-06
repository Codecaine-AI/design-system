#!/usr/bin/env bun
/**
 * scan-literals: count hard-coded style literals in a source tree.
 *
 * Zero dependencies (node:fs and node:path only). Built for the
 * @codecaine-ai/design-system migration: run it before and after each wave to
 * see what still bypasses the tokens.
 *
 *   bun scripts/scan-literals.ts <path> [<path>...] [options]
 *
 * HARD categories break the token standard and add up to the headline total:
 *   hex            #fff, #ffffff, #ffffffaa
 *   rgb            rgb()/rgba() with literal channels (rgb(var(--x)) is a token)
 *   hsl            hsl()/hsla() with literal channels
 *   oklch          oklch()/oklab() with literal channels
 *   otherColorFn   lab(), lch(), hwb(), color(display-p3 ...)
 *   twArbitrary    Tailwind arbitrary values: bg-[#fff], p-[13px], [mask-type:alpha]
 *   pxFontSize     font-size: 13px, fontSize: 13, font: 12px Inter, fontSize={12}
 *   radius         border-radius declarations with a literal value (not var()), and
 *                  var()-based values whose calc() adds a px/rem/em length
 *   fontFamily     font-family declarations that name fonts (not var()), a value
 *                  written over several lines included
 *
 * SOFT categories are token-adjacent signals, reported separately:
 *   namedColor     color: white, fill="black", border: 1px solid red
 *   twPalette      Tailwind default-palette classes: bg-zinc-900, text-white
 *   twArbitraryVar Tailwind arbitrary values that only wrap a var: bg-[var(--x)], bg-(--x)
 *   pxSpacing      padding/margin/gap declarations with literal px values
 *   otherFontSize  literal rem/em/pt/% font sizes
 *
 * Custom-property definitions count like the declaration that reads them:
 *   --mono: "SFMono-Regular", ui-monospace, monospace   fontFamily (a font stack)
 *   --radius: 8px                                       radius (by name, or because
 *                                                       the file reads it in border-radius)
 *   --font-size-sm: 12px, --gap: 8px                    pxFontSize, pxSpacing
 * A shell-scoped --ds-layout-* override (guide/layout.md) is not a literal.
 *
 * Color literals are split three ways, because each migrates differently:
 *   definitions  --accent: #fff, $accent: #fff, --primary: 222 47% 11%, any
 *                color in a JSON file: a palette file to alias or delete
 *   fallbacks    var(--accent, #fff): already behind a token
 *   inline       everything else: one edit per site
 *
 * Skipped by default: node_modules, dist, build, out, .next and other build
 * output, vendor, reference/ai_docs (vendored code), Unity Library/Temp, dot
 * directories (except .storybook and .vitepress), git submodules, symlinks,
 * tests and test fixtures, minified or generated files, and files over 2 MB.
 * Comments are stripped before matching.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Categories

export const HARD = [
  "hex",
  "rgb",
  "hsl",
  "oklch",
  "otherColorFn",
  "twArbitrary",
  "pxFontSize",
  "radius",
  "fontFamily",
] as const;

export const SOFT = ["namedColor", "twPalette", "twArbitraryVar", "pxSpacing", "otherFontSize"] as const;

export type HardCategory = (typeof HARD)[number];
export type SoftCategory = (typeof SOFT)[number];
export type Category = HardCategory | SoftCategory;

const COLOR_CATEGORIES = new Set<Category>(["hex", "rgb", "hsl", "oklch", "otherColorFn"]);

const LABELS: Record<Category, string> = {
  hex: "hex colors",
  rgb: "rgb()/rgba()",
  hsl: "hsl()/hsla()",
  oklch: "oklch()/oklab()",
  otherColorFn: "lab()/lch()/hwb()/color()",
  twArbitrary: "Tailwind arbitrary values",
  pxFontSize: "px font sizes",
  radius: "border-radius declarations",
  fontFamily: "font-family declarations",
  namedColor: "named colors (white, black, red ...)",
  twPalette: "Tailwind default-palette classes",
  twArbitraryVar: "Tailwind arbitrary var() values",
  pxSpacing: "px padding/margin/gap",
  otherFontSize: "rem/em/pt font sizes",
};

const SHORT: Record<HardCategory, string> = {
  hex: "hex",
  rgb: "rgb",
  hsl: "hsl",
  oklch: "okl",
  otherColorFn: "oth",
  twArbitrary: "tw[]",
  pxFontSize: "fpx",
  radius: "rad",
  fontFamily: "fam",
};

export interface Hit {
  category: Category;
  value: string;
  line: number;
  /**
   * Literal inside a variable definition: a color in a custom-property / SCSS / LESS variable or a
   * JSON file, or a font stack or size in a custom-property definition (`--mono: …`, `--radius: 8px`).
   */
  def: boolean;
  /** Color literal used as a var() fallback: var(--x, #fff). */
  fallback: boolean;
  /** For a font stack or length in a custom-property definition: the property (`--radius`). */
  definition?: string;
}

export type FileKind = "css" | "scss" | "js" | "html" | "json";

// ---------------------------------------------------------------------------
// File selection

const DEFAULT_EXTS = [
  "css", "scss", "sass", "less", "uss",
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "html", "htm", "vue", "svelte", "astro",
];

const KIND_BY_EXT: Record<string, FileKind> = {
  css: "css", uss: "css",
  scss: "scss", sass: "scss", less: "scss",
  ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js",
  html: "html", htm: "html", vue: "html", svelte: "html", astro: "html",
  json: "json", jsonc: "json",
  // opt-in with --ext +md: Slidev decks and VitePress pages carry inline HTML and classes
  md: "html", mdx: "html",
};

/** Directory names that never hold first-party UI source. */
const SKIP_DIRS = new Set([
  // dependencies and vendored code
  "node_modules", "bower_components", "jspm_packages", "vendor", "vendors", "third_party", "third-party",
  "reference", "references", "ai_docs", "site-packages", "Pods",
  // build output and caches
  "dist", "dist-next", "build", "out", "coverage", "storybook-static", "target", "DerivedData",
  "__pycache__", "venv", "tmp", "temp",
  // Unity project state
  "Library", "Temp", "Logs", "obj", "Builds", "UserSettings",
]);

/** Build output with a suffix: dist-electron, dist_ssr, out-tsc. */
const BUILD_DIR = /^(?:dist|out|build)[-_][\w-]+$/;

/** Dot directories that can hold real UI source. Every other dot directory is skipped. */
const DOT_DIR_ALLOW = new Set([".storybook", ".vitepress"]);

/** Directories that hold tests or fixtures; skipped unless --include-tests. */
const TEST_DIRS = new Set([
  "__tests__", "__mocks__", "__fixtures__", "__snapshots__", "__screenshots__",
  "test", "tests", "e2e", "fixtures", "test-fixtures", "testdata", "cypress",
]);

const TEST_FILE = /\.(test|spec|e2e|stories|story)\.[a-z0-9]+$/i;
const FIXTURE_FILE = /\.fixtures?\.[a-z0-9]+$/i;
const GENERATED_FILE = /\.(min|bundle|generated|gen)\.[a-z0-9]+$|\.d\.[cm]?ts$/i;
const MAX_BYTES = 2 * 1024 * 1024;
// A file over MINIFIED_MIN_BYTES whose lines average more than MAX_AVG_LINE
// characters is a bundle. Small one-line files are kept: hand-written CSS is
// sometimes compressed onto one line.
const MINIFIED_MIN_BYTES = 100 * 1024;
const MAX_AVG_LINE = 300;
const GENERATED_HEADER = /@generated|do not edit|auto-?generated|this file (?:is|was) generated/i;

export interface Options {
  roots: string[];
  json: boolean;
  top: number;
  hits: boolean;
  excludes: string[];
  exts: Set<string>;
  includeTests: boolean;
  includeSubmodules: boolean;
  keepComments: boolean;
  failAbove: number | null;
  verbose: boolean;
}

export interface SkipStats {
  dirs: number;
  dotDirs: number;
  submodules: number;
  symlinks: number;
  tests: number;
  generated: number;
  tooLarge: number;
  excluded: number;
  unreadable: number;
}

/** Skipped paths and reasons, collected only with --verbose. */
let skipLog: Array<{ path: string; reason: keyof SkipStats }> | null = null;

function skip(stats: SkipStats, reason: keyof SkipStats, path: string) {
  stats[reason]++;
  skipLog?.push({ path, reason });
}

function parseGitmodules(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) paths.push(m[1]);
  return paths;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

function makeExcluder(patterns: string[]): (rel: string, name: string) => boolean {
  const names = new Set<string>();
  const globs: RegExp[] = [];
  for (const p of patterns) {
    const clean = p.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!clean.includes("/") && !/[*?]/.test(clean)) names.add(clean);
    else globs.push(globToRegExp(clean));
  }
  return (rel, name) => names.has(name) || globs.some((g) => g.test(rel));
}

function fileKind(path: string): FileKind | null {
  return KIND_BY_EXT[extname(path).slice(1).toLowerCase()] ?? null;
}

export function collectFiles(root: string, opts: Options, stats: SkipStats): string[] {
  const absRoot = resolve(root);
  const st = statSync(absRoot);
  if (st.isFile()) return [absRoot];

  const excluded = makeExcluder(opts.excludes);
  const submodules = new Set<string>();
  const files: string[] = [];

  const walk = (dir: string) => {
    if (!opts.includeSubmodules) {
      const gm = join(dir, ".gitmodules");
      if (existsSync(gm)) {
        try {
          for (const p of parseGitmodules(readFileSync(gm, "utf8"))) submodules.add(resolve(dir, p));
        } catch {
          skip(stats, "unreadable", gm);
        }
      }
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skip(stats, "unreadable", dir);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(absRoot, full).split(sep).join("/");
      if (e.isSymbolicLink()) {
        skip(stats, "symlinks", full);
        continue;
      }
      if (e.isDirectory()) {
        if (e.name.startsWith(".") && !DOT_DIR_ALLOW.has(e.name)) {
          skip(stats, "dotDirs", full);
          continue;
        }
        if (SKIP_DIRS.has(e.name) || BUILD_DIR.test(e.name) || (e.name === "cache" && basename(dir) === ".vitepress")) {
          skip(stats, "dirs", full);
          continue;
        }
        if (!opts.includeTests && TEST_DIRS.has(e.name)) {
          skip(stats, "tests", full);
          continue;
        }
        if (submodules.has(full)) {
          skip(stats, "submodules", full);
          continue;
        }
        if (excluded(rel, e.name)) {
          skip(stats, "excluded", full);
          continue;
        }
        walk(full);
      } else if (e.isFile()) {
        const ext = extname(e.name).slice(1).toLowerCase();
        if (!opts.exts.has(ext)) continue;
        if (excluded(rel, e.name)) {
          skip(stats, "excluded", full);
          continue;
        }
        if (!opts.includeTests && (TEST_FILE.test(e.name) || FIXTURE_FILE.test(e.name))) {
          skip(stats, "tests", full);
          continue;
        }
        if (GENERATED_FILE.test(e.name)) {
          skip(stats, "generated", full);
          continue;
        }
        files.push(full);
      }
    }
  };
  walk(absRoot);
  return files;
}

// ---------------------------------------------------------------------------
// Comment stripping. Every stripper preserves length and newlines so match
// offsets map back to the original line numbers.

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/** CSS, SCSS, LESS, USS. Line comments only when `lineComments` (SCSS/LESS). */
export function stripCss(src: string, lineComments: boolean): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (out[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    if (lineComments && c === "/" && d === "/" && src[i - 1] !== ":") {
      let k = i;
      while (k < n && src[k] !== "\n") out[k++] = " ";
      i = k;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      i = k + 1;
      continue;
    }
    if (c === "u" && src.startsWith("url(", i)) {
      let k = i + 4;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== '"' && src[k] !== "'") {
        const end = src.indexOf(")", k);
        i = end === -1 ? n : end + 1;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
/** After `<`, the rest of a JSX closing tag (`</b>`, `</Foo.Bar>`, `</>`): the `/` is not a regex. */
const JSX_CLOSE_REST = /\s*(?:[A-Za-z_$][\w$.:-]*\s*)?>/y;

/**
 * JS/TS lexer. Blanks comments and marks the characters that sit inside
 * string or template literals (`inStr`). Strings end at a newline so stray
 * apostrophes in JSX text cannot swallow the rest of a file.
 */
export function lexJs(src: string, keepComments = false): { text: string; inStr: Uint8Array } {
  const n = src.length;
  const out = src.split("");
  const inStr = new Uint8Array(n);
  const CODE = 0, LINE = 1, BLOCK = 2, SQ = 3, DQ = 4, TPL = 5, RE = 6;
  let state = CODE;
  let braceDepth = 0;
  const tplStack: number[] = [];
  let lastSig = ""; // "a" = identifier, "0" = number, otherwise the punctuation char
  let lastWord = "";
  let reClass = false;
  let i = 0;
  const isIdStart = (ch: string) => /[A-Za-z_$]/.test(ch);
  const isId = (ch: string) => /[\w$]/.test(ch);

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    switch (state) {
      case CODE: {
        if (c === "/" && d === "/" && src[i - 1] !== ":") {
          state = LINE;
          if (!keepComments) out[i] = out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (c === "/" && d === "*") {
          state = BLOCK;
          if (!keepComments) out[i] = out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (c === "'") { state = SQ; i++; continue; }
        if (c === '"') { state = DQ; i++; continue; }
        if (c === "`") { state = TPL; i++; continue; }
        if (c === "/") {
          let allowed = lastSig === "" || (lastSig === "a" ? REGEX_KEYWORDS.has(lastWord) : REGEX_AFTER.has(lastSig));
          if (allowed && lastSig === "<") {
            JSX_CLOSE_REST.lastIndex = i + 1;
            if (JSX_CLOSE_REST.test(src)) allowed = false;
          }
          if (allowed) {
            state = RE;
            reClass = false;
            i++;
            continue;
          }
        }
        if (c === "{") braceDepth++;
        else if (c === "}") {
          if (tplStack.length && tplStack[tplStack.length - 1] === braceDepth) {
            tplStack.pop();
            state = TPL;
            i++;
            continue;
          }
          braceDepth--;
        }
        if (isIdStart(c)) {
          let k = i + 1;
          while (k < n && isId(src[k])) k++;
          lastWord = src.slice(i, k);
          lastSig = "a";
          i = k;
          continue;
        }
        if (/[0-9]/.test(c)) {
          let k = i + 1;
          while (k < n && /[\w.]/.test(src[k])) k++;
          lastSig = "0";
          lastWord = "";
          i = k;
          continue;
        }
        if (!/\s/.test(c)) {
          lastSig = c;
          lastWord = "";
        }
        i++;
        continue;
      }
      case LINE: {
        if (c === "\n") state = CODE;
        else if (!keepComments) out[i] = " ";
        i++;
        continue;
      }
      case BLOCK: {
        if (c === "*" && d === "/") {
          if (!keepComments) out[i] = out[i + 1] = " ";
          state = CODE;
          i += 2;
          continue;
        }
        if (c !== "\n" && !keepComments) out[i] = " ";
        i++;
        continue;
      }
      case SQ:
      case DQ: {
        const q = state === SQ ? "'" : '"';
        if (c === "\\") {
          inStr[i] = 1;
          if (i + 1 < n) inStr[i + 1] = 1;
          i += 2;
          continue;
        }
        if (c === q || c === "\n") {
          state = CODE;
          lastSig = q;
          lastWord = "";
          i++;
          continue;
        }
        inStr[i] = 1;
        i++;
        continue;
      }
      case TPL: {
        if (c === "\\") {
          inStr[i] = 1;
          if (i + 1 < n) inStr[i + 1] = 1;
          i += 2;
          continue;
        }
        if (c === "`") {
          state = CODE;
          lastSig = "`";
          lastWord = "";
          i++;
          continue;
        }
        if (c === "$" && d === "{") {
          tplStack.push(braceDepth);
          state = CODE;
          lastSig = "{";
          i += 2;
          continue;
        }
        inStr[i] = 1;
        i++;
        continue;
      }
      case RE: {
        if (c === "\\") { i += 2; continue; }
        if (c === "\n") { state = CODE; lastSig = ")"; i++; continue; }
        if (c === "[") reClass = true;
        else if (c === "]") reClass = false;
        else if (c === "/" && !reClass) {
          let k = i + 1;
          while (k < n && /[a-z]/i.test(src[k])) k++;
          state = CODE;
          lastSig = ")";
          lastWord = "";
          i = k;
          continue;
        }
        i++;
        continue;
      }
    }
  }
  return { text: out.join(""), inStr };
}

/** HTML, Vue, Svelte, Astro: HTML comments, CSS comments in <style>, JS comments in <script>. */
export function stripHtml(src: string): string {
  let text = src.replace(/<!--[\s\S]*?-->/g, blank);
  text = text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, body, close) => open + stripCss(body, true) + close);
  text = text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, open, body, close) => open + lexJs(body).text + close);
  return text;
}

// ---------------------------------------------------------------------------
// Matchers

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid " +
    "mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen " +
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown " +
    "royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
    "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

// Not after & (HTML entity &#8212;), a word char (url#frag, this.#field) or / (path/#anchor).
const HEX = /(?<![&\w$\\/])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN =
  /(?<![\w-])(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi;
const COLOR_SPACES = /^\s*(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\b/i;
const NUMBER_TOKEN = /(?<![\w.#-])[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|deg|rad|grad|turn)?(?![\w.])/gi;
const VAR_GROUP = /var\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gi;

// Tailwind utility roots that accept arbitrary values (v3 and v4).
const TW_ROOTS =
  "inset(?:-[xy])?|start|end|top|right|bottom|left|z|order|col(?:-(?:span|start|end))?|row(?:-(?:span|start|end))?|" +
  "grid-(?:cols|rows)|auto-(?:cols|rows)|gap(?:-[xy])?|[pm][xytrblse]?|space-[xy]|(?:min-|max-)?[wh]|size|basis|" +
  "flex|grow|shrink|font|text|leading|tracking|indent|align|bg|from|via|to|" +
  "border(?:-[xytrblse])?|rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|ee|es))?|divide(?:-[xy])?|outline(?:-offset)?|" +
  "ring(?:-offset)?|shadow|drop-shadow|inset-shadow|inset-ring|text-shadow|opacity|blur|brightness|contrast|grayscale|" +
  "hue-rotate|invert|saturate|sepia|backdrop-[a-z-]+|transition|duration|ease|delay|animate|scale(?:-[xy])?|rotate|" +
  "translate-[xy]|skew-[xy]|origin|perspective|fill|stroke|decoration|underline-offset|caret|accent|placeholder|" +
  "columns|aspect|line-clamp|content|cursor|will-change|list|object|scroll-[mp][xytrblse]?|mask(?:-[a-z]+)?|tab-size";
const TW_ARBITRARY = new RegExp(
  `(?<![\\w\\-/\\[\\].$#@])(!?-?(?:${TW_ROOTS}))-(\\[[^\\]\\s]+\\]|\\(--[\\w-]+\\))(?!:)!?`,
  "g",
);
const TW_ARBITRARY_PROPERTY = /(?<![\w\-\]\[(])\[([a-z][a-z-]*):([^\]\s]+)\](?![\w-]|:)/g;
const TW_HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const TW_COLOR_ROOTS =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|placeholder|" +
  "caret|accent|shadow|inset-shadow|inset-ring|text-shadow|drop-shadow";
const TW_PALETTE = new RegExp(
  `(?<![\\w\\-/\\[.$#@])!?(?:${TW_COLOR_ROOTS})-(?:(?:${TW_HUES})-(?:50|[1-9]00|950)|white|black)(?:/(?:\\d{1,3}|\\[[^\\]\\s]+\\]))?(?![\\w-])`,
  "g",
);

type PropKind = "fontSize" | "font" | "fontFamily" | "radius" | "spacing" | "color";

const PROP_KIND: Record<string, PropKind> = {};
const addProps = (kind: PropKind, names: string[]) => names.forEach((n) => (PROP_KIND[n] = kind));
addProps("fontSize", ["font-size", "fontSize"]);
addProps("font", ["font"]);
addProps("fontFamily", ["font-family", "fontFamily", "-unity-font", "-unity-font-definition"]);
{
  const corners = ["top-left", "top-right", "bottom-left", "bottom-right", "start-start", "start-end", "end-start", "end-end"];
  const camel = (s: string) => s.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
  const radius = ["border-radius", "borderRadius"];
  for (const c of corners) radius.push(`border-${c}-radius`, camel(`border-${c}-radius`));
  addProps("radius", radius);
  const spacing = ["padding", "margin", "gap", "row-gap", "column-gap", "rowGap", "columnGap", "paddingHorizontal", "paddingVertical", "marginHorizontal", "marginVertical"];
  for (const base of ["padding", "margin"]) {
    for (const side of ["top", "right", "bottom", "left", "inline", "block", "inline-start", "inline-end", "block-start", "block-end"]) {
      spacing.push(`${base}-${side}`, camel(`${base}-${side}`));
    }
  }
  addProps("spacing", spacing);
  const color = [
    "color", "background", "background-color", "backgroundColor", "border-color", "borderColor", "border",
    "outline", "outline-color", "outlineColor", "fill", "stroke", "caret-color", "caretColor", "accent-color",
    "accentColor", "text-decoration-color", "textDecorationColor", "stop-color", "stopColor", "box-shadow",
    "boxShadow", "text-shadow", "textShadow", "column-rule-color", "shadowColor", "flood-color", "floodColor",
    "-unity-background-image-tint-color", "-unity-text-outline-color",
  ];
  for (const side of ["top", "right", "bottom", "left", "block", "inline"]) {
    color.push(`border-${side}`, `border-${side}-color`, camel(`border-${side}`), camel(`border-${side}-color`));
  }
  addProps("color", color);
}
const PROP_NAMES = Object.keys(PROP_KIND).sort((a, b) => b.length - a.length);
const PROP_RE = new RegExp(
  `(?<![\\w$-])(['"]?)(${PROP_NAMES.map((p) => p.replace(/[-]/g, "\\-")).join("|")})\\1\\s*:(?!:)`,
  "g",
);
const ATTR_RE =
  /(?<![\w$.-])(fontSize|font-size|fontFamily|font-family|fill|stroke|stop-color|stopColor|bgcolor)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(-?\d+(?:\.\d+)?)\s*\}|\{\s*["'`]([^"'`]*)["'`]\s*\})/g;
const CANVAS_FONT_RE = /\.font\s*=\s*(['"`])([^'"`\n]*)\1/g;
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;
// Bare channel triplets in custom properties, as in shadcn's `--primary: 222 47% 11%`
// (consumed through hsl(var(--primary))) or `--rgb: 255 255 255` for rgb(var(--rgb)).
const CUSTOM_PROP_RE = /(?<![\w-])--[\w-]+\s*:\s*([^;{}]+)/g;
// Palette tables written as numeric tuples, `background: [249, 249, 247],`. One
// tuple could be a coordinate, so they only count when a file has
// RGB_TUPLE_MIN of them.
const RGB_TUPLE = /(?<![\w$])[\w$]+['"]?\s*:\s*\[\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\]/g;
const RGB_TUPLE_MIN = 6;
const HSL_TRIPLET =/^-?\d*\.?\d+(?:deg|turn|rad|grad)?\s*,?\s+-?\d*\.?\d+%\s*,?\s+-?\d*\.?\d+%(?:\s*\/\s*\d*\.?\d+%?)?$/;
const RGB_TRIPLET = /^(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*\/\s*\d*\.?\d+%?)?$/;

type ValueKind = "css" | "quoted" | "expr";

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function normalizeHex(h: string): string {
  const s = h.toLowerCase();
  if (s.length === 4 || s.length === 5) return "#" + s.slice(1).split("").map((ch) => ch + ch).join("");
  return s;
}

function firstFamily(value: string): string {
  const first = value.split(",")[0].trim().replace(/^\\?['"]|\\?['"]$/g, "").trim();
  return first.toLowerCase().replace(/\s+/g, " ");
}

function literalColorFn(fn: string, args: string): boolean {
  if (fn === "color" && !COLOR_SPACES.test(args)) return false;
  const stripped = args.replace(/\$\{[^}]*\}/g, " X ").replace(VAR_GROUP, " X ");
  const nums = stripped.match(NUMBER_TOKEN) ?? [];
  return nums.length >= 3;
}

/**
 * True when a color at `index` sits in a variable definition: a CSS custom
 * property (--x: ...), an SCSS ($x: ...) or LESS (@x: ...) variable.
 */
function inDefinition(text: string, index: number, kind: FileKind): boolean {
  if (kind === "json") return true;
  if (kind === "css" || kind === "scss") {
    let k = index - 1;
    while (k >= 0 && text[k] !== ";" && text[k] !== "{" && text[k] !== "}") k--;
    const decl = text.slice(k + 1, index).trimStart();
    return /^(--[\w-]+|\$[\w-]+|@[\w-]+)\s*:/.test(decl);
  }
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /(?:^|[\s{,(])(['"`]?)(--[\w-]+|\$[\w-]+)\1\s*:/.test(text.slice(lineStart, index));
}

/** In CSS files, `#abc {` or `#abc.foo` is an ID selector, not a color. */
function isCssSelector(text: string, end: number): boolean {
  for (let k = end; k < text.length; k++) {
    const ch = text[k];
    if (ch === "{") return true;
    if (ch === ";" || ch === "}") return false;
  }
  return false;
}

/**
 * Where a CSS value starting at `i` ends: at a `stops` character, at the end of a JS string (`inStr`),
 * or at a newline, unless `multiline` and the value so far is a list that goes on (ends with a comma).
 */
function valueEnd(text: string, i: number, stops: string, multiline: boolean, inStr: Uint8Array | null): number {
  let k = i;
  let last = "";
  for (; k < text.length; k++) {
    const ch = text[k];
    if (stops.includes(ch) || (inStr && inStr[k] === 0)) break;
    if (ch === "\n" && !(multiline && last === ",")) break;
    if (!/\s/.test(ch)) last = ch;
  }
  return k;
}

/**
 * Reads a declaration value. `multiline` (font-family) reads a value that starts on the next line or
 * runs over several (`font-family:\n  Inter,\n  sans-serif;`): a newline ends it unless the value is
 * still empty or ends with a comma, so an unterminated value (indented Sass) still ends at its line.
 */
function readValue(text: string, start: number, kind: FileKind, inStr: Uint8Array | null, multiline = false): { value: string; vkind: ValueKind } {
  let i = start;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const cssInJs = kind === "js" && inStr !== null && inStr[start - 1] === 1;
  const cssLike = kind === "css" || kind === "scss" || cssInJs;
  if (multiline && (text[i] === "\n" || text[i] === "\r")) {
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    // In JS only a string value on the next line is a value; an expression there is not a literal.
    if (cssLike || kind === "html" || "'\"`".includes(text[j] ?? "")) i = j;
  }
  if (cssLike) {
    const k = valueEnd(text, i, ";{}", multiline, cssInJs ? inStr : null);
    return { value: text.slice(i, k).trim(), vkind: "css" };
  }
  const q = text[i];
  if (q === "'" || q === '"' || q === "`") {
    let k = i + 1;
    while (k < text.length && text[k] !== q && (q === "`" || text[k] !== "\n")) k += text[k] === "\\" ? 2 : 1;
    return { value: text.slice(i + 1, Math.min(k, text.length)).replace(/\\(["'`])/g, "$1"), vkind: "quoted" };
  }
  if (kind === "html") {
    const k = valueEnd(text, i, ';{}"<>', multiline, null);
    const value = text.slice(i, k).trim();
    // A script expression in a template binding (`ok ? 0 : 4`), not a CSS value.
    if (/\?|===|!==|&&|\|\||=>/.test(value)) return { value: "", vkind: "expr" };
    return { value, vkind: "css" };
  }
  let k = i;
  let depth = 0;
  while (k < text.length) {
    const ch = text[k];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      if (depth === 0) break;
      depth--;
    } else if ((ch === "," || ch === "}" || ch === ";" || ch === "\n") && depth === 0) break;
    k++;
  }
  return { value: text.slice(i, k).trim(), vkind: "expr" };
}

/**
 * Non-zero px/rem/em lengths inside calc() in a value whose var() groups are already blanked (so a
 * var() fallback length never counts): `calc(  - 2px)` -> ["2px"].
 */
function calcLengths(noVars: string): string[] {
  const out: string[] = [];
  for (const m of noVars.matchAll(/calc\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi)) {
    for (const len of m[1].matchAll(/(?<![\w.#-])(\d*\.?\d+)(px|rem|em)\b/g)) {
      if (Number(len[1]) !== 0) out.push(`${len[1]}${len[2]}`);
    }
  }
  return out;
}

const IS_NUMBER = /^-?\d+(?:\.\d+)?$/;
const RESET_VALUES = new Set(["0", "0px", "0rem", "0em", "none", "inherit", "initial", "unset", "revert"]);

/** Classify one property value. Returns hits as [category, value] pairs. */
function classifyProp(kind: PropKind, raw: string, vkind: ValueKind): Array<[Category, string]> {
  const value = raw.replace(/\s*!important\s*$/i, "").trim();
  if (!value || value.includes("${")) return []; // empty or interpolated: dynamic, not a literal
  const out: Array<[Category, string]> = [];
  if (vkind === "expr") {
    if (kind === "fontSize" && IS_NUMBER.test(value)) out.push(["pxFontSize", `${value}px`]);
    else if (kind === "radius" && IS_NUMBER.test(value) && Number(value) !== 0) out.push(["radius", `${value}px`]);
    else if (kind === "spacing" && IS_NUMBER.test(value) && Number(value) !== 0) out.push(["pxSpacing", `${value}px`]);
    else if (kind === "color") {
      for (const m of value.matchAll(/(['"])([a-zA-Z]+)\1/g)) {
        if (NAMED_COLORS.has(m[2].toLowerCase())) out.push(["namedColor", m[2].toLowerCase()]);
      }
    }
    return out;
  }
  const noVars = value.replace(VAR_GROUP, " ");
  const tokenBacked = /var\(|theme\(|\$\{/.test(value);
  switch (kind) {
    case "fontSize": {
      if (/calc\(/i.test(noVars)) {
        // calc(var(--base) + 2px), calc(14px + 0.3vw): each length counts as it would on its own.
        for (const len of calcLengths(noVars)) out.push(len.endsWith("px") ? ["pxFontSize", len] : ["otherFontSize", len]);
        break;
      }
      if (tokenBacked) break;
      const px = value.match(/^(-?\d*\.?\d+)px$/);
      if (px && Number(px[1]) === 0) break;
      if (px) out.push(["pxFontSize", `${px[1]}px`]);
      else if (/^-?\d*\.?\d+(rem|em|pt|%)$/.test(value)) out.push(["otherFontSize", value]);
      break;
    }
    case "font": {
      if (/^(var\(|inherit|initial|unset|revert)/.test(value) || value.includes("${")) break;
      const m = value.match(/(?:^|\s)(\d*\.?\d+)(px|rem|em|pt|%)(?:\s*\/\s*[\w.%-]+)?\s+(.+)$/);
      if (!m) break;
      out.push(m[2] === "px" ? ["pxFontSize", `${m[1]}px`] : ["otherFontSize", `${m[1]}${m[2]}`]);
      const family = m[3].trim();
      if (family && !family.startsWith("var(")) out.push(["fontFamily", firstFamily(family)]);
      break;
    }
    case "fontFamily": {
      if (/^(?:var\(|-*theme\(|inherit|initial|unset|revert)/.test(value) || value.includes("${")) break;
      const res = value.match(/^(?:resource|url)\(\s*['"]?([^'")]+)['"]?\s*\)/);
      const family = res ? basename(res[1].split(/[?#]/)[0]).replace(/\.[a-z0-9]+$/i, "").toLowerCase() : firstFamily(value);
      if (family) out.push(["fontFamily", family]);
      break;
    }
    case "radius": {
      // calc(var(--radius) - 2px): a radius built from a token plus a literal length.
      if (tokenBacked && calcLengths(noVars).length) out.push(["radius", value.replace(/\s+/g, " ")]);
      if (tokenBacked || RESET_VALUES.has(value.toLowerCase())) break;
      if (/\d/.test(value)) out.push(["radius", value.replace(/\s+/g, " ")]);
      break;
    }
    case "spacing": {
      if (/(?<![\w.])(?!0+(?:\.0+)?px)\d*\.?\d+px\b/.test(noVars)) out.push(["pxSpacing", value.replace(/\s+/g, " ")]);
      break;
    }
    case "color": {
      const words = noVars.replace(/url\([^)]*\)/gi, " ").replace(/(['"])[^'"]*\1/g, (s) => (vkind === "quoted" ? s : " "));
      for (const m of words.matchAll(/(?<![\w-])([a-zA-Z]+)(?![\w-])/g)) {
        const w = m[1].toLowerCase();
        if (NAMED_COLORS.has(w)) out.push(["namedColor", w]);
      }
      break;
    }
  }
  return out;
}

/**
 * Marks the fallback half of every var(): in `var(--x, #fff)` the `#fff`.
 * A literal fallback already sits behind a token, so it is the cheapest kind
 * of color literal to migrate.
 */
function varFallbackMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const re = /var\(\s*--[\w-]+\s*,/g;
  for (const m of text.matchAll(re)) {
    let depth = 1;
    let k = m.index! + m[0].length;
    const start = k;
    while (k < text.length && depth > 0) {
      const ch = text[k];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "\n" && k - start > 400) break; // unbalanced; stop
      k++;
    }
    mask.fill(1, start, k);
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Custom-property definitions

/** CSS generic family keywords and the system-font aliases stacks start or end with. */
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont",
]);
const FAMILY_ITEM = /^(?:"[^"\n]+"|'[^'\n]+'|-?[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*)$/;
/** Names that hold a font stack: --font-sans, --font-family-mono, --mono, --ff-body, --typeface. */
const FAMILY_NAME = /(?:^--|-)(?:font|fonts|ff|family|typeface|mono|sans|serif)(?:-|$)/i;
/** ... unless they name another font property: --font-size-sm, --font-weight-bold, --font-feature-settings. */
const NOT_FAMILY_NAME = /size|weight|style|variant|stretch|feature|setting|smooth|synthesis|kerning|optical|height|leading|tracking|spacing|scale/i;
/** Keywords no font is called: CSS-wide values and @font-face font-display values (`--font-display: swap`). */
const NOT_A_FAMILY = /^(?:inherit|initial|unset|revert|revert-layer|none|normal|auto|block|swap|fallback|optional)$/i;
/** Whole name segments: --radius, --radius-lg, --card-corner-radius, --rounded (not --shadow-blur-radius). */
const RADIUS_NAME = /(?:^--|-)(?:radius|rounded)(?:-|$)/i;
const NOT_RADIUS_NAME = /shadow|blur|spread|glow/i;
/** --font-size-sm, --fs-body, --text-sm (Tailwind v4 theme), --blog-heading-size, --label-text-size. */
const FONT_SIZE_NAME =
  /font-?size|(?:^--|-)fs(?:-|$)|^--text-(?:2xs|xs|sm|base|md|lg|xl|[2-9]xl)$|(?:^--|-)(?:text|font|type|title|subtitle|heading|subheading|body|label|caption|h[1-6])-size(?:-|$)/i;
/** Whole name segments only: --gap, --content-padding-x, --site-gutter (not --workspace-height). */
const SPACING_NAME = /(?:^--|-)(?:space|spacing|spacer|gap|gutter|pad|padding|margin)(?:-|$)/i;
/** A shell-scoped `--ds-layout-*` override is allowed (guide/layout.md, decision 32); the names check owns its scope. */
const ALLOWED_DEFINITION = /^--ds-layout-/;
const COUNTED_READS = new Set<PropKind>(["fontFamily", "radius", "fontSize", "spacing"]);

/** A comma list of font family names, or null: `"SFMono-Regular", ui-monospace, Menlo`. */
function familyList(value: string): string[] | null {
  if (!value || /var\(|\$\{|[();]/.test(value)) return null;
  const items = value.split(",").map((x) => x.trim().replace(/\s+/g, " "));
  return items.every((x) => FAMILY_ITEM.test(x)) ? items : null;
}

/**
 * The kind a custom property's name gives it, or null. After a second `--` the name is a
 * sub-property (Tailwind's `--text-sm--line-height`, BEM's `--button--radius`): that part decides.
 */
function kindFromName(full: string): PropKind | null {
  const inner = full.indexOf("--", 2);
  const name = inner === -1 ? full : `--${full.slice(full.lastIndexOf("--") + 2)}`;
  if (RADIUS_NAME.test(name) && !NOT_RADIUS_NAME.test(name)) return "radius";
  if (FONT_SIZE_NAME.test(name)) return "fontSize";
  if (FAMILY_NAME.test(name) && !NOT_FAMILY_NAME.test(name)) return "fontFamily";
  if (SPACING_NAME.test(name)) return "spacing";
  return null;
}

/**
 * The hits a custom-property definition holds: a font stack (fontFamily) or a length (radius,
 * font size, spacing). How the file reads the property decides first (`border-radius:
 * var(--radius)`; read only as a color or a shadow, it holds none of these), then its name; a list
 * of families with a generic family (`monospace`, `system-ui`) is a font stack whatever its name.
 */
function classifyDefinition(name: string, raw: string, readAs: PropKind | null): Array<[Category, string]> {
  if (ALLOWED_DEFINITION.test(name)) return [];
  const value = raw.replace(/\s*!important\s*$/i, "").trim();
  if (!value || /^[-+]?(?:\d*\.)?0+(?:\.0+)?(?:[a-z%]+)?$/i.test(value)) return [];
  if (readAs && readAs !== "font" && !COUNTED_READS.has(readAs)) return [];
  const kind = readAs && COUNTED_READS.has(readAs) ? readAs : kindFromName(name);
  const families = familyList(value);
  if (kind === "fontFamily" || (kind === null && families)) {
    if (!families || NOT_A_FAMILY.test(families[0])) return [];
    const generic = families.some((x) => GENERIC_FAMILIES.has(x.toLowerCase()));
    // Without a name or reader that says font, only a stack with a generic family is one. One bare
    // word is a family only where the name or a reader says so, and only when it looks like a font
    // name (Inter, "Fraunces", monospace), not a keyword.
    const ok = kind === null ? generic : families.length > 1 || generic || /^["'A-Z]/.test(families[0]);
    return ok ? [["fontFamily", firstFamily(value)]] : [];
  }
  if (kind === "radius" || kind === "fontSize" || kind === "spacing") return classifyProp(kind, value, "css");
  return [];
}

/**
 * Custom-property definitions with their values: CSS and <style> text, style="" attributes, CSS
 * strings and quoted keys in JS. A value ends at `;`, `{` or `}`, at a newline unless it is a list
 * that goes on (`--mono:\n  Menlo,\n  monospace;`), at the end of its JS string, and in a style=""
 * attribute at its quote. A `--x:` inside a selector (`[style*="--x: 1"] {`) or a Tailwind arbitrary
 * property (`[--radius:8px]`) is not a definition here.
 */
function customPropDefs(text: string, kind: FileKind, inStr: Uint8Array | null): Array<{ name: string; value: string; index: number }> {
  const out: Array<{ name: string; value: string; index: number }> = [];
  if (kind === "json") return out;
  for (const m of text.matchAll(/(?<![\w-])(--[\w-]+)[ \t]*:(?!:)/g)) {
    const at = m.index!;
    // In JS only inside a string or template (CSS text), never code.
    if (inStr && !inStr[at]) continue;
    let p = at - 1;
    while (p >= 0 && (text[p] === " " || text[p] === "\t")) p--;
    if (text[p] === "[") continue;
    let i = at + m[0].length;
    // `--x: 1"] {` on its line: part of a selector (an attribute value), not a declaration.
    if ((kind === "css" || kind === "scss") && /^[^;{}\n]*\{/.test(text.slice(i, i + 400))) continue;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (text[i] === "\n" || text[i] === "\r") while (i < text.length && /\s/.test(text[i])) i++;
    let stops = ";{}";
    if (kind === "html") {
      // Inside a tag: a style="" attribute, which ends at its quote; else a <style> body, which ends at `<`.
      const open = text.lastIndexOf("<", at);
      const inTag = open > text.lastIndexOf(">", at);
      const tag = inTag ? text.slice(open, at) : "";
      const attr = [...tag.matchAll(/\bstyle\s*=\s*(["'])/g)].pop();
      // The style attribute is still open when its own quote has not come again.
      const quote = attr && !tag.slice(attr.index! + attr[0].length).includes(attr[1]) ? attr[1] : undefined;
      stops += inTag ? `<>${quote ?? "\"'"}` : "<";
    }
    const value = text.slice(i, valueEnd(text, i, stops, true, inStr)).trim();
    out.push({ name: m[1], value, index: at });
  }
  if (kind === "js") {
    // A style object key: { "--radius": "8px" }.
    for (const m of text.matchAll(/(['"])(--[\w-]+)\1\s*:\s*(['"`])([^'"`\n]*)\3/g)) out.push({ name: m[2], value: m[4].trim(), index: m.index! });
  }
  return out;
}

/** Scan one file's text. Pure: no I/O, so other tools can reuse it. */
export function scanText(src: string, kind: FileKind, keepComments = false): Hit[] {
  let text: string;
  let inStr: Uint8Array | null = null;
  if (kind === "js") {
    const lexed = lexJs(src, keepComments);
    text = lexed.text;
    inStr = lexed.inStr;
  } else if (keepComments || kind === "json") text = src;
  else if (kind === "html") text = stripHtml(src);
  else text = stripCss(src, kind === "scss");

  const starts = lineStarts(src);
  const fallbacks = varFallbackMask(text);
  const hits: Hit[] = [];
  const add = (category: Category, value: string, index: number, def = false, definition?: string) =>
    hits.push({
      category,
      value,
      line: lineOf(starts, index),
      def,
      fallback: !def && COLOR_CATEGORIES.has(category) && fallbacks[index] === 1,
      ...(definition ? { definition } : {}),
    });

  // 1. Tailwind classes. Arbitrary values are masked afterwards so bg-[#fff]
  //    is not counted again as a hex color.
  const masks: Array<[number, number]> = [];
  if (kind !== "json") {
    for (const m of text.matchAll(TW_ARBITRARY)) {
      const body = m[2];
      const inner = body.startsWith("(") ? "" : body.slice(1, -1).replace(/^[a-z-]+:(?!\/\/)/, "");
      const varOnly =
        body.startsWith("(") || (!/[\d#]/.test(inner.replace(VAR_GROUP, "")) && /var\(|^--/.test(inner));
      add(varOnly ? "twArbitraryVar" : "twArbitrary", m[0].replace(/^!/, ""), m.index!);
      masks.push([m.index!, m.index! + m[0].length]);
    }
    // In CSS files `[attr:value]` is an attribute selector, not a Tailwind class.
    if (kind !== "css" && kind !== "scss") {
      for (const m of text.matchAll(TW_ARBITRARY_PROPERTY)) {
        add("twArbitrary", m[0], m.index!);
        masks.push([m.index!, m.index! + m[0].length]);
      }
    }
    for (const m of text.matchAll(TW_PALETTE)) add("twPalette", m[0].replace(/^!/, ""), m.index!);
  }
  if (masks.length) {
    const chars = text.split("");
    for (const [a, b] of masks) for (let k = a; k < b; k++) chars[k] = " ";
    text = chars.join("");
  }

  // 2. Property declarations: CSS syntax, CSS-in-JS, JS style objects, JSON.
  const declText = kind === "js" || kind === "json" ? text : text.replace(FONT_FACE_RE, blank);
  /** What each custom property is read as in this file: `border-radius: calc(var(--radius) - 2px)`. */
  const readAs = new Map<string, PropKind | null>();
  for (const m of declText.matchAll(PROP_RE)) {
    const name = m[2];
    const pkind = PROP_KIND[name];
    const end = m.index! + m[0].length;
    // In CSS-like files, `color:` inside a selector (a:hover) is not a declaration.
    if ((kind === "css" || kind === "scss") && isCssSelector(declText, end)) continue;
    // A value over several lines only for font-family (in markup, the CSS name only: `fontFamily:` there is script).
    const multiline = pkind === "fontFamily" && (kind !== "html" || name === "font-family");
    const { value, vkind } = readValue(declText, end, kind, inStr, multiline);
    for (const [category, v] of classifyProp(pkind, value, vkind)) add(category, v, m.index!);
    for (const r of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const was = readAs.get(r[1]);
      readAs.set(r[1], was === undefined || was === pkind ? pkind : null);
    }
  }

  // 2b. Custom-property definitions of a font stack or a length: `--mono: "SFMono-Regular", monospace`,
  //     `--radius: 8px`. They count like the declaration that reads them.
  for (const d of customPropDefs(text, kind, inStr)) {
    for (const [category, v] of classifyDefinition(d.name, d.value, readAs.get(d.name) ?? null)) add(category, v, d.index, true, d.name);
  }

  // 3. JSX / HTML / SVG attributes and canvas fonts.
  if (kind === "js" || kind === "html") {
    for (const m of text.matchAll(ATTR_RE)) {
      const name = m[1];
      const value = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
      if (!value) continue;
      if (name === "fontSize" || name === "font-size") {
        const px = value.match(/^(\d*\.?\d+)(px)?$/);
        if (px) add("pxFontSize", `${px[1]}px`, m.index!);
      } else if (name === "fontFamily" || name === "font-family") {
        const family = firstFamily(value);
        if (family && !value.startsWith("var(") && !value.includes("${")) add("fontFamily", family, m.index!);
      } else if (NAMED_COLORS.has(value.toLowerCase())) {
        add("namedColor", value.toLowerCase(), m.index!);
      }
    }
    for (const m of text.matchAll(CANVAS_FONT_RE)) {
      for (const [category, v] of classifyProp("font", m[2], "quoted")) add(category, v, m.index!);
    }
  }

  // 4. Colors.
  for (const m of text.matchAll(HEX)) {
    const i = m.index!;
    if (inStr && !inStr[i + 1]) continue; // JS: only colors inside strings and templates
    if (kind === "css" || kind === "scss") {
      if (isCssSelector(text, i + m[0].length)) continue;
    } else {
      const before = text.slice(Math.max(0, i - 24), i);
      if (/(?:href|to|id|for|xlink:href)\s*=\s*\{?\s*["'`]$/.test(before) || /url\(\s*['"]?$/.test(before)) continue;
    }
    add("hex", normalizeHex(m[0]), i, inDefinition(text, i, kind));
  }
  for (const m of text.matchAll(COLOR_FN)) {
    const fn = m[1].toLowerCase();
    if (!literalColorFn(fn, m[2])) continue;
    const category: Category = fn.startsWith("rgb")
      ? "rgb"
      : fn.startsWith("hsl")
        ? "hsl"
        : fn === "oklch" || fn === "oklab"
          ? "oklch"
          : "otherColorFn";
    add(category, m[0].replace(/\s+/g, " ").toLowerCase(), m.index!, inDefinition(text, m.index!, kind));
  }
  if (kind === "js") {
    const tuples = [...text.matchAll(RGB_TUPLE)].filter((m) => [m[1], m[2], m[3]].every((ch) => Number(ch) <= 255));
    if (tuples.length >= RGB_TUPLE_MIN) {
      for (const m of tuples) add("rgb", `rgb(${m[1]} ${m[2]} ${m[3]})`, m.index!, true);
    }
  }
  if (kind === "css" || kind === "scss" || kind === "html") {
    for (const m of text.matchAll(CUSTOM_PROP_RE)) {
      const value = m[1].replace(/\s*!important\s*$/i, "").trim();
      if (HSL_TRIPLET.test(value)) add("hsl", `hsl(${value.replace(/\s+/g, " ")})`, m.index!, true);
      else {
        const rgb = value.match(RGB_TRIPLET);
        if (rgb && [rgb[1], rgb[2], rgb[3]].every((ch) => Number(ch) <= 255)) {
          add("rgb", `rgb(${value.replace(/\s+/g, " ")})`, m.index!, true);
        }
      }
    }
  }

  hits.sort((a, b) => a.line - b.line);
  return hits;
}

// ---------------------------------------------------------------------------
// Aggregation

export interface FileReport {
  path: string;
  hard: number;
  soft: number;
  colorDefs: number;
  colorFallbacks: number;
  counts: Record<Category, number>;
  hits?: Hit[];
}

export interface Report {
  tool: "scan-literals";
  version: 1;
  roots: string[];
  files: { scanned: number; withLiterals: number; skipped: SkipStats };
  totals: {
    hard: number;
    soft: number;
    colorDefs: number;
    colorFallbacks: number;
    colorUsages: number;
    byCategory: Record<Category, number>;
  };
  distinct: Record<Category, Array<{ value: string; count: number }>>;
  byDir: Array<{ dir: string; hard: number; soft: number; files: number }>;
  fileReports: FileReport[];
}

const emptyCounts = (): Record<Category, number> =>
  Object.fromEntries([...HARD, ...SOFT].map((c) => [c, 0])) as Record<Category, number>;

function commonDir(paths: string[]): string {
  if (paths.length === 1) return paths[0];
  const parts = paths.map((p) => p.split(sep));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = parts[0][i];
    if (seg === undefined || parts.some((p) => p[i] !== seg)) break;
    out.push(seg);
  }
  return out.join(sep) || sep;
}

export function scan(opts: Options): Report {
  const skipped: SkipStats = {
    dirs: 0, dotDirs: 0, submodules: 0, symlinks: 0, tests: 0, generated: 0, tooLarge: 0, excluded: 0, unreadable: 0,
  };
  skipLog = opts.verbose ? [] : null;
  const roots = opts.roots.map((r) => resolve(r));
  const seen = new Set<string>();
  const files: string[] = [];
  for (const root of roots) {
    for (const f of collectFiles(root, opts, skipped)) {
      if (!seen.has(f)) {
        seen.add(f);
        files.push(f);
      }
    }
  }
  const base = commonDir(roots.map((r) => (statSync(r).isFile() ? dirname(r) : r)));

  const totals = emptyCounts();
  const distinct = Object.fromEntries([...HARD, ...SOFT].map((c) => [c, new Map<string, number>()])) as Record<
    Category,
    Map<string, number>
  >;
  const fileReports: FileReport[] = [];
  const byDir = new Map<string, { hard: number; soft: number; files: number }>();
  let colorDefs = 0;
  let colorFallbacks = 0;
  let scanned = 0;

  for (const file of files) {
    const kind = fileKind(file);
    if (!kind) continue;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      skip(skipped, "unreadable", file);
      continue;
    }
    if (size > MAX_BYTES) {
      skip(skipped, "tooLarge", file);
      continue;
    }
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      skip(skipped, "unreadable", file);
      continue;
    }
    const lines = src.split("\n").length;
    if ((size > MINIFIED_MIN_BYTES && src.length / lines > MAX_AVG_LINE) || GENERATED_HEADER.test(src.slice(0, 500))) {
      skip(skipped, "generated", file);
      continue;
    }
    scanned++;
    const hits = scanText(src, kind, opts.keepComments);
    if (!hits.length) continue;
    const counts = emptyCounts();
    let defs = 0;
    let fallbacksHere = 0;
    for (const h of hits) {
      counts[h.category]++;
      totals[h.category]++;
      const d = distinct[h.category];
      d.set(h.value, (d.get(h.value) ?? 0) + 1);
      if (h.def && COLOR_CATEGORIES.has(h.category)) defs++;
      if (h.fallback) fallbacksHere++;
    }
    colorDefs += defs;
    colorFallbacks += fallbacksHere;
    const hard = HARD.reduce((s, c) => s + counts[c], 0);
    const soft = SOFT.reduce((s, c) => s + counts[c], 0);
    const rel = relative(base, file).split(sep).join("/") || basename(file);
    fileReports.push({ path: rel, hard, soft, colorDefs: defs, colorFallbacks: fallbacksHere, counts, ...(opts.hits ? { hits } : {}) });
    const dir = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : ".";
    const agg = byDir.get(dir) ?? { hard: 0, soft: 0, files: 0 };
    agg.hard += hard;
    agg.soft += soft;
    agg.files++;
    byDir.set(dir, agg);
  }

  fileReports.sort((a, b) => b.hard - a.hard || b.soft - a.soft || a.path.localeCompare(b.path));
  const hardTotal = HARD.reduce((s, c) => s + totals[c], 0);
  const softTotal = SOFT.reduce((s, c) => s + totals[c], 0);
  const colorTotal = [...COLOR_CATEGORIES].reduce((s, c) => s + totals[c], 0);

  return {
    tool: "scan-literals",
    version: 1,
    roots,
    files: { scanned, withLiterals: fileReports.length, skipped },
    totals: {
      hard: hardTotal,
      soft: softTotal,
      colorDefs,
      colorFallbacks,
      colorUsages: colorTotal - colorDefs - colorFallbacks,
      byCategory: totals,
    },
    distinct: Object.fromEntries(
      Object.entries(distinct).map(([c, m]) => [
        c,
        [...m.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      ]),
    ) as Report["distinct"],
    byDir: [...byDir.entries()]
      .map(([dir, v]) => ({ dir, ...v }))
      .sort((a, b) => b.hard - a.hard || b.soft - a.soft || a.dir.localeCompare(b.dir)),
    fileReports,
  };
}

// ---------------------------------------------------------------------------
// Text report

const pad = (s: string | number, w: number) => String(s).padStart(w);
const padEnd = (s: string | number, w: number) => String(s).padEnd(w);

function listValues(values: Array<{ value: string; count: number }>, limit: number): string {
  if (!values.length) return "none";
  const shown = values.slice(0, limit).map((v) => (v.count > 1 ? `${v.value} x${v.count}` : v.value));
  const rest = values.length - limit;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

export function formatText(report: Report, opts: Options): string {
  const out: string[] = [];
  const { totals, files } = report;
  const s = files.skipped;
  out.push(`scan-literals  ${report.roots.join("  ")}`);
  out.push(
    `files: ${files.scanned} scanned, ${files.withLiterals} with literals | skipped: ${s.tests} test/fixture, ` +
      `${s.generated} generated/minified, ${s.tooLarge} too large, ${s.submodules} submodule dirs, ${s.symlinks} symlinks, ` +
      `${s.excluded} excluded`,
  );
  out.push("");
  out.push(`HARD-CODED LITERALS${" ".repeat(25)}count  distinct`);
  for (const c of HARD) {
    out.push(`  ${padEnd(LABELS[c], 40)}${pad(totals.byCategory[c], 6)}  ${pad(report.distinct[c].length, 8)}`);
  }
  out.push(`  ${padEnd("TOTAL", 40)}${pad(totals.hard, 6)}`);
  out.push(
    `  color literals: ${totals.colorDefs} in variable definitions, ${totals.colorFallbacks} as var() fallbacks, ` +
      `${totals.colorUsages} inline`,
  );
  out.push("");
  out.push("SOFT SIGNALS (token-adjacent, review)");
  for (const c of SOFT) {
    out.push(`  ${padEnd(LABELS[c], 40)}${pad(totals.byCategory[c], 6)}  ${pad(report.distinct[c].length, 8)}`);
  }
  out.push(`  ${padEnd("TOTAL", 40)}${pad(totals.soft, 6)}`);
  out.push("");
  out.push("DISTINCT VALUES");
  out.push(`  radius:        ${listValues(report.distinct.radius, 12)}`);
  out.push(`  font families: ${listValues(report.distinct.fontFamily, 10)}`);
  out.push(`  px font sizes: ${listValues(report.distinct.pxFontSize, 14)}`);
  out.push(`  top hex:       ${listValues(report.distinct.hex, 10)}`);
  if (report.distinct.twArbitrary.length) out.push(`  tw arbitrary:  ${listValues(report.distinct.twArbitrary, 8)}`);
  out.push("");

  const top = opts.top === 0 ? report.fileReports : report.fileReports.slice(0, opts.top);
  if (top.length) {
    const head = HARD.map((c) => pad(SHORT[c], 5)).join("");
    out.push(`TOP FILES (by hard total; then soft signals, color definitions, var() fallbacks)`);
    out.push(`  ${pad("hard", 5)}${head}  ${pad("soft", 5)} ${pad("defs", 5)} ${pad("fb", 4)}  file`);
    for (const f of top) {
      const cells = HARD.map((c) => pad(f.counts[c] || ".", 5)).join("");
      out.push(`  ${pad(f.hard, 5)}${cells}  ${pad(f.soft, 5)} ${pad(f.colorDefs, 5)} ${pad(f.colorFallbacks, 4)}  ${f.path}`);
    }
    const rest = report.fileReports.length - top.length;
    if (rest > 0) out.push(`  ... ${rest} more files with literals (--top 0 lists all)`);
    out.push("");
  }

  if (report.byDir.length > 1) {
    out.push("BY TOP-LEVEL DIRECTORY");
    for (const d of report.byDir) out.push(`  ${pad(d.hard, 6)} hard ${pad(d.soft, 6)} soft ${pad(d.files, 5)} files  ${d.dir}`);
    out.push("");
  }

  if (opts.hits) {
    out.push("HITS");
    for (const f of [...report.fileReports].sort((a, b) => a.path.localeCompare(b.path))) {
      for (const h of f.hits ?? []) out.push(`  ${f.path}:${h.line}  ${h.category}${h.def ? " (def)" : h.fallback ? " (fallback)" : ""}  ${h.value}`);
    }
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: bun scripts/scan-literals.ts <path> [<path>...] [options]

Counts hard-coded style literals (hex/rgb/hsl/oklch colors, Tailwind arbitrary
values, px font sizes, border-radius and font-family declarations) in
.css/.scss/.uss/.ts/.tsx/.js/.jsx/.html/.vue/.svelte/.astro files.

Options:
  --json                 print a JSON report
  --top <n>              files listed in the text report (default 15, 0 = all)
  --hits                 list every hit with file:line (JSON: per-file "hits")
  --exclude <pattern>    skip a directory or file name, or a root-relative glob
                         such as "src/legacy" or "**/*.stories.tsx" (repeatable)
  --ext <list>           replace the extension list (css,tsx) or add to it (+json)
  --include-tests        scan tests, stories and fixtures too
  --include-submodules   scan git submodule paths listed in .gitmodules
  --keep-comments        match inside comments too
  --fail-above <n>       exit 1 when the hard total exceeds n (CI ratchet)
  --verbose              list every skipped path and the reason on stderr
  -h, --help             show this help
`;

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    roots: [],
    json: false,
    top: 15,
    hits: false,
    excludes: [],
    exts: new Set(DEFAULT_EXTS),
    includeTests: false,
    includeSubmodules: false,
    keepComments: false,
    failAbove: null,
    verbose: false,
  };
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json": opts.json = true; break;
      case "--hits": opts.hits = true; break;
      case "--include-tests": opts.includeTests = true; break;
      case "--include-submodules": opts.includeSubmodules = true; break;
      case "--keep-comments": opts.keepComments = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--top": {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 0) throw new Error("--top needs a whole number");
        opts.top = n;
        break;
      }
      case "--fail-above": {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 0) throw new Error("--fail-above needs a whole number");
        opts.failAbove = n;
        break;
      }
      case "--exclude": opts.excludes.push(need(i++, a)); break;
      case "--ext": {
        const v = need(i++, a);
        const list = v.replace(/^\+/, "").split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
        for (const e of list) if (!KIND_BY_EXT[e]) throw new Error(`--ext: unsupported extension "${e}"`);
        if (!v.startsWith("+")) opts.exts = new Set();
        for (const e of list) opts.exts.add(e);
        break;
      }
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        opts.roots.push(a);
    }
  }
  if (!opts.roots.length) throw new Error("give at least one path to scan");
  for (const r of opts.roots) if (!existsSync(r)) throw new Error(`path not found: ${r}`);
  return opts;
}

function main() {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`scan-literals: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const report = scan(opts);
  if (skipLog) for (const s of skipLog) process.stderr.write(`skipped ${s.reason}: ${s.path}\n`);
  process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + "\n" : formatText(report, opts) + "\n");
  if (opts.failAbove !== null && report.totals.hard > opts.failAbove) {
    process.stderr.write(`scan-literals: ${report.totals.hard} hard-coded literals, limit ${opts.failAbove}\n`);
    process.exit(1);
  }
}

if (import.meta.main) main();
