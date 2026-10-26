/**
 * The state of the trees a shot renders from: the app repo (HEAD, uncommitted content) and the
 * design-system inside the root (HEAD, every file of dist/, css/ and fonts/). snapshot records it per
 * shot; snapshot:diff reads it again at diff time and fails a B set the tree no longer matches.
 *
 *   treeState(root, app, warnings?)   the state now (git through git.ts, pinned and hook-free; a git failure
 *                                     hashes its error and warns; a pin that changed throws GitPinChanged)
 *   staleFields(recorded, now)        the gated fields a recorded provenance no longer matches
 *
 * The repositories are pinned (git.ts) before the first app of the process starts: startApp pins the
 * app's checkouts and the design-system ones; snapshot:diff and snapshot:sheet, which start no app, pin
 * them on first use.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { gitEntryState, GitPinError, pinFor, pinnedGit } from "./git";
import { type AppEntry, resolvePath, designSystemIn } from "./registry";
import { canonicalPath } from "./safe-paths";

/** Everything a shot's provenance records except the capture time. */
export interface TreeState {
  /** The app repo's HEAD, and the sha256 of its `git status --porcelain` output (uncommitted paths). */
  appHead: string;
  appStatusSha256: string;
  /** Uncommitted paths in the app repo. */
  appDirty: number;
  /** sha256 of the app repo's uncommitted content: `git diff --binary HEAD`, then each untracked file under the app's root and scan paths. */
  appContentSha256: string;
  /** HEAD of the design-system the app renders with (inside the root). */
  designSystemHead: string;
  /** sha256 of that design-system's dist/css/tokens.css. */
  tokensCssSha256: string | null;
  /** sha256 over every file of that design-system's dist/, css/ and fonts/ (path and content). */
  designSystemFilesSha256: string;
}

/**
 * The fields a B set must still match at diff time, with how a report names them: the app's commit and
 * uncommitted content, and the files the app renders with. The design-system's own HEAD is left out: a
 * commit there that changes no dist/, css/ or fonts/ file changes no pixel.
 */
export const GATED_FIELDS = [
  ["appHead", "app HEAD"],
  ["appContentSha256", "app content (uncommitted changes)"],
  ["designSystemFilesSha256", "design-system dist/, css/, fonts/"],
] as const satisfies ReadonlyArray<readonly [keyof TreeState, string]>;

/** The gated fields a recorded provenance does not match now (fields it does not record are not compared). */
export function staleFields(recorded: Partial<TreeState>, now: TreeState): string[] {
  return GATED_FIELDS.filter(([field]) => recorded[field] !== undefined && recorded[field] !== now[field]).map(([, label]) => label);
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * The repository pin for `repo` (git.ts pinFor), or the reason there is none (in no checkout). A pin
 * that changed, or a repository first seen after an app started, throws: the caller must not trust it.
 */
function pinOf(repo: string): ReturnType<typeof pinFor> | string {
  try {
    return pinFor(repo);
  } catch (error) {
    if (error instanceof GitPinError && /is in no git checkout/.test(error.message)) return error.message;
    throw error;
  }
}

/** git's trimmed stdout through the repo's pin, or "ERROR: ..." when git fails or `repo` is in no checkout. */
function git(repo: string, args: string[]): string {
  const pin = pinOf(repo);
  if (typeof pin === "string" || !pin) return `ERROR: ${pin ?? "no checkout"}`;
  const result = pinnedGit(pin, args);
  return result.status === 0 ? result.stdout.trimEnd() : `ERROR: ${(result.error?.message ?? result.stderr ?? "").trim()}`;
}

/** git's raw stdout through the repo's pin, or null after recording why it failed. */
function gitBytes(repo: string, args: string[], warnings: Set<string>): Buffer | null {
  const pin = pinOf(repo);
  if (typeof pin === "string" || !pin) {
    warnings.add(`provenance: git ${args.join(" ")} in ${repo} failed: ${pin ?? "no checkout"}`);
    return null;
  }
  const result = pinnedGit(pin, args, { buffer: true, maxBuffer: 1 << 30 });
  if (result.status === 0 && result.stdout) return result.stdout;
  warnings.add(`provenance: git ${args.join(" ")} in ${repo} failed: ${(result.error?.message ?? result.stderr ?? "").trim() || `exit ${result.status}`}`);
  return null;
}

/** sha256 of a file's content, a symlink's link text, or the error that stopped the read. */
function entryHash(path: string, warnings: Set<string>): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
    if (!stat.isFile()) return "not a file";
    return sha256Hex(readFileSync(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.add(`provenance: cannot read ${path}: ${message}`);
    return `error: ${message}`;
  }
}

/**
 * sha256 of the app repo's uncommitted content: `git diff --binary HEAD`, then each untracked file under
 * the app's root and scan paths (sorted) as `<path>\0<sha256>\n`. Unlike the porcelain status, a second
 * edit to an already-modified file changes it. A git failure hashes the error text (and warns).
 */
function appContentSha256(root: string, app: AppEntry, warnings: Set<string>): string {
  const repo = resolvePath(root, app.repo);
  // git runs in the checkout's top (its pin): pathspecs and listed files are relative to it.
  const pin = pinOf(repo);
  const top = typeof pin === "string" || !pin ? repo : pin.workTree;
  const pathspecs = [app.root, ...(app.scan?.paths ?? [])]
    .filter((path): path is string => typeof path === "string")
    .map((path) => relative(top, canonicalPath(resolvePath(root, path))))
    .filter((rel) => !rel.startsWith("..") && !isAbsolute(rel))
    .map((rel) => rel || ".");
  const hash = createHash("sha256");
  // --no-ext-diff and --no-textconv: the repo's config never runs a command of its own here.
  hash.update(gitBytes(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], warnings) ?? "diff failed\n");
  hash.update("\0untracked\0");
  if (pathspecs.length) {
    const list = gitBytes(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs], warnings);
    if (!list) hash.update("ls-files failed\n");
    const files = (list?.toString("utf8") ?? "").split("\0").filter(Boolean).sort();
    for (const file of files) hash.update(`${file}\0${entryHash(join(top, file), warnings)}\n`);
  }
  return hash.digest("hex");
}

