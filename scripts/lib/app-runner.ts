/**
 * App runner: starts one registry app under its run profile, and stops it again.
 *
 * Shared by snapshot (screenshots), verify:apps (runtime check) and registry-prove. Every run:
 *   - gets a fresh temp dir that is HOME and the XDG dirs, with the profile's fixtures copied in;
 *   - runs with a sanitized environment built from an allowlist, never from the full process.env;
 *   - runs every process it starts inside the OS sandbox (sandbox.ts): outbound network only to
 *     loopback and never an owner port, no writes under the real home outside --root, the out dir and
 *     its temp dir, no `.env` reads. Without a working sandbox-exec startApp throws, unless the caller
 *     passes allowUnsandboxed (proof/debug only; running.unsandboxed is then set);
 *   - samples its processes' TCP connections with lsof from before the first spawn until stop(); every
 *     connection that leaves the run, and every failed sample, goes into running.violations;
 *   - binds only its profile's ports (46900-47999, never an owner port) and refuses a busy port;
 *   - starts every process in its own process group and records each process's identity (pid, group,
 *     start time) in <outDir>/runs/<id>.json, so `bun scripts/lib/app-runner.ts --cleanup` can stop
 *     exactly those after a crash; stop() kills only this run's processes, revalidating each one's start
 *     time before every signal, then confirms every port the run bound is free.
 *
 * Run modes (registry `run.mode`):
 *   browser   spawn `run.start`, read the bound URL from its output with `run.readyPattern`; served
 *             URL paths map under `run.serveRoot` (the Vite/web root), default `run.cwd`
 *   static    `run.start` set: same as browser (a fixture server that builds into {tmp});
 *             otherwise run `commands.build`, then serve `run.staticDir` on the app's port
 *   electron  run `run.electron.build`, then Playwright `_electron.launch` against `run.electron.main`
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
import { DESIGN_SYSTEM_ROOT, resolvePath, type AppEntry } from "./registry";
import { safeAppId, safeOutputPath } from "./safe-paths";
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

/** The allowlisted inherited variables, with HOME and the XDG dirs inside `tmp`. Browsers get exactly this. */
export function sanitizedEnv(tmp: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (ENV_ALLOWLIST.has(key) || key.startsWith("BUN_INSTALL"))) env[key] = value;
  }
  env.HOME = tmp;
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

function checkProfilePorts(app: AppEntry) {
  for (const [name, port] of Object.entries(app.runProfile.ports ?? {})) {
    if (OWNER_PORTS.includes(port)) throw new Error(`${app.id}: port ${name}=${port} is an owner port`);
    if (!Number.isInteger(port) || port < RUN_PORT_RANGE.min || port > RUN_PORT_RANGE.max)
      throw new Error(`${app.id}: port ${name}=${port} is outside ${RUN_PORT_RANGE.min}-${RUN_PORT_RANGE.max}`);
  }
  for (const port of app.runProfile.allowedLocalPorts ?? []) {
    if (OWNER_PORTS.includes(port)) throw new Error(`${app.id}: allowedLocalPorts lists owner port ${port}`);
  }
}

// -- processes ----------------------------------------------------------------

/** A process and its identity: pid plus start time, so a reused pid is never mistaken for it. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
}

/** A process the run started: its pid and its start time. */
export interface RootProc {
  pid: number;
  started: string;
}

const normalizeStart = (text: string) => text.trim().split(/\s+/).join(" ");

function processTable(): ProcInfo[] {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8" }).stdout ?? "";
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [pid, ppid, pgid] = cols.slice(0, 3).map(Number) as [number, number, number];
    if (![pid, ppid, pgid].every(Number.isInteger)) continue;
    procs.push({ pid, ppid, pgid, started: cols.slice(3).join(" ") });
  }
  return procs;
}

/** `ps -o lstart=` of a pid (whitespace normalized), or "" when it is gone. */
function startTime(pid: number): string {
  return normalizeStart(spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "");
}

export function rootProc(pid: number): RootProc {
  return { pid, started: startTime(pid) };
}

const OWN_PGID = (() => processTable().find((p) => p.pid === process.pid)?.pgid ?? process.pid)();

