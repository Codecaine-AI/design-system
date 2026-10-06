/**
 * Which checkouts a run may write, and what the write checks compare. Shared by the app runner (app runs)
 * and test:apps (test suites and named commands). git goes through git.ts (pinned, hook-free).
 *
 *   appScope(root, app)         app runs (decision 29): the app's own checkouts, the ones holding its repo,
 *                               root and scan paths; every other checkout nested in them and every git dir
 *                               inside --root read-only. A dir in no checkout inside --root falls back to
 *                               the app's own folder (its repo, else its root), never --root itself.
 *   writeScope(root, dirs, o)   test:apps: the checkouts holding `dirs`, every checkout nested in those, and
 *                               (enclosing, default true) every checkout around them below --root; sibling
 *                               checkouts nested in an enclosing one are pruned. Throws when a dir is in no
 *                               checkout inside --root: the write check needs one.
 *   gitEntries(scope)           each checkout's `.git` entry (git.ts gitEntryState)
 *   checkoutStates(dirs)        each dir's identity (device:inode) and `.git` entry: what an app run must
 *                               leave as it found it (app-runner stop(), registry-prove)
 *   statusSnapshot(scope, skip) `git status --ignored --porcelain` per checkout, pinned to its recorded git dir
 *   nestedCheckouts(dir)        checkouts below `dir` (a `.git` file or folder), node_modules skipped
 *
 * Before any app of the process started, checkouts are discovered with git (git.ts discoverRepo). After
 * that, git is never asked: a checkout must have been pinned before (git.ts pinFor, else GitPinError),
 * and a nested checkout's git dir is read from its `.git` entry the way git reads it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { appsHaveStarted, discoverRepo, gitAt, gitDirsOf, gitEntryState, pinFor } from "./git";
import { resolvePath, type AppEntry } from "./registry";
import { canonicalPath } from "./safe-paths";

export { gitDirsOf };

/** find by absolute path (never PATH). */
export const FIND = "/usr/bin/find";

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The top of the checkout holding `dir` (canonical), or null. Before any app started, git says; after,
 * only a pinned checkout is accepted (git.ts pinFor: GitPinError for one that was not pinned).
 */
export function toplevel(dir: string): string | null {
  if (appsHaveStarted()) return pinFor(dir, { optional: true })?.workTree ?? null;
  return discoverRepo(dir)?.workTree ?? null;
}

function find(args: string[]): string[] {
  const out = spawnSync(FIND, args, { encoding: "utf8", maxBuffer: 256 << 20, timeout: 300_000 });
  return (out.stdout ?? "").split("\n").filter(Boolean);
}

/** Git checkouts below `dir` (a `.git` file or folder at depth >= 1), not inside node_modules; canonical. */
export function nestedCheckouts(dir: string): string[] {
  return find([dir, "-mindepth", "2", "(", "-name", "node_modules", "-prune", ")", "-o", "(", "-name", ".git", "-print", "-prune", ")"]).map((path) => canonicalPath(dirname(path)));
}

export interface AppScope {
  /** The dirs under --root a run of the app may write: its own checkouts (or its own folder, fallback). */
  writable: string[];
  /** Which of `writable` are git checkouts (their `.git` entries stay read-only). */
  checkouts: string[];
  /** Inside `writable`, never writable: other repositories' checkouts nested there, git dirs inside --root. */
  readOnly: string[];
  /** Set when a dir of the app is in no checkout inside --root: the folder used instead. */
  fallback?: string;
}

/**
 * The write scope of an app run (decision 29): the checkouts holding the app's repo, root and scan paths;
 * other checkouts nested in them and every git dir or common dir inside --root are read-only. A dir in
 * no checkout inside --root (or only in --root's own) adds the app's own folder (repo, else root) instead.
 * Throws when that folder is --root itself or outside it.
 */
export function appScope(root: string, app: Pick<AppEntry, "id" | "repo" | "root" | "scan">): AppScope {
  const realRoot = canonicalPath(root);
  const dirs = [app.repo, app.root, ...(app.scan?.paths ?? [])]
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .map((path) => resolvePath(root, path))
    .filter((path) => existsSync(path));
  const own = new Set<string>();
  let fallback: string | undefined;
  for (const dir of dirs) {
    const top = toplevel(dir);
    if (top && inside(top, realRoot) && top !== realRoot) own.add(top);
    else {
      const folder = canonicalPath(resolvePath(root, app.repo ?? app.root));
      if (folder === realRoot || !inside(folder, realRoot))
        throw new Error(`${app.id}: ${dir} is in no git checkout inside ${realRoot}, and the app's own folder ${folder} is ${folder === realRoot ? "--root itself" : "outside --root"}; a run may not write there`);
      fallback = folder;
    }
  }
  if (own.size === 0 && !fallback) throw new Error(`${app.id}: none of its repo, root or scan paths exists under ${realRoot}`);
  const checkouts = [...own].sort();
  const writable = [...new Set([...checkouts, ...(fallback && !checkouts.some((top) => inside(fallback!, top)) ? [fallback] : [])])].sort();
  const readOnly = new Set<string>();
  const nested = new Set<string>();
  for (const dir of writable) for (const sub of nestedCheckouts(dir)) if (!own.has(sub)) nested.add(sub);
  for (const sub of nested) if (![...own].some((top) => top !== sub && inside(top, sub))) readOnly.add(sub);
  for (const dir of [...checkouts, ...nested]) for (const gitDir of gitDirsOf(dir)) if (inside(gitDir, realRoot)) readOnly.add(gitDir);
  return { writable, checkouts, readOnly: [...readOnly].sort(), ...(fallback ? { fallback } : {}) };
}

