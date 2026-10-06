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

function resolveModule(spec: string, fromFile: string, serveRoot: string, stop: string): string | null {
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
  const graph: ModuleGraph = { entry: null, entryExists: false, roots: [], edges: new Map(), reachable: new Set() };
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
    for (const spec of specs) {
      const hit = resolveModule(spec, file, opts.serveRoot, opts.root);
      const real = hit ? realpathOrNull(hit) : null;
      if (!real || real.includes("/node_modules/") || !(JS_FILE.test(real) || PAGE_FILE.test(real))) continue;
      targets.push(real);
      if (!graph.reachable.has(real)) {
        graph.reachable.add(real);
        queue.push(real);
      }
    }
    graph.edges.set(file, targets);
  }
  return graph;
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