/** Every file under `dir` (lstat: symlinks are entries, never followed), as paths relative to `base`. */
function walkFiles(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) walkFiles(path, base, out);
    else out.push(relative(base, path));
  }
}

/** sha256 over sorted `<rel>\0<sha256>\n` of every file in a design-system's dist/, css/ and fonts/. */
function designSystemFilesSha256(dsDir: string, warnings: Set<string>): string {
  const lines: string[] = [];
  for (const sub of ["dist", "css", "fonts"]) {
    const top = join(dsDir, sub);
    if (!existsSync(top)) {
      lines.push(`${sub}: missing\n`);
      continue;
    }
    const files: string[] = [];
    try {
      walkFiles(top, dsDir, files);
    } catch (error) {
      warnings.add(`provenance: cannot list ${top}: ${error instanceof Error ? error.message : String(error)}`);
      lines.push(`${sub}: unreadable\n`);
    }
    for (const rel of files) lines.push(`${rel}\0${entryHash(join(dsDir, rel), warnings)}\n`);
  }
  return sha256Hex(lines.sort().join(""));
}

/** A repository a capture pinned (snapshot manifest `git`): its work tree and `.git` entry then. */
export interface RecordedRepo {
  workTree: string;
  entry: string;
}

/**
 * The repositories of a capture's manifest (`git`) whose `.git` entry is not what it was at capture: git
 * must not run there (it would follow the new entry). One message per changed repository.
 */
export function changedGitEntries(recorded: unknown): string[] {
  if (!Array.isArray(recorded)) return [];
  return recorded
    .filter((repo): repo is RecordedRepo => typeof repo?.workTree === "string" && typeof repo?.entry === "string")
    .filter((repo) => gitEntryState(repo.workTree) !== repo.entry)
    .map((repo) => `${repo.workTree}: its .git entry changed since the capture (${repo.entry.split("\n")[0]} -> ${gitEntryState(repo.workTree).split("\n")[0]}); refusing to run git there`);
}

/** The state of the app repo and of `<root>/codecaine/core/design-system` right now. Problems reading them go to `warnings`. */
export function treeState(root: string, app: AppEntry, warnings: Set<string> = new Set()): TreeState {
  const repo = resolvePath(root, app.repo);
  const dsDir = designSystemIn(root);
  const status = git(repo, ["status", "--porcelain"]);
  const tokensCss = join(dsDir, "dist/css/tokens.css");
  return {
    appHead: git(repo, ["rev-parse", "HEAD"]),
    appStatusSha256: sha256Hex(status),
    appDirty: status.split("\n").filter(Boolean).length,
    appContentSha256: appContentSha256(root, app, warnings),
    designSystemHead: git(dsDir, ["rev-parse", "HEAD"]),
    tokensCssSha256: existsSync(tokensCss) ? sha256Hex(readFileSync(tokensCss)) : null,
    designSystemFilesSha256: designSystemFilesSha256(dsDir, warnings),
  };
}
