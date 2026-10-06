/**
 * The current design-system build the linter compares apps against: the checkout
 * the script runs from (DESIGN_SYSTEM_ROOT). Its generated CSS defines the valid
 * --ds-* names, dist/json/tokens.json the valid JS token paths, and
 * templates/react-app-shell the AppShell structure. A dist/ that differs from what
 * tokens/ builds today (build.ts staleFiles) is refused: the linter would compare
 * apps against names and hashes that are not current.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { staleFiles } from "../../build";
import { DESIGN_SYSTEM_ROOT } from "../registry";
import { lexJs } from "../../scan-literals";
import { isDir, isFile, toPosix } from "./workspace";

export type TokenGroup = "base" | "light" | "dark";

export interface DesignSystemBuild {
  dir: string;
  commit: string;
  dirty: boolean;
  tokensCssSha256: string;
  /** Every --ds-* custom property declared in the generated CSS (dist/**\/*.css) and css/*.css. */
  definedNames: Set<string>;
  /** Dotted token paths by group (base, light, dark), from dist/json/tokens.json. */
  groups: Record<TokenGroup, Set<string>>;
  /** Every leaf path in any group. */
  paths: Set<string>;
  /** Every leaf path and every ancestor of one ("color", "color.surface"). */
  prefixes: Set<string>;
  /** dist/json/tokens.json. */
  tree: Record<TokenGroup, any>;
  /** The AppShell template: its non-test files (relative to the AppShell folder) and the ds-* classes it renders. */
  template: { files: string[]; classes: Set<string> };
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** sha256 of a file, or null when it cannot be read. */
export function fileSha256(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  if (!isDir(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const DECLARED_NAME = /(?<![\w-])(--ds-[A-Za-z0-9_-]+)\s*:/g;

function git(dir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export const TEMPLATE_APPSHELL = "templates/react-app-shell/src/_components/AppShell";
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i;
/** A ds-* class in a string: not a CSS selector (.ds-x) and not a custom property (--ds-x). */
export const DS_CLASS = /(?<![\w.-])ds-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g;

/** ds-* class tokens inside the string literals of a JS/TS source. */
export function dsClassesInJs(src: string): Map<string, number> {
  const { text, inStr } = lexJs(src);
  const found = new Map<string, number>();
  for (const m of text.matchAll(DS_CLASS)) if (inStr[m.index!] && !found.has(m[0])) found.set(m[0], m.index!);
  return found;
}

export function loadDesignSystem(dir: string = DESIGN_SYSTEM_ROOT): DesignSystemBuild {
  const tokensCss = join(dir, "dist/css/tokens.css");
  const tokensSha = fileSha256(tokensCss);
  if (!tokensSha) throw new Error(`no build at ${tokensCss}: run \`bun run build\` in ${dir}`);
  // Names and hashes are compared against dist/, so dist/ must be what tokens/ builds today.
  const stale = staleFiles(dir);
  if (stale.length) {
    const shown = stale.slice(0, 5).join(", ") + (stale.length > 5 ? `, and ${stale.length - 5} more` : "");
    throw new Error(`the build in ${dir} is stale (${shown}): run \`bun run build\` there`);
  }

  const definedNames = new Set<string>();
  for (const f of [...walk(join(dir, "dist")), ...walk(join(dir, "css"))]) {
    if (!f.endsWith(".css")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(DECLARED_NAME)) definedNames.add(m[1]);
  }

  const tree = JSON.parse(readFileSync(join(dir, "dist/json/tokens.json"), "utf8")) as Record<TokenGroup, any>;
  const groups: Record<TokenGroup, Set<string>> = { base: new Set(), light: new Set(), dark: new Set() };
  const paths = new Set<string>();
  const prefixes = new Set<string>();
  const flatten = (node: any, path: string[], group: TokenGroup) => {
    if (node === null || typeof node !== "object") {
      const p = path.join(".");
      groups[group].add(p);
      paths.add(p);
      for (let i = 1; i <= path.length; i++) prefixes.add(path.slice(0, i).join("."));
      return;
    }
    for (const [k, v] of Object.entries(node)) flatten(v, [...path, k], group);
  };
  for (const g of ["base", "light", "dark"] as const) flatten(tree[g] ?? {}, [], g);

  const templateDir = join(dir, TEMPLATE_APPSHELL);
  const files: string[] = [];
  const classes = new Set<string>();
  for (const f of walk(templateDir)) {
    const rel = toPosix(relative(templateDir, f));
    if (TEST_FILE.test(rel)) continue;
    files.push(rel);
    if (/\.[jt]sx?$/.test(f)) for (const c of dsClassesInJs(readFileSync(f, "utf8")).keys()) classes.add(c);
  }
  files.sort();

  const status = git(dir, ["status", "--porcelain"]);
  return {
    dir,
    commit: git(dir, ["rev-parse", "HEAD"]) ?? "unknown",
    dirty: status === null ? false : status.length > 0,
    tokensCssSha256: tokensSha,
    definedNames,
    groups,
    paths,
    prefixes,
    tree,
    template: { files, classes },
  };
}

/** Generated file of the build, by package-relative path; null when the build does not have it yet. */
export function buildFile(ds: DesignSystemBuild, rel: string): string | null {
  const p = join(ds.dir, rel);
  return isFile(p) ? p : null;
}
