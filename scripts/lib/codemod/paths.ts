/**
 * Where the codemod may write. Tables go only under the output folder, never into the owner's
 * tree (the shared validator, scripts/lib/safe-paths.ts) or a git checkout (reports stay out of
 * checkouts); `apply` edits only files inside the root it was given, and never the owner's tree
 * unless `--root` names an owner root (OWNER_ROOTS), nor its private dirs (OWNER_PRIVATE).
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalPath, isOwnerRoot, isWithin, ownerPrivateDirs, OWNER_TREE, safeAppId, safeOutputPath, UnsafePathError } from "../safe-paths.ts";

/** The git checkout holding `path` (a directory with `.git`), or null. */
function gitCheckoutOf(path: string): string | null {
  for (let dir = canonicalPath(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The folder a propose run writes its tables into, `<outDir>/<app>/codemod`, canonical. Refuses an
 * app id that is not one safe path segment, the owner's tree and any git checkout.
 */
export function tableDir(outDir: string, app: string, ownerTree: string = OWNER_TREE): string {
  const dir = safeOutputPath(join(outDir, safeAppId(app), "codemod"), { label: "--out-dir", ownerTree });
  const checkout = gitCheckoutOf(dir);
  if (checkout) throw new UnsafePathError(`--out-dir ${outDir} is inside the git checkout ${checkout}: write tables outside any checkout`);
  return dir;
}

/**
 * The canonical root `apply` may edit. A root in the owner's tree is refused unless `--root` named
 * an owner root (OWNER_ROOTS) (the owner applying a table after the merge); a root read from the
 * table's own `root` field never reaches it.
 */
export function applyRoot(root: string, explicit: boolean, ownerTree: string = OWNER_TREE): string {
  if (!existsSync(root)) throw new UnsafePathError(`root ${root} does not exist`);
  const ownerRun = explicit && isOwnerRoot(root, ownerTree);
  const ownerRoot = join(ownerTree, "codebases");
  if (!ownerRun && isWithin(root, ownerTree)) {
    throw new UnsafePathError(
      explicit
        ? `--root ${root} is inside the owner's tree: only --root ${ownerRoot} itself applies there`
        : `the table's root ${root} is in the owner's tree: pass --root ${ownerRoot} to apply there`,
    );
  }
  return canonicalPath(root);
}

/** The canonical path of a table row's file under `root`, or why it may not be edited. */
export function targetIn(root: string, file: string, ownerTree: string = OWNER_TREE): { path: string } | { refused: string } {
  if (!file || isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return { refused: `${JSON.stringify(file)} is not a root-relative path` };
  if (file.split(/[\\/]/).includes("..")) return { refused: `${JSON.stringify(file)} climbs out of the root` };
  const abs = resolve(root, file);
  if (!existsSync(abs)) return { refused: `file not found under ${root}` };
  const real = canonicalPath(abs);
  if (!isWithin(real, root)) return { refused: `${JSON.stringify(file)} is a link out of the root (${real})` };
  if (!isOwnerRoot(root, ownerTree) && isWithin(real, ownerTree)) return { refused: `${JSON.stringify(file)} resolves into the owner's tree (${real})` };
  const priv = ownerPrivateDirs(ownerTree).find((dir) => isWithin(real, dir));
  if (priv) return { refused: `${JSON.stringify(file)} resolves into the owner's private dir ${priv} (${real})` };
  return { path: real };
}
