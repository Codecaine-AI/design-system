/**
 * App runner: starts one registry app under its run profile, and stops it again.
 *
 * Shared by snapshot (screenshots), verify:apps (runtime check) and registry-prove. Every run:
 *   - gets a fresh temp dir that is HOME and the XDG dirs, with the profile's fixtures copied in;
 *   - runs with a sanitized environment built from an allowlist, never from the full process.env;
 *   - runs every process it starts inside the OS sandbox, a profile generated per run (sandbox.ts):
 *     network only to its own port block and allowedLocalPorts on loopback (listening only on the
 *     block), no Unix socket but DNS/syslog and its temp dir, no reads under the real home but --root and
 *     the runtimes, writes only in --root (never the design-system checkout or the out dir) and its temp
 *     dir, no `.env*` reads, signals only to its own processes; TMPDIR is its temp dir. Without a working
 *     sandbox-exec startApp throws, unless the caller passes allowUnsandboxed (proof/debug only;
 *     running.unsandboxed is then set);
 *   - samples its processes' TCP connections with lsof from before the first spawn until stop(); every
 *     connection that leaves the run, and every failed sample, goes into running.violations;
 *   - binds only its profile's ports (46900-47999, never an owner port) and refuses a busy port;
 *   - starts every process in its own process group and records the roots' and every process's identity
 *     (pid, group, start time) in <outDir>/runs/<id>.json, where no run process can write, so
 *     `bun scripts/lib/app-runner.ts --cleanup` can stop what a crashed tool left: only processes under an
 *     identity-checked runner root; stop() kills only this run's processes, revalidating each one's start
 *     time before every signal, then confirms they are gone and every port the run bound is free (a stop it
 *     cannot confirm rejects, and the run stays for the exit hook);
 *   - installs SIGINT/SIGTERM/SIGHUP handlers (graceful stop, then exit 130/143/129; a second signal
 *     SIGKILLs every live run at once), and an exit hook that SIGKILLs what is still live; a watchdog in
 *     every run's process group kills it when the tool dies by SIGKILL.
 *
 * Run modes (registry `run.mode`):
 *   browser   spawn `run.start`, read the bound URL from its output with `run.readyPattern`; served
 *             URL paths map under `run.serveRoot` (the Vite/web root), default `run.cwd`
 *   static    `run.start` set: same as browser (a fixture server that builds into {tmp});
 *             otherwise run `commands.build`, then serve `run.staticDir` on the app's port
 *   electron  refused unless the tool runs with DS_ALLOW_ELECTRON=1 (cfprefsd writes the owner's
 *             ~/Library/Preferences/com.github.Electron.plist, which no sandbox stops). Then: run
 *             `run.electron.build`, then Playwright `_electron.launch` against `run.electron.main`
 *             through a launcher that starts Electron inside the sandbox (with `--no-sandbox`: Chromium
 *             cannot nest its own sandbox in ours). The app's `ready` event waits until the request
 *             guard is on electronApp.context(). The guard covers renderer traffic; main-process Node
 *             traffic is contained by the sandbox and observed by the egress sampling.
 *   none      throws: the app has no screenshots and no runtime checks
 *
 * Placeholders `{tmp}`, `{root}`, `{ds}` (DESIGN_SYSTEM_ROOT, the design-system checkout the tool runs from)
 * and `{port:<name>}` are substituted in `run.start`, `commands.*`,
 * `run.electron.build`, `runProfile.flags` and `runProfile.env` values. `runProfile.flags` go where the
 * start command says `{flags}`, else at its end (browser), or after the main entry (electron).
 *
 * Fixtures are design-system-relative. `apps/fixtures/<id>/<rest>` is copied to `<tmp>/<rest>`, so a
 * fixture can seed HOME (`apps/fixtures/<id>/.config/...`); any other path lands at `<tmp>/<basename>`.
 * `.env*` files are never copied.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { CONTEXT_OPTIONS, DETERMINISM_CSS, installStyleInitScript, LAUNCH_OPTIONS } from "./capture";
import { describeConnection, egressConnections, lsofConnections } from "./egress";
import { OWNER_PORTS } from "./owner";
import { loadPlaywright, playwrightAnchor } from "./playwright";
import { portProblems, PROFILE_PORTS } from "../registry-check";
import { DESIGN_SYSTEM_ROOT, resolvePath, validateRegistry, type AppEntry, type Registry } from "./registry";
import { safeAppId, safeOutputPath } from "./safe-paths";
import { SYSTEM_BIN, SYSTEM_PATH } from "./system-bin";
import { runPolicy, sandboxCommand, sandboxProfile, sandboxUnavailable, type SandboxPolicy } from "./sandbox";

/** The owner's ports (scripts/lib/owner.ts). No run binds or contacts them, whatever its profile says. */
export { OWNER_PORTS };
/** Run profiles use 47000-47999; tool tests use 46900-46999. */
export const RUN_PORT_RANGE = { min: 46900, max: 47999 } as const;

/** app-runner's Electron preload (see electron-loader.cjs). */
const ELECTRON_LOADER = join(import.meta.dir, "electron-loader.cjs");

/** Inherited variables a run keeps (plus every BUN_INSTALL* from run.env). Nothing else crosses over. */
const ENV_ALLOWLIST = new Set(["PATH", "LANG", "TERM", "TMPDIR"]);

/** How often the egress sampler reads the run's connections. */
const SAMPLE_INTERVAL_MS = 250;
/** How long the guard trusts its view of the run's listeners before asking lsof again. */
const PORT_CACHE_MS = 500;
const MAX_VIOLATIONS = 50;

export interface RunningApp {
  app: AppEntry;
  root: string;
  /** browser/static: the URL read from server output (no trailing slash). */
  baseUrl?: string;
  /** Named ports the run assigned. */
  ports: Record<string, number>;
  /** Every port this run's processes bound (history, for reports; the guard authorizes current listeners only). */
  startedPorts: number[];
  /** Per-run HOME/XDG dir, fixtures copied in. Removed by stop(). */
  tmp: string;
  /** The sanitized env the app runs with. */
  env: Record<string, string>;
  /** Combined stdout/stderr of every command the run started. */
  logPath: string;
  /** Stops only this run's processes, then confirms the ports are free. Rejects when a port stays bound. */
  stop(): Promise<void>;
  /** run.mode "electron" only. */
  electron?: { app: any; window(): Promise<any> };
  /** run.mode "electron" only: requests the guard blocked in electronApp.context(). */
  blocked?: () => string[];
  /** Directory the served URL paths map to: run.serveRoot (the Vite/web root), else the static dir, else run.cwd. */
  serveRoot?: string;
  /** static mode without run.start: every file the built-in server sent. */
  servedFiles?: () => string[];
  /** Set when the run used allowUnproven: its results must not count for a gate. */
  unproven?: true;
  /** Set when the run used allowUnsandboxed on a machine without sandbox-exec: its results must not count for a gate. */
  unsandboxed?: true;
  /**
   * Isolation violations: an owner port a run process listened on, a connection that left the run, or
   * an egress sample that failed (isolation unproven, never clean). startApp refuses a run that has any
   * when it becomes ready; stop() adds what its last sample finds, so read this after stop().
   */
  violations?: string[];
  /** Egress sampling so far: lsof samples taken, the ones that failed, distinct sockets seen. */
  egress?: EgressStats;
}

export interface EgressStats {
  samples: number;
  failures: string[];
  connections: number;
}

export interface StartOptions {
  root: string;
  outDir: string;
  /** Per phase (build, then ready). Default 180 s. */
  timeoutMs?: number;
  /**
   * Run an unproven profile. Only for proving a profile (the registry worker); the run logs a loud
   * line to stderr and to the run log. Default false: an unproven profile is refused.
   */
  allowUnproven?: boolean;
  /**
   * Start without the OS sandbox when sandbox-exec is unavailable here. Proof/debug only: the run logs a
   * loud line and sets running.unsandboxed. Default false: startApp throws instead.
   */
  allowUnsandboxed?: boolean;
  /**
   * The registry `app` was loaded from. Its index there fixes the app's port block (47000 + 10 x index);
   * without it the block is the aligned ten-port block of the profile's first port.
   */
  registry?: Registry;
}

// -- placeholders, env, fixtures ---------------------------------------------

export interface PlaceholderContext {
  root: string;
  tmp: string;
  ports: Record<string, number>;
}

/** Substitutes {tmp}, {root}, {ds} and {port:<name>}. An unknown port name throws; other braces stay as written. */
export function expandPlaceholders(text: string, ctx: PlaceholderContext): string {
  return text
    .replace(/\{port:([A-Za-z0-9_-]+)\}/g, (_, name: string) => {
      const port = ctx.ports[name];
      if (port === undefined) throw new Error(`placeholder {port:${name}}: the run profile has no port named "${name}"`);
      return String(port);
    })
    .replaceAll("{tmp}", ctx.tmp)
    .replaceAll("{root}", ctx.root)
    .replaceAll("{ds}", DESIGN_SYSTEM_ROOT);
}

