/**
 * Check 4, names: every design-system name the app uses exists in the current build,
 * and the app never redefines one.
 *
 * Files: the scan files plus the app's own stylesheets the entry loads. A copy of a
 * design-system file (its first 200 characters open with the package's header comment,
 * `/* @codecaine-ai/design-system …`) is the package's, not the app's: it is skipped.
 *
 * - CSS custom properties: every `--ds-*` name must be declared by the build's generated
 *   CSS (dist/**\/*.css, css/*.css). A name cut short by interpolation or concatenation
 *   (`--ds-color-${hue}-soft`, `"--ds-color-" + hue`) must be the prefix of a declared
 *   name; any other name, a trailing hyphen included, must match exactly.
 * - Declarations: apps never redefine `--ds-*` tokens. A declaration is a CSS property
 *   `--ds-x:` (CSS, SCSS, Less, HTML `<style>` and `style=""`, CSS in JS strings, a Tailwind
 *   arbitrary property `[--ds-x:…]`), `setProperty("--ds-x", …)`, and a style-object key
 *   `"--ds-x":` or `["--ds-x"]:`. A reference (`var(--ds-x)`, `cssVar("…")`) is fine.
 * - JS token paths: `cssVar("…")`/`cssVarName("…")` arguments, `flat.<group>["…"]` keys,
 *   `tokens.<group>.a.b` and `tokens["…"]` chains (also through the default export, a
 *   namespace or json/tokens.json) must exist in dist/json/tokens.json. The names come
 *   from @codecaine-ai/design-system (or its json/*.json) by a static import, a
 *   destructured or namespace `require(…)`, an `await import(…)`, or a local module that
 *   re-exports them (`export { cssVar as v } from …`, `export * from …`, an import it
 *   exports again), through chains of such modules (relative, root-absolute and tsconfig
 *   `paths` specifiers).
 * - String literals shaped like a token path (`"color.surface.page"`: typed `TokenPath`
 *   values) must exist, in every JS file of the app. In a file with no design-system
 *   binding only a near miss counts: its first two segments name a real token group
 *   (`"color.surface.nope"`), so an app's own keys (`"layout.radius"`) pass. A file name
 *   (`font.woff2`) is not a token path.
 * - `color.notion.*` (`--ds-color-notion-*`) is docs-system compat: only apps whose
 *   repo is codecaine/core/docs-system may use it.
 */

import { lexJs, stripCss, stripHtml } from "../../scan-literals";
import { resolvePath } from "../registry";
import type { TokenGroup } from "./design-system";
import { resolveModule } from "./modules";
import type { AppContext, CheckOutput, Finding } from "./types";
import { PACKAGE_NAME } from "./types";
import { fileKindOf, isInside, lineFinder, readText, realpathOrNull } from "./workspace";

export const NOTION_REPO = "codecaine/core/docs-system";
const NOTION_NAME = /^--ds-(?:(?:light|dark)-)?color-notion(?:-|$)/;
const NOTION_PATH = /^(?:(?:base|light|dark)\.)?color\.notion(?:\.|$)/;
const DS_NAME = /(?<![\w-])--ds-[A-Za-z0-9_-]*/g;
const PATH_STRING =
  /^(?:color|space|font|radius|shadow|motion|z|layout|line-height|letter-spacing|border|focus|blur)\.[A-Za-z0-9][\w.-]*$/;
const FILE_NAME =
  /\.(?:[cm]?[jt]sx?|css|s[ac]ss|less|json|md|mdx|html?|svg|png|jpe?g|webp|gif|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|webm|mov|pdf|txt|ya?ml|toml|csv|wasm|glb|gltf)$/i;
const GROUPS = new Set(["base", "light", "dark"]);
/** The header the package's own CSS files open with (loads.ts recognizes copies by it). */
const COPY_HEADER = /^\s*\/\*[\s*]*@codecaine-ai\/design-system\b/;
const JS_FILE = /\.(?:[mc]?[jt]sx?)$/i;
/** How many local modules a re-export chain may pass through. */
const MAX_CHAIN = 8;

// ---------------------------------------------------------------------------
// Declarations