/** The processes of `procs` that still exist with the same start time, with their current pgid. */
function stillRunning(procs: readonly ProcInfo[], table: ProcInfo[] = processTable()): ProcInfo[] {
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
 */
function runProcesses(roots: RootProc[], table: ProcInfo[] = processTable()): ProcInfo[] {
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  const rootPids = roots
    .filter((root) => {
      const now = byPid.get(root.pid);
      return !now || now.started === normalizeStart(root.started); // exited roots: their group may live on
    })
    .map((root) => root.pid);
  const groups = new Set(rootPids);
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

/** TCP ports in LISTEN state held by these pids. */
function listeningPorts(pids: number[]): number[] {
  if (pids.length === 0) return [];
  const out = spawnSync("lsof", ["-nP", "-w", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fn"], { encoding: "utf8" }).stdout ?? "";
  const ports = new Set<number>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Pids listening on a TCP port (any process). */
function portListeners(port: number): number[] {
  const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout ?? "";
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
 * Signals the processes of `procs` that are still the same processes (pid and start time checked just
 * before), and their current process groups: a group is signalled only while one of its members is a
 * revalidated run process, so its id cannot have been reused. Never this process or its own group.
 */
function signalRun(procs: readonly ProcInfo[], sig: NodeJS.Signals): number {
  const live = stillRunning(procs).filter((proc) => proc.pid !== process.pid);
  const groups = new Set(live.map((proc) => proc.pgid).filter((pgid) => pgid > 1 && pgid !== OWN_PGID));
  for (const pgid of groups) signal(-pgid, sig);
  for (const proc of live) signal(proc.pid, sig);
  return live.length;
}

/**
 * Stops a run's processes: SIGTERM, wait, SIGKILL, to the roots' descendants and process groups, plus
 * `known` processes seen earlier (a descendant that left its group). Every process is revalidated by
 * start time before each signal.
 */
export async function killRun(roots: RootProc[], graceMs = 8_000, known: readonly ProcInfo[] = []) {
  const table = processTable();
  const captured = new Map<number, ProcInfo>();
  for (const proc of [...stillRunning(known, table), ...runProcesses(roots, table)]) if (proc.pid !== process.pid) captured.set(proc.pid, proc);
  const procs = [...captured.values()];
  if (signalRun(procs, "SIGTERM") === 0) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && stillRunning(procs).length) await sleep(100);
  signalRun(procs, "SIGKILL");
  const hard = Date.now() + 3_000;
  while (Date.now() < hard && stillRunning(procs).length) await sleep(50);
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

/** Spawns `sh -c cmd` in its own process group, inside the sandbox when `policy` is set. */
function spawnLogged(cmd: string, cwd: string, env: Record<string, string>, logPath: string, policy: SandboxPolicy | null): Spawned {
  appendFileSync(logPath, `\n$ ${cmd}\n  (cwd ${cwd}${policy ? ", sandboxed" : ", NOT SANDBOXED"})\n`);
  const argv = policy ? sandboxCommand(policy, ["/bin/sh", "-c", cmd]) : ["/bin/sh", "-c", cmd];
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
): Promise<number> {
  const proc = spawnLogged(cmd, cwd, env, logPath, policy);
  const pid = proc.child.pid;
  if (!pid) throw new Error(`failed to spawn ${cmd}`);
  const root = rootProc(pid);
  roots.push(root);
  try {
    const deadline = Date.now() + timeoutMs;
    while (proc.exited() === null && Date.now() < deadline) await sleep(100);
    await killRun([root], 2_000);
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
}
const internals = new WeakMap<RunningApp, Internal>();
/** Runs this process started and has not finished stopping (a run leaves only when its stop() is done). */
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

let exitHookInstalled = false;

/** At process exit (normal, process.exit, crash): SIGKILL every live run's processes, synchronously. */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    shuttingDown = true;
    for (const running of live) {
      const internal = internals.get(running);
      if (!internal) continue;
      const table = processTable();
      signalRun([...stillRunning([...internal.known.values()], table), ...runProcesses(internal.roots, table)], "SIGKILL");
    }
  });
}

const signalCleanups = new Set<() => unknown>();
let signalHandlersInstalled = false;

/**
 * Opt-in for CLIs and library users: on SIGINT, SIGTERM or SIGHUP (exit 130), or an uncaught exception
 * or unhandled rejection (exit 1), refuse new runs, run `cleanup` (close the browser), stop every app this
 * process started, then exit. Launch browsers with LAUNCH_OPTIONS (handleSIG* false) so Playwright does
 * not exit first. Returns a function that removes `cleanup`.
 */
export function installSignalHandlers(cleanup?: () => unknown): () => void {
  if (cleanup) signalCleanups.add(cleanup);
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    let exiting = false;
    const shutdown = (reason: string, code: number) => {
      shuttingDown = true;
      if (exiting) return;
      exiting = true;
      console.error(`\n${reason}: stopping the apps this process started...`);
      const bounded = (fn: () => unknown) => Promise.race([Promise.resolve().then(fn), sleep(10_000)]);
      void Promise.allSettled([...signalCleanups].map(bounded))
        .then(() => stopAllApps())
        .finally(() => process.exit(code));
    };
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => shutdown(sig, 130));
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
  const listening = listeningPorts(runProcesses(internal.roots).map((proc) => proc.pid));
  recordListeners(running, listening);
  const ports = new Set([...listening, ...(internal.staticPort ? [internal.staticPort] : [])].filter((port) => !OWNER_PORTS.includes(port)));
  internal.portCache = { at: Date.now(), ports };
  return ports;
}

/** The run's processes now (descendants, groups, and earlier-seen ones still alive); new ones are recorded. */
function captureProcesses(internal: Internal, persist: () => void): ProcInfo[] {
  const table = processTable();
  const before = internal.known.size;
  const procs = [...runProcesses(internal.roots, table), ...stillRunning([...internal.known.values()], table)];
  for (const proc of procs) if (!internal.known.has(proc.pid)) internal.known.set(proc.pid, proc);
  if (internal.known.size !== before) persist();
  return procs;
}

/** One egress sample: the run's processes, their identities, their TCP sockets; violations recorded. */
async function sampleEgress(running: RunningApp, internal: Internal, egress: EgressStats, persist: () => void) {
  const procs = captureProcesses(internal, persist);
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
 * the sandbox with `--no-sandbox` (Chromium cannot install its own Seatbelt sandbox inside ours).
 */
function electronLauncher(dir: string, executablePath: string, policy: SandboxPolicy | null): { path: string; pidFile: string } {
  mkdirSync(dir, { recursive: true });
  const pidFile = join(dir, "electron.pid");
  const argv = policy ? sandboxCommand(policy, [executablePath, "--no-sandbox"]) : [executablePath];
  const path = join(dir, "electron");
  writeFileSync(path, `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec ${argv.map(shellQuote).join(" ")} "$@"\n`, { mode: 0o700 });
  return { path, pidFile };
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function writeJsonAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(partial, path);
}

export async function startApp(app: AppEntry, opts: StartOptions): Promise<RunningApp> {
  if (shuttingDown) throw new Error(`${app?.id}: this process is shutting down; no new runs`);
  const mode = app.run?.mode;
  if (!mode || mode === "none")
    throw new Error(`${app.id}: run mode none (${app.run?.reason ?? "no reason given"}): no screenshots and no runtime checks`);
  if (!app.runProfile) throw new Error(`${app.id}: no run profile`);
  safeAppId(app.id);
  const unproven = app.runProfile.proof?.status !== "proven";
  if (unproven && !opts.allowUnproven)
    throw new Error(`${app.id}: run profile is ${app.runProfile.proof?.status ?? "missing"}; only a proven profile runs`);
  const root = resolve(opts.root);
  const outDir = safeOutputPath(opts.outDir, { root, label: `${app.id}: outDir` });
  const timeoutMs = opts.timeoutMs ?? 180_000;
  checkProfilePorts(app);
  const noSandbox = sandboxUnavailable();
  if (noSandbox && !opts.allowUnsandboxed) throw new Error(`${app.id}: refusing to start without the OS sandbox: ${noSandbox}`);
  for (const [name, port] of Object.entries(app.runProfile.ports ?? {})) {
    const holders = portListeners(port);
    if (holders.length) throw new Error(`${app.id}: port ${name}=${port} is in use (pid ${holders.join(", ")}); a previous run may still be up`);
  }

  const logDir = join(outDir, app.id, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${stamp()}-${mode}.log`);
  const tmp = mkdtempSync(join(realTmpRoot(), `ds-run-${app.id}-`));
  appendFileSync(logPath, `# ${app.id} run mode ${mode}, root ${root}, tmp ${tmp}\n`);
  if (unproven) {
    const warning = `!!! ${app.id}: RUNNING AN UNPROVEN PROFILE (allowUnproven). Use only to prove the profile; never for gates.`;
    console.error(warning);
    appendFileSync(logPath, `${warning}\n`);
  }
  const policy = noSandbox ? null : runPolicy({ root, tmp, outDir });
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
  let server: ReturnType<typeof Bun.serve> | undefined;
  let electronApp: any;
  let electronPidFile: string | undefined;
  const served = new Set<string>();
  let stopping: Promise<void> | undefined;

  const egress: EgressStats = { samples: 0, failures: [], connections: 0 };
  const recordPath = join(outDir, "runs", `${app.id}.json`);
  const tool = { pid: process.pid, started: startTime(process.pid) };
  const persist = () =>
    writeJsonAtomic(recordPath, {
      version: 1,
      app: app.id,
      tool,
      tmp,
      logPath,
      processes: [...internal.known.values()].map(({ pid, pgid, started }) => ({ pid, pgid, started })),
    });
  /** A new root: recorded at once, so a crash right after the spawn still leaves its identity on disk. */
  const adopt = (pid: number) => {
    if (roots.some((root) => root.pid === pid)) return;
    roots.push(rootProc(pid));
    captureProcesses(internal, persist);
  };
  let sampling = true;
  let wake: (() => void) | undefined;
  const sampleOnce = async () => {
    if (electronPidFile && existsSync(electronPidFile)) {
      // Adopt Electron from its launcher's pid file only while it is still our child: a pid read after
      // Electron exited could already belong to another process.
      const pid = Number(readFileSync(electronPidFile, "utf8").trim());
      if (processTable().find((proc) => proc.pid === pid)?.ppid === process.pid) {
        adopt(pid);
        electronPidFile = undefined;
      }
    }
    await sampleEgress(running, internal, egress, persist).catch((error) => {
      egress.failures.push(String(error));
      addViolation(running, `egress sampling failed, isolation unproven: ${String(error).split("\n")[0]}`);
    });
  };

  const doStop = async () => {
    sampling = false;
    wake?.();
    await sampler;
    await sampleOnce(); // the last look before anything is killed
    if (electronApp) await Promise.race([electronApp.close().catch(() => undefined), sleep(10_000)]);
    server?.stop(true);
    internal.staticPort = undefined;
    await killRun(roots, 8_000, [...internal.known.values()]);
    const check = [...new Set([...running.startedPorts, ...Object.values(ports)])];
    let busy: string[] = [];
    for (let i = 0; i < 20; i++) {
      busy = check.flatMap((port) => {
        const holders = portListeners(port);
        return holders.length ? [`:${port} (pid ${holders.join(", ")})`] : [];
      });
      if (busy.length === 0) break;
      await sleep(100);
    }
    const leftover = stillRunning([...internal.known.values()]);
    rmSync(tmp, { recursive: true, force: true });
    appendFileSync(logPath, `\n# stopped${busy.length ? `; still bound: ${busy.join(", ")}` : "; ports free"}; ${egress.samples} egress samples\n`);
    if (leftover.length === 0) rmSync(recordPath, { force: true });
    if (busy.length) throw new Error(`${app.id}: ports still bound after stop, not by this run's processes: ${busy.join(", ")}`);
  };
  // The run stays in `live` until its stop is done: stopAllApps then waits for it, and the exit hook
  // still kills its processes if the process exits mid-stop.
  const stopOnce = () => doStop().finally(() => live.delete(running));

  const running: RunningApp = {
    app,
    root,
    ports,
    startedPorts: [],
    tmp,
    env: {},
    logPath,
    egress,
    // Memoized: a second caller (a signal handler during a failed start) waits for the same stop.
    stop: () => (stopping ??= stopOnce()),
  };
  if (unproven) running.unproven = true;
  if (noSandbox) running.unsandboxed = true;
  internals.set(running, internal);
  live.add(running);
  installExitHook();
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
      adopt(proc.child.pid);
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
      const code = await runToExit(expand(app.commands.build), appCwd(app, root, app.commands.cwd), env, logPath, timeoutMs, roots, policy);
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
      const code = await runToExit(expand(app.run.electron.build), cwd, env, logPath, timeoutMs, roots, policy);
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
      const launcher = electronLauncher(join(tmp, ".ds-launcher"), executablePath, policy);
      electronPidFile = launcher.pidFile;
      const { _electron } = loadPlaywright(root);
      const listenersBefore = new Map(SIGNALS.map((sig) => [sig, new Set(process.listeners(sig))]));
      electronApp = await _electron.launch({
        executablePath: launcher.path,
        // Playwright adds its loader only without executablePath; ours loads it and holds `ready` (below).
        // Electron ignores $HOME on macOS: the loader moves userData & co. under {tmp}/electron-user-data,
        // and --user-data-dir covers Chromium's own early use of the profile dir.
        args: ["-r", ELECTRON_LOADER, `--user-data-dir=${join(tmp, "electron-user-data")}`, main, ...flags],
        cwd,
        env: { ...env, DS_PW_ELECTRON_LOADER: playwrightElectronLoader(root) },
        timeout: timeoutMs,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      // Playwright's Electron launcher installs its own signal handlers regardless of the options above;
      // they exit before stopAllApps runs. Remove exactly the ones the launch added.
      for (const sig of SIGNALS) for (const fn of process.listeners(sig)) if (!listenersBefore.get(sig)!.has(fn)) process.off(sig, fn as any);
      const pid = electronApp.process()?.pid;
      if (pid) adopt(pid);
      stillStarting();
      electronApp.process()?.stdout?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
      electronApp.process()?.stderr?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
      running.serveRoot = app.run.serveRoot ? resolvePath(root, expand(app.run.serveRoot)) : cwd;
      running.electron = { app: electronApp, window: () => electronApp.firstWindow({ timeout: timeoutMs }) };
      running.blocked = await installGuard(electronApp.context(), running);
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
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(needsCheck, (ws: any) => {
      if (decide(ws.url())) {
        ws.connectToServer();
        return;
      }
      blocked.push(`WS ${ws.url()}`);
      ws.close({ code: 1008, reason: "blocked by the rollout request guard" });
    });
  }
  return () => [...blocked];
}

/** A browser context with the request guard: aborts and records every request to a local port the run does not hold (and not in allowedLocalPorts), and every non-loopback request. */
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

/**
 * Stops what crashed runs left behind: for every <outDir>/runs/<id>.json whose tool process is gone,
 * signals the recorded processes that still exist with the same start time (and their groups), then
 * removes the record and the run's temp dir. Records of a live tool are left alone. Returns one line per
 * record.
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
    const tool = record?.tool;
    if (tool && Number.isInteger(tool.pid) && startTime(tool.pid) === normalizeStart(String(tool.started ?? ""))) {
      report.push(`${record.app}: its tool (pid ${tool.pid}) is still running; left alone`);
      continue;
    }
    const procs: ProcInfo[] = (Array.isArray(record?.processes) ? record.processes : [])
      .filter((p: any) => Number.isInteger(p?.pid) && Number.isInteger(p?.pgid) && typeof p?.started === "string")
      .map((p: any) => ({ pid: p.pid, ppid: 0, pgid: p.pgid, started: p.started }));
    const left = stillRunning(procs);
    if (left.length) await killRun([], 3_000, procs);
    const after = stillRunning(procs);
    report.push(
      `${record?.app ?? name}: ${left.length ? `stopped ${left.length - after.length} of ${left.length} leftover process(es) (pids ${left.map((p) => p.pid).join(", ")})` : "nothing left running"}`,
    );
    if (after.length === 0) {
      rmSync(path, { force: true });
      const tmp = typeof record?.tmp === "string" ? record.tmp : "";
      if (tmp && dirname(tmp) === realTmpRoot() && basename(tmp).startsWith("ds-run-")) rmSync(tmp, { recursive: true, force: true });
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