export interface WriteScope {
  /** Every checkout whose `git status` is compared, with its git dir (absolute, recorded before any run). */
  checkouts: string[];
  gitDirs: Record<string, string>;
  /** Top-most dirs `find` walks: also the only dirs (with the run's temp dir) a run may write. */
  scan: string[];
  /** Nested checkouts `find` skips and the run may not write (the app touches none of them). */
  prune: string[];
}

/**
 * The checkouts a test:apps run touches: those holding `dirs`, every checkout nested in those and (unless
 * `enclosing` is false) every checkout around them below --root (a bun workspace root whose node_modules the
 * app shares). Sibling checkouts nested in an enclosing one are pruned. Throws when a dir is in no checkout
 * inside --root: the write check needs one.
 */
export function writeScope(root: string, dirs: string[], opts: { enclosing?: boolean } = {}): WriteScope {
  const realRoot = canonicalPath(root);
  const touched = new Set<string>();
  for (const dir of dirs) {
    const top = toplevel(dir);
    if (!top || !inside(top, realRoot) || top === realRoot) throw new Error(`${dir} is in no git checkout inside ${realRoot}; the write check needs one`);
    touched.add(top);
  }
  const enclosing = new Set<string>();
  if (opts.enclosing !== false) {
    for (const top of touched) {
      for (let parent = dirname(top); inside(parent, realRoot) && parent !== realRoot; parent = dirname(parent)) {
        const outer = toplevel(parent);
        if (!outer || !inside(outer, realRoot) || outer === realRoot) break;
        enclosing.add(outer);
        parent = outer;
      }
    }
  }
  const nested = new Set<string>();
  for (const top of touched) for (const dir of nestedCheckouts(top)) nested.add(dir);
  const own = new Set([...touched, ...nested]);
  const prune = new Set<string>();
  for (const outer of enclosing) for (const dir of nestedCheckouts(outer)) if (!own.has(dir) && !enclosing.has(dir) && ![...own].some((o) => inside(o, dir))) prune.add(dir);
  const all = [...new Set([...touched, ...enclosing])].sort();
  const scan = all.filter((dir) => !all.some((other) => other !== dir && inside(dir, other)));
  const checkouts = [...new Set([...all, ...nested])].sort();
  const gitDirs: Record<string, string> = {};
  for (const dir of checkouts) {
    const repo = discoverRepo(dir);
    if (!repo) throw new Error(`${dir}: git cannot read its git dir`);
    gitDirs[dir] = repo.gitDir;
  }
  return { checkouts, gitDirs, scan, prune: [...prune].sort() };
}

/** What a run must not change in a checkout's git setup: each `.git` entry (git.ts gitEntryState). */
export function gitEntries(scope: Pick<WriteScope, "checkouts">): Map<string, string> {
  return new Map(scope.checkouts.map((dir) => [join(dir, ".git"), gitEntryState(dir)]));
}

/** A dir's identity: "<device>:<inode>", or "missing". */
function dirIdentity(dir: string): string {
  try {
    const stat = statSync(dir);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "missing";
  }
}

/**
 * What an app run must leave as it found it (verify:apps, snapshot, registry-prove): for each checkout
 * of its scope, the checkout dir itself (device:inode: not renamed away and replaced) and its `.git`
 * entry (gitEntries). Keyed by checkout.
 */
export function checkoutStates(checkouts: readonly string[]): Map<string, string> {
  return new Map(checkouts.map((dir) => [dir, `dir ${dirIdentity(dir)}; .git ${gitEntryState(dir)}`]));
}

/** The checkouts whose state (checkoutStates) differs between `before` and `after`, with what they were and are. */
export function changedCheckouts(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...before].filter(([dir, state]) => after.get(dir) !== state).map(([dir, state]) => `${dir} (${state.split("\n")[0]} -> ${(after.get(dir) ?? "missing").split("\n")[0]})`);
}

/** `git status --ignored --porcelain` lines of each checkout, git pinned to its recorded git dir (hook-free, git.ts). */
export function statusSnapshot(scope: Pick<WriteScope, "checkouts" | "gitDirs">, skip: ReadonlySet<string> = new Set()): Map<string, string[]> {
  return new Map(
    scope.checkouts
      .filter((dir) => !skip.has(dir))
      .map((dir) => [dir, gitAt({ workTree: dir, gitDir: scope.gitDirs[dir]! }, ["status", "--ignored", "--porcelain"]).stdout.split("\n").filter(Boolean)]),
  );
}
