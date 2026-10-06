/**
 * Every git call the rollout tools make (provenance, snapshot, snapshot:diff, snapshot:sheet, verify:apps,
 * registry-prove; test:apps through checkouts.ts). git runs outside the run sandbox, against repositories
 * a run's processes sit in, so no repository may decide what git executes:
 *
 *   - the system git by absolute path (SYSTEM_BIN.git), PATH the system dirs only;
 *   - `-c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null
 *     -c core.attributesFile=/dev/null -c safe.bareRepository=explicit --no-optional-locks` and
 *     `--attr-source=<the empty tree>` on every call: no hook, no work-tree `.gitattributes` (so no
 *     filter, diff or merge driver), never an implicit bare repository;
 *   - GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_ATTR_NOSYSTEM=1, HOME and XDG_CONFIG_HOME in
 *     an empty dir nobody can write (/var/empty, else a temp dir of the tool's own), and nothing else from
 *     the tool's environment (no GIT_DIR);
 *   - pinned: each repository's work tree, git dir and common dir are recorded (pinRepos) before the first
 *     app of the process starts, and every later call names them (--git-dir, --work-tree), so a `.git`
 *     file a run rewrote cannot point git at a repository (and a config) the run made. A call refuses
 *     (GitPinChanged) when the `.git` entry or the git dir's config or info/attributes changed since the
 *     pin was recorded; after the first app started (markAppsStarted), a repository that was not pinned
 *     before is refused too (GitPinError);
 *   - found by lstat, never by git's own search: the checkout of a dir is the nearest dir up with a
 *     `.git` entry, its git dir the one that entry names; a git dir or common dir a run may write (in a
 *     checkout's files, in a temp dir: gitDirProblem) is refused unless it is the checkout's own `.git`.
 *
 *   discoverRepo(dir)        work tree, git dir, common dir and object format of the checkout holding `dir`, or null
 *   gitDirsOf(workTree)      the git dir and common dir a `.git` entry names (no git run)
 *   pinRepos(dirs)           pins the checkouts holding `dirs` (or checks the existing pins)
 *   pinFor(dir)              the pin of the checkout holding `dir` (pinning it while no app has started)
 *   pinnedGit(pin, args)     runs git against a pin (utf8 or buffer output)
 *   gitAt(at, args)          git against a work tree and git dir recorded by the caller (test:apps' check), through its pin
 *   gitEntryState(workTree)  what a `.git` entry is: a dir (device:inode), a gitdir file's text, a symlink
 *
 * The sandbox keeps every `.git` entry and every git dir inside --root read-only for run processes
 * (sandbox.ts runPolicy); the pins are the second layer.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalPath, safeTempBase } from "./safe-paths";
import { SYSTEM_BIN, SYSTEM_PATH } from "./system-bin";

/**
 * The config every call overrides: nothing a repository sets may run a command or touch the index, and
 * git never takes a dir for an implicit bare repository (safe.bareRepository=explicit): a git dir is
 * used only when a call names it (--git-dir).
 */
export const GIT_SAFE_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "safe.bareRepository=explicit",
  "--no-optional-locks",
];

/**
 * The empty tree of each object format. Every call reads gitattributes from it (--attr-source), never
 * from the work tree, so a `.gitattributes` a run wrote cannot select a filter, diff or merge driver.
 * git knows the empty tree without the object (verified on 2.50.1, sha1 and sha256); the id must match
 * the repository's format, or git dies when it first reads attributes ("bad --attr-source").
 */
export const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;

export type ObjectFormat = keyof typeof EMPTY_TREE;

export class GitPinError extends Error {
  override name = "GitPinError";
}

/** A pinned repository's `.git` entry, config or attributes changed since the pin was recorded. */
export class GitPinChanged extends GitPinError {
  override name = "GitPinChanged";
}

let home: string | undefined;

/**
 * The empty HOME every git call gets: /var/empty (an empty dir root owns, so nobody can put a config in it,
 * and nothing is left behind), else a temp dir of this process, removed at exit.
 */
