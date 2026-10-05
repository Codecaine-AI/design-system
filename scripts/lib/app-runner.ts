/**
 * App runner: starts one registry app under its run profile, and stops it again.
 *
 * Shared by snapshot (screenshots) and verify:apps (runtime check). Every run:
 *   - gets a fresh temp dir that is HOME and the XDG dirs, with the profile's fixtures copied in;
 *   - runs with a sanitized environment built from an allowlist, never from the full process.env;
 *   - binds only its profile's ports (46900-47999, never an owner port) and refuses a busy port;
 *   - starts every process in its own process group, and stop() kills only this run's processes,
 *     then confirms every port the run bound is free.
 *
 * Run modes (registry `run.mode`):
 *   browser   spawn `run.start`, read the bound URL from its output with `run.readyPattern`
 *   static    `run.start` set: same as browser (a fixture server that builds into {tmp});
 *             otherwise run `commands.build`, then serve `run.staticDir` on the app's port
 *   electron  run `run.electron.build`, then Playwright `_electron.launch` against `run.electron.main`;
 *             the app's `ready` event waits until the request guard is on electronApp.context(). The guard
 *             covers renderer (Chromium) traffic only; main-process Node network calls are not guarded.
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
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { CONTEXT_OPTIONS, DETERMINISM_CSS, installStyleInitScript } from "./capture";
import { loadPlaywright, playwrightAnchor } from "./playwright";
import { DESIGN_SYSTEM_ROOT, resolvePath, type AppEntry } from "./registry";

/** The owner's ports. No run binds them, whatever its profile says. */
export const OWNER_PORTS: readonly number[] = [3998, 3999, 4318, 4800, 4801, 4820, 4830, 4840, 4888, 5173, 5174, 9222];
/** Run profiles use 47000-47999; tool tests use 46900-46999. */
export const RUN_PORT_RANGE = { min: 46900, max: 47999 } as const;

/** app-runner's Electron preload (see electron-loader.cjs). */
const ELECTRON_LOADER = join(import.meta.dir, "electron-loader.cjs");

/** Inherited variables a run keeps (plus every BUN_INSTALL* from run.env). Nothing else crosses over. */
const ENV_ALLOWLIST = new Set(["PATH", "LANG", "TERM", "TMPDIR"]);

export interface RunningApp {
  app: AppEntry;
  root: string;
  /** browser/static: the URL read from server output (no trailing slash). */
  baseUrl?: string;
  /** Named ports the run assigned. */
  ports: Record<string, number>;
  /** Every port this run's processes bound. The request guard re-reads it when it meets an unknown local port. */
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
  /** Directory the served URL paths map to (Vite root or static dir). */
  serveRoot?: string;
  /** static mode without run.start: every file the built-in server sent. */
  servedFiles?: () => string[];
  /** Set when the run used allowUnproven: its results must not count for a gate. */
  unproven?: true;
  /** Owner ports a run process was found listening on. startApp refuses to return such a run. */
  violations?: string[];
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

export function profileEnv(app: AppEntry, opts: { root: string; tmp: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (ENV_ALLOWLIST.has(key) || key.startsWith("BUN_INSTALL"))) env[key] = value;
  }
  env.HOME = opts.tmp;
  env.XDG_CONFIG_HOME = join(opts.tmp, ".config");
  env.XDG_DATA_HOME = join(opts.tmp, ".local", "share");
  env.XDG_STATE_HOME = join(opts.tmp, ".local", "state");
  env.XDG_CACHE_HOME = join(opts.tmp, ".cache");
  const ctx = { root: opts.root, tmp: opts.tmp, ports: app.runProfile?.ports ?? {} };
  for (const [key, value] of Object.entries(app.runProfile?.env ?? {})) env[key] = expandPlaceholders(value, ctx);
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

interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
}

/** A process the run started: its pid and its start time, so a reused pid is never mistaken for it. */
export interface RootProc {
  pid: number;
  started: string;
}

function processTable(): ProcInfo[] {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length === 3 && cols.every((n) => Number.isInteger(n)))
    .map(([pid, ppid, pgid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid! }));
}