/** A `--ds-*` name, interpolations included (`--ds-color-${hue}-solid`, `--ds-#{$x}`). */
const DECL_NAME = String.raw`--ds-[A-Za-z0-9_-]*(?:(?:\$\{|#\{|@\{)[^}\n]*\}[A-Za-z0-9_-]*)*`;
/** CSS property: `--ds-x:` (not `--ds-x::`). */
const DECL_CSS = new RegExp(String.raw`(?<![\w-])(${DECL_NAME})\s*:(?!:)`, "g");
/** `setProperty("--ds-x", …)`. */
const DECL_SET = new RegExp(String.raw`(?<![\w$])setProperty\s*\(\s*(["'\`])(${DECL_NAME})`, "g");
/** Style-object key after `{` or `,`: `"--ds-x":` (a ternary's `? "--ds-x" :` is not a key). */
const DECL_KEY = new RegExp(String.raw`([{,]\s*)(["'\`])(${DECL_NAME})\2\s*:`, "g");
/** Computed style-object key: `["--ds-x"]:`, `["--ds-x" as string]:`. */
const DECL_COMPUTED = new RegExp(String.raw`\[\s*(["'\`])(${DECL_NAME})\1\s*(?:as\s+[\w$.]+\s*)?\]\s*:`, "g");

