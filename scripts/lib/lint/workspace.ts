/**
 * File-system helpers the checks share: workspace paths, the scan spec's source
 * files, the scan-literals run, and Node-style package resolution with real paths.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AppEntry } from "../registry";
import { resolvePath } from "../registry";
import { collectFiles, parseArgs, scan, type FileKind, type Options, type Report, type SkipStats } from "../../scan-literals";

// ---------------------------------------------------------------------------
// Paths

export const toPosix = (p: string) => p.split(sep).join("/");

export function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `child` is `parent` or below it. Both should be real paths. */
export function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const textCache = new Map<string, string | null>();
const pkgCache = new Map<string, { dir: string; name: string } | null>();

/** Drops cached file text and package lookups. lintApps calls it at the start of every run. */
export function clearCaches(): void {
  textCache.clear();
  pkgCache.clear();
}

/** File text, cached for one lint run. Null when unreadable. */
export function readText(p: string): string | null {
  if (!textCache.has(p)) {
    try {
      textCache.set(p, readFileSync(p, "utf8"));
    } catch {
      textCache.set(p, null);
    }
  }
  return textCache.get(p)!;
}

export function readJson(p: string): any | null {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** 1-based line of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** A fast offset-to-line function for one text (binary search over line starts). */
export function lineFinder(text: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 1-based line of the first occurrence of `needle`, or 1. */
export function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : lineAt(text, i);
}

// ---------------------------------------------------------------------------
// Scan spec: source files and literal scan

const KIND_BY_EXT: Record<string, FileKind> = {
  css: "css", uss: "css",
  scss: "scss", sass: "scss", less: "scss",
  ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js",
  html: "html", htm: "html", vue: "html", svelte: "html", astro: "html", md: "html", mdx: "html",
  json: "json", jsonc: "json",
};

export function fileKindOf(path: string): FileKind | null {
  return KIND_BY_EXT[extname(path).slice(1).toLowerCase()] ?? null;
}

// The same skips scan-literals' scan() applies after collectFiles(): size, bundles, generated headers.
const MAX_BYTES = 2 * 1024 * 1024;
const MINIFIED_MIN_BYTES = 100 * 1024;
const MAX_AVG_LINE = 300;
const GENERATED_HEADER = /@generated|do not edit|auto-?generated|this file (?:is|was) generated/i;

export interface SourceFile {
  abs: string;
  /** Workspace-relative posix path. */
  rel: string;
  ext: string;
  kind: FileKind;
  text: string;
}

export interface ScanSetup {
  /** scan-literals options for the existing scan paths; null when none exists or the spec is invalid. */
  opts: Options | null;
  /** Scan paths that do not exist under the root, workspace-relative. */
  missing: string[];
  error?: string;
}

/** The scan spec as scan-literals options, built through its own argument parser so the counts match the CLI the audit used. */
export function scanSetup(app: AppEntry, root: string): ScanSetup {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const p of app.scan?.paths ?? []) {
    const abs = resolvePath(root, p);
    if (existsSync(abs)) existing.push(abs);
    else missing.push(p);
  }
  if (!existing.length) return { opts: null, missing, error: app.scan?.paths?.length ? undefined : "apps.json gives no scan paths" };
  const argv = [...existing];
  for (const e of app.scan.exclude ?? []) argv.push("--exclude", e);
  if (app.scan.ext) argv.push("--ext", app.scan.ext);
  try {
    return { opts: parseArgs(argv), missing };
  } catch (err) {
    return { opts: null, missing, error: `scan spec: ${(err as Error).message}` };
  }
}

const emptySkips = (): SkipStats => ({
  dirs: 0, dotDirs: 0, submodules: 0, symlinks: 0, tests: 0, generated: 0, tooLarge: 0, excluded: 0, unreadable: 0,
});

/** Source files of the scan spec: scan-literals' selection (no tests, vendored, generated or oversized files). */
export function collectSources(setup: ScanSetup, rel: (abs: string) => string): SourceFile[] {
  if (!setup.opts) return [];
  const seen = new Set<string>();
  const out: SourceFile[] = [];
  for (const r of setup.opts.roots) {
    for (const abs of collectFiles(r, setup.opts, emptySkips())) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      const kind = fileKindOf(abs);
      if (!kind) continue;
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_BYTES) continue;
      const text = readText(abs);
      if (text === null) continue;
      const lines = text.split("\n").length;
      if ((size > MINIFIED_MIN_BYTES && text.length / lines > MAX_AVG_LINE) || GENERATED_HEADER.test(text.slice(0, 500))) continue;
      out.push({ abs, rel: rel(abs), ext: extname(abs).slice(1).toLowerCase(), kind, text });
    }
  }
  return out;
}

export interface LiteralScan {
  setup: ScanSetup;
  report: Report | null;
  /** Absolute path of each fileReport, in report order. */
  absPaths: string[];
}

/** scan-literals' common base directory of its roots (report paths are relative to it). */
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

