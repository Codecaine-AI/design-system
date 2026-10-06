/**
 * The design-system package as a fixture page's host loads it: resolved from the app's own directory the
 * way the app imports `@codecaine-ai/design-system/...`, and copied into the fixture's site with the
 * package's own layout, so fonts.css's `../fonts/<file>` urls resolve to the package's font files (byte
 * copies; verify:apps' font check accepts them because the winning @font-face rule sits in a byte copy of
 * the package's fonts.css). Nothing from text-measure: decision 20, fonts come from the design-system
 * package only.
 */
import { copyFileSync, cpSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ensureTmpDir } from "./fixture-server";

/** The real directory of the design-system package that `fromDir` resolves (bun's resolution). Throws when it resolves none. */
export function resolvedPackage(fromDir: string): string {
  let manifest: string;
  try {
    manifest = Bun.resolveSync("@codecaine-ai/design-system/package.json", fromDir);
  } catch (error) {
    throw new Error(`${fromDir} resolves no @codecaine-ai/design-system (${String(error).split("\n")[0]}); install the workspace first`);
  }
  return realpathSync(dirname(manifest));
}

/** Package files a host page links, package-relative, in load order: fonts.css, then tokens.css. */
export const HOST_STYLESHEETS = ["css/fonts.css", "dist/css/tokens.css"] as const;

/**
 * Copies `files` (package-relative) and the package's fonts/ into `<site>/<prefix>/` under `tmp`, keeping
 * the package layout. Returns the site-relative hrefs of `files`, in order.
 */
export function copyPackageFiles(pkg: string, site: string, prefix: string, tmp: string, files: readonly string[] = HOST_STYLESHEETS): string[] {
  const base = ensureTmpDir(tmp, join(site, prefix));
  for (const rel of files) {
    const from = join(pkg, rel);
    if (!existsSync(from)) throw new Error(`the design-system package at ${pkg} has no ${rel}`);
    ensureTmpDir(tmp, dirname(join(base, rel)));
    copyFileSync(from, join(base, rel));
  }
  if (!existsSync(join(pkg, "fonts"))) throw new Error(`the design-system package at ${pkg} has no fonts/`);
  cpSync(join(pkg, "fonts"), ensureTmpDir(tmp, join(base, "fonts")), { recursive: true });
  return files.map((rel) => `${prefix}/${rel}`);
}

/** What a host serves under its package prefix: package.json and the folders the package's exports reach. */
export const PACKAGE_SERVED = ["package.json", "css", "fonts", "dist"] as const;

/**
 * Copies the package's served files (PACKAGE_SERVED) into `<site>/<prefix>/` under `tmp`, in the package
 * layout, so `/<prefix>/<package path>` answers with the package's own bytes. Dotfiles and symlinks are
 * skipped (no `.env`, nothing from outside the package). Returns the copy's root.
 */
export function copyPackageTree(pkg: string, site: string, prefix: string, tmp: string): string {
  const base = ensureTmpDir(tmp, join(site, prefix));
  for (const rel of PACKAGE_SERVED) {
    const from = join(pkg, rel);
    if (!existsSync(from)) throw new Error(`the design-system package at ${pkg} has no ${rel}`);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`the design-system package at ${pkg}: ${rel} is a symlink`);
    cpSync(from, join(base, rel), { recursive: true, filter: (path) => path === from || (!basename(path).startsWith(".") && !lstatSync(path).isSymbolicLink()) });
  }
  return base;
}
