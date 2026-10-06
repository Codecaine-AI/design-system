/**
 * Check 4, names: every design-system name the app uses exists in the current build.
 *
 * - CSS custom properties: every `--ds-*` name in the scan files and in the app's
 *   own stylesheets the entry loads must be declared by the build's generated CSS
 *   (dist/**\/*.css, css/*.css). A name cut short by interpolation or concatenation
 *   (`--ds-color-${hue}-soft`, `"--ds-color-" + hue`) must be the prefix of a declared
 *   name; any other name, a trailing hyphen included, must match exactly.
 * - JS token paths, in files that import @codecaine-ai/design-system (or its
 *   json/*.json): `cssVar("…")`/`cssVarName("…")` arguments, `flat.<group>["…"]`
 *   keys, `tokens.<group>.a.b` and `tokens["…"]` chains (also through the default
 *   export, a namespace import or json/tokens.json), and string literals shaped like a
 *   token path (`"color.surface.page"`: typed `TokenPath` values) must exist in
 *   dist/json/tokens.json.
 * - `color.notion.*` (`--ds-color-notion-*`) is docs-system compat: only apps whose
 *   repo is codecaine/core/docs-system may use it.
 */

import { lexJs, stripCss, stripHtml } from "../../scan-literals";
import type { TokenGroup } from "./design-system";
import type { AppContext, CheckOutput, Finding } from "./types";
import { PACKAGE_NAME } from "./types";
import { fileKindOf, isInside, lineFinder, readText } from "./workspace";

export const NOTION_REPO = "codecaine/core/docs-system";
const NOTION_NAME = /^--ds-(?:(?:light|dark)-)?color-notion(?:-|$)/;
const NOTION_PATH = /^(?:(?:base|light|dark)\.)?color\.notion(?:\.|$)/;
const DS_NAME = /(?<![\w-])--ds-[A-Za-z0-9_-]*/g;
const PATH_STRING =
  /^(?:color|space|font|radius|shadow|motion|z|layout|line-height|letter-spacing|border|focus|blur)\.[A-Za-z0-9][\w.-]*$/;
const FILE_NAME = /\.(?:[cm]?[jt]sx?|css|json|md|html?|svg|png|jpe?g|webp)$/;
const GROUPS = new Set(["base", "light", "dark"]);

interface Bindings {
  fns: string[];
  trees: string[];
  flats: string[];
  groups: Array<{ name: string; group: TokenGroup }>;
  namespaces: string[];
}

const esc = (s: string) => s.replace(/[$]/g, "\\$");