export function runLiteralScan(setup: ScanSetup): LiteralScan {
  if (!setup.opts) return { setup, report: null, absPaths: [] };
  const opts: Options = { ...setup.opts, hits: true, json: true };
  const report = scan(opts);
  const base = commonDir(report.roots.map((r) => (isFile(r) ? dirname(r) : r)));
  const absPaths = report.fileReports.map((f) => {
    if (report.roots.length === 1 && isFile(report.roots[0]) && f.path === basename(report.roots[0])) return report.roots[0];
    return join(base, f.path);
  });
  return { setup, report, absPaths };
}

// ---------------------------------------------------------------------------
// Package resolution

/** Splits a bare specifier into package name and subpath ("" for the package root). Null for relative or absolute specifiers. */
export function splitSpecifier(spec: string): { name: string; subpath: string } | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || /^[a-z]+:/i.test(spec)) return null;
  const parts = spec.replace(/^~/, "").split("/");
  const n = parts[0].startsWith("@") ? 2 : 1;
  if (parts.length < n) return null;
  return { name: parts.slice(0, n).join("/"), subpath: parts.slice(n).join("/") };
}

/** The `node_modules/<name>` directory Node would find from `fromDir`, walking up. Not a real path. */
export function findPackageDir(name: string, fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const CONDITIONS = ["style", "import", "module", "browser", "default", "require", "node"];

function pickTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = pickTarget(v);
      if (t) return t;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const c of CONDITIONS) if (c in (value as Record<string, unknown>)) {
      const t = pickTarget((value as Record<string, unknown>)[c]);
      if (t) return t;
    }
  }
  return null;
}

/** A package subpath ("tokens.css", "" for the root) to a file, through `exports` (style condition first), else directly. */
export function resolveExport(pkgDir: string, subpath: string): string | null {
  const pkg = readJson(join(pkgDir, "package.json")) ?? {};
  const key = subpath ? `./${subpath}` : ".";
  const exp = pkg.exports;
  let target: string | null = null;
  if (typeof exp === "string" || Array.isArray(exp)) target = key === "." ? pickTarget(exp) : null;
  else if (exp && typeof exp === "object") {
    const keys = Object.keys(exp);
    if (keys.length && !keys[0].startsWith(".")) target = key === "." ? pickTarget(exp) : null;
    else if (key in exp) target = pickTarget(exp[key]);
    else {
      for (const k of keys) {
        const star = k.indexOf("*");
        if (star === -1) continue;
        const pre = k.slice(0, star);
        const post = k.slice(star + 1);
        if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
          const mid = key.slice(pre.length, key.length - post.length);
          const t = pickTarget(exp[k]);
          if (t) target = t.replace("*", mid);
          break;
        }
      }
    }
  }
  if (target) {
    const p = join(pkgDir, target);
    if (existsSync(p)) return p;
  }
  if (!subpath) {
    for (const m of [pkg.module, pkg.main, "index.js"]) if (typeof m === "string" && isFile(join(pkgDir, m))) return join(pkgDir, m);
    return null;
  }
  const direct = join(pkgDir, subpath);
  return isFile(direct) ? direct : null;
}

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];

function withExtensions(base: string): string | null {
  if (isFile(base)) return base;
  for (const e of JS_EXTS) if (isFile(base + e)) return base + e;
  if (isDir(base)) for (const e of JS_EXTS) if (isFile(join(base, "index" + e))) return join(base, "index" + e);
  return null;
}

/**
 * Resolves an import specifier from a file. Relative specifiers resolve against the importing
 * file; root-absolute ones ("/src/main.tsx" from an HTML page) against `serveRoot`, the app's web
 * root (an absolute file-system path when nothing is there); bare ones through node_modules.
 * `relativeFirst` (HTML and CSS references) tries a bare-looking path against the file first.
 */
export function resolveSpecifier(spec: string, fromFile: string, relativeFirst = false, serveRoot?: string): string | null {
  const clean = spec.replace(/[?#].*$/, "");
  if (!clean || /^(?:https?:|data:|\/\/)/i.test(clean)) return null;
  if (clean.startsWith(".")) return withExtensions(resolve(dirname(fromFile), clean));
  // HTML href/src and CSS @import are URLs: "src/main.tsx" is document-relative before it is a package.
  if (relativeFirst && !clean.startsWith("/")) {
    const local = withExtensions(resolve(dirname(fromFile), clean));
    if (local) return local;
  }
  if (clean.startsWith("/")) return (serveRoot ? withExtensions(join(serveRoot, clean)) : null) ?? withExtensions(clean);
  const parsed = splitSpecifier(clean);
  if (!parsed) return null;
  const pkgDir = findPackageDir(parsed.name, dirname(fromFile));
  return pkgDir ? resolveExport(pkgDir, parsed.subpath) : null;
}

/** Nearest package.json above a file: its directory and package name. */
export function owningPackage(file: string): { dir: string; name: string } | null {
  let dir = dirname(file);
  const visited: string[] = [];
  let found: { dir: string; name: string } | null = null;
  for (;;) {
    if (pkgCache.has(dir)) {
      found = pkgCache.get(dir)!;
      break;
    }
    visited.push(dir);
    const pj = join(dir, "package.json");
    if (isFile(pj)) {
      const name = readJson(pj)?.name;
      found = { dir, name: typeof name === "string" ? name : "" };
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const v of visited) pkgCache.set(v, found);
  return found;
}
