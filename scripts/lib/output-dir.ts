/**
 * The output dir of snapshot, verify:apps and progress: screenshots, sheets, results and reports.
 *
 *   toolOutputDir(dest, opts)   safeOutputPath (never the owner's tree), and never inside a git checkout
 *   gitCheckoutOf(path)         the working tree that holds `path` (a `.git` dir or file on the way up), or null
 *
 * Screenshots and reports never land in a checkout, where a commit or a `git clean` could pick them up
 * (TOOLING_CONTRACT.md "Places"). Nested destinations under the dir go through safeChildPath.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalPath, safeOutputPath, type SafeOutputOptions, UnsafePathError } from "./safe-paths";

/** The top of the git working tree that holds `path` (canonical), or null when no ancestor has a `.git`. */
export function gitCheckoutOf(path: string): string | null {
  for (let dir = canonicalPath(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** safeOutputPath, then refuses a destination inside any git checkout. Returns the canonical dir. */
export function toolOutputDir(dest: string, opts: SafeOutputOptions = {}): string {
  const dir = safeOutputPath(dest, opts);
  const checkout = gitCheckoutOf(dir);
  if (checkout !== null) {
    throw new UnsafePathError(`${opts.label ?? "output dir"} ${dest} is inside the git checkout ${checkout}; write outputs outside any checkout ($DS_RUN or a temp dir)`);
  }
  return dir;
}