function parseBindings(text: string, inStr: Uint8Array): Bindings | null {
  const b: Bindings = { fns: [], trees: [], flats: [], groups: [], namespaces: [] };
  let any = false;
  // The clause is limited to import-clause characters, so a match never spans an earlier import.
  const re = /(?<![\w$.])import\s+(?!type\b)([\w$*{}\s,]*?)\s+from\s+(["'])(@codecaine-ai\/design-system(?:\/[^"']*)?)\2/g;
  for (const m of text.matchAll(re)) {
    if (inStr[m.index!]) continue;
    const clause = m[1].trim();
    const sub = m[3].slice(PACKAGE_NAME.length).replace(/^\//, "");
    const json = sub.match(/^json\/(tokens|base|light|dark)\.json$/);
    if (sub && !json) continue; // CSS and other subpaths carry no JS token paths
    any = true;
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) b.namespaces.push(ns[1]);
    const def = clause.match(/^([\w$]+)\s*(?:,|$)/);
    if (def) {
      if (!json || json[1] === "tokens") b.trees.push(def[1]);
      else b.groups.push({ name: def[1], group: json[1] as TokenGroup });
    }
    const named = clause.match(/\{([^}]*)\}/);
    if (named && !json) {
      for (const part of named[1].split(",")) {
        const pm = part.trim().replace(/^type\s+/, "").match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!pm) continue;
        const local = pm[2] ?? pm[1];
        if (pm[1] === "cssVar" || pm[1] === "cssVarName") b.fns.push(local);
        else if (pm[1] === "tokens" || pm[1] === "default") b.trees.push(local);
        else if (pm[1] === "flat") b.flats.push(local);
      }
    }
  }
  return any ? b : null;
}

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

  for (const { rel, text: src, kind } of files.values()) {
    const line = lineFinder(src);
    let text = src;
    let inStr: Uint8Array | null = null;
    if (kind === "js") ({ text, inStr } = lexJs(src));
    else if (kind === "html") text = stripHtml(src);
    else if (kind === "css" || kind === "scss") text = stripCss(src, kind === "scss");

    // CSS custom property names.
    for (const m of text.matchAll(DS_NAME)) {
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
    const b = parseBindings(text, inStr);
    if (!b) continue;
    const checked = new Set<number>();
    const checkPath = (path: string, index: number, via: string) => {
      checked.add(index);
      if (!notionOk && NOTION_PATH.test(path)) add(rel, line(index), `token path "${path}" is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
      else if (!ds.paths.has(path)) add(rel, line(index), `token path "${path}" (${via}) does not exist in the current build`);
    };

    const fnNames = [...b.fns, ...b.namespaces.flatMap((n) => [`${n}.cssVar`, `${n}.cssVarName`])];
    for (const fn of fnNames) {
      const re = new RegExp(`(?<![\\w$.])${esc(fn).replace(".", "\\s*\\.\\s*")}\\s*\\(\\s*(["'\`])([^"'\`$]*)\\1`, "g");
      for (const m of text.matchAll(re)) if (!inStr[m.index!]) checkPath(m[2], m.index! + m[0].indexOf(m[1]) + 1, fn.replace(/^.*\./, ""));
    }

    const flatNames = [...b.flats, ...b.namespaces.map((n) => `${n}.flat`)];
    for (const fl of flatNames) {
      const re = new RegExp(
        `(?<![\\w$.])${esc(fl).replace(".", "\\s*\\.\\s*")}\\s*(?:\\.\\s*(\\w+)|\\[\\s*["'](\\w+)["']\\s*\\])\\s*\\[\\s*(["'\`])([^"'\`$]+)\\3\\s*\\]`,
        "g",
      );
      for (const m of text.matchAll(re)) {
        if (inStr[m.index!]) continue;
        const group = m[1] ?? m[2];
        const idx = m.index! + m[0].lastIndexOf(m[4]);
        checked.add(idx);
        if (!GROUPS.has(group)) add(rel, line(m.index!), `flat.${group} is not a token group (base, light, dark)`);
        else if (!notionOk && NOTION_PATH.test(m[4])) add(rel, line(m.index!), `token path "${m[4]}" is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
        else if (!ds.groups[group as TokenGroup].has(m[4])) add(rel, line(m.index!), `token path "${m[4]}" is not in flat.${group} of the current build`);
      }
    }
    for (const { name, group } of b.groups) {
      const re = new RegExp(`(?<![\\w$.])${esc(name)}\\s*\\[\\s*(["'\`])([^"'\`$]+)\\1\\s*\\]`, "g");
      for (const m of text.matchAll(re)) {
        if (inStr[m.index!]) continue;
        checked.add(m.index! + m[0].indexOf(m[2]));
        if (!ds.groups[group].has(m[2])) add(rel, line(m.index!), `token path "${m[2]}" is not in json/${group}.json of the current build`);
      }
    }

    const treeNames = [...b.trees, ...b.namespaces.flatMap((n) => [`${n}.tokens`, `${n}.default`])];
    for (const t of treeNames) {
      const re = new RegExp(
        `(?<![\\w$.])${esc(t).replace(".", "\\s*\\.\\s*")}((?:\\s*\\.\\s*[A-Za-z_$][\\w$]*|\\s*\\[\\s*(?:"[^"]*"|'[^']*'|\\d+)\\s*\\])+)`,
        "g",
      );
      for (const m of text.matchAll(re)) {
        if (inStr[m.index!]) continue;
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

    // String literals shaped like token paths (typed TokenPath values).
    for (const m of src.matchAll(/(["'`])([A-Za-z][\w.-]*)\1/g)) {
      const start = m.index! + 1;
      if (!inStr[start] || checked.has(start) || !PATH_STRING.test(m[2]) || FILE_NAME.test(m[2])) continue;
      if (!notionOk && NOTION_PATH.test(m[2])) add(rel, line(start), `token path "${m[2]}" is docs-system compat (color.notion.*); only ${NOTION_REPO} may use it`);
      else if (!ds.prefixes.has(m[2])) add(rel, line(start), `token path "${m[2]}" does not exist in the current build`);
    }
  }
  return { violations, warnings: [] };
}