function gitHome(): string {
  if (home && existsSync(home)) return home;
  try {
    const stat = statSync("/var/empty");
    if (stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0 && readdirSync("/var/empty").length === 0) return (home = "/var/empty");
  } catch {}
  home = mkdtempSync(join(safeTempBase(), "ds-git-home-"));
  const made = home;
  process.once("exit", () => rmSync(made, { recursive: true, force: true }));
  return home;
}

/** The whole environment of a git call: system PATH, no system or global config, an empty HOME. */
export function gitEnv(): Record<string, string> {
  const dir = gitHome();
  return {
    PATH: SYSTEM_PATH,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

export interface GitRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface GitRunBytes {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  error?: Error;
}

interface RunOptions {
  maxBuffer?: number;
  timeout?: number;
}

interface SpawnOptions extends RunOptions {
  /** The repository's object format (its empty tree is the attribute source). Default sha1: calls before a repository is known read no attributes. */
  format?: ObjectFormat;
}

function spawnGit(cwd: string, args: readonly string[], opts: SpawnOptions & { buffer: true }): SpawnSyncReturns<Buffer>;
function spawnGit(cwd: string, args: readonly string[], opts?: SpawnOptions & { buffer?: false }): SpawnSyncReturns<string>;
function spawnGit(cwd: string, args: readonly string[], opts: SpawnOptions & { buffer?: boolean } = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync(SYSTEM_BIN.git, [...GIT_SAFE_ARGS, `--attr-source=${EMPTY_TREE[opts.format ?? "sha1"]}`, ...args], {
    cwd,
    env: gitEnv(),
    maxBuffer: opts.maxBuffer ?? 256 << 20,
    timeout: opts.timeout ?? 120_000,
    ...(opts.buffer ? {} : { encoding: "utf8" as const }),
  });
}

export interface RepoPaths {
  /** The work tree (canonical). */
  workTree: string;
  /** The repository's git dir (`.git`, or `<main>/.git/worktrees/<name>` for a linked worktree). */
  gitDir: string;
  /** The common dir (config, hooks, objects): the git dir itself, or the main repository's for a worktree. */
  commonDir: string;
  /** The repository's object format: which empty tree is its attribute source. */
  objectFormat: ObjectFormat;
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * A checkout's git dir and common dir, read from its `.git` entry without running git: the `.git` dir
 * itself, or the dir a `gitdir: <path>` file names, plus that dir's `commondir` file. Canonical; [] when
 * the entry is neither (missing, a symlink, something else).
 */
export function gitDirsOf(workTree: string): string[] {
  const entry = join(workTree, ".git");
  try {
    const stat = lstatSync(entry);
    let gitDir: string | null = null;
    if (stat.isDirectory()) gitDir = entry;
    else if (stat.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(entry, "utf8"))?.[1];
      if (named) gitDir = isAbsolute(named) ? named : resolve(workTree, named);
    }
    if (!gitDir) return [];
    const dirs = [canonicalPath(gitDir)];
    const common = join(gitDir, "commondir");
    if (existsSync(common)) {
      const text = readFileSync(common, "utf8").trim();
      if (text) dirs.push(canonicalPath(isAbsolute(text) ? text : resolve(gitDir, text)));
    }
    return [...new Set(dirs)];
  } catch {
    return [];
  }
}

/** The system temp dirs: every run's own temp dir (writable by its processes, with no `.git` rule) is in one. */
function tempBases(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/private/var/folders"].filter((dir) => dir && existsSync(dir)).map((dir) => canonicalPath(dir)))];
}

/**
 * Why git may not use `dir` as `workTree`'s git dir or common dir, or null when it may. A run may write
 * its app's checkouts (except every `.git` entry and what is under one, sandbox.ts) and its own temp
 * dir, so a git dir in those places could hold a config, attributes or hooks a run wrote:
 *   - the checkout's own `.git` dir (a real dir, not a symlink): accepted;
 *   - anything else inside a checkout's files (no `.git` component on its path): refused;
 *   - anything else in a system temp dir: refused (a run's temp dir has no `.git` rule);
 *   - inside some checkout's `.git` (a worktree's `<main>/.git/worktrees/<name>`, a submodule's
 *     `<super>/.git/modules/<name>`), or outside every checkout (a bare repository elsewhere): accepted.
 * Mirror worktrees keep their git dirs in the owner's tree, which no run can write; system-view's is its own `.git`.
 */
export function gitDirProblem(workTree: string, dir: string): string | null {
  const own = join(workTree, ".git");
  if (dir === own) {
    try {
      if (lstatSync(own).isDirectory()) return null;
    } catch {}
  }
  const parts = dir.split(sep);
  if (!parts.includes(".git")) {
    for (let at = dir; ; at = dirname(at)) {
      try {
        lstatSync(join(at, ".git"));
        return `it lies in the files of the checkout ${at}, which a run of its app may write`;
      } catch {}
      if (dirname(at) === at) break;
    }
  }
  const temp = tempBases().find((base) => inside(dir, base));
  if (temp) return `it lies in the temp dir ${temp}, where runs keep their own writable dirs`;
  return null;
}

/** Throws GitPinError when git may not use the git dir or common dir of `paths` (gitDirProblem). */
function refuseUnsafeGitDirs(paths: Pick<RepoPaths, "workTree" | "gitDir" | "commonDir">): void {
  for (const [what, dir] of [
    ["git dir", paths.gitDir],
    ["common dir", paths.commonDir],
  ] as const) {
    const problem = gitDirProblem(paths.workTree, dir);
    if (problem) throw new GitPinError(`${paths.workTree}: refusing its ${what} ${dir}: ${problem}`);
  }
}

/**
 * The checkout holding `dir` (a file's folder for a file), or null when there is none. Never lets git
 * search: the checkout is the nearest dir from `dir` up with a `.git` entry (lstat), its git dir is the
 * one that entry names (gitDirsOf), and git is asked about that git dir by name (--git-dir), so a bare
 * repository planted on the way up is never taken for one. Refused (GitPinError): a git dir that names
 * another work tree (core.worktree), and a git dir or common dir a run may write (gitDirProblem). Null
 * when git cannot read the entry. Call it only before any app starts (pinRepos does).
 */
export function discoverRepo(dir: string): RepoPaths | null {
  if (!existsSync(dir)) return null;
  const start = statSync(dir).isDirectory() ? dir : dirname(dir);
  const workTree = nearestWorkTree(start);
  if (!workTree) return null;
  const [named] = gitDirsOf(workTree);
  if (!named || !existsSync(named)) return null;
  const out = spawnGit(workTree, [`--git-dir=${named}`, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-object-format"], {
    timeout: 30_000,
  });
  if (out.status !== 0 || out.error) return null;
  const [top, gitDir, commonDir, format] = (out.stdout ?? "").trim().split("\n");
  if (!top || !gitDir || !commonDir || ![top, gitDir, commonDir].every(isAbsolute)) return null;
  if (format !== "sha1" && format !== "sha256") throw new GitPinError(`${workTree}: unknown object format ${format}`);
  const paths: RepoPaths = { workTree: canonicalPath(top), gitDir: canonicalPath(gitDir), commonDir: canonicalPath(resolve(workTree, commonDir)), objectFormat: format };
  if (paths.workTree !== workTree || !inside(canonicalPath(start), paths.workTree))
    throw new GitPinError(`${workTree}: its git dir ${named} names the work tree ${paths.workTree}, not the checkout its .git entry is in; refusing it`);
  if (paths.gitDir !== named) throw new GitPinError(`${workTree}: git reads the git dir ${paths.gitDir}, not ${named} that its .git entry names; refusing it`);
  refuseUnsafeGitDirs(paths);
  return paths;
}

/** What a work tree's `.git` entry is: "dir <dev>:<ino>", "file <its text>", "symlink <target>", "missing" or "other". */
export function gitEntryState(workTree: string): string {
  const entry = join(workTree, ".git");
  try {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) return `symlink ${readlinkSync(entry)}`;
    if (stat.isDirectory()) return `dir ${stat.dev}:${stat.ino}`;
    if (stat.isFile()) return `file ${readFileSync(entry, "utf8")}`;
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Config sections that never make the calls the tools make (rev-parse, status, diff, ls-files) run a
 * command or read another file: upstream, remote, identity and UI settings. `git push -u` or a branch
 * upstream change by the owner or another worker edits these while tools run; they are not compared.
 */
const INERT_CONFIG = /^(branch|remote|user|pull|push|fetch|gui|rerere|maintenance|advice|color|column|init|i18n|log|format|credential)\./i;

/** The settings of one config file that count (INERT_CONFIG left out), sorted; the raw bytes when git cannot parse it. */
function configSettings(file: string): string {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return `not a file (${stat.isSymbolicLink() ? `symlink ${readlinkSync(file)}` : "dir"})`;
  } catch {
    return "missing";
  }
  // Run from the empty HOME, never from inside the git dir: no repository is looked for around the file.
  const out = spawnGit(gitHome(), ["config", "--file", file, "--list", "--no-includes", "-z"], { timeout: 30_000 });
  if (out.status !== 0 || out.error) return `unparsed ${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  return (out.stdout ?? "")
    .split("\0")
    .filter((entry) => entry && !INERT_CONFIG.test(entry))
    .sort()
    .join("\0");
}

/**
 * sha256 over what decides what git may run in a repository: its config and config.worktree (every
 * setting but INERT_CONFIG's) and info/attributes (whole).
 */
function configState(paths: Pick<RepoPaths, "gitDir" | "commonDir">): string {
  const hash = createHash("sha256");
  for (const file of [join(paths.commonDir, "config"), join(paths.gitDir, "config.worktree")]) hash.update(`${file}\0${configSettings(file)}\n`);
  for (const file of [join(paths.commonDir, "info", "attributes"), join(paths.gitDir, "info", "attributes")]) {
    hash.update(`${file}\0`);
    try {
      const stat = lstatSync(file);
      hash.update(stat.isFile() ? readFileSync(file) : `not a file (${stat.isSymbolicLink() ? `symlink ${readlinkSync(file)}` : "dir"})`);
    } catch {
      hash.update("missing");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

export interface GitPin extends RepoPaths {
  /** gitEntryState(workTree) when the pin was recorded. */
  entry: string;
  /** configState when the pin was recorded. */
  config: string;
}

const pins = new Map<string, GitPin>();
let appsStarted = false;

/** The runner calls this right before the first app process of this tool starts: from then on no new pin. */
export function markAppsStarted(): void {
  appsStarted = true;
}

/** Whether an app has started in this process (no repository can be pinned any more). */
export function appsHaveStarted(): boolean {
  return appsStarted;
}

/** Throws GitPinChanged when the pin's `.git` entry, config or attributes are not what was recorded. */
export function checkPin(pin: GitPin): void {
  const entry = gitEntryState(pin.workTree);
  if (entry !== pin.entry) throw new GitPinChanged(`${pin.workTree}: its .git entry changed since it was recorded (${pin.entry.split("\n")[0]} -> ${entry.split("\n")[0]}); refusing to run git there`);
  if (configState(pin) !== pin.config) throw new GitPinChanged(`${pin.workTree}: the config or attributes of its git dir ${pin.gitDir} changed since they were recorded; refusing to run git there`);
}

/** The nearest dir from `dir` up that has a `.git` entry (no git run: lstat only), or null. */
function nearestWorkTree(dir: string): string | null {
  for (let current = canonicalPath(dir); ; current = dirname(current)) {
    try {
      lstatSync(join(current, ".git"));
      return current;
    } catch {}
    if (dirname(current) === current) return null;
  }
}

/**
 * Pins (or re-checks) the checkout holding each dir: work tree, git dir and common dir as git reports them
 * now, the `.git` entry and the config. Dirs in no checkout are skipped. After markAppsStarted, a checkout
 * that was not pinned before throws GitPinError, and a pinned one whose entry changed throws GitPinChanged.
 */
export function pinRepos(dirs: readonly string[]): GitPin[] {
  const out: GitPin[] = [];
  for (const dir of dirs) {
    const pin = pinFor(dir, { optional: true });
    if (pin && !out.includes(pin)) out.push(pin);
  }
  return out;
}

/**
 * The pin of the checkout holding `dir`. Before any app started, pins it on first use. After that, only a
 * checkout pinned before is accepted (found by lstat of `.git` entries on the way up, never by asking git),
 * and its pin is checked. `optional`: null instead of a throw when `dir` is in no checkout.
 */
export function pinFor(dir: string, opts: { optional?: boolean } = {}): GitPin | null {
  const near = nearestWorkTree(dir);
  const known = near ? pins.get(near) : undefined;
  if (known) {
    checkPin(known);
    return known;
  }
  if (appsStarted) {
    if (near === null) {
      if (opts.optional) return null;
      throw new GitPinError(`${dir} is in no git checkout`);
    }
    throw new GitPinError(`${near}: its repository was not recorded before the first app started; pin every repository a tool reads before starting apps`);
  }
  const paths = discoverRepo(dir);
  if (!paths) {
    if (opts.optional) return null;
    throw new GitPinError(`${dir} is in no git checkout`);
  }
  const existing = pins.get(paths.workTree);
  if (existing) {
    checkPin(existing);
    return existing;
  }
  const pin: GitPin = { ...paths, entry: gitEntryState(paths.workTree), config: configState(paths) };
  pins.set(paths.workTree, pin);
  return pin;
}

/** Every pin recorded so far (for reports and manifests). */
export function recordedPins(): GitPin[] {
  return [...pins.values()];
}

/** Tests only: forget every pin and the started flag. */
export function resetPinsForTests(): void {
  pins.clear();
  appsStarted = false;
}

/** The arguments that tie a call to a recorded work tree and git dir. */
function pinArgs(at: { workTree: string; gitDir: string }): string[] {
  return [`--git-dir=${at.gitDir}`, `--work-tree=${at.workTree}`];
}

/** git against a pin (checked first; GitPinChanged when it changed), utf8 output. */
export function pinnedGit(pin: GitPin, args: readonly string[], opts?: RunOptions): GitRun;
/** git against a pin, raw stdout. */
export function pinnedGit(pin: GitPin, args: readonly string[], opts: RunOptions & { buffer: true }): GitRunBytes;
export function pinnedGit(pin: GitPin, args: readonly string[], opts: RunOptions & { buffer?: boolean } = {}): GitRun | GitRunBytes {
  checkPin(pin);
  const full = [...pinArgs(pin), ...args];
  if (opts.buffer) {
    const result = spawnGit(pin.workTree, full, { ...opts, format: pin.objectFormat, buffer: true });
    return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr?.toString() ?? "", ...(result.error ? { error: result.error } : {}) };
  }
  const result = spawnGit(pin.workTree, full, { ...opts, format: pin.objectFormat, buffer: false });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
}

/**
 * git against a work tree and git dir the caller recorded (test:apps' check), through the pin of that
 * checkout (pinFor: pinned on first use while no app has started, checked on every call). Refused
 * (GitPinChanged) when the recorded git dir is not the pin's, so a git dir a caller took from elsewhere
 * (a planted repository) never runs.
 */
export function gitAt(at: { workTree: string; gitDir: string }, args: readonly string[], opts?: RunOptions): GitRun;
/** The same, raw stdout. */
export function gitAt(at: { workTree: string; gitDir: string }, args: readonly string[], opts: RunOptions & { buffer: true }): GitRunBytes;
export function gitAt(at: { workTree: string; gitDir: string }, args: readonly string[], opts: RunOptions & { buffer?: boolean } = {}): GitRun | GitRunBytes {
  const pin = pinFor(at.workTree)!;
  if (pin.workTree !== canonicalPath(at.workTree) || pin.gitDir !== canonicalPath(at.gitDir))
    throw new GitPinChanged(`${at.workTree}: the git dir ${at.gitDir} is not the one recorded for it (${pin.gitDir} of ${pin.workTree}); refusing to run git there`);
  return pinnedGit(pin, args, opts as RunOptions & { buffer: true });
}

/** `git rev-parse HEAD` (trimmed) of the checkout holding `dir`, through its pin; "ERROR: ..." when git fails. */
export function headOf(dir: string): string {
  const pin = pinFor(dir);
  const result = pinnedGit(pin!, ["rev-parse", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : `ERROR: ${(result.error?.message ?? result.stderr).trim()}`;
}
