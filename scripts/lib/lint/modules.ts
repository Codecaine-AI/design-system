/**
 * The module graph of an app: the local JS/TS modules its entry reaches through imports,
 * the way the bundler walks them. Markup in a file outside it is never rendered.
 *
 * Roots:
 * - the registry entry (`entryStylesheet`) when it is a JS/TS module or an HTML page;
 * - for a stylesheet entry, the app's index.html (in the web root, else the app root);
 * - for a Next.js app router entry (`app/layout.tsx`), every route special file under
 *   that `app/` folder: the router renders them without an import.
 * Edges: static `import`/`export … from` (not `import type`), dynamic `import("…")`,
 * `require("…")`, and an HTML page's `<script src>` and inline module scripts.
 * Specifiers: relative (a page's `src="app.js"` too), root-absolute (against the app's
 * web root) and tsconfig `paths` aliases (`@/…`, through `extends` and `references`).
 * Bare package specifiers are not followed: a package is not the app's own source.
 * Not followed: template-literal `import(`…${x}`)` and `import.meta.glob` patterns.
 *
 * `importBindings` reads which local names a module binds to each specifier (default,
 * named, namespace, `const X = lazy(() => import("…"))`) and what it re-exports; the
 * shell check uses it to tell a rendered component from one only imported.
 */

import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lexJs, stripHtml } from "../../scan-literals";
import { isDir, isFile, isInside, readText, realpathOrNull, withExtensions } from "./workspace";

export interface ModuleGraph {
  /** Real path of the registry entry; null when it is not set or does not exist. */
  entry: string | null;
  entryExists: boolean;
  /** Where the walk starts (real paths). Empty when no module entry is known. */
  roots: string[];
  /** Local import edges between real paths. */
  edges: Map<string, string[]>;
  /** Every module reachable from the roots, roots included. */
  reachable: Set<string>;
  /** Per module: each local specifier it imports (as written) and the real path it resolves to. */
  resolved: Map<string, Map<string, string>>;
}

const JS_FILE = /\.(?:[mc]?[jt]sx?)$/i;
const PAGE_FILE = /\.(?:html?|vue|svelte|astro)$/i;
const MAX_FILES = 20_000;
const NEXT_ROUTE_FILES = new Set([
  "page", "layout", "template", "loading", "error", "not-found", "global-error", "default", "forbidden", "unauthorized",
]);

const IMPORT_SPEC =
  /(?<![\w$.])(?:import|export)\s+(?!type\b)(?:[\w$*{}\s,]*?\s+from\s+)?(["'])([^"'\n]+)\1|(?<![\w$.])(?:import|require)\s*\(\s*(["'])([^"'\n]+)\3\s*\)/g;
const ATTR_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function jsSpecifiers(src: string): string[] {
  const { text, inStr } = lexJs(src);
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_SPEC)) if (!inStr[m.index!]) out.push(m[2] ?? m[4]);
  return out;
}

function pageSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of stripHtml(src).matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const a = m[1].match(ATTR_SRC);
    const v = a && (a[1] ?? a[2] ?? a[3]);
    if (v) out.push(v);
    else out.push(...jsSpecifiers(m[2]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// tsconfig `paths`

interface PathAliases {
  /** Directory the targets resolve against (baseUrl, else the directory of the config that sets paths). */
  base: string;
  paths: Record<string, string[]>;
}

/** JSON with comments and trailing commas, as tsconfig.json allows. */
export function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface ConfigOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsBase?: string;
}

const configCache = new Map<string, ConfigOptions | null>();
const aliasCache = new Map<string, PathAliases[]>();

/** Drops cached tsconfig lookups (lintApps calls clearCaches, which calls this). */
export function clearModuleCaches(): void {
  configCache.clear();
  aliasCache.clear();
}

function configFile(spec: string, fromDir: string): string | null {
  if (!spec.startsWith(".") && !isAbsolute(spec)) return null; // a package config (@tsconfig/...) sets no app paths
  const p = resolve(fromDir, spec);
  if (isFile(p)) return p;
  if (isFile(p + ".json")) return p + ".json";
  if (isDir(p) && isFile(join(p, "tsconfig.json"))) return join(p, "tsconfig.json");
  return null;
}

/** compilerOptions.baseUrl and paths of one config, with what it extends (child wins). */
function loadConfig(file: string, depth = 0): ConfigOptions | null {
  if (configCache.has(file)) return configCache.get(file)!;
  configCache.set(file, null); // cycle guard
  let json: any;
  try {
    json = parseJsonc(readText(file) ?? "");
  } catch {
    return null;
  }
  const dir = dirname(file);
  let merged: ConfigOptions = {};
  const parents = Array.isArray(json?.extends) ? json.extends : json?.extends ? [json.extends] : [];
  if (depth < 8) {
    for (const e of parents) {
      const parent = typeof e === "string" ? configFile(e, dir) : null;
      const opts = parent ? loadConfig(parent, depth + 1) : null;
      if (opts) merged = { ...merged, ...opts };
    }
  }
  const co = json?.compilerOptions ?? {};
  if (typeof co.baseUrl === "string") merged.baseUrl = resolve(dir, co.baseUrl);
  if (co.paths && typeof co.paths === "object") {
    merged.paths = co.paths;
    merged.pathsBase = dir;
  }
  configCache.set(file, merged);
  return merged;
}

/** The path aliases that apply to a file: its nearest tsconfig.json and the configs it references. */
function aliasesFor(fromFile: string, stop: string): PathAliases[] {
  let dir = dirname(fromFile);
  const visited: string[] = [];
  let found: PathAliases[] = [];
  for (;;) {
    if (aliasCache.has(dir)) {
      found = aliasCache.get(dir)!;
      break;
    }
    visited.push(dir);
    const file = join(dir, "tsconfig.json");
    if (isFile(file)) {
      const files = [file];
      try {
        for (const r of parseJsonc(readText(file) ?? "")?.references ?? []) {
          const f = typeof r?.path === "string" ? configFile(r.path, dir) : null;
          if (f) files.push(f);
        }
      } catch {
        // an unreadable config contributes no aliases
      }
      for (const f of files) {
        const o = loadConfig(f);
        if (o?.paths) found.push({ base: o.baseUrl ?? o.pathsBase ?? dirname(f), paths: o.paths });
      }
      break;
    }
    const up = dirname(dir);
    if (up === dir || dir === stop || !isInside(dir, stop)) break;
    dir = up;
  }
  for (const v of visited) aliasCache.set(v, found);
  return found;
}

// ---------------------------------------------------------------------------
// Resolution

/** A module file for a path: as written, with a JS/TS extension, as a folder index, or a `.js` import of a `.ts` source. */
function moduleFile(base: string): string | null {
  const direct = withExtensions(base);
  if (direct) return direct;
  const m = base.match(/^(.*)\.(m|c)?jsx?$/);
  if (m) for (const e of [".ts", ".tsx", ".mts", ".cts"]) if (isFile(m[1] + e)) return m[1] + e;
  return null;
}

/** A module specifier to a local file: relative, root-absolute (against `serveRoot`), or a tsconfig `paths` alias (lookups stop at `stop`). Null for bare packages. */
export function resolveModule(spec: string, fromFile: string, serveRoot: string, stop: string): string | null {
  const clean = spec.replace(/[?#].*$/, "");
  if (!clean || /^(?:[a-z]+:|\/\/)/i.test(clean)) return null;
  if (clean.startsWith(".")) return moduleFile(resolve(dirname(fromFile), clean));
  // A page's <script src="app.js"> is a URL relative to the page.
  if (PAGE_FILE.test(fromFile) && !clean.startsWith("/")) {
    const local = moduleFile(resolve(dirname(fromFile), clean));
    if (local) return local;
  }
  if (clean.startsWith("/")) return moduleFile(join(serveRoot, clean)) ?? moduleFile(clean);
  for (const { base, paths } of aliasesFor(fromFile, stop)) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf("*");
      let captured: string | null = null;
      if (star === -1) captured = clean === pattern ? "" : null;
      else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (clean.startsWith(pre) && clean.endsWith(post) && clean.length >= pre.length + post.length) {
          captured = clean.slice(pre.length, clean.length - post.length);
        }
      }
      if (captured === null) continue;
      for (const t of Array.isArray(targets) ? targets : []) {
        const hit = moduleFile(resolve(base, t.replace("*", captured)));
        if (hit) return hit;
      }
    }
  }
  return null;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) routeFiles(p, out);
    else if (JS_FILE.test(e.name) && NEXT_ROUTE_FILES.has(e.name.replace(/\.[^.]+$/, ""))) out.push(p);
  }
  return out;
}

export interface ModuleGraphOptions {
  /** The registry entry, absolute. */
  entry: string | null;
  /** The app's web root, where a root-absolute URL points. */
  serveRoot: string;
  /** The app package root. */
  appRoot: string;
  /** The workspace root: tsconfig lookups stop here. */
  root: string;
}

