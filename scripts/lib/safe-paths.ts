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
 *   safeChildPath(b, ...s) a nested destination under a validated base: every segment safe, no symlinked
 *                          component on the way, never the owner's tree (for every nested output write)
 *   safeTempBase()         os.tmpdir(), canonical and validated, for mkdtemp callers (TMPDIR is inherited)
 *
 * Only the owner's tree is refused. Writing into a checkout in the mirror (`pack --out <app>/vendor`)
 * is intended.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { HOME_FORBIDDEN, OWNER_TREE } from "./owner";

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

export interface SafeChildBase {
  /** The output dir the nested path lives under (validated with safeOutputPath here). */
  base: string;
  /** The run's --root (as for safeOutputPath: the owner's tree is allowed only when root is that tree). */
  root?: string;
  /** The owner's tree; tests pass a temp dir. Default OWNER_TREE. */
  ownerTree?: string;
  /** Names the destination in errors. */
  label?: string;
}

/**
 * The destination `<base>/<segment>/.../<segment>` for a nested output write (snapshot shots, verify
 * results, logs). `base` is validated like safeOutputPath; each segment must pass safeSegment (no
 * separators, no traversal, no leading dot); every component that already exists on the way must be a
 * real directory, never a symlink (lstat, so a link planted after the base was validated is refused, the
 * way O_NOFOLLOW would), and the last one may be a regular file but never a symlink. The result is
 * refused when it lands in the owner's tree. Returns the path; the caller creates it.
 */
export function safeChildPath(base: string | SafeChildBase, ...segments: string[]): string {
  const opts: SafeChildBase = typeof base === "string" ? { base } : base;
  const label = opts.label ?? "output path";
  const owner = opts.ownerTree ?? OWNER_TREE;
  if (segments.length === 0) throw new UnsafePathError(`${label}: no path segments under ${opts.base}`);
  const root = safeOutputPath(opts.base, { root: opts.root, ownerTree: owner, label });
  for (const segment of segments) safeSegment(segment, `${label} segment`);
  let current = root;
  const kind = (path: string) => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
    } catch {
      return "missing";
    }
  };
  if (kind(root) === "link") throw new UnsafePathError(`${label}: ${root} is a symlink`);
  if (kind(root) === "file") throw new UnsafePathError(`${label}: ${root} is not a directory`);
  let missing = kind(root) === "missing";
  segments.forEach((segment, i) => {
    current = join(current, segment);
    if (missing) return;
    const found = kind(current);
    if (found === "link") throw new UnsafePathError(`${label}: ${current} is a symlink; refusing to write through it`);
    if (found === "file" && i < segments.length - 1) throw new UnsafePathError(`${label}: ${current} is a file, not a directory`);
    if (found === "missing") missing = true;
  });
  const ownerRun = opts.root !== undefined && sameDir(opts.root, owner);
  if (!ownerRun && isWithin(current, owner)) throw new UnsafePathError(`${label} ${current} resolves into the owner's tree`);
  return current;
}

export interface SafeTempOptions {
  /** The temp base to check; default os.tmpdir() (which honors an inherited TMPDIR). */
  tmp?: string;
  /** The real home; default from the user database (not $HOME). */
  home?: string;
  /** The owner's tree; tests pass a temp dir. Default OWNER_TREE. */
  ownerTree?: string;
}

/**
 * The base dir for mkdtemp callers (scratch dirs, staging, npm HOME): os.tmpdir() made canonical, which
 * must be an existing directory outside the owner's tree, not the real home itself, and not inside
 * ~/Library or a credential store under it (HOME_FORBIDDEN). An inherited TMPDIR can point anywhere, so
 * every `mkdtempSync(join(tmpdir(), ...))` in the tools goes through this instead.
 */
export function safeTempBase(opts: SafeTempOptions = {}): string {
  const given = opts.tmp ?? tmpdir();
  const home = opts.home ?? userInfo().homedir;
  const owner = opts.ownerTree ?? OWNER_TREE;
  if (!given) throw new UnsafePathError("temp base is empty");
  const canonical = canonicalPath(given);
  if (!existsSync(canonical) || !statSync(canonical).isDirectory()) throw new UnsafePathError(`temp base ${given} (${canonical}) is not an existing directory`);
  if (isWithin(canonical, owner)) throw new UnsafePathError(`temp base ${given} resolves into the owner's tree (${canonical}); unset TMPDIR or point it at a system temp dir`);
  if (sameDir(canonical, home)) throw new UnsafePathError(`temp base ${given} is the home directory itself`);
  for (const rel of HOME_FORBIDDEN) {
    const dir = join(home, rel);
    if (isWithin(canonical, dir)) throw new UnsafePathError(`temp base ${given} resolves into ${dir}; unset TMPDIR or point it at a system temp dir`);
  }
  return canonical;
}
