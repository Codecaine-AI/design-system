/**
 * Write destinations for the rollout tools: one validator every tool calls before it creates or
 * changes anything (output dirs, report files, pack destinations, codemod targets).
 *
 *   canonicalPath(p)       realpath of the nearest existing ancestor, plus the part that does not exist yet
 *   isWithin(p, dir)       directory identity (device + inode) up the canonical path, so a case variant,
 *                          the firmlink spelling (/System/Volumes/Data/Users/...) or a symlink still counts
 *   safeOutputPath(p, o)   the canonical destination; refuses the owner's tree unless `root` is that tree
 *   safeAppId(id)          an app id that is safe as one path segment (the registry id pattern)
 *   safeSegment(name)      any other user-supplied path segment (set names, route ids)
 *
 * Only the owner's tree is refused. Writing into a checkout in the mirror (`pack --out <app>/vendor`)
 * is intended.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { OWNER_TREE } from "./owner";

export { OWNER_TREE };

export class UnsafePathError extends Error {
  override name = "UnsafePathError";
}

/** Registry app ids: lowercase letters, digits and hyphens, starting with a letter or digit. */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Other path segments a user names on the command line (snapshot sets, route ids). */
export const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The real path `path` names: realpath of its nearest existing ancestor, joined with the components
 * that do not exist yet. A dangling symlink on the way is followed to its target (a write through it
 * would land there). Throws on a symlink loop.
 */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (let hops = 0; ; hops++) {
    if (hops > 64) throw new UnsafePathError(`${path}: too many symlinks`);
    if (existsSync(current)) return rest.length ? join(realpathSync(current), ...rest.reverse()) : realpathSync(current);
    let link: string | undefined;
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
    } catch {
      // does not exist at all
    }
    if (link !== undefined) {
      current = resolve(dirname(current), link);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...rest.reverse());
    rest.push(basename(current));
    current = parent;
  }
}

function identity(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function lexicallyInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Whether `path` is `dir` or inside it. Compares directory identity (device and inode) of every
 * existing ancestor of the canonical path with `dir`, so the case-insensitive spelling, the firmlink
 * spelling and symlinked routes all count. Falls back to canonical paths when `dir` does not exist.
 */
export function isWithin(path: string, dir: string): boolean {
  const target = identity(dir);
  const canonical = canonicalPath(path);
  if (target === null) return lexicallyInside(canonical, canonicalPath(dir));
  for (let current = canonical; ; current = dirname(current)) {
    if (identity(current) === target) return true;
    if (dirname(current) === current) return false;
  }
}

/** Whether `a` and `b` name the same existing directory (or the same canonical path when missing). */
export function sameDir(a: string, b: string): boolean {
  const ia = identity(a);
  return ia !== null ? ia === identity(b) : canonicalPath(a) === canonicalPath(b);
}

export interface SafeOutputOptions {
  /** The run's --root. Writes inside the owner's tree are allowed only when root is that tree itself. */
  root?: string;
  /** Names the destination in errors ("--out-dir", "pack --out"). */
  label?: string;
  /** The owner's tree; tests pass a temp dir. Default OWNER_TREE. */
  ownerTree?: string;
}

/**
 * Validates a destination before anything is created there and returns its canonical path. Refuses
 * the owner's tree (directly, through a symlink, a case variant or the firmlink spelling) unless
 * `root` is the owner's tree itself.
 */
export function safeOutputPath(dest: string, opts: SafeOutputOptions = {}): string {
  const owner = opts.ownerTree ?? OWNER_TREE;
  const label = opts.label ?? "output path";
  if (!dest) throw new UnsafePathError(`${label} is empty`);
  const canonical = canonicalPath(dest);
  const ownerRun = opts.root !== undefined && sameDir(opts.root, owner);
  if (!ownerRun && isWithin(canonical, owner))
    throw new UnsafePathError(`${label} ${dest} resolves into the owner's tree (${canonical}); write into the mirror or a temp dir`);
  return canonical;
}

/** `id` when it is a registry app id; throws otherwise (so `<out>/<id>/...` can never climb out). */
export function safeAppId(id: string): string {
  if (typeof id !== "string" || !APP_ID_PATTERN.test(id)) throw new UnsafePathError(`app id ${JSON.stringify(id)} does not match ${APP_ID_PATTERN}`);
  return id;
}

/** `name` when it is safe as one path segment (no separators, no leading dot, no traversal). */
export function safeSegment(name: string, label = "name"): string {
  if (typeof name !== "string" || !SEGMENT_PATTERN.test(name)) throw new UnsafePathError(`${label} ${JSON.stringify(name)} does not match ${SEGMENT_PATTERN}`);
  return name;
}
