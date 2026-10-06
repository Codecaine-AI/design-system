#!/usr/bin/env bun
/**
 * test:apps: run an app's safe tests (and named commands) the only way the rollout runs them.
 *
 *   bun run test:apps [--root <dir>] [--registry <apps.json>] [--out-dir <dir>] [--commands typecheck,build]
 *                     [--no-tests] [--timeout <seconds>] [--json] <app>...
 *
 * Every `tests.safe` command (and with --commands, each named `commands.<name>`; never `install`) runs:
 *   - with the app's profile environment (profileEnv: allowlisted variables only, HOME and the XDG dirs in a
 *     fresh temp dir with the profile's fixtures, BUN_OPTIONS=--no-env-file, runProfile.env, unsetEnv removed),
 *     placeholders ({root}, {tmp}, {ds}, {port:<name>}) substituted;
 *   - inside the OS sandbox (sandbox.ts runPolicy: writes only in --root and the temp dir; no `.env` reads;
 *     loopback only). A test command may connect to and listen on any loopback port (suites start their own
 *     servers on ephemeral ports) except the owner's ports and every port something already listens on when
 *     it starts (netstat, every user's sockets): a listener the run did not start counts as an owner service.
 *     A named command (typecheck, build) gets no port at all. Without a working sandbox-exec, or without a
 *     listener snapshot, it refuses to run anything;
 *   - in its own process group, with a watchdog that kills the group when this tool dies, and a timeout;
 *   - between two write checks: `git status --ignored --porcelain` of every checkout the app touches (the
 *     checkouts holding its repo, root and command cwds, the checkouts nested in those, and the checkouts
 *     around them below --root), and `find -newer/-cnewer <marker>` over the same checkouts (nested checkouts
 *     the app does not touch are pruned, so a worker in a sibling repo cannot trip it).
 *
 * Build caches are listed but never fail a run (BUILD_CACHES): node_modules/.vite, node_modules/.vite-temp,
 * node_modules/.vitest, node_modules/.cache, node_modules/.tmp and *.tsbuildinfo (tsc's incremental state).
 * Every other write or deletion is an unexpected write.
 *
 * Results: the output is read for a test summary (bun test, vitest, Python unittest) and failing names, or for
 * tsc errors. Each command is compared with its recorded baseline (registry `tests.baselines[<label>]`):
 *   exit 0                       pass (baseline failures that now pass are listed as fixed)
 *   exit != 0, no baseline       fail
 *   baseline exit 0              fail (a new failure)
 *   otherwise                    fail when a failing test or tsc error is not in the baseline, when more
 *                                tests fail or more errors happen than recorded, or when the output names
 *                                no failures to compare
 * Exit 1 when any command fails that comparison or writes unexpectedly (or nothing could run), else 0.
 * A report goes to <out-dir>/<app>/test-apps/<stamp>/report.json, with every command's log beside it; each
 * command's `proposedBaseline` is what the managing agent records into the registry (app workers never do).
 *
 * Known limits: a write that keeps an old mtime and ctime, or a deletion inside an ignored folder, is not
 * seen; network use is contained by the sandbox, not sampled; run nothing else in the app's checkouts while
 * this runs (their edits would count as the app's writes).
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { expandPlaceholders, killRun, profileEnv, rootProc, stripAnsi, validateLoadedRegistry } from "./lib/app-runner";
import { OWNER_PORTS } from "./lib/owner";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, resolvePath, type AppEntry, type Registry, type TestBaseline } from "./lib/registry";
import { safeAppId, safeOutputPath, safeTempBase } from "./lib/safe-paths";
import { runPolicy, sandboxCommand, sandboxUnavailable, SANDBOX_EXEC } from "./lib/sandbox";

/** Build caches: writes there are listed, never failed. Matched against root-relative paths. */
export const BUILD_CACHES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /(^|\/)node_modules\/\.vite(-temp)?(\/|$)/, what: "Vite's dependency cache and bundled-config temp files" },
  { pattern: /(^|\/)node_modules\/\.vitest(\/|$)/, what: "Vitest's results cache" },
  { pattern: /(^|\/)node_modules\/\.cache(\/|$)/, what: "tool caches (babel, eslint, ...)" },
  { pattern: /(^|\/)node_modules\/\.tmp(\/|$)/, what: "tsc incremental state some configs keep there" },
  { pattern: /\.tsbuildinfo$/, what: "tsc's incremental state (tsc --noEmit with incremental)" },
];