/** `ps -o lstart=` of a pid, or "" when it is gone. */
function startTime(pid: number): string {
  return (spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
}

export function rootProc(pid: number): RootProc {
  return { pid, started: startTime(pid) };
}

const OWN_PGID = (() => processTable().find((p) => p.pid === process.pid)?.pgid ?? process.pid)();

/**
 * The run's processes: descendants of its roots, plus every member of their process groups. A root whose
 * pid now belongs to a different process (start time changed) is dropped with its group: the pid was reused.
 */
function runProcesses(roots: RootProc[]): ProcInfo[] {
  const table = processTable();
  const rootPids = roots
    .filter((root) => {
      if (!table.some((proc) => proc.pid === root.pid)) return true; // exited; its group may live on
      return startTime(root.pid) === root.started;
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
  const out = spawnSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fn"], { encoding: "utf8" }).stdout ?? "";
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
 * Stops a run's processes: SIGTERM, wait, SIGKILL, to the roots' descendants and process groups only.
 * Never signals this process or its own process group.
 */
export async function killRun(roots: RootProc[], graceMs = 8_000) {
  const procs = runProcesses(roots).filter((proc) => proc.pid !== process.pid);
  if (procs.length === 0) return;
  const groups = new Set(procs.map((proc) => proc.pgid).filter((pgid) => pgid > 1 && pgid !== OWN_PGID));
  for (const pgid of groups) signal(-pgid, "SIGTERM");
  for (const proc of procs) signal(proc.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && procs.some((proc) => alive(proc.pid))) await sleep(100);
  for (const pgid of groups) signal(-pgid, "SIGKILL");
  for (const proc of procs) if (alive(proc.pid)) signal(proc.pid, "SIGKILL");
  const hard = Date.now() + 3_000;
  while (Date.now() < hard && procs.some((proc) => alive(proc.pid))) await sleep(50);
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

function spawnLogged(cmd: string, cwd: string, env: Record<string, string>, logPath: string): Spawned {
  appendFileSync(logPath, `\n$ ${cmd}\n  (cwd ${cwd})\n`);
  const child = spawn("/bin/sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
async function runToExit(cmd: string, cwd: string, env: Record<string, string>, logPath: string, timeoutMs: number, roots: RootProc[]): Promise<number> {
  const proc = spawnLogged(cmd, cwd, env, logPath);
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

// -- start / stop -------------------------------------------------------------

interface Internal {
  roots: RootProc[];
}
const internals = new WeakMap<RunningApp, Internal>();
const live = new Set<RunningApp>();

/** For CLI signal handlers: stop every app this process started and has not stopped. */
export async function stopAllApps(): Promise<void> {
  await Promise.allSettled([...live].map((running) => running.stop()));
}

const signalCleanups = new Set<() => unknown>();
let signalHandlersInstalled = false;

/**
 * Opt-in for CLIs and library users: on SIGINT, SIGTERM or SIGHUP, run `cleanup` (close the browser),
 * stop every app this process started, then exit 130. Launch browsers with LAUNCH_OPTIONS (handleSIG*
 * false) so Playwright does not exit first. Returns a function that removes `cleanup`.
 */
export function installSignalHandlers(cleanup?: () => unknown): () => void {
  if (cleanup) signalCleanups.add(cleanup);
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    let exiting = false;
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        if (exiting) return;
        exiting = true;
        console.error(`\n${sig}: stopping the apps this process started...`);
        const bounded = (fn: () => unknown) => Promise.race([Promise.resolve().then(fn), sleep(10_000)]);
        void Promise.allSettled([...signalCleanups].map(bounded))
          .then(() => stopAllApps())
          .finally(() => process.exit(130));
      });
    }
  }
  return () => {
    if (cleanup) signalCleanups.delete(cleanup);
  };
}

/**
 * Re-reads the ports the run's processes listen on into running.startedPorts. An owner port is never
 * added (so the guard can never allow it); it is recorded in running.violations instead.
 */
export function refreshStartedPorts(running: RunningApp): number[] {
  const internal = internals.get(running);
  if (!internal) return running.startedPorts;
  const now = listeningPorts(runProcesses(internal.roots).map((proc) => proc.pid));
  for (const port of now) {
    if (OWNER_PORTS.includes(port)) {
      const violation = `a run process listens on owner port ${port}`;
      running.violations ??= [];
      if (!running.violations.includes(violation)) running.violations.push(violation);
    } else if (!running.startedPorts.includes(port)) {
      running.startedPorts.push(port);
    }
  }
  running.startedPorts.sort((a, b) => a - b);
  return running.startedPorts;
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

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function startApp(app: AppEntry, opts: StartOptions): Promise<RunningApp> {
  const mode = app.run?.mode;
  if (!mode || mode === "none")
    throw new Error(`${app.id}: run mode none (${app.run?.reason ?? "no reason given"}): no screenshots and no runtime checks`);
  if (!app.runProfile) throw new Error(`${app.id}: no run profile`);
  const unproven = app.runProfile.proof?.status !== "proven";
  if (unproven && !opts.allowUnproven)
    throw new Error(`${app.id}: run profile is ${app.runProfile.proof?.status ?? "missing"}; only a proven profile runs`);
  const root = resolve(opts.root);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  checkProfilePorts(app);
  for (const [name, port] of Object.entries(app.runProfile.ports ?? {})) {
    const holders = portListeners(port);
    if (holders.length) throw new Error(`${app.id}: port ${name}=${port} is in use (pid ${holders.join(", ")}); a previous run may still be up`);
  }

  const logDir = join(resolve(opts.outDir), app.id, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${stamp()}-${mode}.log`);
  const tmp = mkdtempSync(join(realTmpRoot(), `ds-run-${app.id}-`));
  appendFileSync(logPath, `# ${app.id} run mode ${mode}, root ${root}, tmp ${tmp}\n`);
  if (unproven) {
    const warning = `!!! ${app.id}: RUNNING AN UNPROVEN PROFILE (allowUnproven). Use only to prove the profile; never for gates.`;
    console.error(warning);
    appendFileSync(logPath, `${warning}\n`);
  }

  const ports = { ...(app.runProfile.ports ?? {}) };
  const ctx: PlaceholderContext = { root, tmp, ports };
  const expand = (text: string) => expandPlaceholders(text, ctx);
  const roots: RootProc[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let electronApp: any;
  const served = new Set<string>();
  let stopping: Promise<void> | undefined;

  const doStop = async () => {
    live.delete(running);
    if (electronApp) await Promise.race([electronApp.close().catch(() => undefined), sleep(10_000)]);
    server?.stop(true);
    await killRun(roots);
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
    rmSync(tmp, { recursive: true, force: true });
    appendFileSync(logPath, `\n# stopped${busy.length ? `; still bound: ${busy.join(", ")}` : "; ports free"}\n`);
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
    // Memoized: a second caller (a signal handler during a failed start) waits for the same stop.
    stop: () => (stopping ??= doStop()),
  };
  if (unproven) running.unproven = true;
  internals.set(running, { roots });
  live.add(running);
  /** After every await: a stop() that ran meanwhile (Ctrl-C) aborts the start before it creates more. */
  const stillStarting = () => {
    if (stopping) throw new Error(`${app.id}: stopped while starting`);
  };

  try {
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
      running.serveRoot = app.run.staticDir ? resolvePath(root, expand(app.run.staticDir)) : cwd;
      const proc = spawnLogged(cmd, cwd, env, logPath);
      if (!proc.child.pid) throw new Error(`${app.id}: failed to spawn ${cmd}`);
      roots.push(rootProc(proc.child.pid));
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
      refreshStartedPorts(running);
      if (!running.startedPorts.includes(ready.port))
        throw new Error(`${app.id}: ${ready.baseUrl} is not served by this run's processes (they listen on ${running.startedPorts.join(", ") || "nothing"})`);
    } else if (mode === "static") {
      if (!app.run.staticDir) throw new Error(`${app.id}: run mode static needs run.staticDir (or run.start)`);
      if (!app.commands?.build) throw new Error(`${app.id}: run mode static needs commands.build`);
      const code = await runToExit(expand(app.commands.build), appCwd(app, root, app.commands.cwd), env, logPath, timeoutMs, roots);
      stillStarting();
      if (code !== 0) throw new Error(`${app.id}: build exited ${code}; see ${logPath}`);
      const dir = resolvePath(root, expand(app.run.staticDir));
      if (!existsSync(dir)) throw new Error(`${app.id}: staticDir ${dir} does not exist after the build`);
      const port = ports.http ?? ports.ui ?? ports.web ?? Object.values(ports)[0];
      if (port === undefined) throw new Error(`${app.id}: run mode static needs a profile port`);
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => serveStatic(dir, request, served) });
      running.serveRoot = dir;
      running.baseUrl = `http://127.0.0.1:${port}`;
      running.startedPorts.push(port);
      running.servedFiles = () => [...served].sort();
      appendFileSync(logPath, `# serving ${dir} on ${running.baseUrl}\n`);
    } else if (mode === "electron") {
      if (!app.run.electron) throw new Error(`${app.id}: run mode electron needs run.electron`);
      const cwd = appCwd(app, root, app.run.cwd);
      const code = await runToExit(expand(app.run.electron.build), cwd, env, logPath, timeoutMs, roots);
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
      const { _electron } = loadPlaywright(root);
      const listenersBefore = new Map(SIGNALS.map((sig) => [sig, new Set(process.listeners(sig))]));
      electronApp = await _electron.launch({
        executablePath,
        // Playwright adds its loader only without executablePath; ours loads it and holds `ready` (below).
        args: ["-r", ELECTRON_LOADER, main, ...flags],
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
      if (pid) roots.push(rootProc(pid));
      stillStarting();
      electronApp.process()?.stdout?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
      electronApp.process()?.stderr?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
      running.serveRoot = cwd;
      running.electron = { app: electronApp, window: () => electronApp.firstWindow({ timeout: timeoutMs }) };
      running.blocked = await installGuard(electronApp.context(), running);
      // Only now may the app emit `ready` and open windows: their first loads go through the guard.
      await electronApp.evaluate(() => (globalThis as any).__ds_release());
      refreshStartedPorts(running);
    } else {
      throw new Error(`${app.id}: unknown run mode ${String(mode)}`);
    }

    refreshStartedPorts(running);
    if (running.violations?.length) throw new Error(`${app.id}: ${running.violations.join("; ")}`);
    appendFileSync(logPath, `# ready${running.baseUrl ? ` at ${running.baseUrl}` : ""}; listening on ${running.startedPorts.join(", ")}\n`);
    return running;
  } catch (error) {
    await running.stop().catch((stopError) => appendFileSync(logPath, `# stop after failed start: ${stopError}\n`));
    throw error;
  }
}

function serveStatic(dir: string, request: Request, served: Set<string>): Response {
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
  served.add(file);
  return new Response(Bun.file(file));
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
  const serveRoot = running.serveRoot ?? appCwd(running.app, running.root, running.app.run?.cwd);
  const basePath = running.baseUrl ? new URL(running.baseUrl).pathname.replace(/\/+$/, "") : "";
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

/** Installs the request guard on a context; returns the list of blocked requests. */
export async function installGuard(context: any, running: RunningApp): Promise<() => string[]> {
  const blocked: string[] = [];
  const allowed = () => new Set([...running.startedPorts, ...(running.app.runProfile?.allowedLocalPorts ?? [])]);
  const decide = (raw: string): boolean => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return true;
    }
    let verdict = guardVerdict(url, allowed());
    if (verdict === "local-port") {
      // A port the app opened after it became ready (a lazily started API) still counts as the run's.
      refreshStartedPorts(running);
      verdict = guardVerdict(url, allowed());
    }
    return verdict === "ok";
  };
  const needsCheck = (url: URL) => guardVerdict(url, allowed()) !== "ok";
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

/** A browser context with the request guard: aborts and records every request to a local port not in startedPorts ∪ allowedLocalPorts, and every non-loopback request. */
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
