/**
 * Every git call the rollout tools make (provenance, snapshot, snapshot:diff, snapshot:sheet, verify:apps,
 * registry-prove; test:apps through checkouts.ts). git runs outside the run sandbox, against repositories
 * a run's processes sit in, so no repository may decide what git executes:
 *
 *   - the system git by absolute path (SYSTEM_BIN.git), PATH the system dirs only;
 *   - `-c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null
 *     -c core.attributesFile=/dev/null --no-optional-locks` on every call;
 *   - GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_ATTR_NOSYSTEM=1, HOME and XDG_CONFIG_HOME in
 *     an empty dir nobody can write (/var/empty, else a temp dir of the tool's own), and nothing else from
 *     the tool's environment (no GIT_DIR);
 *   - pinned: each repository's work tree, git dir and common dir are recorded (pinRepos) before the first
 *     app of the process starts, and every later call names them (--git-dir, --work-tree), so a `.git`
 *     file a run rewrote cannot point git at a repository (and a config) the run made. A call refuses
 *     (GitPinChanged) when the `.git` entry or the git dir's config or info/attributes changed since the
 *     pin was recorded; after the first app started (markAppsStarted), a repository that was not pinned
 *     before is refused too (GitPinError).
 *
 *   discoverRepo(dir)        work tree, git dir and common dir of the checkout holding `dir`, or null
 *   pinRepos(dirs)           pins the checkouts holding `dirs` (or checks the existing pins)
 *   pinFor(dir)              the pin of the checkout holding `dir` (pinning it while no app has started)
 *   pinnedGit(pin, args)     runs git against a pin (utf8 or buffer output)
 *   gitAt(at, args)          git against a work tree and git dir recorded by the caller (test:apps' check)
 *   gitEntryState(workTree)  what a `.git` entry is: a dir (device:inode), a gitdir file's text, a symlink
 *
 * The sandbox keeps every `.git` entry and every git dir inside --root read-only for run processes
 * (sandbox.ts runPolicy); the pins are the second layer.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalPath, safeTempBase } from "./safe-paths";
import { SYSTEM_BIN, SYSTEM_PATH } from "./system-bin";

/** The config every call overrides: nothing a repository sets may run a command or touch the index. */
export const GIT_SAFE_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "--no-optional-locks",
];

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

function spawnGit(cwd: string, args: readonly string[], opts: RunOptions & { buffer: true }): SpawnSyncReturns<Buffer>;
function spawnGit(cwd: string, args: readonly string[], opts?: RunOptions & { buffer?: false }): SpawnSyncReturns<string>;
function spawnGit(cwd: string, args: readonly string[], opts: RunOptions & { buffer?: boolean } = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync(SYSTEM_BIN.git, [...GIT_SAFE_ARGS, ...args], {
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
}

/**
 * The checkout holding `dir` (a file's folder for a file), or null when there is none. Reads the `.git`
 * entry on the way up the way git does: call it only before any app starts (pinRepos does).
 */
export function discoverRepo(dir: string): RepoPaths | null {
  if (!existsSync(dir)) return null;
  const cwd = statSync(dir).isDirectory() ? dir : dirname(dir);
  const out = spawnGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], { timeout: 30_000 });
  if (out.status !== 0 || out.error) return null;
  const [workTree, gitDir, commonDir] = (out.stdout ?? "").trim().split("\n");
  if (!workTree || !gitDir || !commonDir || ![workTree, gitDir, commonDir].every(isAbsolute)) return null;
  return { workTree: canonicalPath(workTree), gitDir: canonicalPath(gitDir), commonDir: canonicalPath(resolve(cwd, commonDir)) };
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
  const out = spawnGit(dirname(file), ["config", "--file", file, "--list", "--no-includes", "-z"], { timeout: 30_000 });
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
  return gitAt(pin, args, opts as RunOptions & { buffer: true });
}

/** git against a work tree and git dir the caller recorded (no pin check), utf8 output. */
export function gitAt(at: { workTree: string; gitDir: string }, args: readonly string[], opts?: RunOptions): GitRun;
/** git against a work tree and git dir the caller recorded, raw stdout. */
export function gitAt(at: { workTree: string; gitDir: string }, args: readonly string[], opts: RunOptions & { buffer: true }): GitRunBytes;
export function gitAt(at: { workTree: string; gitDir: string }, args: readonly string[], opts: RunOptions & { buffer?: boolean } = {}): GitRun | GitRunBytes {
  const full = [...pinArgs(at), ...args];
  if (opts.buffer) {
    const result = spawnGit(at.workTree, full, { ...opts, buffer: true });
    return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr?.toString() ?? "", ...(result.error ? { error: result.error } : {}) };
  }
  const result = spawnGit(at.workTree, full, { ...opts, buffer: false });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
}

/** `git rev-parse HEAD` (trimmed) of the checkout holding `dir`, through its pin; "ERROR: ..." when git fails. */
export function headOf(dir: string): string {
  const pin = pinFor(dir);
  const result = pinnedGit(pin!, ["rev-parse", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : `ERROR: ${(result.error?.message ?? result.stderr).trim()}`;
}