/** Named commands --commands may run. `install` never runs here: it rewrites node_modules and needs the network. */
export const NAMED_COMMANDS = ["typecheck", "build"] as const;
export type NamedCommand = (typeof NAMED_COMMANDS)[number];

export function isBuildCache(path: string): boolean {
  return BUILD_CACHES.some((cache) => cache.pattern.test(path));
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

export interface ParsedResult {
  /** Which reader recognized the output. */
  parser: "bun" | "vitest" | "unittest" | "tsc" | "none";
  pass?: number;
  fail?: number;
  errors?: number;
  /** Failing test names or tsc errors, sorted and unique. */
  failing: string[];
}

const uniqueSorted = (items: string[]) => [...new Set(items)].sort();

/**
 * Reads a test or typecheck summary and the failing names from a command's (ANSI-stripped) output. `root`
 * (the --root) is written `{root}` in names, so a baseline recorded on one tree matches a run on another.
 */
export function parseOutput(output: string, root?: string): ParsedResult {
  const text = root ? stripAnsi(output).split(root).join("{root}") : stripAnsi(output);
  const lines = text.split("\n");
  const count = (re: RegExp) => {
    let value: number | undefined;
    for (const line of lines) {
      const m = re.exec(line);
      if (m) value = Number(m[1]);
    }
    return value;
  };

  // bun test: "(fail) suite > name [1.23ms]" lines, then " 342 pass", " 54 fail", " 9 errors", "Ran N tests across M files".
  // An error outside a test ("# Unhandled error between tests", e.g. a file that cannot load) is named by its
  // first "error:" line, as "unhandled: error: ...".
  if (lines.some((line) => /^Ran \d+ tests? across \d+ files?\b/.test(line.trim()))) {
    const failing = lines.filter((line) => line.startsWith("(fail) ")).map((line) => line.slice(7).replace(/\s*\[[\d.]+m?s\]\s*$/, "").trim());
    lines.forEach((line, i) => {
      if (line.trim() !== "# Unhandled error between tests") return;
      const error = lines.slice(i + 1, i + 6).find((next) => next.startsWith("error:"));
      if (error) failing.push(`unhandled: ${error.trim()}`);
    });
    return { parser: "bun", pass: count(/^\s*(\d+) pass\b/), fail: count(/^\s*(\d+) fail\b/), errors: count(/^\s*(\d+) errors?\b/) ?? 0, failing: uniqueSorted(failing) };
  }

  // vitest: "      Tests  2 failed | 90 passed (92)", failures as " FAIL  file > suite > name".
  const vitest = lines.map((line) => /^\s*Tests\s+(.*)\(\d+\)\s*$/.exec(line)).find(Boolean);
  if (vitest) {
    const part = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(vitest[1]!)?.[1] ?? 0);
    const failing = lines.map((line) => /^\s*FAIL\s+(.+? > .+?)\s*$/.exec(line)?.[1]).filter((name): name is string => !!name);
    const errors = Number(/Errors\s+(\d+) errors?/.exec(text)?.[1] ?? 0);
    return { parser: "vitest", pass: part("passed"), fail: part("failed"), errors, failing: uniqueSorted(failing) };
  }

  // Python unittest: "Ran 10 tests in 0.195s", then "OK" or "FAILED (failures=1, errors=2)".
  const ran = count(/^Ran (\d+) tests? in /);
  if (ran !== undefined) {
    const failing = lines.map((line) => /^(?:FAIL|ERROR): (\S+) \((.+?)\)/.exec(line)).filter(Boolean).map((m) => `${m![2]}.${m![1]}`.replace(/\.(\w+)\.\1$/, ".$1"));
    const failures = Number(/FAILED \((?:.*?failures=(\d+))?/.exec(text)?.[1] ?? 0);
    const errors = Number(/FAILED \(.*?errors=(\d+)/.exec(text)?.[1] ?? 0);
    return { parser: "unittest", pass: ran - failures - errors, fail: failures + errors, errors: 0, failing: uniqueSorted(failing) };
  }

  // tsc: "src/a.ts(12,5): error TS2322: message" or (pretty) "src/a.ts:12:5 - error TS2322: message".
  const tsc = lines
    .map((line) => /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line) ?? /^(.+?):\d+:\d+ - error (TS\d+): (.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => `${m![1]}: ${m![2]}: ${m![3]!.trim()}`);
  if (tsc.length) return { parser: "tsc", fail: tsc.length, failing: uniqueSorted(tsc) };
  return { parser: "none", failing: [] };
}

export interface Verdict {
  ok: boolean;
  /** Why it failed, one line each. */
  reasons: string[];
  /** Failing names not in the baseline. */
  newFailures: string[];
  /** Baseline failures that passed this time. */
  fixed: string[];
}

/** Compares one command's exit and parsed result with its recorded baseline (see the header). */
export function compareWithBaseline(exit: number, parsed: ParsedResult, baseline: TestBaseline | undefined): Verdict {
  const known = new Set(baseline?.failing ?? []);
  const fixed = baseline?.failing?.filter((name) => !parsed.failing.includes(name)) ?? [];
  if (exit === 0) return { ok: true, reasons: [], newFailures: [], fixed: baseline?.failing ?? [] };
  if (!baseline) return { ok: false, reasons: [`exit ${exit} and no recorded baseline`], newFailures: parsed.failing, fixed: [] };
  if (baseline.exit === 0) return { ok: false, reasons: [`exit ${exit}; the baseline exits 0`], newFailures: parsed.failing, fixed: [] };
  const reasons: string[] = [];
  const newFailures = parsed.failing.filter((name) => !known.has(name));
  if (newFailures.length) reasons.push(`${newFailures.length} failure(s) not in the baseline: ${newFailures.slice(0, 10).join("; ")}${newFailures.length > 10 ? "; ..." : ""}`);
  if (parsed.fail !== undefined && baseline.fail !== undefined && parsed.fail > baseline.fail) reasons.push(`${parsed.fail} failing, the baseline has ${baseline.fail}`);
  if ((parsed.errors ?? 0) > (baseline.errors ?? 0)) reasons.push(`${parsed.errors} error(s) outside tests, the baseline has ${baseline.errors ?? 0}`);
  if (parsed.failing.length === 0 && (parsed.fail ?? 0) === 0 && (parsed.errors ?? 0) <= (baseline.errors ?? 0) && reasons.length === 0)
    reasons.push(`exit ${exit} with no failure the output names (reader: ${parsed.parser}); nothing to compare with the baseline`);
  return { ok: reasons.length === 0, reasons, newFailures, fixed };
}

// ---------------------------------------------------------------------------
// Write checks
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", ["-C", dir, "--no-optional-locks", ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** The checkout holding `dir`, or null. */
function toplevel(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const out = git(statSync(dir).isDirectory() ? dir : dirname(dir), ["rev-parse", "--show-toplevel"]);
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

/** Git checkouts below `dir` (a `.git` file or folder), not inside node_modules. */
function nestedCheckouts(dir: string): string[] {
  const out = spawnSync("find", [dir, "-mindepth", "2", "(", "-name", "node_modules", "-prune", ")", "-o", "(", "-name", ".git", "-print", "-prune", ")"], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "";
  return out.split("\n").filter(Boolean).map((path) => dirname(path));
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export interface WriteScope {
  /** Every checkout whose `git status` is compared. */
  checkouts: string[];
  /** Top-most dirs `find` walks. */
  scan: string[];
  /** Nested checkouts `find` skips (the app touches none of them). */
  prune: string[];
}

/**
 * The checkouts an app touches: those holding its repo, its root and each command's cwd (plus the
 * design-system checkout when a command names {ds}), every checkout nested in those, and every checkout
 * around them below --root (a bun workspace root whose node_modules the app shares). Sibling checkouts
 * nested in an enclosing one are pruned from the scan.
 */
export function writeScope(root: string, dirs: string[]): WriteScope {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const touched = new Set<string>();
  for (const dir of dirs) {
    const top = toplevel(dir);
    if (top) touched.add(top);
  }
  const enclosing = new Set<string>();
  for (const top of touched) {
    for (let parent = dirname(top); inside(parent, realRoot) && parent !== realRoot; parent = dirname(parent)) {
      const outer = toplevel(parent);
      if (!outer || !inside(outer, realRoot) || outer === realRoot) break;
      enclosing.add(outer);
      parent = outer;
    }
  }
  const nested = new Set<string>();
  for (const top of touched) for (const dir of nestedCheckouts(top)) nested.add(dir);
  const own = new Set([...touched, ...nested]);
  const prune = new Set<string>();
  for (const outer of enclosing) for (const dir of nestedCheckouts(outer)) if (!own.has(dir) && !enclosing.has(dir) && ![...own].some((o) => inside(o, dir))) prune.add(dir);
  const all = [...new Set([...touched, ...enclosing])].sort();
  const scan = all.filter((dir) => !all.some((other) => other !== dir && inside(dir, other)));
  return { checkouts: [...new Set([...all, ...nested])].sort(), scan, prune: [...prune].sort() };
}

/** `git status --ignored --porcelain` lines of each checkout. */
export function statusSnapshot(checkouts: string[]): Map<string, string[]> {
  return new Map(checkouts.map((dir) => [dir, git(dir, ["status", "--ignored", "--porcelain"]).stdout.split("\n").filter(Boolean)]));
}

export interface WriteReport {
  /** Writes outside the build caches: these fail the run. root-relative. */
  unexpected: string[];
  /** Writes inside the build caches (listed only). root-relative. */
  caches: string[];
}

/** Files (and symlinks) under the scope modified or changed after `marker`, root-relative. */
function newerFiles(scope: WriteScope, marker: string, skip: string[]): string[] {
  const prunes: string[] = ["-name", ".git"];
  for (const dir of [...scope.prune, ...skip]) prunes.push("-o", "-path", dir);
  const files: string[] = [];
  for (const dir of scope.scan) {
    const out = spawnSync("find", [dir, "(", ...prunes, ")", "-prune", "-o", "(", "-type", "f", "-o", "-type", "l", ")", "(", "-newer", marker, "-o", "-cnewer", marker, ")", "-print"], {
      encoding: "utf8",
      maxBuffer: 256 << 20,
    }).stdout ?? "";
    files.push(...out.split("\n").filter(Boolean));
  }
  return files;
}

/** What changed between two status snapshots and the files newer than the marker, split into caches and the rest. */
export function writeReport(root: string, scope: WriteScope, before: Map<string, string[]>, after: Map<string, string[]>, marker: string, skip: string[] = []): WriteReport {
  const rel = (path: string) => relative(root, path) || ".";
  const files = newerFiles(scope, marker, skip).map(rel);
  // A git status line for a folder (an untracked or ignored folder listed as one entry) is a build cache
  // when every new file find saw under it is one; an empty new folder counts as a write.
  const isCache = (path: string) => {
    if (!path.endsWith("/")) return isBuildCache(path);
    const under = files.filter((file) => file.startsWith(path));
    return under.length > 0 && under.every(isBuildCache);
  };
  const changes = new Map<string, string>();
  for (const [dir, lines] of after) {
    const old = new Set(before.get(dir) ?? []);
    const now = new Set(lines);
    const record = (line: string, what: string) => {
      const path = rel(join(dir, line.slice(3))) + (line.endsWith("/") ? "/" : "");
      changes.set(`${path} (git status: ${line.slice(0, 2).trim()} ${what})`, path);
    };
    for (const line of lines) if (!old.has(line)) record(line, "new");
    for (const line of old) if (!now.has(line)) record(line, "gone");
  }
  for (const file of files) changes.set(file, file);
  const unexpected: string[] = [];
  const caches: string[] = [];
  for (const [change, path] of [...changes].sort(([a], [b]) => a.localeCompare(b))) (isCache(path) ? caches : unexpected).push(change);
  return { unexpected, caches };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Every TCP port something listens on now, on any address and for any user (netstat reads the kernel's
 * table; lsof without root misses other users' sockets). Throws when netstat fails: without the snapshot a
 * test command could reach a service the run did not start.
 */
export function listeningPorts(): number[] {
  const out = spawnSync("netstat", ["-an", "-p", "tcp"], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 << 20 });
  if (out.status !== 0 || out.error) throw new Error(`netstat failed (${out.error?.message ?? `exit ${out.status}`}); without a listener snapshot nothing runs`);
  const ports = new Set<number>();
  for (const line of (out.stdout ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (!cols[0]?.startsWith("tcp") || !line.includes("LISTEN")) continue;
    const port = Number(/[.:](\d+)$/.exec(cols[3] ?? "")?.[1]);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export interface PlannedCommand {
  /** "tests.safe[<i>]" or "commands.<name>": the key of its baseline. */
  label: string;
  cmd: string;
  /** Workspace-relative. */
  cwd: string;
}

/** The commands a run executes: every tests.safe entry (unless `tests` is false), then the named commands. */
export function plannedCommands(app: AppEntry, opts: { tests?: boolean; commands?: string[] } = {}): PlannedCommand[] {
  const planned: PlannedCommand[] = [];
  if (opts.tests !== false) (app.tests?.safe ?? []).forEach((test, i) => planned.push({ label: `tests.safe[${i}]`, cmd: test.cmd, cwd: test.cwd }));
  for (const name of opts.commands ?? []) {
    if (!(NAMED_COMMANDS as readonly string[]).includes(name)) throw new Error(`--commands: "${name}" is not one of ${NAMED_COMMANDS.join(", ")} (install never runs here)`);
    const cmd = app.commands?.[name as NamedCommand];
    if (!cmd) throw new Error(`${app.id}: commands.${name} is not set in the registry`);
    planned.push({ label: `commands.${name}`, cmd, cwd: app.commands.cwd });
  }
  return planned;
}

/** Fixtures are design-system-relative; apps/fixtures/<id>/<rest> lands at <tmp>/<rest>, anything else at <tmp>/<basename>. No .env files. */
function copyFixtures(app: AppEntry, tmp: string) {
  const prefix = `apps/fixtures/${app.id}/`;
  for (const rel of app.runProfile?.fixtures ?? []) {
    const src = resolve(DESIGN_SYSTEM_ROOT, rel);
    if (!inside(src, DESIGN_SYSTEM_ROOT)) throw new Error(`${app.id}: fixture ${rel} is outside design-system`);
    if (!existsSync(src)) throw new Error(`${app.id}: fixture ${rel} does not exist`);
    cpSync(src, rel.startsWith(prefix) ? join(tmp, rel.slice(prefix.length)) : join(tmp, basename(rel)), { recursive: true, filter: (path) => !basename(path).startsWith(".env") });
  }
}

/** The command dies with this tool: a watchdog in its group kills the group at EOF on fd 3, which only this process holds open. */
function withWatchdog(cmd: string): string {
  return `{ cat >/dev/null; kill -KILL 0; } <&3 &\n{\n${cmd}\n} 3<&-`;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export interface CommandResult extends PlannedCommand {
  /** The command after placeholder substitution. */
  expanded: string;
  exit: number;
  timedOut: boolean;
  seconds: number;
  parsed: ParsedResult;
  baseline?: TestBaseline;
  verdict: Verdict;
  writes: WriteReport;
  ok: boolean;
  log: string;
  /** What the managing agent records as this command's baseline. */
  proposedBaseline: TestBaseline;
}

export interface AppReport {
  app: string;
  root: string;
  date: string;
  sandbox: string;
  scope: WriteScope;
  commands: CommandResult[];
  /** Why nothing ran, when nothing could. */
  refused?: string;
  ok: boolean;
  reportPath?: string;
}

export interface TestAppOptions {
  root: string;
  outDir: string;
  registry: Registry;
  tests?: boolean;
  commands?: string[];
  timeoutMs?: number;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runOne(app: AppEntry, planned: PlannedCommand, opts: TestAppOptions & { dir: string; scope: WriteScope }): Promise<CommandResult> {
  const root = opts.root;
  const tmp = mkdtempSync(join(safeTempBase(), `ds-test-${app.id}-`));
  const log = join(opts.dir, `${planned.label.replace(/[^A-Za-z0-9_.-]+/g, "_")}.log`);
  try {
    copyFixtures(app, tmp);
    const env = profileEnv(app, { root, tmp });
    const expanded = expandPlaceholders(planned.cmd, { root, tmp, ports: app.runProfile?.ports ?? {} });
    const cwd = resolvePath(root, planned.cwd);
    // Test suites start their own servers on ephemeral ports: any loopback port but the owner's and every port
    // already listened on (decision 22). Named commands (typecheck, build) need no port.
    const listening = planned.label.startsWith("tests.") ? listeningPorts() : undefined;
    const policy = listening ? runPolicy({ root, tmp, outDir: opts.outDir, anyLoopback: true, extraDeniedPorts: listening }) : runPolicy({ root, tmp, outDir: opts.outDir });
    const deniedPorts = listening ? [...new Set([...OWNER_PORTS, ...listening])].sort((a, b) => a - b) : undefined;
    const argv = sandboxCommand(policy, ["/bin/sh", "-c", withWatchdog(expanded)]);
    writeFileSync(
      log,
      `$ ${expanded}\n  (cwd ${cwd}, sandboxed, HOME ${tmp}, ${deniedPorts ? `loopback except ${deniedPorts.length} owner or listening ports: ${deniedPorts.join(",")}` : "no network port"})\n`,
    );

    const marker = join(opts.dir, `.marker-${planned.label.replace(/[^A-Za-z0-9_.-]+/g, "_")}`);
    const before = statusSnapshot(opts.scope.checkouts);
    writeFileSync(marker, "");
    await sleep(20); // the marker's mtime strictly precedes every write the command makes

    const started = Date.now();
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const root$ = child.pid ? rootProc(child.pid, child) : undefined;
    let output = "";
    const onData = (chunk: Buffer) => {
      appendFileSync(log, chunk);
      output += chunk.toString("utf8");
      if (output.length > 8_000_000) output = output.slice(-4_000_000);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    const exited = new Promise<number>((done) => {
      child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
      child.on("error", () => done(127));
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = opts.timeoutMs ?? 15 * 60_000;
    const exit = await Promise.race([exited, new Promise<number>((done) => (timer = setTimeout(() => ((timedOut = true), done(-1)), timeout)))]);
    clearTimeout(timer);
    if (root$) await killRun([root$], 2_000);
    const code = timedOut ? 124 : exit;
    const seconds = (Date.now() - started) / 1000;
    appendFileSync(log, `\n[exit ${code}${timedOut ? `, timed out after ${timeout / 1000} s` : ""}] ${seconds.toFixed(1)} s\n`);

    const after = statusSnapshot(opts.scope.checkouts);
    const writes = writeReport(root, opts.scope, before, after, marker, [opts.outDir, tmp]);
    rmSync(marker, { force: true });
    const parsed = parseOutput(output, root);
    const baseline = app.tests?.baselines?.[planned.label];
    const verdict = timedOut ? { ok: false, reasons: [`timed out after ${timeout / 1000} s`], newFailures: [], fixed: [] } : compareWithBaseline(code, parsed, baseline);
    if (writes.unexpected.length) verdict.reasons.push(`${writes.unexpected.length} unexpected write(s): ${writes.unexpected.slice(0, 5).join(", ")}${writes.unexpected.length > 5 ? ", ..." : ""}`);
    const proposedBaseline: TestBaseline = {
      exit: code,
      ...(parsed.pass !== undefined ? { pass: parsed.pass } : {}),
      ...(parsed.fail !== undefined ? { fail: parsed.fail } : {}),
      ...(parsed.errors !== undefined ? { errors: parsed.errors } : {}),
      ...(parsed.failing.length ? { failing: parsed.failing } : {}),
      date: new Date().toISOString().slice(0, 10),
      method: `bun run test:apps --root ${root} (sandbox-exec runPolicy, profile env, write check), 1 run`,
    };
    return { ...planned, expanded, exit: code, timedOut, seconds, parsed, baseline, verdict, writes, ok: verdict.ok && writes.unexpected.length === 0 && !timedOut, log, proposedBaseline };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs one app's planned commands (see the header) and writes its report. Never throws for a failing command. */
export async function testApp(app: AppEntry, opts: TestAppOptions): Promise<AppReport> {
  safeAppId(app.id);
  if (!existsSync(opts.root)) throw new Error(`--root ${opts.root} does not exist`);
  // Canonical, as git and find print paths: the write check compares them with it.
  const root = realpathSync(resolve(opts.root));
  const outDir = safeOutputPath(opts.outDir, { root, label: "--out-dir" });
  const report: AppReport = { app: app.id, root, date: new Date().toISOString(), sandbox: SANDBOX_EXEC, scope: { checkouts: [], scan: [], prune: [] }, commands: [], ok: false };
  const planned = plannedCommands(app, { tests: opts.tests, commands: opts.commands });
  const noSandbox = sandboxUnavailable();
  if (noSandbox) {
    report.refused = `refusing to run without the OS sandbox: ${noSandbox}`;
    return report;
  }
  if (planned.length === 0) {
    report.refused = `${app.id} has no tests.safe command${opts.commands?.length ? "" : " (name commands with --commands typecheck,build)"}`;
    return report;
  }
  const dir = join(outDir, app.id, "test-apps", stamp());
  mkdirSync(dir, { recursive: true });
  const usesDs = planned.some((p) => p.cmd.includes("{ds}"));
  report.scope = writeScope(root, [app.repo, app.root, ...planned.map((p) => p.cwd)].map((p) => resolvePath(root, p)).concat(usesDs ? [DESIGN_SYSTEM_ROOT] : []));
  for (const p of planned) report.commands.push(await runOne(app, p, { ...opts, root, outDir, dir, scope: report.scope }));
  report.ok = report.commands.every((c) => c.ok);
  report.reportPath = join(dir, "report.json");
  writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "usage: bun run test:apps [--root <dir>] [--registry <apps.json>] [--out-dir <dir>] [--commands typecheck,build] [--no-tests] [--timeout <seconds>] [--json] <app>...";

export interface CliOptions {
  root: string;
  registry: string;
  outDir: string;
  apps: string[];
  commands: string[];
  tests: boolean;
  timeoutMs?: number;
  json: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const opts: CliOptions = {
    root: resolve(DESIGN_SYSTEM_ROOT, ".."),
    registry: REGISTRY_PATH,
    outDir: env.DS_RUN ?? join(tmpdir(), "ds-rollout"),
    apps: [],
    commands: [],
    tests: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === "--root") opts.root = resolve(value());
    else if (arg === "--registry") opts.registry = resolve(value());
    else if (arg === "--out-dir") opts.outDir = resolve(value());
    else if (arg === "--commands") opts.commands = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--no-tests") opts.tests = false;
    else if (arg === "--timeout") opts.timeoutMs = Number(value()) * 1000;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else opts.apps.push(arg);
  }
  if (opts.apps.length === 0) throw new Error(`name at least one app\n${USAGE}`);
  if (opts.timeoutMs !== undefined && !(opts.timeoutMs > 0)) throw new Error(`--timeout needs a number of seconds\n${USAGE}`);
  for (const name of opts.commands)
    if (!(NAMED_COMMANDS as readonly string[]).includes(name)) throw new Error(`--commands: "${name}" is not one of ${NAMED_COMMANDS.join(", ")} (install never runs here)\n${USAGE}`);
  return opts;
}

function describe(result: CommandResult): string[] {
  const counts = result.parsed.parser === "none" ? "" : ` ${[result.parsed.pass !== undefined ? `${result.parsed.pass} pass` : "", result.parsed.fail !== undefined ? `${result.parsed.fail} fail` : "", result.parsed.errors ? `${result.parsed.errors} errors` : ""].filter(Boolean).join(", ")}`;
  const base = result.baseline ? ` (baseline exit ${result.baseline.exit}${result.baseline.fail !== undefined ? `, ${result.baseline.fail} fail` : ""})` : " (no baseline)";
  const lines = [`${result.ok ? "pass" : "FAIL"} ${result.label}: exit ${result.exit},${counts || " no summary"}${base}, ${result.seconds.toFixed(1)} s`];
  for (const reason of result.verdict.reasons) lines.push(`     ${reason}`);
  if (result.verdict.fixed.length) lines.push(`     fixed since the baseline: ${result.verdict.fixed.length}`);
  if (result.writes.caches.length) lines.push(`     build-cache writes (allowed): ${result.writes.caches.length}`);
  lines.push(`     log ${result.log}`);
  return lines;
}

export async function cli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let opts: CliOptions;
  let registry: Registry;
  try {
    opts = parseArgs(argv);
    registry = validateLoadedRegistry(loadRegistry(opts.registry), opts.registry);
  } catch (error) {
    console.error(`test:apps: ${(error as Error).message}`);
    return 1;
  }
  const reports: AppReport[] = [];
  for (const id of opts.apps) {
    let report: AppReport;
    try {
      report = await testApp(getApp(registry, id), { root: opts.root, outDir: opts.outDir, registry, tests: opts.tests, commands: opts.commands, timeoutMs: opts.timeoutMs });
    } catch (error) {
      report = { app: id, root: opts.root, date: new Date().toISOString(), sandbox: SANDBOX_EXEC, scope: { checkouts: [], scan: [], prune: [] }, commands: [], refused: (error as Error).message, ok: false };
    }
    reports.push(report);
    if (opts.json) continue;
    if (report.refused) console.log(`${id}: REFUSED ${report.refused}`);
    for (const result of report.commands) for (const line of describe(result)) console.log(`${id} ${line}`);
    if (!report.refused) console.log(`${id}: ${report.ok ? "ok" : "FAILED"}; report ${report.reportPath}`);
  }
  if (opts.json) console.log(JSON.stringify(reports, null, 2));
  return reports.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await cli());