/** The allowlisted inherited variables, with HOME, TMPDIR and the XDG dirs inside `tmp`. Browsers get exactly this. */
export function sanitizedEnv(tmp: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (ENV_ALLOWLIST.has(key) || key.startsWith("BUN_INSTALL"))) env[key] = value;
  }
  env.HOME = tmp;
  // Temp files go to the run's own dir: the sandbox denies writes to the shared system temp dirs.
  env.TMPDIR = tmp;
  env.XDG_CONFIG_HOME = join(tmp, ".config");
  env.XDG_DATA_HOME = join(tmp, ".local", "share");
  env.XDG_STATE_HOME = join(tmp, ".local", "state");
  env.XDG_CACHE_HOME = join(tmp, ".cache");
  return env;
}

/**
 * sanitizedEnv, then BUN_OPTIONS=--no-env-file (the sandbox denies `.env` reads, and bun exits 1 without a
 * word when it cannot read one in its cwd), then runProfile.env, then runProfile.unsetEnv removed.
 */
export function profileEnv(app: AppEntry, opts: { root: string; tmp: string }): Record<string, string> {
  const env = sanitizedEnv(opts.tmp);
  const ctx = { root: opts.root, tmp: opts.tmp, ports: app.runProfile?.ports ?? {} };
  for (const [key, value] of Object.entries(app.runProfile?.env ?? {})) env[key] = expandPlaceholders(value, ctx);
  if (!/(^|\s)--no-env-file(\s|$)/.test(env.BUN_OPTIONS ?? "")) env.BUN_OPTIONS = ["--no-env-file", env.BUN_OPTIONS].filter(Boolean).join(" ");
  for (const key of app.runProfile?.unsetEnv ?? []) delete env[key];
  return env;
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function copyFixtures(app: AppEntry, tmp: string) {
  const prefix = `apps/fixtures/${app.id}/`;
  for (const rel of app.runProfile.fixtures ?? []) {
    const src = resolve(DESIGN_SYSTEM_ROOT, rel);
    if (!isInside(src, DESIGN_SYSTEM_ROOT)) throw new Error(`${app.id}: fixture ${rel} is outside design-system`);
    if (!existsSync(src)) throw new Error(`${app.id}: fixture ${rel} does not exist (${src})`);
    const dest = rel.startsWith(prefix) ? join(tmp, rel.slice(prefix.length)) : join(tmp, basename(rel));
    cpSync(src, dest, { recursive: true, filter: (path) => !basename(path).startsWith(".env") });
  }
}

/** A run's port block: ten ports from `start`. Registry apps get 47000 + 10 x their index; tool tests use 46900-46999. */
export interface PortBlock {
  start: number;
  size: number;
}

/** Tool tests' ports (TOOLING_CONTRACT.md); a profile living only here is a test stand-in, not a registry app. */
export const TEST_PORT_RANGE = { min: 46900, max: 46999 } as const;

/** The aligned ten-port block of the profile's first named port (or first allowedLocalPorts entry); null without any. */
function alignedBlock(app: AppEntry): PortBlock | null {
  const first = [...Object.values(app.runProfile?.ports ?? {}), ...(app.runProfile?.allowedLocalPorts ?? [])].find(Number.isInteger);
  return first === undefined ? null : { start: first - (first % PROFILE_PORTS.block), size: PROFILE_PORTS.block };
}

/**
 * The port block a profile runs in. With the registry it was loaded from: 47000 + 10 x the app's index
 * there (registry:check's rule), except a test stand-in whose named ports all lie in the tool-test range
 * 46900-46999, which keeps the aligned rule below. Without a registry: the aligned ten-port block of its
 * first named port (or first allowedLocalPorts entry), and checkProfilePorts then requires every other
 * port to share it. Null when the profile names no port at all.
 */
export function profileBlock(app: AppEntry, registry?: Registry): PortBlock | null {
  if (!registry) return alignedBlock(app);
  const named = Object.values(app.runProfile?.ports ?? {});
  if (named.length && named.every((port) => Number.isInteger(port) && port >= TEST_PORT_RANGE.min && port <= TEST_PORT_RANGE.max)) return alignedBlock(app);
  const index = registry.apps.findIndex((entry) => entry.id === app.id);
  if (index < 0) throw new Error(`${app.id}: not in the registry it was started from`);
  return { start: PROFILE_PORTS.min + PROFILE_PORTS.block * index, size: PROFILE_PORTS.block };
}

/**
 * registry:check's profile rules for one app (portProblems in scripts/registry-check.ts), plus the run
 * range: every named port in 46900-47999, inside `block`, never an owner port; allowedLocalPorts inside
 * the block, never an owner port; no command, flag or env value naming an owner port or a port outside
 * the block. One message per problem.
 */
export function profilePortProblems(app: AppEntry, block: PortBlock | null): string[] {
  const problems: string[] = [];
  const range = block ? `${block.start}-${block.start + block.size - 1}` : "";
  for (const [name, port] of Object.entries(app.runProfile?.ports ?? {})) {
    if (OWNER_PORTS.includes(port)) problems.push(`${app.id}: port ${name}=${port} is an owner port`);
    else if (!Number.isInteger(port) || port < RUN_PORT_RANGE.min || port > RUN_PORT_RANGE.max)
      problems.push(`${app.id}: port ${name}=${port} is outside ${RUN_PORT_RANGE.min}-${RUN_PORT_RANGE.max}`);
    else if (block && (port < block.start || port >= block.start + block.size)) problems.push(`${app.id}: port ${name}=${port} is outside its block ${range}`);
  }
  if (!block) {
    for (const port of app.runProfile?.allowedLocalPorts ?? [])
      problems.push(`${app.id}: runProfile.allowedLocalPorts ${OWNER_PORTS.includes(port) ? `lists owner port ${port}` : `port ${port} has no block to be in`}`);
    return problems;
  }
  return [...problems, ...portProblems(app, block)];
}

function checkProfilePorts(app: AppEntry, block: PortBlock | null) {
  const problems = profilePortProblems(app, block);
  if (problems.length) throw new Error(problems.join("; "));
}

/**
 * Every problem a loaded registry has before any tool may run from it: validateRegistry's structure, then
 * registry:check's profile rules for each app in its own block (profileBlock: 47000 + 10 x index, or the
 * aligned block for a test stand-in on 46900-46999), each profile port used once. Path checks against a
 * workspace tree, and the canonical apps.json's 47000-47999 requirement, stay in registry:check.
 */
export function registryProblems(registry: Registry): string[] {
  const problems = validateRegistry(registry);
  const users = new Map<number, string>();
  registry.apps.forEach((app) => {
    problems.push(...profilePortProblems(app, profileBlock(app, registry)));
    for (const [name, port] of Object.entries(app.runProfile?.ports ?? {})) {
      const other = users.get(port);
      if (other) problems.push(`${app.id}: port ${name}=${port} is also used by ${other}`);
      else users.set(port, `${app.id}.${name}`);
    }
  });
  return [...new Set(problems)];
}

/**
 * For every tool that loads a registry (the canonical apps.json or a --registry file): throws with every
 * problem registryProblems finds, else returns the registry. `source` names the file in the error.
 */
export function validateLoadedRegistry(registry: Registry, source = "apps.json"): Registry {
  const problems = registryProblems(registry);
  if (problems.length) throw new Error(`${source}: ${problems.length} registry problem(s); run registry:check:\n  ${problems.join("\n  ")}`);
  return registry;
}

// -- processes ----------------------------------------------------------------

/** A process and its identity: pid plus start time, so a reused pid is never mistaken for it. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
}

/** A process the run started: its pid and its start time, and the child handle when this process spawned it. */
export interface RootProc {
  pid: number;
  started: string;
  /** While this child has not exited, its pid is still ours (an unreaped pid is never reused), whatever ps says. */
  child?: { exitCode: number | null; signalCode: NodeJS.Signals | string | null };
}

const normalizeStart = (text: string) => text.trim().split(/\s+/).join(" ");

/** ps and lsof run by absolute path (system-bin.ts) with a system-only PATH and the C locale. */
const SYSTEM_ENV = { PATH: SYSTEM_PATH, LANG: "C", LC_ALL: "C" };

/** `ps` and `lsof` never hang a stop: each call is killed after this long and counts as failed. */
const PS_TIMEOUT_MS = 10_000;
const LSOF_TIMEOUT_MS = 10_000;

/**
 * Every process with its identity, or null when `ps` fails (error, timeout, non-zero exit or an empty
 * table, which happens under fork pressure) `attempts` times. Null is "unknown", never "nothing running".
 */
function readProcessTable(attempts = 3, timeout = PS_TIMEOUT_MS): ProcInfo[] | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = spawnSync(SYSTEM_BIN.ps, ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout, env: SYSTEM_ENV });
    if (result.error || result.status !== 0) continue;
    const procs: ProcInfo[] = [];
    for (const line of (result.stdout ?? "").split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [pid, ppid, pgid] = cols.slice(0, 3).map(Number) as [number, number, number];
      if (![pid, ppid, pgid].every(Number.isInteger)) continue;
      procs.push({ pid, ppid, pgid, started: cols.slice(3).join(" ") });
    }
    if (procs.some((proc) => proc.pid === process.pid)) return procs;
  }
  return null;
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `ps -o lstart=` of a pid (whitespace normalized), or "" when it is gone or `ps` keeps failing. */
function startTime(pid: number): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync(SYSTEM_BIN.ps, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS, env: SYSTEM_ENV });
    const started = normalizeStart(result.stdout ?? "");
    if (started || (!result.error && !exists(pid))) return started;
  }
  return "";
}