export function buildModuleGraph(opts: ModuleGraphOptions): ModuleGraph {
  const graph: ModuleGraph = { entry: null, entryExists: false, roots: [], edges: new Map(), reachable: new Set(), resolved: new Map() };
  const entry = opts.entry ? realpathOrNull(opts.entry) : null;
  if (!entry) return graph;
  graph.entry = entry;
  graph.entryExists = true;

  if (JS_FILE.test(entry) || PAGE_FILE.test(entry)) graph.roots.push(entry);
  else {
    for (const dir of [opts.serveRoot, opts.appRoot]) {
      const page = realpathOrNull(join(dir, "index.html"));
      if (page) {
        graph.roots.push(page);
        break;
      }
    }
  }
  if (/^layout\.[mc]?[jt]sx?$/.test(basename(entry)) && basename(dirname(entry)) === "app") {
    for (const f of routeFiles(dirname(entry))) {
      const real = realpathOrNull(f);
      if (real && !graph.roots.includes(real)) graph.roots.push(real);
    }
  }

  const queue = [...graph.roots];
  for (const r of queue) graph.reachable.add(r);
  while (queue.length && graph.reachable.size < MAX_FILES) {
    const file = queue.shift()!;
    const src = readText(file);
    if (src === null) continue;
    const specs = JS_FILE.test(file) ? jsSpecifiers(src) : PAGE_FILE.test(file) ? pageSpecifiers(src) : [];
    const targets: string[] = [];
    const resolved = new Map<string, string>();
    for (const spec of specs) {
      const hit = resolveModule(spec, file, opts.serveRoot, opts.root);
      const real = hit ? realpathOrNull(hit) : null;
      if (!real || real.includes("/node_modules/") || !(JS_FILE.test(real) || PAGE_FILE.test(real))) continue;
      targets.push(real);
      resolved.set(spec, real);
      if (!graph.reachable.has(real)) {
        graph.reachable.add(real);
        queue.push(real);
      }
    }
    graph.edges.set(file, targets);
    graph.resolved.set(file, resolved);
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Import bindings

/** One import (or re-export) statement of a module and the local names it binds. */
export interface ImportBinding {
  /** The specifier as written (a key of `ModuleGraph.resolved`). */
  spec: string;
  /** Offset of the statement in the source. */
  index: number;
  /** Local names and the export each binds: "default", a named export, or "*" for the whole module (namespace, lazy). Type-only names are left out. */
  names: Array<{ local: string; imported: string }>;
  /** Exports the module passes on from this specifier: "*" for `export * from`, else imported → exported pairs. */
  reexports?: "*" | Array<{ imported: string; exported: string }>;
  /** A router renders what this import loads (`lazy: () => import(…)` in a route, `component: () => import(…)`). */
  routed?: boolean;
}

const STATIC_IMPORT = /(?<![\w$.])import\s+(?!type\b)([\w$*{}\s,"']*?)\s*\bfrom\s*(["'])([^"'\n]+)\2|(?<![\w$.])import\s*(["'])([^"'\n]+)\4/g;
const REEXPORT = /(?<![\w$.])export\s+(?!type\b)(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\2/g;
const LOCAL_EXPORT = /(?<![\w$.])export\s*\{([^}]*)\}(?!\s*from\b)|(?<![\w$.])export\s+default\s+([\w$]+)\s*(?:;|$)/gm;
const LAZY_IMPORT =
  /(?<![\w$.])(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]*)?=\s*[\w$.]*\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:\{\s*return\s+)?(?:await\s+)?import\(\s*(["'])([^"'\n]+)\2/g;
const ROUTED_IMPORT = /(?<![\w$.])(?:lazy|component)\s*:\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:await\s+)?import\(\s*(["'])([^"'\n]+)\1/g;

/** `A`, `B as C`, `default as D`, `type E` (dropped), `"str" as F` in an import or export list. */
function listItems(list: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const raw of list.split(",")) {
    const t = raw.trim();
    if (!t || /^type\s/.test(t)) continue;
    const m = t.match(/^([\w$]+|"[^"]*"|'[^']*')(?:\s+as\s+([\w$]+|"[^"]*"|'[^']*'))?$/);
    if (!m) continue;
    const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
    out.push({ from: unquote(m[1]), to: unquote(m[2] ?? m[1]) });
  }
  return out;
}

/** The names an import clause binds: `X`, `* as ns`, `{ A, B as C }`, or a mix. */
function clauseNames(clause: string): ImportBinding["names"] {
  const names: ImportBinding["names"] = [];
  const brace = clause.match(/\{([^}]*)\}/);
  for (const part of clause.replace(/\{[^}]*\}/, "").split(",")) {
    const p = part.trim();
    const ns = p.match(/^\*\s*as\s+([\w$]+)$/);
    if (ns) names.push({ local: ns[1], imported: "*" });
    else if (/^[\w$]+$/.test(p)) names.push({ local: p, imported: "default" });
  }
  if (brace) for (const { from, to } of listItems(brace[1])) names.push({ local: to, imported: from });
  return names;
}

/** The import and re-export statements of a JS/TS source, with the names each binds (see ImportBinding). */
export function importBindings(src: string): ImportBinding[] {
  const { text, inStr } = lexJs(src);
  const out: ImportBinding[] = [];
  for (const m of text.matchAll(STATIC_IMPORT)) {
    if (inStr[m.index!]) continue;
    if (m[3] !== undefined) out.push({ spec: m[3], index: m.index!, names: clauseNames(m[1]) });
    else out.push({ spec: m[5], index: m.index!, names: [] });
  }
  for (const m of text.matchAll(REEXPORT)) {
    if (inStr[m.index!]) continue;
    const head = m[1];
    let reexports: ImportBinding["reexports"];
    if (head === "*") reexports = "*";
    else if (head.startsWith("*")) reexports = [{ imported: "*", exported: head.replace(/^\*\s*as\s+/, "") }];
    else reexports = listItems(head.slice(1, -1)).map(({ from, to }) => ({ imported: from, exported: to }));
    out.push({ spec: m[3], index: m.index!, names: [], reexports });
  }
  for (const m of text.matchAll(LAZY_IMPORT)) {
    if (!inStr[m.index!]) out.push({ spec: m[3], index: m.index!, names: [{ local: m[1], imported: "*" }] });
  }
  for (const m of text.matchAll(ROUTED_IMPORT)) {
    if (!inStr[m.index!]) out.push({ spec: m[2], index: m.index!, names: [], routed: true });
  }
  // `import { X } from "…"; export { X as Y }` and `export default X` pass an import on.
  const byLocal = new Map<string, { binding: ImportBinding; imported: string }>();
  for (const b of out) for (const n of b.names) byLocal.set(n.local, { binding: b, imported: n.imported });
  for (const m of text.matchAll(LOCAL_EXPORT)) {
    if (inStr[m.index!]) continue;
    const pairs = m[1] !== undefined ? listItems(m[1]) : [{ from: m[2], to: "default" }];
    for (const { from, to } of pairs) {
      const hit = byLocal.get(from);
      if (!hit) continue;
      const list = Array.isArray(hit.binding.reexports) ? hit.binding.reexports : [];
      if (hit.binding.reexports !== "*") hit.binding.reexports = [...list, { imported: hit.imported, exported: to }];
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** importBindings for any module: a JS/TS source, or the `<script>` blocks of a page (offsets into the page). */
export function moduleBindings(file: string, src: string): ImportBinding[] {
  if (!PAGE_FILE.test(file)) return importBindings(src);
  const out: ImportBinding[] = [];
  for (const m of src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const start = m.index! + m[1].length;
    for (const b of importBindings(m[2])) out.push({ ...b, index: b.index + start });
  }
  return out;
}

/** True for an HTML, Vue, Svelte or Astro page (a module graph node that is not JS/TS). */
export const isPageFile = (file: string) => PAGE_FILE.test(file);

/** Modules in the graph that import `file` directly. */
export function importersOf(graph: ModuleGraph, file: string): string[] {
  const out: string[] = [];
  for (const [from, targets] of graph.edges) if (targets.includes(file)) out.push(from);
  return out;
}

/**
 * What `file` renders into: the modules reachable from it. A script a page loads with
 * `<script src>` shares that page's DOM with the page's other scripts, so its subtree is
 * the page's (the page, every script it loads and their imports).
 */
export function subtreeOf(graph: ModuleGraph, file: string): Set<string> {
  for (const [from, targets] of graph.edges) {
    if (PAGE_FILE.test(from) && (from === file || targets.includes(file))) return reachableFrom(graph, from);
  }
  return reachableFrom(graph, file);
}

/** Modules reachable from `start` through the graph's edges, `start` included. */
export function reachableFrom(graph: ModuleGraph, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of graph.edges.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