/** Start offset and source text of every `--ds-*` declaration in a file's text. */
function declarations(text: string, inStr: Uint8Array | null): Array<{ index: number; name: string }> {
  const out: Array<{ index: number; name: string }> = [];
  const real = (quote: number) => !inStr || !inStr[quote];
  for (const m of text.matchAll(DECL_CSS)) out.push({ index: m.index!, name: m[1] });
  for (const m of text.matchAll(DECL_SET)) {
    const quote = m.index! + m[0].length - m[2].length - 1;
    if (real(quote)) out.push({ index: quote + 1, name: m[2] });
  }
  for (const m of text.matchAll(DECL_KEY)) {
    const quote = m.index! + m[1].length;
    if (real(quote)) out.push({ index: quote + 1, name: m[3] });
  }
  for (const m of text.matchAll(DECL_COMPUTED)) {
    const quote = m.index! + m[0].indexOf(m[1]);
    if (real(quote)) out.push({ index: quote + 1, name: m[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bindings: which local names reach the package's token API

type Binding =
  | { kind: "fn" | "tree" | "flat" }
  | { kind: "group"; group: TokenGroup }
  | { kind: "ns"; members: Members };
type Members = Map<string, Binding>;

const FN: Binding = { kind: "fn" };
const TREE: Binding = { kind: "tree" };
const FLAT: Binding = { kind: "flat" };
const PKG_MEMBERS: Members = new Map<string, Binding>([["cssVar", FN], ["cssVarName", FN], ["tokens", TREE], ["default", TREE], ["flat", FLAT]]);
const EMPTY: Members = new Map();

/** What a package specifier exports: the root, json/*.json, nothing for other subpaths. Undefined when the specifier is not the package. */
function packageMembers(spec: string): Members | undefined {
  if (spec === PACKAGE_NAME) return PKG_MEMBERS;
  if (!spec.startsWith(PACKAGE_NAME + "/")) return undefined;
  const json = spec.slice(PACKAGE_NAME.length + 1).match(/^json\/(tokens|base|light|dark)\.json$/);
  if (!json) return EMPTY; // CSS and other subpaths carry no JS token paths
  return new Map<string, Binding>([["default", json[1] === "tokens" ? TREE : { kind: "group", group: json[1] as TokenGroup }]]);
}

interface Bindings {
  fns: string[];
  trees: string[];
  flats: string[];
  groups: Array<{ name: string; group: TokenGroup }>;
}

/** A binding as the dotted names code reaches it by: `ds` of the package gives `ds.cssVar`, `ds.tokens`, … */
function flatten(name: string, b: Binding, out: Bindings, depth = 0): void {
  if (b.kind === "fn") out.fns.push(name);
  else if (b.kind === "tree") out.trees.push(name);
  else if (b.kind === "flat") out.flats.push(name);
  else if (b.kind === "group") out.groups.push({ name, group: b.group });
  else if (depth < 3) for (const [m, mb] of b.members) flatten(`${name}.${m}`, mb, out, depth + 1);
}

// The clause is limited to import-clause characters, so a match never spans an earlier import.
const IMPORT = /(?<![\w$.])import\s+(?!type\b)([\w$*{}\s,]*?)\s+from\s+(["'])([^"'\n]+)\2/g;
/** `const { a, b: c } = require("…")`, `const ns = await import("…")`. */
const REQUIRE_BIND =
  /(?<![\w$.])(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:require\s*\(|await\s+import\s*\()\s*(["'])([^"'\n]+)\2\s*\)/g;
const EXPORT_FROM = /(?<![\w$.])export\s+(?!type\b)(\*\s*as\s+[\w$]+|\*|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\2/g;
const EXPORT_LIST = /(?<![\w$.])export\s+(?!type\b)\{([^}]*)\}(?!\s*from\b)/g;
const EXPORT_DEFAULT = /(?<![\w$.])export\s+default\s+([A-Za-z_$][\w$]*)\s*(?=;|\n|$)/g;

/** `a`, `a as b`, `type a`: [imported or local name, exposed name]. */
function specifierParts(list: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of list.split(",")) {
    const pm = part.trim().replace(/^type\s+/, "").match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    if (pm) out.push([pm[1], pm[2] ?? pm[1]]);
  }
  return out;
}

/** Follows imports and re-exports through the app's local modules, for one app. */
function makeBinder(serveRoot: string, root: string) {
  const exportsCache = new Map<string, Members>();
  const pending = new Set<string>();

  /** What a specifier imported from `fromFile` exports, or null when it reaches nothing of the package. */
  const membersOf = (spec: string, fromFile: string, depth: number): Members | null => {
    const pkg = packageMembers(spec);
    if (pkg !== undefined) return pkg;
    if (depth >= MAX_CHAIN) return null;
    const hit = resolveModule(spec, fromFile, serveRoot, root);
    const real = hit ? realpathOrNull(hit) : null;
    if (!real || real.includes("/node_modules/") || !JS_FILE.test(real)) return null;
    const members = exportsOf(real, depth + 1);
    return members.size ? members : null;
  };

  /** Local names a module binds to the package: static imports, require and await import. */
  const localsOf = (file: string, text: string, inStr: Uint8Array, depth: number): Members => {
    const locals: Members = new Map();
    for (const m of text.matchAll(IMPORT)) {
      if (inStr[m.index!]) continue;
      const members = membersOf(m[3], file, depth);
      if (!members) continue;
      const clause = m[1].trim();
      const ns = clause.match(/\*\s*as\s+([\w$]+)/);
      if (ns) locals.set(ns[1], { kind: "ns", members });
      const def = clause.match(/^([\w$]+)\s*(?:,|$)/);
      if (def && members.has("default")) locals.set(def[1], members.get("default")!);
      const named = clause.match(/\{([^}]*)\}/);
      if (named) for (const [name, local] of specifierParts(named[1])) if (members.has(name)) locals.set(local, members.get(name)!);
    }
    for (const m of text.matchAll(REQUIRE_BIND)) {
      if (inStr[m.index!]) continue;
      const members = membersOf(m[3], file, depth);
      if (!members) continue;
      if (!m[1].startsWith("{")) {
        locals.set(m[1], { kind: "ns", members });
        continue;
      }
      for (const part of m[1].slice(1, -1).split(",")) {
        const pm = part.trim().match(/^([\w$]+)\s*(?::\s*([\w$]+))?\s*(?:=[\s\S]*)?$/);
        if (pm && members.has(pm[1])) locals.set(pm[2] ?? pm[1], members.get(pm[1])!);
      }
    }
    return locals;
  };

  /** What a local module exports of the package, through its re-exports. */
  const exportsOf = (file: string, depth: number): Members => {
    const cached = exportsCache.get(file);
    if (cached) return cached;
    if (pending.has(file)) return EMPTY; // a cycle of re-exports
    const src = readText(file);
    if (src === null || !/\bexport\b/.test(src)) return EMPTY;
    pending.add(file);
    const { text, inStr } = lexJs(src);
    const out: Members = new Map();
    for (const m of text.matchAll(EXPORT_FROM)) {
      if (inStr[m.index!]) continue;
      const members = membersOf(m[3], file, depth);
      if (!members) continue;
      const what = m[1];
      if (what === "*") {
        for (const [k, v] of members) if (k !== "default") out.set(k, v);
      } else if (what.startsWith("*")) {
        out.set(what.replace(/^\*\s*as\s+/, ""), { kind: "ns", members });
      } else {
        for (const [name, exposed] of specifierParts(what.slice(1, -1))) if (members.has(name)) out.set(exposed, members.get(name)!);
      }
    }
    // `export { a as b }` and `export default a` of names the module imported.
    const lists = [...text.matchAll(EXPORT_LIST)].filter((m) => !inStr[m.index!]);
    const defaults = [...text.matchAll(EXPORT_DEFAULT)].filter((m) => !inStr[m.index!]);
    if (lists.length || defaults.length) {
      const locals = localsOf(file, text, inStr, depth);
      for (const m of lists) for (const [local, exposed] of specifierParts(m[1])) if (locals.has(local)) out.set(exposed, locals.get(local)!);
      for (const m of defaults) if (locals.has(m[1])) out.set("default", locals.get(m[1])!);
    }
    pending.delete(file);
    exportsCache.set(file, out);
    return out;
  };

  return (file: string, text: string, inStr: Uint8Array): Bindings | null => {
    const b: Bindings = { fns: [], trees: [], flats: [], groups: [] };
    for (const [name, binding] of localsOf(file, text, inStr, 0)) flatten(name, binding, b);
    return b.fns.length || b.trees.length || b.flats.length || b.groups.length ? b : null;
  };
}

/** A dotted name as a regex: `ds.cssVar` matches `ds . cssVar`. */
const namePattern = (name: string) => name.split(".").map((s) => s.replace(/[$]/g, "\\$")).join("\\s*\\.\\s*");

/**
 * True when interpolation or concatenation follows a name that ends at `end`: `${` (template
 * literal), `#{` (SCSS), `@{` (Less), `{` (Svelte, Vue, JSX text), or a closing quote and then `+`.
 * Only then is the name a prefix; `var(--ds-color-surface-)` is a static reference to a missing name.
 */
function isInterpolated(text: string, end: number): boolean {
  const rest = text.slice(end, end + 64);
  return /^(?:\$\{|#\{|@\{|\{)/.test(rest) || /^["'`]\s*\+/.test(rest);
}

export function checkNames(ctx: AppContext): CheckOutput {
  const { app, ds } = ctx;
  const violations: Finding[] = [];
  const notionOk = app.repo === NOTION_REPO;
  const seen = new Set<string>();
  const add = (file: string, line: number, message: string) => {
    const key = `${file}:${line}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file, line, message });
  };
  const bindingsOf = makeBinder(resolvePath(ctx.root, app.run?.serveRoot ?? app.run?.cwd ?? app.root), ctx.root);

  // Files: the scan spec plus the app's own stylesheets the entry loads.
  const files = new Map<string, { rel: string; text: string; kind: string }>();
  for (const f of ctx.sources()) files.set(f.abs, { rel: f.rel, text: f.text, kind: f.kind });
  const graph = ctx.loads();
  for (const abs of graph.files) {
    if (files.has(abs) || !(isInside(abs, ctx.appRoot) || abs === graph.entry)) continue;
    const kind = fileKindOf(abs);
    const text = readText(abs);
    if (kind && text !== null) files.set(abs, { rel: ctx.rel(abs), text, kind });
  }

  const isPrefix = (name: string) => {
    for (const d of ds.definedNames) if (d.startsWith(name)) return true;
    return false;
  };

  for (const [abs, { rel, text: src, kind }] of files) {
    if (COPY_HEADER.test(src.slice(0, 200))) continue; // a copy of a design-system file
    const line = lineFinder(src);
    let text = src;
    let inStr: Uint8Array | null = null;
    if (kind === "js") ({ text, inStr } = lexJs(src));
    else if (kind === "html") text = stripHtml(src);
    else if (kind === "css" || kind === "scss") text = stripCss(src, kind === "scss");

    // Declarations: apps never redefine --ds-* tokens.
    const declared = new Set<number>();
    if (kind !== "json") {
      for (const d of declarations(text, inStr)) {
        declared.add(d.index);
        add(rel, line(d.index), `${d.name.slice(0, 80)} is declared here; apps never redefine --ds-* tokens`);
      }
    }

    // CSS custom property names.
    for (const m of text.matchAll(DS_NAME)) {
      if (declared.has(m.index!)) continue;
      const name = m[0];
      const partial = isInterpolated(text, m.index! + name.length);
      const ln = line(m.index!);
      if (!notionOk && NOTION_NAME.test(name)) {
        add(rel, ln, `${name} is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
        continue;
      }
      if (partial ? !isPrefix(name) : !ds.definedNames.has(name)) {
        add(rel, ln, partial ? `no design-system custom property starts with ${name}` : `${name} is not defined by the current build`);
      }
    }

    // JS token paths.
    if (kind !== "js" || !inStr) continue;
    const strs = inStr;
    const checked = new Set<number>();
    const b = bindingsOf(abs, text, strs);
    if (b) {
      const checkPath = (path: string, index: number, via: string) => {
        checked.add(index);
        if (!notionOk && NOTION_PATH.test(path)) add(rel, line(index), `token path "${path}" is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
        else if (!ds.paths.has(path)) add(rel, line(index), `token path "${path}" (${via}) does not exist in the current build`);
      };

      for (const fn of b.fns) {
        const re = new RegExp(`(?<![\\w$.])${namePattern(fn)}\\s*\\(\\s*(["'\`])([^"'\`$]*)\\1`, "g");
        for (const m of text.matchAll(re)) if (!strs[m.index!]) checkPath(m[2], m.index! + m[0].indexOf(m[1]) + 1, fn.replace(/^.*\./, ""));
      }

      for (const fl of b.flats) {
        const re = new RegExp(
          `(?<![\\w$.])${namePattern(fl)}\\s*(?:\\.\\s*(\\w+)|\\[\\s*["'](\\w+)["']\\s*\\])\\s*\\[\\s*(["'\`])([^"'\`$]+)\\3\\s*\\]`,
          "g",
        );
        for (const m of text.matchAll(re)) {
          if (strs[m.index!]) continue;
          const group = m[1] ?? m[2];
          const idx = m.index! + m[0].lastIndexOf(m[4]);
          checked.add(idx);
          if (!GROUPS.has(group)) add(rel, line(m.index!), `flat.${group} is not a token group (base, light, dark)`);
          else if (!notionOk && NOTION_PATH.test(m[4])) add(rel, line(m.index!), `token path "${m[4]}" is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
          else if (!ds.groups[group as TokenGroup].has(m[4])) add(rel, line(m.index!), `token path "${m[4]}" is not in flat.${group} of the current build`);
        }
      }
      for (const { name, group } of b.groups) {
        const re = new RegExp(`(?<![\\w$.])${namePattern(name)}\\s*\\[\\s*(["'\`])([^"'\`$]+)\\1\\s*\\]`, "g");
        for (const m of text.matchAll(re)) {
          if (strs[m.index!]) continue;
          checked.add(m.index! + m[0].indexOf(m[2]));
          if (!ds.groups[group].has(m[2])) add(rel, line(m.index!), `token path "${m[2]}" is not in json/${group}.json of the current build`);
        }
      }

      for (const t of b.trees) {
        const re = new RegExp(
          `(?<![\\w$.])${namePattern(t)}((?:\\s*\\.\\s*[A-Za-z_$][\\w$]*|\\s*\\[\\s*(?:"[^"]*"|'[^']*'|\\d+)\\s*\\])+)`,
          "g",
        );
        for (const m of text.matchAll(re)) {
          if (strs[m.index!]) continue;
          const segs = [...m[1].matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]/g)].map((s) => s[1] ?? s[2] ?? s[3] ?? s[4]);
          for (const s of m[1].matchAll(/\[\s*["']([^"']*)["']/g)) checked.add(m.index! + m[0].indexOf(s[1]));
          let node: any = ds.tree;
          const walked: string[] = [];
          for (const seg of segs) {
            if (node === null || typeof node !== "object") break; // a value: the rest is a property of the string
            if (!(seg in node)) {
              const shown = `tokens.${[...walked, seg].join(".")}`;
              add(rel, line(m.index!), `${shown} does not exist in the current build`);
              break;
            }
            walked.push(seg);
            node = node[seg];
            if (!notionOk && walked.length === 3 && walked[1] === "color" && walked[2] === "notion") {
              add(rel, line(m.index!), `tokens.${walked.join(".")} is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
              break;
            }
          }
        }
      }
    }

    // String literals shaped like token paths (typed TokenPath values), in every JS file.
    for (const m of src.matchAll(/(["'`])([A-Za-z][\w.-]*)\1/g)) {
      const start = m.index! + 1;
      if (!strs[start] || checked.has(start) || !PATH_STRING.test(m[2]) || FILE_NAME.test(m[2])) continue;
      // Without a design-system binding, only a near miss of a real path is one: `color.surface.nope`, not `layout.radius`.
      if (!b && !ds.prefixes.has(m[2].split(".").slice(0, 2).join("."))) continue;
      if (!notionOk && NOTION_PATH.test(m[2])) add(rel, line(start), `token path "${m[2]}" is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
      else if (!ds.prefixes.has(m[2])) add(rel, line(start), `token path "${m[2]}" does not exist in the current build`);
    }
  }
  return { violations, warnings: [] };
}