/** The identity of a process this run started; pass the child handle when this process spawned it. */
export function rootProc(pid: number, child?: RootProc["child"]): RootProc {
  return { pid, started: startTime(pid), ...(child ? { child } : {}) };
}

/** A root this process spawned and that has not exited yet: its pid and process group are certainly ours. */
function unreaped(root: RootProc): boolean {
  return root.child !== undefined && root.child.exitCode === null && root.child.signalCode === null;
}

let ownPgid: number | undefined;
/** This process's group (read once while `ps` works; importing the runner runs no `ps`). Never signalled. */
function OWN_PGID(): number {
  return (ownPgid ??= readProcessTable()?.find((p) => p.pid === process.pid)?.pgid ?? process.pid);
}

/** The processes of `procs` that still exist with the same start time, with their current pgid. */
function stillRunning(procs: readonly ProcInfo[], table: readonly ProcInfo[]): ProcInfo[] {
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  const out: ProcInfo[] = [];
  for (const proc of procs) {
    const now = byPid.get(proc.pid);
    if (now && now.started === normalizeStart(proc.started)) out.push(now);
  }
  return out;
}

/**
 * The run's processes: descendants of its roots, plus every member of their process groups. A root whose
 * pid now belongs to a different process (start time changed) is dropped with its group: the pid was reused.
 * The group of a root that has exited counts only while one of its members is a `known` run process with
 * the same start time: once every member is gone, the group id can belong to a stranger that got the pid.
 */
function runProcesses(roots: RootProc[], table: readonly ProcInfo[], known: readonly ProcInfo[] = []): ProcInfo[] {
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  const provenGroups = new Set(stillRunning(known, table).map((proc) => proc.pgid));
  const rootPids: number[] = [];
  const groups = new Set<number>();
  for (const root of roots) {
    const now = byPid.get(root.pid);
    if (unreaped(root) || (now && now.started === normalizeStart(root.started))) {
      rootPids.push(root.pid);
      groups.add(root.pid);
    } else if (!now && provenGroups.has(root.pid)) groups.add(root.pid); // exited root: its group lives on in known members
  }
  const found = new Map<number, ProcInfo>();
  const queue = [...rootPids];
  while (queue.length) {
    const pid = queue.pop()!;
    for (const proc of table) {
      if ((proc.pid === pid || proc.ppid === pid) && !found.has(proc.pid)) {
        found.set(proc.pid, proc);
        if (proc.ppid === pid) queue.push(proc.pid);
      }
    }
  }
  for (const proc of table) if (groups.has(proc.pgid)) found.set(proc.pid, proc);
  found.delete(process.pid);
  return [...found.values()];
}

/** Runs lsof with a timeout; null when it fails (exit 1 with no message is "nothing matched", not a failure). */
function lsofSync(args: string[]): string | null {
  const result = spawnSync(SYSTEM_BIN.lsof, args, { encoding: "utf8", timeout: LSOF_TIMEOUT_MS, env: SYSTEM_ENV });
  if (result.error) return null;
  if (result.status === 0 || (result.status === 1 && !(result.stderr ?? "").trim())) return result.stdout ?? "";
  return null;
}

/** TCP ports in LISTEN state held by these pids; [] when lsof fails (the guard then allows nothing new). */
function listeningPorts(pids: number[]): number[] {
  if (pids.length === 0) return [];
  const out = lsofSync(["-nP", "-w", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fn"]) ?? "";
  const ports = new Set<number>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Pids listening on a TCP port (any process), or null when lsof fails. */
function portListeners(port: number): number[] | null {
  const out = lsofSync(["-nP", "-w", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function signal(target: number, sig: NodeJS.Signals) {
  try {
    process.kill(target, sig);
  } catch {
    // already gone
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Signals the processes of `procs` that are still the same processes (pid and start time checked against
 * `table`, read just before), and their current process groups: a group is signalled only while one of
 * its members is a revalidated run process, so its id cannot have been reused. Never this process or its
 * own group.
 */
function signalRun(procs: readonly ProcInfo[], sig: NodeJS.Signals, table: readonly ProcInfo[]): number {
  const live = stillRunning(procs, table).filter((proc) => proc.pid !== process.pid);
  const groups = new Set(live.map((proc) => proc.pgid).filter((pgid) => pgid > 1 && pgid !== OWN_PGID()));
  for (const pgid of groups) signal(-pgid, sig);
  for (const proc of live) signal(proc.pid, sig);
  return live.length;
}

/**
 * The fallback when `ps` fails: the process groups of the roots this process spawned and has not reaped
 * (each was spawned detached, so its pid is its group id, and an unreaped pid cannot be reused). An exited
 * root's group is not signalled blind: without `ps` nothing proves the id is still the run's. What that
 * leaves stays in `live` (unconfirmed), and the watchdog kills the group when this process exits.
 */
function signalRootGroups(roots: readonly RootProc[], sig: NodeJS.Signals) {
  for (const root of roots) {
    if (!unreaped(root) || root.pid <= 1 || root.pid === process.pid || root.pid === OWN_PGID()) continue;
    signal(-root.pid, sig);
    signal(root.pid, sig);
  }
}

export interface KillResult {
  /** Every run process is gone, read from a working process table. False when `ps` failed or some survived. */
  confirmed: boolean;
  /** Run processes still alive at the end (empty when unknown). */
  left: ProcInfo[];
}

/**
 * Stops a run's processes: SIGTERM, wait, SIGKILL, to the roots' descendants and process groups, plus
 * `known` processes seen earlier (a descendant that left its group). Every process is revalidated by
 * start time before each signal. When `ps` fails, the roots' process groups are signalled instead (the
 * recorded group ids), and the result is unconfirmed.
 */
export async function killRun(roots: RootProc[], graceMs = 8_000, known: readonly ProcInfo[] = []): Promise<KillResult> {
  const first = readProcessTable();
  const captured = new Map<number, ProcInfo>();
  if (first) for (const proc of [...stillRunning(known, first), ...runProcesses(roots, first, known)]) if (proc.pid !== process.pid) captured.set(proc.pid, proc);
  const procs = [...captured.values()];
  // Roots this process spawned (detached, so each leads its own group) are signalled from their child
  // handle too: that needs no `ps`, so a failing process table can never leave a root running.
  const signalAll = (sig: NodeJS.Signals) => {
    const own = roots.filter(unreaped);
    for (const root of own) {
      signal(-root.pid, sig);
      signal(root.pid, sig);
    }
    const table = readProcessTable(1);
    if (!table) {
      signalRootGroups(roots, sig);
      return own.length + 1; // unknown: assume something is left
    }
    return signalRun([...procs, ...runProcesses(roots, table, procs)], sig, table) + own.length;
  };
  const left = (): ProcInfo[] | null => {
    const table = readProcessTable(1);
    if (!table) return null;
    const alive = new Map<number, ProcInfo>();
    for (const proc of [...stillRunning(procs, table), ...runProcesses(roots, table, procs)]) if (proc.pid !== process.pid) alive.set(proc.pid, proc);
    return [...alive.values()];
  };
  const anyLeft = () => {
    if (roots.some(unreaped)) return true;
    const now = left();
    return now === null || now.length > 0;
  };
  if (first && procs.length === 0 && !roots.some(unreaped)) return { confirmed: true, left: [] };
  signalAll("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && anyLeft()) await sleep(100);
  if (anyLeft()) signalAll("SIGKILL");
  const hard = Date.now() + 3_000;
  while (Date.now() < hard && anyLeft()) await sleep(50);
  const final = left();
  return { confirmed: final !== null && final.length === 0 && !roots.some(unreaped), left: final ?? [] };
}

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

interface Spawned {
  child: ChildProcess;
  /** Output so far, ANSI stripped. */
  output(): string;
  exited(): number | null;
}

/**
 * The run dies with this tool: a watchdog in the run's process group reads a pipe (fd 3) whose only
 * write end this process holds, and kills the group at EOF. EOF comes when this process exits by any
 * route, SIGKILL included, so no hook has to run. The command itself does not get fd 3.
 */
function withWatchdog(cmd: string): string {
  return `{ cat >/dev/null; kill -KILL 0; } <&3 &\n{\n${cmd}\n} 3<&-`;
}

/** Spawns `sh -c cmd` in its own process group (with the watchdog), inside the sandbox when `policy` is set. */
function spawnLogged(cmd: string, cwd: string, env: Record<string, string>, logPath: string, policy: SandboxPolicy | null): Spawned {
  appendFileSync(logPath, `\n$ ${cmd}\n  (cwd ${cwd}${policy ? ", sandboxed" : ", NOT SANDBOXED"})\n`);
  const shell = ["/bin/sh", "-c", withWatchdog(cmd)];
  const argv = policy ? sandboxCommand(policy, shell) : shell;
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let text = "";
  const onData = (chunk: Buffer) => {
    appendFileSync(logPath, chunk);
    text += stripAnsi(chunk.toString("utf8"));
    if (text.length > 1_000_000) text = text.slice(-500_000);
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  let code: number | null = null;
  child.on("exit", (exitCode, sig) => {
    code = exitCode ?? (sig ? 128 : 1);
    appendFileSync(logPath, `\n[exit ${exitCode ?? sig}] ${cmd}\n`);
  });
  child.on("error", (error) => {
    code = 127;
    appendFileSync(logPath, `\n[spawn error] ${error.message}\n`);
  });
  return { child, output: () => text, exited: () => code };
}

/**
 * Runs one command to completion in its own process group; kills strays it left behind. While it runs,
 * its root is in `roots`, so a stop() (Ctrl-C) during a build stops the build too.
 */
async function runToExit(
  cmd: string,
  cwd: string,
  env: Record<string, string>,
  logPath: string,
  timeoutMs: number,
  roots: RootProc[],
  policy: SandboxPolicy | null,
  known: () => readonly ProcInfo[] = () => [],
): Promise<number> {
  const proc = spawnLogged(cmd, cwd, env, logPath, policy);
  const pid = proc.child.pid;
  if (!pid) throw new Error(`failed to spawn ${cmd}`);
  const root = rootProc(pid, proc.child);
  roots.push(root);
  try {
    const deadline = Date.now() + timeoutMs;
    while (proc.exited() === null && Date.now() < deadline) await sleep(100);
    // Strays the command left in its group: the sampler saw them while the root ran (known).
    await killRun([root], 2_000, known());
  } finally {
    roots.splice(roots.indexOf(root), 1);
  }
  const code = proc.exited();
  if (code === null) throw new Error(`timed out after ${timeoutMs} ms: ${cmd} (see ${logPath})`);
  return code;
}

// -- ready URL ----------------------------------------------------------------

/**
 * Reads the served URL from (ANSI-stripped) server output. The pattern's first capture group holds the
 * URL, or a bare port. Wildcard hosts become 127.0.0.1. Returns null until the pattern matches.
 */
export function readyUrl(output: string, pattern: string): { baseUrl: string; port: number } | null {
  const match = new RegExp(pattern, "m").exec(stripAnsi(output));
  if (!match) return null;
  const captured = (match[1] ?? match[0]).trim();
  if (/^\d+$/.test(captured)) return { baseUrl: `http://127.0.0.1:${captured}`, port: Number(captured) };
  const url = new URL(captured);
  if (["0.0.0.0", "[::]"].includes(url.hostname)) url.hostname = "127.0.0.1";
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, port };
}

// -- run state, shutdown --------------------------------------------------------

interface Internal {
  roots: RootProc[];
  /** Every run process seen so far, by pid (identity revalidated before use). */
  known: Map<number, ProcInfo>;
  /** static mode without run.start: the port of the built-in server (in this process) while it serves. */
  staticPort?: number;
  /** The run's current listeners, as last read. */
  portCache?: { at: number; ports: Set<number> };
  /** Every socket egress sampling saw ("pid local->remote"). */
  sockets: Set<string>;
  /** Electron only, while its launch is in flight or after a stop() that raced it: kill it synchronously. */
  lateKill?: () => void;
}
const internals = new WeakMap<RunningApp, Internal>();
/**
 * Runs this process started and has not confirmed stopped: a run leaves only when its stop() saw every
 * one of its processes gone (from a working `ps`). The exit hook and a second signal SIGKILL what is here.
 */
const live = new Set<RunningApp>();
/** Set by the signal and crash handlers and at exit: no new run may start. */
let shuttingDown = false;

/**
 * For CLI signal handlers: stop every app this process started and has not stopped, and wait for stops
 * already in flight (a tool's own stop() racing the signal), so nothing is left when the process exits.
 */
export async function stopAllApps(): Promise<void> {
  await Promise.allSettled([...live].map((running) => running.stop()));
}

/**
 * SIGKILL every live run's processes now, synchronously (the exit hook, a second signal): revalidated run
 * processes and their groups from one `ps` read, and the roots' own groups when `ps` fails.
 */
function killAllNow() {
  shuttingDown = true;
  const runs = [...live].map((running) => internals.get(running)).filter((internal): internal is Internal => Boolean(internal));
  if (runs.length === 0) return;
  const table = readProcessTable(1, 5_000);
  for (const internal of runs) {
    for (const root of internal.roots.filter(unreaped)) {
      signal(-root.pid, "SIGKILL");
      signal(root.pid, "SIGKILL");
    }
    if (table) signalRun([...stillRunning([...internal.known.values()], table), ...runProcesses(internal.roots, table, [...internal.known.values()])], "SIGKILL", table);
    else signalRootGroups(internal.roots, "SIGKILL");
    internal.lateKill?.();
  }
}

let exitHookInstalled = false;

/** At process exit (normal, process.exit, crash): SIGKILL every live run's processes, synchronously. */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killAllNow);
}

const signalCleanups = new Set<() => unknown>();
let signalHandlersInstalled = false;
let crashHandlersInstalled = false;
let exiting = false;
const SIGNAL_EXIT: Record<"SIGINT" | "SIGTERM" | "SIGHUP", number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * First signal or crash: refuse new runs, run the cleanups (close the browser), stop every app this
 * process started, then exit with `code`. A second signal while that runs SIGKILLs every live run at once
 * and exits.
 */
function shutdown(reason: string, code: number) {
  shuttingDown = true;
  if (exiting) {
    console.error(`\n${reason} again: killing the apps this process started now`);
    killAllNow();
    process.exit(code);
  }
  exiting = true;
  console.error(`\n${reason}: stopping the apps this process started...`);
  const bounded = (fn: () => unknown) => Promise.race([Promise.resolve().then(fn), sleep(10_000)]);
  void Promise.allSettled([...signalCleanups].map(bounded))
    .then(() => stopAllApps())
    .finally(() => process.exit(code));
}

/**
 * SIGINT, SIGTERM and SIGHUP handlers (exit 130, 143, 129). startApp installs them for every process
 * that starts an app: Bun runs exit hooks on SIGINT but not on SIGTERM or SIGHUP, so without them those
 * signals would leave the run to the watchdog. Launch browsers with LAUNCH_OPTIONS (handleSIG* false) so
 * Playwright does not exit first.
 */
function installRunSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => shutdown(sig, SIGNAL_EXIT[sig]));
}

/**
 * For CLIs: the signal handlers startApp installs anyway, plus an uncaught exception or unhandled
 * rejection (exit 1) handled the same way, and `cleanup` (close the browser) run before the apps are
 * stopped. Returns a function that removes `cleanup`.
 */
export function installSignalHandlers(cleanup?: () => unknown): () => void {
  if (cleanup) signalCleanups.add(cleanup);
  installRunSignalHandlers();
  if (!crashHandlersInstalled) {
    crashHandlersInstalled = true;
    process.on("uncaughtException", (error) => {
      console.error(error);
      shutdown("uncaught exception", 1);
    });
    process.on("unhandledRejection", (error) => {
      console.error(error);
      shutdown("unhandled rejection", 1);
    });
  }
  return () => {
    if (cleanup) signalCleanups.delete(cleanup);
  };
}

function addViolation(running: RunningApp, message: string) {
  running.violations ??= [];
  if (running.violations.includes(message) || running.violations.length > MAX_VIOLATIONS) return;
  running.violations.push(running.violations.length === MAX_VIOLATIONS ? `more than ${MAX_VIOLATIONS} violations; see ${running.logPath}` : message);
  try {
    appendFileSync(running.logPath, `# VIOLATION ${message}\n`);
  } catch {
    // the log dir is gone after stop()
  }
}

/** Records listening ports in startedPorts; an owner port is never added, it is a violation instead. */
function recordListeners(running: RunningApp, ports: number[]) {
  for (const port of ports) {
    if (OWNER_PORTS.includes(port)) addViolation(running, `a run process listens on owner port ${port}`);
    else if (!running.startedPorts.includes(port)) running.startedPorts.push(port);
  }
  running.startedPorts.sort((a, b) => a - b);
}

/**
 * Re-reads the ports the run's processes listen on into running.startedPorts. An owner port is never
 * added (so the guard can never allow it); it is recorded in running.violations instead.
 */
export function refreshStartedPorts(running: RunningApp): number[] {
  ownPorts(running, 0);
  return running.startedPorts;
}

/**
 * The local ports that belong to the run right now: what its processes listen on (read with lsof at
 * most `maxAgeMs` ago) plus the built-in static server while it serves. Owner ports never.
 */
function ownPorts(running: RunningApp, maxAgeMs = PORT_CACHE_MS): Set<number> {
  const internal = internals.get(running);
  if (!internal) return new Set(running.startedPorts.filter((port) => !OWNER_PORTS.includes(port)));
  if (internal.portCache && Date.now() - internal.portCache.at <= maxAgeMs) return internal.portCache.ports;
  const table = readProcessTable(1);
  const listening = table ? listeningPorts(runProcesses(internal.roots, table, [...internal.known.values()]).map((proc) => proc.pid)) : [];
  recordListeners(running, listening);
  const ports = new Set([...listening, ...(internal.staticPort ? [internal.staticPort] : [])].filter((port) => !OWNER_PORTS.includes(port)));
  internal.portCache = { at: Date.now(), ports };
  return ports;
}

/**
 * The run's processes now (descendants, groups, and earlier-seen ones still alive); new ones are recorded.
 * Null when `ps` fails: the run's processes are then unknown.
 */
function captureProcesses(internal: Internal, persist: () => void): ProcInfo[] | null {
  const table = readProcessTable();
  if (!table) return null;
  const before = internal.known.size;
  const procs = [...runProcesses(internal.roots, table, [...internal.known.values()]), ...stillRunning([...internal.known.values()], table)];
  for (const proc of procs) if (!internal.known.has(proc.pid)) internal.known.set(proc.pid, proc);
  if (internal.known.size !== before) persist();
  return procs;
}

/** One egress sample: the run's processes, their identities, their TCP sockets; violations recorded. */
async function sampleEgress(running: RunningApp, internal: Internal, egress: EgressStats, persist: () => void) {
  const procs = captureProcesses(internal, persist);
  if (!procs) {
    egress.failures.push("ps failed: the run's processes are unknown");
    addViolation(running, "egress sampling failed, isolation unproven: ps failed, the run's processes are unknown");
    return;
  }
  const pids = [...new Set(procs.map((proc) => proc.pid))].filter((pid) => pid !== process.pid);
  if (pids.length === 0) return;
  const result = await lsofConnections(pids);
  egress.samples++;
  if (!result.ok) {
    egress.failures.push(result.reason);
    addViolation(running, `egress sampling failed, isolation unproven: ${result.reason}`);
    return;
  }
  for (const conn of result.conns) internal.sockets.add(`${conn.pid} ${conn.raw.split(/\s+/).slice(8).join(" ")}`);
  egress.connections = internal.sockets.size;
  const listening = result.conns.filter((conn) => !conn.remote && conn.state === "LISTEN").map((conn) => conn.local.port);
  recordListeners(running, listening);
  const current = [...listening, ...(internal.staticPort ? [internal.staticPort] : [])];
  internal.portCache = { at: Date.now(), ports: new Set(current.filter((port) => !OWNER_PORTS.includes(port))) };
  // Outbound: the run's current listeners, its named profile ports (its own block; a dead kernel URL the
  // profile points at on purpose), the profile's allowedLocalPorts. Inbound: any port it listened on.
  const outbound = new Set([...current, ...Object.values(running.ports), ...(running.app.runProfile?.allowedLocalPorts ?? [])]);
  const inbound = new Set([...current, ...running.startedPorts]);
  for (const conn of egressConnections(result.conns, { inbound, outbound })) addViolation(running, describeConnection(conn));
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function realTmpRoot(): string {
  return realpathSync(tmpdir());
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function appCwd(app: AppEntry, root: string, cwd: string | undefined): string {
  return resolvePath(root, cwd ?? app.commands?.cwd ?? app.root);
}

/** A served URL the run may contact while it starts: loopback, one of the app's profile ports, never an owner port. */
function checkReadyUrl(app: AppEntry, ready: { baseUrl: string; port: number }, ports: Record<string, number>) {
  const url = new URL(ready.baseUrl);
  if (!isLoopbackHost(url.hostname)) throw new Error(`${app.id}: the ready URL ${ready.baseUrl} is not a loopback address; check run.readyPattern`);
  if (OWNER_PORTS.includes(ready.port)) throw new Error(`${app.id}: the ready URL ${ready.baseUrl} is on owner port ${ready.port}`);
  if (!Object.values(ports).includes(ready.port))
    throw new Error(`${app.id}: the ready URL ${ready.baseUrl} is not on one of its profile ports (${JSON.stringify(ports)}); check run.readyPattern`);
}

/** The Playwright loader app-runner's electron preload wraps (from the playwright-core that Playwright uses). */
function playwrightElectronLoader(root: string): string {
  const playwrightPkg = createRequire(playwrightAnchor(root)).resolve("playwright/package.json");
  return join(dirname(createRequire(playwrightPkg).resolve("playwright-core/package.json")), "lib/server/electron/loader.js");
}

/**
 * The executable Playwright launches for Electron: a script that writes its pid (Electron's, after exec)
 * to `pidFile`, so egress sampling covers Electron from its first instruction, then execs Electron inside
 * the sandbox with `--no-sandbox` (Chromium cannot install its own Seatbelt sandbox inside ours). `dir` is
 * the tool's own dir, never one the run can write: this script runs outside the sandbox.
 */
function electronLauncher(dir: string, executablePath: string, policy: SandboxPolicy | null): { path: string; pidFile: string } {
  const pidFile = join(dir, "electron.pid");
  const argv = policy ? sandboxCommand(policy, [executablePath, "--no-sandbox"]) : [executablePath];
  const path = join(dir, "electron");
  writeFileSync(path, `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec ${argv.map(shellQuote).join(" ")} "$@"\n`, { mode: 0o700 });
  return { path, pidFile };
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Set to "1" in the tool's environment to run an Electron app at all (decision 23). */
export const ELECTRON_OPT_IN = "DS_ALLOW_ELECTRON";

function writeJsonAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(partial, path);
}

/** The ten ports of a block, or none. */
function blockPorts(block: PortBlock | null): number[] {
  return block ? Array.from({ length: block.size }, (_, i) => block.start + i) : [];
}

export async function startApp(app: AppEntry, opts: StartOptions): Promise<RunningApp> {
  if (shuttingDown) throw new Error(`${app?.id}: this process is shutting down; no new runs`);
  const mode = app.run?.mode;
  if (!mode || mode === "none")
    throw new Error(`${app.id}: run mode none (${app.run?.reason ?? "no reason given"}): no screenshots and no runtime checks`);
  if (!app.runProfile) throw new Error(`${app.id}: no run profile`);
  safeAppId(app.id);
  if (mode === "electron" && process.env[ELECTRON_OPT_IN] !== "1")
    throw new Error(
      `${app.id}: Electron runs are refused (decision 23): cfprefsd writes the owner's ~/Library/Preferences/com.github.Electron.plist, which the sandbox cannot stop; set ${ELECTRON_OPT_IN}=1 only where that is acceptable`,
    );
  const unproven = app.runProfile.proof?.status !== "proven";
  if (unproven && !opts.allowUnproven)
    throw new Error(`${app.id}: run profile is ${app.runProfile.proof?.status ?? "missing"}; only a proven profile runs`);
  const root = resolve(opts.root);
  const outDir = safeOutputPath(opts.outDir, { root, label: `${app.id}: outDir` });
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const block = profileBlock(app, opts.registry);
  checkProfilePorts(app, block);
  OWN_PGID(); // read while `ps` works, before any signal may need it
  const noSandbox = sandboxUnavailable();
  if (noSandbox && !opts.allowUnsandboxed) throw new Error(`${app.id}: refusing to start without the OS sandbox: ${noSandbox}`);
  for (const [name, port] of Object.entries(app.runProfile.ports ?? {})) {
    const holders = portListeners(port);
    if (holders === null) throw new Error(`${app.id}: cannot check whether port ${name}=${port} is free (lsof failed)`);
    if (holders.length) throw new Error(`${app.id}: port ${name}=${port} is in use (pid ${holders.join(", ")}); a previous run may still be up`);
  }
  installRunSignalHandlers();
  installExitHook();

  const logDir = join(outDir, app.id, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${stamp()}-${mode}.log`);
  const tmp = mkdtempSync(join(realTmpRoot(), `ds-run-${app.id}-`));
  // The tool's own scratch (the Electron launcher): in the shared temp dir, which the run cannot write.
  const toolDir = mkdtempSync(join(realTmpRoot(), `ds-tool-${app.id}-`));
  appendFileSync(logPath, `# ${app.id} run mode ${mode}, root ${root}, tmp ${tmp}\n`);
  if (unproven) {
    const warning = `!!! ${app.id}: RUNNING AN UNPROVEN PROFILE (allowUnproven). Use only to prove the profile; never for gates.`;
    console.error(warning);
    appendFileSync(logPath, `${warning}\n`);
  }
  const policy = noSandbox
    ? null
    : runPolicy({
        root,
        tmp,
        outDir,
        blockPorts: blockPorts(block),
        allowedLocalPorts: app.runProfile.allowedLocalPorts ?? [],
        bindAnyPort: mode === "electron",
      });
  if (noSandbox) {
    const warning = `!!! ${app.id}: RUNNING WITHOUT THE OS SANDBOX (allowUnsandboxed): ${noSandbox}. Proof/debug only; never for gates.`;
    console.error(warning);
    appendFileSync(logPath, `${warning}\n`);
  } else {
    appendFileSync(logPath, `# sandbox profile:\n${sandboxProfile(policy!)}`);
  }

  const ports = { ...(app.runProfile.ports ?? {}) };
  const ctx: PlaceholderContext = { root, tmp, ports };
  const expand = (text: string) => expandPlaceholders(text, ctx);
  const roots: RootProc[] = [];
  const internal: Internal = { roots, known: new Map(), sockets: new Set() };
  const knownProcs = () => [...internal.known.values()];
  /** Settles when an Electron launch in flight has resolved or failed (undefined when none is). */
  let launchSettled: Promise<any> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let electronApp: any;
  let electronPidFile: string | undefined;
  const served = new Set<string>();
  let stopping: Promise<void> | undefined;

  const egress: EgressStats = { samples: 0, failures: [], connections: 0 };
  // In the out dir, which the sandbox keeps read-only for the run: no run process can forge or edit it.
  const recordPath = join(outDir, "runs", `${app.id}.json`);
  const tool = { pid: process.pid, started: startTime(process.pid) };
  const persist = () =>
    writeJsonAtomic(recordPath, {
      version: 2,
      app: app.id,
      tool,
      tmp,
      toolDir,
      logPath,
      roots: roots.map(({ pid, started }) => ({ pid, started })),
      processes: [...internal.known.values()].map(({ pid, pgid, started }) => ({ pid, pgid, started })),
    });
  /** A new root: recorded at once, so a crash right after the spawn still leaves its identity on disk. */
  const adopt = (pid: number, child?: RootProc["child"]) => {
    const known = roots.find((root) => root.pid === pid);
    if (known) {
      if (child && !known.child) known.child = child;
      return;
    }
    roots.push(rootProc(pid, child));
    persist();
    captureProcesses(internal, persist);
  };
  /** Electron's pid from its launcher's pid file, only while it is still this process's child (else null). */
  const electronChild = (): number | null => {
    if (!electronPidFile || !existsSync(electronPidFile)) return null;
    const pid = Number(readFileSync(electronPidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    return readProcessTable(1)?.find((proc) => proc.pid === pid)?.ppid === process.pid ? pid : null;
  };
  let sampling = true;
  let wake: (() => void) | undefined;
  const sampleOnce = async () => {
    try {
      // Adopt Electron from its launcher's pid file only while it is still our child: a pid read after
      // Electron exited could already belong to another process.
      const pid = electronChild();
      if (pid !== null) {
        adopt(pid);
        electronPidFile = undefined;
      }
    } catch (error) {
      egress.failures.push(`adopting Electron failed: ${String(error).split("\n")[0]}`);
      addViolation(running, `isolation unproven: adopting Electron failed: ${String(error).split("\n")[0]}`);
    }
    await sampleEgress(running, internal, egress, persist).catch((error) => {
      egress.failures.push(String(error));
      addViolation(running, `egress sampling failed, isolation unproven: ${String(error).split("\n")[0]}`);
    });
  };

  const removeScratch = () => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(toolDir, { recursive: true, force: true });
  };
  const doStop = async () => {
    sampling = false;
    wake?.();
    await sampler;
    await sampleOnce(); // the last look before anything is killed (adopts a launching Electron too)
    // An Electron launch in flight: kill it from its pid file now, then let the launch settle (it fails, or
    // resolves and startApp's stopped-while-starting path ends it) before this stop may count as done.
    let launchOpen = false;
    if (launchSettled) {
      internal.lateKill?.();
      const settled = await Promise.race([launchSettled.then((app) => ({ app })), sleep(15_000).then(() => null)]);
      launchOpen = settled === null;
      // A launch that resolved anyway: its Electron becomes a root here, so the kill below covers it.
      const child = settled?.app?.process?.();
      if (child?.pid && !roots.some((root) => root.pid === child.pid)) roots.push(rootProc(child.pid, child));
    }
    if (electronApp) await Promise.race([electronApp.close().catch(() => undefined), sleep(10_000)]);
    server?.stop(true);
    internal.staticPort = undefined;
    const kill = await killRun(roots, 8_000, [...internal.known.values()]);
    const check = [...new Set([...running.startedPorts, ...Object.values(ports)])];
    let busy: string[] = [];
    for (let i = 0; i < 20; i++) {
      busy = check.flatMap((port) => {
        const holders = portListeners(port);
        if (holders === null) return [`:${port} (unknown: lsof failed)`];
        return holders.length ? [`:${port} (pid ${holders.join(", ")})`] : [];
      });
      if (busy.length === 0) break;
      await sleep(100);
    }
    removeScratch();
    const unconfirmed = launchOpen
      ? "an Electron launch did not settle"
      : kill.confirmed
        ? ""
        : kill.left.length
          ? `pids ${kill.left.map((proc) => proc.pid).join(", ")} still running`
          : "ps failed";
    appendFileSync(
      logPath,
      `\n# stopped${unconfirmed ? ` (NOT CONFIRMED: ${unconfirmed})` : ""}${busy.length ? `; still bound: ${busy.join(", ")}` : "; ports free"}; ${egress.samples} egress samples\n`,
    );
    if (unconfirmed) throw new Error(`${app.id}: could not confirm the run stopped (${unconfirmed}); its record ${recordPath} stays for --cleanup`);
    // Confirmed: the run leaves `live` (the exit hook has nothing more to kill) and its record goes.
    live.delete(running);
    rmSync(recordPath, { force: true });
    if (busy.length) throw new Error(`${app.id}: ports still bound after stop, not by this run's processes: ${busy.join(", ")}`);
  };

  const running: RunningApp = {
    app,
    root,
    ports,
    startedPorts: [],
    tmp,
    env: {},
    logPath,
    egress,
    // Memoized: a second caller (a signal handler during a failed start) waits for the same stop. A run
    // whose kill is not confirmed stays in `live`, so the exit hook and a second signal still SIGKILL it.
    stop: () => (stopping ??= doStop()),
  };
  if (unproven) running.unproven = true;
  if (noSandbox) running.unsandboxed = true;
  internals.set(running, internal);
  live.add(running);
  // Sampling starts before the first spawn, so nothing a run process does at startup goes unobserved.
  const sampler = (async () => {
    while (sampling) {
      await sampleOnce();
      if (sampling) await new Promise<void>((done) => ((wake = done), setTimeout(done, SAMPLE_INTERVAL_MS)));
    }
  })();
  /** After every await: a stop() that ran meanwhile (Ctrl-C) aborts the start before it creates more. */
  const stillStarting = () => {
    if (stopping) throw new Error(`${app.id}: stopped while starting`);
  };

  try {
    persist();
    const flags = (app.runProfile.flags ?? []).map(expand);
    copyFixtures(app, tmp);
    running.env = profileEnv(app, { root, tmp });
    const env = running.env;
    appendFileSync(logPath, `# env keys: ${Object.keys(env).sort().join(" ")}\n`);

    if (mode === "browser" || (mode === "static" && app.run.start)) {
      if (!app.run.start || !app.run.readyPattern) throw new Error(`${app.id}: run mode ${mode} needs run.start and run.readyPattern`);
      let cmd = expand(app.run.start);
      const flagText = flags.map(shellQuote).join(" ");
      cmd = cmd.includes("{flags}") ? cmd.replaceAll("{flags}", flagText) : flagText ? `${cmd} ${flagText}` : cmd;
      const cwd = appCwd(app, root, app.run.cwd);
      running.serveRoot = app.run.serveRoot
        ? resolvePath(root, expand(app.run.serveRoot))
        : app.run.staticDir
          ? resolvePath(root, expand(app.run.staticDir))
          : cwd;
      const proc = spawnLogged(cmd, cwd, env, logPath, policy);
      if (!proc.child.pid) throw new Error(`${app.id}: failed to spawn ${cmd}`);
      adopt(proc.child.pid, proc.child);
      const deadline = Date.now() + timeoutMs;
      let ready: ReturnType<typeof readyUrl> = null;
      while (!(ready = readyUrl(proc.output(), app.run.readyPattern))) {
        if (proc.exited() !== null) throw new Error(`${app.id}: start command exited (code ${proc.exited()}) before it printed a ready URL; see ${logPath}`);
        if (Date.now() > deadline) throw new Error(`${app.id}: no output matched readyPattern ${app.run.readyPattern} within ${timeoutMs} ms; see ${logPath}`);
        await sleep(100);
        stillStarting();
      }
      // Before the first request: the URL must be the app's own loopback profile port.
      checkReadyUrl(app, ready, ports);
      running.baseUrl = ready.baseUrl;
      while (true) {
        if (proc.exited() !== null) throw new Error(`${app.id}: start command exited (code ${proc.exited()}); see ${logPath}`);
        if (Date.now() > deadline) throw new Error(`${app.id}: ${ready.baseUrl} did not answer within ${timeoutMs} ms; see ${logPath}`);
        const answered = await fetch(`${ready.baseUrl}/`, { redirect: "manual", signal: AbortSignal.timeout(2_000) }).then(
          () => true,
          () => false,
        );
        stillStarting();
        if (answered) break;
        await sleep(200);
      }
      if (!ownPorts(running, 0).has(ready.port))
        throw new Error(`${app.id}: ${ready.baseUrl} is not served by this run's processes (they listen on ${running.startedPorts.join(", ") || "nothing"})`);
    } else if (mode === "static") {
      if (!app.run.staticDir) throw new Error(`${app.id}: run mode static needs run.staticDir (or run.start)`);
      if (!app.commands?.build) throw new Error(`${app.id}: run mode static needs commands.build`);
      const code = await runToExit(expand(app.commands.build), appCwd(app, root, app.commands.cwd), env, logPath, timeoutMs, roots, policy, knownProcs);
      stillStarting();
      if (code !== 0) throw new Error(`${app.id}: build exited ${code}; see ${logPath}`);
      const dir = resolvePath(root, expand(app.run.staticDir));
      if (!existsSync(dir)) throw new Error(`${app.id}: staticDir ${dir} does not exist after the build`);
      const port = ports.http ?? ports.ui ?? ports.web ?? Object.values(ports)[0];
      if (port === undefined) throw new Error(`${app.id}: run mode static needs a profile port`);
      const dirReal = realpathSync(dir);
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => serveStatic(dir, dirReal, request, served) });
      internal.staticPort = port;
      internal.portCache = undefined;
      running.serveRoot = dir;
      running.baseUrl = `http://127.0.0.1:${port}`;
      running.startedPorts.push(port);
      running.servedFiles = () => [...served].sort();
      appendFileSync(logPath, `# serving ${dir} on ${running.baseUrl}\n`);
    } else if (mode === "electron") {
      if (!app.run.electron) throw new Error(`${app.id}: run mode electron needs run.electron`);
      const cwd = appCwd(app, root, app.run.cwd);
      const code = await runToExit(expand(app.run.electron.build), cwd, env, logPath, timeoutMs, roots, policy, knownProcs);
      stillStarting();
      if (code !== 0) throw new Error(`${app.id}: electron build exited ${code}; see ${logPath}`);
      const main = resolvePath(root, app.run.electron.main);
      if (!existsSync(main)) throw new Error(`${app.id}: electron main ${main} does not exist after the build`);
      let executablePath: string;
      try {
        executablePath = createRequire(join(resolvePath(root, app.root), "package.json"))("electron") as string;
      } catch (error) {
        throw new Error(`${app.id}: the electron package does not resolve from ${app.root}: ${String(error).split("\n")[0]}`);
      }
      const launcher = electronLauncher(toolDir, executablePath, policy);
      electronPidFile = launcher.pidFile;
      // A stop() or exit while the launch is in flight kills Electron from its pid file (it is our child).
      internal.lateKill = () => {
        const pid = electronChild();
        if (pid !== null) signal(pid, "SIGKILL");
      };
      const { _electron } = loadPlaywright(root);
      const listenersBefore = new Map(SIGNALS.map((sig) => [sig, new Set(process.listeners(sig))]));
      let launched: Promise<any> | undefined;
      try {
        launched = _electron.launch({
          executablePath: launcher.path,
          // Playwright adds its loader only without executablePath; ours loads it and holds `ready` (below).
          // Electron ignores $HOME on macOS: the loader moves userData & co. under {tmp}/electron-user-data,
          // and --user-data-dir covers Chromium's own early use of the profile dir.
          args: ["-r", ELECTRON_LOADER, `--user-data-dir=${join(tmp, "electron-user-data")}`, main, ...flags],
          cwd,
          // No CFFIXED_USER_HOME: cfprefsd ignores it (`CFFIXED_USER_HOME=<dir> defaults read <domain>` does not
          // read <dir>/Library/Preferences on macOS 26), so it cannot keep the owner's plist safe; hence the opt-in.
          env: { ...env, DS_PW_ELECTRON_LOADER: playwrightElectronLoader(root) },
          timeout: timeoutMs,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        });
        launchSettled = launched.then(
          (app) => app,
          () => undefined,
        );
        electronApp = await launched;
      } finally {
        // Playwright's Electron launcher installs its own signal handlers regardless of the options above;
        // they exit before stopAllApps runs. Remove exactly the ones the launch added.
        for (const sig of SIGNALS) for (const fn of process.listeners(sig)) if (!listenersBefore.get(sig)!.has(fn)) process.off(sig, fn as any);
      }
      const child = electronApp.process();
      if (stopping) {
        // stop() ran while Electron launched and has already finished: nothing tracks this process. End it
        // here, then let the stop's leftovers (the temp dirs Electron may have recreated) go too.
        await Promise.race([electronApp.close().catch(() => undefined), sleep(5_000)]);
        if (child?.pid) await killRun([rootProc(child.pid, child)], 2_000);
        removeScratch();
        throw new Error(`${app.id}: stopped while starting (Electron was launching; it is stopped)`);
      }
      try {
        if (child?.pid) adopt(child.pid, child);
      } catch (error) {
        throw new Error(`${app.id}: could not adopt Electron (pid ${child?.pid}): ${String(error).split("\n")[0]}`);
      }
      internal.lateKill = undefined;
      child?.stdout?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
      child?.stderr?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
      running.serveRoot = app.run.serveRoot ? resolvePath(root, expand(app.run.serveRoot)) : cwd;
      running.electron = { app: electronApp, window: () => electronApp.firstWindow({ timeout: timeoutMs }) };
      running.blocked = await installGuard(electronApp.context(), running);
      stillStarting();
      // Only now may the app emit `ready` and open windows: their first loads go through the guard.
      await electronApp.evaluate(() => (globalThis as any).__ds_release());
    } else {
      throw new Error(`${app.id}: unknown run mode ${String(mode)}`);
    }

    refreshStartedPorts(running);
    captureProcesses(internal, persist);
    if (running.violations?.length) throw new Error(`${app.id}: ${running.violations.join("; ")}`);
    appendFileSync(logPath, `# ready${running.baseUrl ? ` at ${running.baseUrl}` : ""}; listening on ${running.startedPorts.join(", ")}\n`);
    return running;
  } catch (error) {
    await running.stop().catch((stopError) => appendFileSync(logPath, `# stop after failed start: ${stopError}\n`));
    throw error;
  }
}

function serveStatic(dir: string, dirReal: string, request: Request, served: Set<string>): Response {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  let file = resolve(dir, `.${pathname}`);
  if (!isInside(file, dir)) return new Response("not found", { status: 404 });
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    // SPA fallback for extensionless paths.
    if (/\.[A-Za-z0-9]+$/.test(pathname)) return new Response("not found", { status: 404 });
    file = join(dir, "index.html");
    if (!existsSync(file)) return new Response("not found", { status: 404 });
  }
  // A symlink inside the dir may point anywhere: serve only what really lives under it.
  const real = realpathSync(file);
  if (!isInside(real, dirReal)) return new Response("not found", { status: 404 });
  served.add(file);
  return new Response(Bun.file(real));
}

// -- served files ---------------------------------------------------------------

/**
 * Maps a served URL or path to a disk path, or null for a virtual module (/@vite/client, /@id/...).
 * A URL under the run's base path (baseUrl /app) maps relative to it.
 */
function toDiskPath(entry: string, serveRoot: string, basePath: string): string | null {
  let path = entry;
  let fromUrl = false;
  if (/^https?:\/\//.test(entry)) {
    path = decodeURIComponent(new URL(entry).pathname);
    fromUrl = true;
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || "/";
  } else {
    path = entry.split(/[?#]/)[0]!;
  }
  if (path.startsWith("/@fs/")) return path.slice("/@fs".length);
  if (path.startsWith("/@") || path.startsWith("/__")) return null;
  if (!fromUrl && isAbsolute(path)) {
    // An absolute disk path, unless it reads as a URL path under the serve root (/src/main.tsx).
    const first = path.split("/")[1] ?? "";
    if (existsSync(path) || (first && existsSync(`/${first}`) && !existsSync(join(serveRoot, first)))) return path;
  }
  return join(serveRoot, path);
}

function serveRootOf(running: RunningApp): string {
  return (
    running.serveRoot ??
    (running.app.run?.serveRoot
      ? resolvePath(running.root, expandPlaceholders(running.app.run.serveRoot, { root: running.root, tmp: running.tmp, ports: running.ports ?? {} }))
      : appCwd(running.app, running.root, running.app.run?.cwd))
  );
}

function basePathOf(running: RunningApp): string {
  return running.baseUrl ? new URL(running.baseUrl).pathname.replace(/\/+$/, "") : "";
}

/**
 * The disk path a served module/file URL (Vite `/@fs/...`, `/src/...`, a static file) or path maps to,
 * the same mapping servedFromRoot checks; null for a virtual module. Not resolved through symlinks.
 */
export function servedDiskPath(running: RunningApp, entry: string): string | null {
  return toDiskPath(entry, serveRootOf(running), basePathOf(running));
}

/**
 * Checks that served module/file URLs (Vite `/@fs/...`, `/src/...`, static files) or absolute disk paths
 * resolve inside `running.root` (or the run's own temp dir, where fixture servers build). Symlinks are
 * resolved, so a linked package outside the root is reported in `outside`. A path that maps to no file
 * is reported in `unresolved` (pass only module and file URLs: scripts, styles, fonts, images, not page
 * routes). ok means both lists are empty.
 */
export function servedFromRoot(running: RunningApp, filePaths: string[]): { ok: boolean; outside: string[]; unresolved: string[] } {
  const rootReal = realpathSync(running.root);
  const tmpReal = existsSync(running.tmp ?? "") ? realpathSync(running.tmp) : undefined;
  const serveRoot = serveRootOf(running);
  const basePath = basePathOf(running);
  const outside: string[] = [];
  const unresolved: string[] = [];
  for (const entry of filePaths) {
    const disk = toDiskPath(entry, serveRoot, basePath);
    if (disk === null) continue;
    if (!existsSync(disk)) {
      unresolved.push(entry === disk ? disk : `${entry} -> ${disk}`);
      continue;
    }
    const real = realpathSync(disk);
    if (!isInside(real, rootReal) && !(tmpReal && isInside(real, tmpReal))) outside.push(entry === real ? real : `${entry} -> ${real}`);
  }
  return { ok: outside.length === 0 && unresolved.length === 0, outside: [...new Set(outside)], unresolved: [...new Set(unresolved)] };
}

// -- request guard --------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * "ok", an owner port (always denied, whatever the allow set says), a local port the run did not start,
 * or a non-loopback host. Non-network schemes are ok.
 */
export function guardVerdict(url: URL, allowedPorts: ReadonlySet<number>): "ok" | "owner-port" | "local-port" | "external" {
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return "ok";
  if (!isLoopbackHost(url.hostname)) return "external";
  const port = url.port ? Number(url.port) : url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
  if (OWNER_PORTS.includes(port)) return "owner-port";
  return allowedPorts.has(port) ? "ok" : "local-port";
}

/**
 * Splits guard entries ("GET http://...", "WS ws://...") into unexpected ones and expected ones: requests
 * to one of the app's own named profile ports that the run never bound (a dead kernel URL the profile
 * points the app at on purpose).
 */
export function splitBlocked(running: RunningApp, entries: string[]): { unexpected: string[]; expected: string[] } {
  const named = new Set(Object.values(running.ports));
  const unexpected: string[] = [];
  const expected: string[] = [];
  for (const entry of entries) {
    let url: URL | undefined;
    try {
      url = new URL(entry.slice(entry.indexOf(" ") + 1));
    } catch {
      // not a URL: unexpected
    }
    const port = url && isLoopbackHost(url.hostname) ? Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80)) : NaN;
    (named.has(port) && !running.startedPorts.includes(port) ? expected : unexpected).push(entry);
  }
  return { unexpected, expected };
}

/**
 * Installs the request guard on a context; returns the list of blocked requests. A local port is allowed
 * while a run process listens on it right now (re-read at most PORT_CACHE_MS ago, and again before a
 * request is blocked) or when the profile lists it in allowedLocalPorts; a port the run once bound but no
 * longer holds is not.
 */
export async function installGuard(context: any, running: RunningApp): Promise<() => string[]> {
  const blocked: string[] = [];
  const allowed = (maxAgeMs: number) => new Set([...ownPorts(running, maxAgeMs), ...(running.app.runProfile?.allowedLocalPorts ?? [])]);
  const decide = (raw: string): boolean => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return true;
    }
    // A port the app opened after it became ready (a lazily started API) counts once a run process holds it.
    return guardVerdict(url, allowed(0)) === "ok";
  };
  const needsCheck = (url: URL) => guardVerdict(url, allowed(PORT_CACHE_MS)) !== "ok";
  await context.route(needsCheck, (route: any) => {
    const request = route.request();
    if (decide(request.url())) return route.fallback();
    blocked.push(`${request.method()} ${request.url()}`);
    return route.abort("blockedbyclient");
  });
  // WebSockets bypass context.route: without routeWebSocket a page could reach any local port. Fail closed.
  if (typeof context.routeWebSocket !== "function") throw new Error("the request guard needs Playwright's context.routeWebSocket (Playwright 1.48+) to block WebSockets");
  await context.routeWebSocket(needsCheck, (ws: any) => {
    if (decide(ws.url())) {
      ws.connectToServer();
      return;
    }
    blocked.push(`WS ${ws.url()}`);
    ws.close({ code: 1008, reason: "blocked by the rollout request guard" });
  });
  return () => [...blocked];
}

/**
 * A browser context with the request guard: aborts and records every request and WebSocket to a local
 * port the run does not hold (and not in allowedLocalPorts), to an owner port, and to any non-loopback
 * host. WebSockets are recorded as "WS <url>".
 */
export async function guardedContext(
  browser: any,
  running: RunningApp,
  opts: {
    colorScheme?: "light" | "dark";
    storageState?: unknown;
    viewport?: { width: number; height: number };
    /** Install DETERMINISM_CSS in every frame (default true). */
    determinism?: boolean;
  } = {},
): Promise<{ context: any; blocked: () => string[] }> {
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    serviceWorkers: "block",
    // DETERMINISM_CSS is an inline <style>; a page CSP like `style-src 'self'` would block it and leave
    // animations running. Bypassing CSP changes no settled style of the app.
    bypassCSP: true,
    colorScheme: opts.colorScheme ?? "light",
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  try {
    if (opts.determinism !== false) await context.addInitScript(installStyleInitScript, DETERMINISM_CSS);
    const blocked = await installGuard(context, running);
    return { context, blocked };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

// -- browsers -------------------------------------------------------------------

/**
 * Chromium for snapshot, verify and the profile proof: LAUNCH_OPTIONS (plus `overrides`) with a sanitized
 * environment, sanitizedEnv over a fresh temp HOME/XDG dir that is removed when the browser disconnects
 * (or the launch fails). The tool's own HOME, credentials and service variables never reach the browser.
 */
export async function launchBrowser(root: string, overrides: Record<string, unknown> = {}): Promise<any> {
  const home = mkdtempSync(join(realTmpRoot(), "ds-browser-"));
  const remove = () => rmSync(home, { recursive: true, force: true });
  try {
    const browser = await loadPlaywright(root).chromium.launch({ ...LAUNCH_OPTIONS, ...overrides, env: sanitizedEnv(home) });
    browser.on("disconnected", remove);
    return browser;
  } catch (error) {
    remove();
    throw error;
  }
}

// -- cleanup after a crash ----------------------------------------------------------

/** The command line of a pid (`ps -o command=`), or "" when it is gone or ps fails. */
function commandOf(pid: number): string {
  const result = spawnSync(SYSTEM_BIN.ps, ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS, env: SYSTEM_ENV });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * Whether a live process is a root this runner starts: the sandboxed shell that carries the watchdog
 * (spawnLogged), or an Electron started with app-runner's loader. A record naming any other process as a
 * root is not trusted, whatever its start time says.
 */
function looksLikeRunRoot(pid: number): boolean {
  const command = commandOf(pid);
  return command.startsWith("/bin/sh -c { cat >/dev/null; kill -KILL 0; }") || command.includes(ELECTRON_LOADER);
}

/**
 * Stops what crashed runs left behind: for every <outDir>/runs/<id>.json whose tool process is gone,
 * signals the processes that are provably the run's: a recorded root that still exists with the same
 * start time and the runner's own command line, its descendants and its process group. A recorded
 * process that is not one of those (it left the run's tree, or the record names something else) is never
 * signalled; it is reported and the record stays. Records live in the out dir, which the sandbox keeps
 * read-only for run processes. Records of a live tool are left alone; nothing is touched when `ps` fails.
 * Returns one line per record.
 */
export async function cleanupRuns(outDir: string): Promise<string[]> {
  const dir = join(safeOutputPath(outDir, { label: "--out-dir" }), "runs");
  if (!existsSync(dir)) return [];
  const report: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
    const path = join(dir, name);
    let record: any;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      report.push(`${name}: unreadable; left in place`);
      continue;
    }
    const label = typeof record?.app === "string" ? record.app : name;
    const table = readProcessTable();
    if (!table) {
      report.push(`${label}: cannot read the process table (ps failed); left alone`);
      continue;
    }
    const tool = record?.tool;
    if (tool && Number.isInteger(tool.pid) && stillRunning([{ pid: tool.pid, ppid: 0, pgid: 0, started: String(tool.started ?? "") }], table).length) {
      report.push(`${label}: its tool (pid ${tool.pid}) is still running; left alone`);
      continue;
    }
    const identity = (p: any) => Number.isInteger(p?.pid) && p.pid > 1 && typeof p?.started === "string" && p.started.trim() !== "";
    const recordedRoots: RootProc[] = (Array.isArray(record?.roots) ? record.roots : []).filter(identity).map((p: any) => ({ pid: p.pid, started: p.started }));
    const recorded: ProcInfo[] = (Array.isArray(record?.processes) ? record.processes : [])
      .filter((p: any) => identity(p) && Number.isInteger(p?.pgid))
      .map((p: any) => ({ pid: p.pid, ppid: 0, pgid: p.pgid, started: p.started }));
    // Roots that are provably still the run's: same pid, same start time, the runner's command line.
    const roots = recordedRoots.filter((root) => stillRunning([{ ...root, ppid: 0, pgid: 0 }], table).length && looksLikeRunRoot(root.pid));
    const ours = runProcesses(roots, table).filter((proc) => roots.length > 0 && proc.pid !== process.pid);
    const oursPids = new Set(ours.map((proc) => proc.pid));
    const strays = stillRunning(recorded, table).filter((proc) => !oursPids.has(proc.pid));
    let line: string;
    let confirmed = true;
    if (ours.length) {
      const kill = await killRun(roots, 3_000);
      confirmed = kill.confirmed;
      line = `stopped ${ours.length - kill.left.length} of ${ours.length} leftover process(es) (pids ${ours.map((p) => p.pid).join(", ")})${kill.confirmed ? "" : `; NOT CONFIRMED (${kill.left.length ? `pids ${kill.left.map((p) => p.pid).join(", ")} left` : "ps failed"})`}`;
    } else line = "nothing left running";
    if (strays.length)
      line += `; left alone ${strays.length} recorded process(es) that are not a recorded root's descendants (pids ${strays.map((p) => p.pid).join(", ")}): check them by hand`;
    report.push(`${label}: ${line}`);
    if (confirmed && strays.length === 0) {
      rmSync(path, { force: true });
      for (const [key, prefix] of [
        ["tmp", "ds-run-"],
        ["toolDir", "ds-tool-"],
      ] as const) {
        const scratch = typeof record?.[key] === "string" ? record[key] : "";
        if (scratch && dirname(scratch) === realTmpRoot() && basename(scratch).startsWith(prefix)) rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  return report;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out-dir");
  if (!argv.includes("--cleanup")) {
    console.error("usage: bun scripts/lib/app-runner.ts --cleanup [--out-dir <dir>]   (the --out-dir the crashed tool used)");
    process.exit(2);
  }
  const outDir = at >= 0 ? argv[at + 1]! : (process.env.DS_RUN ?? join(tmpdir(), "ds-rollout"));
  const report = await cleanupRuns(outDir);
  for (const line of report) console.log(line);
  console.log(`cleanup: ${report.length} run record(s) in ${join(outDir, "runs")}`);
}
