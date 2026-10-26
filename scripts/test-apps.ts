#!/usr/bin/env bun
/**
 * test:apps: run an app's safe tests (and named commands) the only way the rollout runs them.
 *
 *   bun run test:apps [--root <dir>] [--registry <apps.json>] [--out-dir <dir>] [--commands typecheck,build]
 *                     [--no-tests] [--timeout <seconds>] [--json] <app>...
 *
 * Every `tests.safe` command (and with --commands, each named `commands.<name>` the entry sets; one it does not
 * set is skipped with "commands.<name>: not set in apps.json (skipped)"; `install` and unknown names refuse) runs:
 *   - with the app's profile environment (profileEnv: allowlisted variables only, HOME and the XDG dirs in a
 *     fresh temp dir with the profile's fixtures, BUN_OPTIONS=--no-env-file, runProfile.env, unsetEnv removed),
 *     placeholders ({root}, {tmp}, {ds}, {port:<name>}) substituted;
 *   - inside the OS sandbox (sandbox.ts runPolicy, one place: commandPolicy). Writes: only the app's own
 *     writable scope (checkouts.ts appScope, decision 29: the checkouts holding its repo, root and scan paths)
 *     and its temp dir; never a `.git` entry, a git dir inside --root, another repository's checkout nested
 *     in the app's, the enclosing checkout (Core), the design-system checkout, the run folder or the out dir.
 *     No `.env` reads. Network (decision 31): a test command connects only to its port block and the
 *     ephemeral range 49152-65535 on loopback, minus every port something listens on when it starts
 *     (netstat, every user's sockets) and the owner's ports, so a service that starts listening later
 *     outside those ranges stays out of reach; a named command (typecheck, build) gets no port at all.
 *     Without a working sandbox-exec, without a listener snapshot, or when the app's own folder is in no git
 *     checkout inside --root, it refuses to run anything;
 *   - in its own process group, with a watchdog that kills the group when this tool dies, and a timeout;
 *     afterwards every process still carrying the run's tag in its environment (one that left the group) is
 *     killed and fails the run;
 *   - watched every 250 ms for a listener beyond loopback (0.0.0.0, ::, a LAN address: other hosts could
 *     connect, and Seatbelt cannot refuse such a bind): a hit kills the command's group at once and fails it,
 *     naming the address and port (egress.ts exposedListeners);
 *   - between two write checks over exactly what the run may write (appWriteScope: the app's own checkouts,
 *     the read-only dirs inside them pruned), so an edit anywhere else (a concurrent worker in Core, the
 *     design-system checkout, the run folder) cannot fail the app:
 *       `git status --ignored --porcelain`, git pinned to each checkout's git dir as recorded before the run
 *       (checkouts.ts, git.ts: hook-free, no system or global config, fsmonitor off; a checkout whose `.git`
 *       entry changed gets no status: the change itself is reported); `find -newer/-cnewer <marker>` for new
 *       and changed files and for folders that lost an entry (a deletion or rename); and each `.git` entry.
 * System tools run by absolute path (TOOLS).
 *
 * Build caches are listed but never fail a run (BUILD_CACHES): node_modules/.vite, node_modules/.vite-temp,
 * node_modules/.vitest, node_modules/.cache, node_modules/.tmp and *.tsbuildinfo (tsc's incremental state).
 * Every other write or deletion is an unexpected write.
 *
 * Results: the output is read for a test summary (bun test, vitest, Python unittest) and failing names, or for
 * tsc errors. Each command is compared with its recorded baseline (registry `tests.baselines[<label>]`):
 *   baseline without cmd         fail (a stale baseline could not be told apart; registry:check requires cmd)
 *   baseline for another cmd     fail (stale: the entry's command changed since it was recorded)
 *   fewer tests than baseline    fail, whatever the exit (pass + fail below the baseline's: a lost test file)
 *   exit 0                       pass (baseline failures that now pass are listed as fixed)
 *   exit != 0, no baseline       fail
 *   baseline exit 0              fail (a new failure)
 *   otherwise                    fail when a failing test or tsc error is not in the baseline, when more
 *                                tests fail, more errors happen or more failures go unnamed than recorded,
 *                                or when the output names no failures to compare
 * Exit 1 when any command fails that comparison or writes unexpectedly (or nothing could run), else 0.
 * A report goes to <out-dir>/<app>/test-apps/<stamp>/report.json, with every command's log beside it; each
 * command's `proposedBaseline` is what the managing agent records into the registry (app workers never do).
 *
 * Known limits: a write that keeps an old mtime and ctime is not seen, nor a deletion in a folder that also
 * gained an entry; network use is contained by the sandbox, not sampled; a stray platform binary (/bin/sleep)
 * hides its environment from ps, so only runtime strays (bun, node, python) are found by tag; run nothing else
 * in the app's own checkouts while this runs (their edits would count as the app's writes); a bind to port 0
 * matches no single port, so a suite's binds stay a deny list (owner ports and the listeners at start).
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { expandPlaceholders, killRun, profileBlock, profileEnv, rootProc, stripAnsi, validateLoadedRegistry, type ProcInfo } from "./lib/app-runner";
import { appScope, gitEntries, statusSnapshot, type WriteScope } from "./lib/checkouts";
import { describeConnection, exposedListeners } from "./lib/egress";
import { discoverRepo } from "./lib/git";
import { OWNER_PORTS } from "./lib/owner";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, resolvePath, type AppEntry, type Registry, type TestBaseline, workspaceRoot } from "./lib/registry";
import { safeAppId, safeChildPath, safeOutputPath, safeTempBase } from "./lib/safe-paths";
import { EPHEMERAL_PORTS, runPolicy, sandboxCommand, sandboxUnavailable, SANDBOX_EXEC, type SandboxPolicy } from "./lib/sandbox";
import { SYSTEM_BIN, SYSTEM_PATH } from "./lib/system-bin";

export type { WriteScope };

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
 * Reads a test or typecheck summary and the failing names from a command's (ANSI-stripped) output. The
 * run's temp dir is written `{tmp}` and the --root `{root}` in names, so a baseline recorded in one run on
 * one tree matches a later run on another.
 */
export function parseOutput(output: string, paths: { root?: string; tmp?: string } = {}): ParsedResult {
  let text = stripAnsi(output);
  if (paths.tmp) text = text.split(paths.tmp).join("{tmp}");
  if (paths.root) text = text.split(paths.root).join("{root}");
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
  // An error outside a test ("# Unhandled error between tests", e.g. a file that cannot load; bun counts it in
  // fail and errors) is named "unhandled: <file>: <its first Error/error: line>", the file from bun's header.
  if (lines.some((line) => /^Ran \d+ tests? across \d+ files?\b/.test(line.trim()))) {
    const failing = lines.filter((line) => line.startsWith("(fail) ")).map((line) => line.slice(7).replace(/\s*\[[\d.]+m?s\]\s*$/, "").trim());
    lines.forEach((line, i) => {
      if (line.trim() !== "# Unhandled error between tests") return;
      const file = lines.slice(0, i).reverse().find((prev) => /^\S.*:$/.test(prev) && !prev.startsWith("("))?.slice(0, -1) ?? "?";
      const end = lines.findIndex((next, j) => j > i + 1 && /^-{5,}$/.test(next.trim()));
      const error = lines.slice(i + 1, end === -1 ? i + 40 : end).find((next) => /^(?:\w*Error|error)\b[^:]*:/.test(next.trim()));
      failing.push(`unhandled: ${file}: ${error?.trim() ?? "(no error line)"}`);
    });
    return { parser: "bun", pass: count(/^\s*(\d+) pass\b/), fail: count(/^\s*(\d+) fail\b/), errors: count(/^\s*(\d+) errors?\b/) ?? 0, failing: uniqueSorted(failing) };
  }

  // vitest: "      Tests  2 failed | 90 passed (92)", failures as " FAIL  file > suite > name"; a file that fails to
  // load is " FAIL  file [ file ]" and counts only under "Test Files": named "file: <file>" and added to fail.
  const vitest = lines.map((line) => /^\s*Tests\s+(.*)\(\d+\)\s*$/.exec(line)).find(Boolean);
  if (vitest || lines.some((line) => /^\s*Test Files\s+\d+ failed/.test(line))) {
    const part = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(vitest?.[1] ?? "")?.[1] ?? 0);
    const tests = lines.map((line) => /^\s*FAIL\s+(.+? > .+?)\s*$/.exec(line)?.[1]).filter((name): name is string => !!name);
    const files = uniqueSorted(lines.map((line) => /^\s*FAIL\s+(\S+)\s+\[\s*\S+\s*\]\s*$/.exec(line)?.[1]).filter((name): name is string => !!name)).map((file) => `file: ${file}`);
    const errors = Number(/Errors\s+(\d+) errors?/.exec(text)?.[1] ?? 0);
    return { parser: "vitest", pass: part("passed"), fail: part("failed") + files.length, errors, failing: uniqueSorted([...tests, ...files]) };
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

/**
 * Why a run executed fewer tests than its baseline (pass + fail below the baseline's), or null. Only a
 * baseline with a test count (bun test, vitest, unittest) is compared; output with no test summary ran 0.
 * Applies whatever the exit: a suite that silently stops loading files can still exit 0.
 */
export function fewerTests(parsed: ParsedResult, baseline: TestBaseline | undefined): string | null {
  if (baseline?.pass === undefined) return null;
  const expected = baseline.pass + (baseline.fail ?? 0);
  const counted = parsed.parser === "bun" || parsed.parser === "vitest" || parsed.parser === "unittest";
  const ran = counted ? (parsed.pass ?? 0) + (parsed.fail ?? 0) : 0;
  if (ran >= expected) return null;
  return `ran ${ran} test(s) (pass + fail${counted ? "" : `; the output has no test summary (reader: ${parsed.parser})`}), the baseline ran ${expected}`;
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

/**
 * Compares one command's exit and parsed result with its recorded baseline (see the header). `cmd` is the
 * registry command now: a baseline recorded for another command is stale and compares with nothing.
 */
export function compareWithBaseline(exit: number, parsed: ParsedResult, baseline: TestBaseline | undefined, cmd?: string): Verdict {
  if (baseline && typeof baseline.cmd !== "string")
    return { ok: false, reasons: ["the baseline records no cmd (the command it was recorded for), so a stale one cannot be told apart; the managing agent re-records it"], newFailures: [], fixed: [] };
  if (baseline?.cmd !== undefined && cmd !== undefined && baseline.cmd !== cmd)
    return { ok: false, reasons: [`the baseline was recorded for another command (${baseline.cmd}); the managing agent re-records it`], newFailures: [], fixed: [] };
  const known = new Set(baseline?.failing ?? []);
  const fixed = baseline?.failing?.filter((name) => !parsed.failing.includes(name)) ?? [];
  const fewer = fewerTests(parsed, baseline);
  if (exit === 0) return { ok: !fewer, reasons: fewer ? [fewer] : [], newFailures: [], fixed: baseline?.failing ?? [] };
  if (!baseline) return { ok: false, reasons: [`exit ${exit} and no recorded baseline`], newFailures: parsed.failing, fixed: [] };
  if (baseline.exit === 0) return { ok: false, reasons: [`exit ${exit}; the baseline exits 0`], newFailures: parsed.failing, fixed: [] };
  const reasons: string[] = fewer ? [fewer] : [];
  const newFailures = parsed.failing.filter((name) => !known.has(name));
  if (newFailures.length) reasons.push(`${newFailures.length} failure(s) not in the baseline: ${newFailures.slice(0, 10).join("; ")}${newFailures.length > 10 ? "; ..." : ""}`);
  if (parsed.fail !== undefined && baseline.fail !== undefined && parsed.fail > baseline.fail) reasons.push(`${parsed.fail} failing, the baseline has ${baseline.fail}`);
  if ((parsed.errors ?? 0) > (baseline.errors ?? 0)) reasons.push(`${parsed.errors} error(s) outside tests, the baseline has ${baseline.errors ?? 0}`);
  // Failures the output counts but does not name compare by count only: never more than the baseline had.
  const unnamed = Math.max(0, (parsed.fail ?? 0) - parsed.failing.length);
  const unnamedBefore = Math.max(0, (baseline.fail ?? 0) - (baseline.failing?.length ?? 0));
  if (unnamed > unnamedBefore) reasons.push(`${unnamed} failure(s) the output does not name, the baseline has ${unnamedBefore}`);
  if (parsed.failing.length === 0 && (parsed.fail ?? 0) === 0 && (parsed.errors ?? 0) <= (baseline.errors ?? 0) && reasons.length === 0)
    reasons.push(`exit ${exit} with no failure the output names (reader: ${parsed.parser}); nothing to compare with the baseline`);
  return { ok: reasons.length === 0, reasons, newFailures, fixed };
}

// ---------------------------------------------------------------------------
// Write checks
// ---------------------------------------------------------------------------

/** System binaries by absolute path (SYSTEM_BIN, plus find and netstat): never through PATH. */
export const TOOLS = { ps: SYSTEM_BIN.ps, sh: SYSTEM_BIN.sh, find: "/usr/bin/find", netstat: "/usr/sbin/netstat" } as const;

function find(args: string[]): string[] {
  const out = spawnSync(TOOLS.find, args, { encoding: "utf8", maxBuffer: 256 << 20, timeout: 300_000 });
  return (out.stdout ?? "").split("\n").filter(Boolean);
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * What the write check watches: exactly what a run of the app may write (checkouts.ts appScope, decision 29),
 * its own checkouts, with the read-only dirs inside them (other repositories' checkouts nested there, git
 * dirs inside --root) pruned. Nothing else under --root: a run cannot write there, so an edit there (another
 * worker in Core, the design-system checkout, the run folder) is not the app's. Throws when the app's own
 * folder is in no git checkout inside --root: the write check needs one.
 */
export function appWriteScope(root: string, app: AppEntry): WriteScope {
  const own = appScope(root, app);
  if (own.fallback) throw new Error(`${own.fallback} is in no git checkout inside ${realpathSync(root)}; the write check needs one`);
  const gitDirs: Record<string, string> = {};
  for (const dir of own.checkouts) {
    const repo = discoverRepo(dir);
    if (!repo) throw new Error(`${dir}: git cannot read its git dir`);
    gitDirs[dir] = repo.gitDir;
  }
  return { checkouts: own.checkouts, gitDirs, scan: own.writable, prune: own.readOnly };
}

export interface WriteReport {
  /** Writes outside the build caches: these fail the run. root-relative. */
  unexpected: string[];
  /** Writes inside the build caches (listed only). root-relative. */
  caches: string[];
}

/**
 * Files and symlinks under the scope modified or changed after `marker`, plus folders whose entries
 * changed with no new file in them (a deletion or rename), root-relative, folders with a trailing slash.
 * Git dirs inside the scope are walked too (a run must not touch them).
 */
function newerEntries(scope: WriteScope, marker: string, skip: string[]): { files: string[]; dirs: string[] } {
  const skipped: string[] = [];
  for (const dir of [...scope.prune, ...skip]) skipped.push("-o", "-path", dir);
  const files: string[] = [];
  const dirs: string[] = [];
  const newer = ["(", "-newer", marker, "-o", "-cnewer", marker, ")"];
  for (const dir of scope.scan) {
    files.push(...find([dir, "(", "-path", "/dev/null", ...skipped, ")", "-prune", "-o", "(", "-type", "f", "-o", "-type", "l", ")", ...newer, "-print"]));
    dirs.push(...find([dir, "(", "-path", "/dev/null", ...skipped, ")", "-prune", "-o", "-type", "d", "-mindepth", "1", ...newer, "-print"]));
  }
  return { files, dirs };
}

/**
 * What changed: status lines that appeared or went, files newer than the marker, folders whose entries
 * changed without a new file (deletions), and `.git` entries a run rewrote. Split into build caches and the rest.
 */
export function writeReport(
  root: string,
  scope: WriteScope,
  before: { status: Map<string, string[]>; git: Map<string, string> },
  marker: string,
  skip: string[] = [],
): WriteReport {
  const rel = (path: string) => relative(root, path) || ".";
  const changes = new Map<string, string>();
  // The git setup first: a checkout whose .git entry changed gets no status (git would follow it).
  const changedGit = new Set<string>();
  for (const [entry, state] of gitEntries(scope)) {
    if (before.git.get(entry) === state) continue;
    changedGit.add(dirname(entry));
    changes.set(`${rel(entry)} (the checkout's .git entry changed)`, `${rel(entry)}`);
  }
  const { files: newFiles, dirs: newDirs } = newerEntries(scope, marker, skip);
  const files = newFiles.map(rel);
  for (const file of files) changes.set(file, file);
  for (const dir of newDirs.map(rel)) {
    // A folder changes when an entry is added, removed or renamed; a new file or folder in it explains an addition.
    const explained = [...files, ...newDirs.map(rel)].some((path) => path !== dir && dirname(path) === dir);
    if (!explained) changes.set(`${dir}/ (an entry was removed or renamed)`, `${dir}/`);
  }
  const after = statusSnapshot(scope, changedGit);
  for (const [dir, lines] of after) {
    const old = new Set(before.status.get(dir) ?? []);
    const now = new Set(lines);
    const record = (line: string, what: string) => {
      const path = rel(join(dir, line.slice(3))) + (line.endsWith("/") ? "/" : "");
      changes.set(`${path} (git status: ${line.slice(0, 2).trim()} ${what})`, path);
    };
    for (const line of lines) if (!old.has(line)) record(line, "new");
    for (const line of old) if (!now.has(line)) record(line, "gone");
  }
  // A folder entry (from git status or a deletion) is a build cache when it is one or every new file under it is.
  const isCache = (path: string) => {
    if (!path.endsWith("/")) return isBuildCache(path);
    if (isBuildCache(path)) return true;
    const under = files.filter((file) => file.startsWith(path));
    return under.length > 0 && under.every(isBuildCache);
  };
  const unexpected: string[] = [];
  const caches: string[] = [];
  for (const [change, path] of [...changes].sort(([a], [b]) => a.localeCompare(b))) (isCache(path) && !change.includes(".git entry") ? caches : unexpected).push(change);
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
  const out = spawnSync(TOOLS.netstat, ["-an", "-p", "tcp"], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 << 20 });
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

export interface Plan {
  /** What runs, in order. */
  commands: PlannedCommand[];
  /** Named commands the entry does not set, one line each ("commands.build: not set in apps.json (skipped)"). */
  skipped: string[];
}

/**
 * The commands a run executes: every tests.safe entry (unless `tests` is false), then each named command the
 * entry sets. A named command the entry does not set is skipped, not refused (`--commands typecheck,build`
 * fits every app); a name that is not a named command (install among them) throws.
 */
export function plannedCommands(app: AppEntry, opts: { tests?: boolean; commands?: string[] } = {}): Plan {
  const commands: PlannedCommand[] = [];
  const skipped: string[] = [];
  if (opts.tests !== false) (app.tests?.safe ?? []).forEach((test, i) => commands.push({ label: `tests.safe[${i}]`, cmd: test.cmd, cwd: test.cwd }));
  for (const name of opts.commands ?? []) {
    if (!(NAMED_COMMANDS as readonly string[]).includes(name)) throw new Error(`--commands: "${name}" is not one of ${NAMED_COMMANDS.join(", ")} (install never runs here)`);
    const cmd = app.commands?.[name as NamedCommand];
    if (cmd) commands.push({ label: `commands.${name}`, cmd, cwd: app.commands.cwd });
    else skipped.push(`commands.${name}: not set in apps.json (skipped)`);
  }
  return { commands, skipped };
}

/** Why a run has nothing to execute, with the --commands the entry does set (if any). */
export function nothingToRun(app: AppEntry, opts: { tests?: boolean; commands?: string[] } = {}): string {
  const asked = opts.commands ?? [];
  const others = NAMED_COMMANDS.filter((name) => app.commands?.[name] && !asked.includes(name));
  const tests = opts.tests === false ? "--no-tests" : `${app.id} has no tests.safe command`;
  const named = asked.length ? `, and the entry sets none of ${asked.map((name) => `commands.${name}`).join(", ")}` : "";
  const hint = others.length
    ? `; it sets ${others.map((name) => `commands.${name}`).join(" and ")}: run it with --commands ${others.join(",")}`
    : asked.length
      ? ""
      : "; it sets no typecheck or build command either";
  return `nothing to run: ${tests}${named}${hint}`;
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

/** The members of process group `pgid` now, with their identities (killRun signals an exited root's group only through members it saw). */
function groupMembers(pgid: number): ProcInfo[] {
  const out = spawnSync(TOOLS.ps, ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout: 30_000, env: { PATH: SYSTEM_PATH } }).stdout ?? "";
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [pid, ppid, group] = cols.slice(0, 3).map(Number) as [number, number, number];
    if (group === pgid && Number.isInteger(pid)) procs.push({ pid, ppid, pgid: group, started: cols.slice(3).join(" ") });
  }
  return procs;
}

/**
 * SIGKILLs every process whose environment carries `DS_TEST_APPS_RUN=<tag>`: a descendant that left the
 * command's process group (setsid, a detached child) still carries the run's environment. macOS hides the
 * environment of platform binaries (/bin/sleep and the like) from ps, so only the runtimes' strays (bun, node,
 * python) are found this way.
 */
function killTagged(tag: string): number[] {
  const out = spawnSync(TOOLS.ps, ["-A", "-E", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 30_000 }).stdout ?? "";
  const pids = out
    .split("\n")
    .filter((line) => line.includes(`DS_TEST_APPS_RUN=${tag}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return pids;
}

export interface CommandResult extends PlannedCommand {
  /** The command after placeholder substitution. */
  expanded: string;
  /** Processes outside the command's group that still carried the run's tag after it ended (killed). */
  strays: number[];
  /** Listeners beyond loopback the command's processes opened (the command was killed at the first). */
  exposed: string[];
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
  /** Named commands the entry does not set (plannedCommands): listed, never run, never a failure. */
  skipped: string[];
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

/**
 * The sandbox one command runs in: the one place test:apps builds it. Writes: only the app's own writable
 * scope (the write check's scan, its read-only dirs pruned) and the run's temp dir (runPolicy keeps every
 * `.git` entry under them, the tool's dirs and the design-system checkouts read-only). Network (decision 31):
 * a test command gets runPolicy's suiteNetwork (its port block and 49152-65535 on loopback, minus the ports
 * listening now and the owner's); a named command no port at all.
 */
export function commandPolicy(
  app: AppEntry,
  planned: PlannedCommand,
  ctx: { root: string; tmp: string; outDir: string; scope: WriteScope; registry?: Registry },
): { policy: SandboxPolicy; network: string } {
  const base = { root: ctx.root, tmp: ctx.tmp, outDir: ctx.outDir, writable: ctx.scope.scan, readOnly: ctx.scope.prune };
  if (!planned.label.startsWith("tests.")) return { policy: runPolicy(base), network: "no network port" };
  const block = profileBlock(app, ctx.registry);
  const blockPorts = block ? Array.from({ length: block.size }, (_, i) => block.start + i) : [];
  const listeners = listeningPorts();
  const range = block ? `its block ${block.start}-${block.start + block.size - 1} and ` : "";
  const denied = [...new Set([...OWNER_PORTS, ...listeners])].sort((a, b) => a - b);
  return {
    policy: runPolicy({ ...base, blockPorts, suiteNetwork: { listeners } }),
    network: `loopback only to ${range}${EPHEMERAL_PORTS.min}-${EPHEMERAL_PORTS.max}, minus ${listeners.length} port(s) listening at start and the owner's ports; never ${denied.join(",")}`,
  };
}

async function runOne(app: AppEntry, planned: PlannedCommand, opts: TestAppOptions & { dir: string; scope: WriteScope }): Promise<CommandResult> {
  const root = opts.root;
  const tmp = mkdtempSync(join(safeTempBase(), `ds-test-${app.id}-`));
  const name = planned.label.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const log = join(opts.dir, `${name}.log`);
  try {
    copyFixtures(app, tmp);
    const tag = randomUUID();
    const env = { ...profileEnv(app, { root, tmp }), DS_TEST_APPS_RUN: tag };
    const expanded = expandPlaceholders(planned.cmd, { root, tmp, ports: app.runProfile?.ports ?? {} });
    const cwd = resolvePath(root, planned.cwd);
    const sandbox = commandPolicy(app, planned, { root, tmp, outDir: opts.outDir, scope: opts.scope, registry: opts.registry });
    const argv = sandboxCommand(sandbox.policy, [TOOLS.sh, "-c", withWatchdog(expanded)]);
    writeFileSync(log, `$ ${expanded}\n  (cwd ${cwd}, sandboxed, HOME ${tmp}, writes only in ${opts.scope.scan.join(", ")} and HOME; ${sandbox.network})\n`);

    const marker = join(opts.dir, `.marker-${name}`);
    const before = { status: statusSnapshot(opts.scope), git: gitEntries(opts.scope) };
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
    // stdout and stderr only: the watchdog's fd 3 stays open on this side until the child is gone.
    const closed = Promise.all([child.stdout!, child.stderr!].map((stream) => new Promise<void>((done) => stream.once("close", () => done()))));
    const exited = new Promise<number>((done) => {
      child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
      child.on("error", () => done(127));
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = opts.timeoutMs ?? 15 * 60_000;
    // The group's members as they appear (the watchdog among them): killRun stops an exited root's group
    // only through members it has seen.
    const known = new Map<number, ProcInfo>();
    // Listeners beyond loopback: Seatbelt lets a suite bind 0.0.0.0 (its `localhost` is every local address),
    // so the tool looks, and kills the group at the first one.
    const exposed: string[] = [];
    let running = true;
    const watch = (async () => {
      while (running && child.pid) {
        const members = groupMembers(child.pid);
        for (const proc of members) if (!known.has(proc.pid)) known.set(proc.pid, proc);
        if (exposed.length === 0 && members.length) {
          const found = await exposedListeners(members.map((proc) => proc.pid));
          if (found.ok && found.listeners.length) {
            exposed.push(...found.listeners.map(describeConnection));
            appendFileSync(log, `\n# VIOLATION listening beyond loopback, reachable from other hosts: ${exposed.join("; ")}; killing the command\n`);
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
        }
        await sleep(250);
      }
    })();
    const exit = await Promise.race([exited, new Promise<number>((done) => (timer = setTimeout(() => ((timedOut = true), done(-1)), timeout)))]);
    clearTimeout(timer);
    running = false;
    await watch;
    // Once more right after the exit, for a command that ended before the first look: milliseconds after the
    // root was reaped, its pid (allocated in sequence) cannot lead another process's group yet.
    if (child.pid && !timedOut) for (const proc of groupMembers(child.pid)) if (!known.has(proc.pid)) known.set(proc.pid, proc);
    if (root$) await killRun([root$], 2_000, [...known.values()]);
    const strays = killTagged(tag);
    // Every byte the command wrote, before reading the result (a stray holding the pipe is dead by now).
    await Promise.race([closed, sleep(5_000)]);
    (child.stdio[3] as { destroy?: () => void } | null)?.destroy?.();
    const code = timedOut ? 124 : exit;
    const seconds = (Date.now() - started) / 1000;
    appendFileSync(log, `\n[exit ${code}${timedOut ? `, timed out after ${timeout / 1000} s` : ""}] ${seconds.toFixed(1)} s${strays.length ? `; killed ${strays.length} stray process(es) outside its group: ${strays.join(", ")}` : ""}\n`);

    const writes = writeReport(root, opts.scope, before, marker, [opts.outDir, tmp, opts.dir]);
    rmSync(marker, { force: true });
    const parsed = parseOutput(output, { root, tmp });
    const baseline = app.tests?.baselines?.[planned.label];
    const verdict = timedOut ? { ok: false, reasons: [`timed out after ${timeout / 1000} s`], newFailures: [], fixed: [] } : compareWithBaseline(code, parsed, baseline, planned.cmd);
    if (writes.unexpected.length) verdict.reasons.push(`${writes.unexpected.length} unexpected write(s): ${writes.unexpected.slice(0, 5).join(", ")}${writes.unexpected.length > 5 ? ", ..." : ""}`);
    if (strays.length) verdict.reasons.push(`${strays.length} process(es) left the command's group and outlived it (killed)`);
    if (exposed.length) verdict.reasons.push(`listened beyond loopback, reachable from other hosts (killed): ${exposed.join("; ")}`);
    const proposedBaseline: TestBaseline = {
      cmd: planned.cmd,
      exit: code,
      ...(parsed.pass !== undefined ? { pass: parsed.pass } : {}),
      ...(parsed.fail !== undefined ? { fail: parsed.fail } : {}),
      ...(parsed.errors !== undefined ? { errors: parsed.errors } : {}),
      ...(parsed.failing.length ? { failing: parsed.failing } : {}),
      date: new Date().toLocaleDateString("sv-SE"), // the local YYYY-MM-DD
      method: `bun run test:apps --root ${root} (sandbox-exec, profile env, write check), 1 run`,
    };
    const ok = verdict.ok && writes.unexpected.length === 0 && !timedOut && strays.length === 0 && exposed.length === 0;
    return { ...planned, expanded, strays, exposed, exit: code, timedOut, seconds, parsed, baseline, verdict, writes, ok, log, proposedBaseline };
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
  const { commands: planned, skipped } = plannedCommands(app, { tests: opts.tests, commands: opts.commands });
  const report: AppReport = { app: app.id, root, date: new Date().toISOString(), sandbox: SANDBOX_EXEC, scope: { checkouts: [], gitDirs: {}, scan: [], prune: [] }, commands: [], skipped, ok: false };
  const noSandbox = sandboxUnavailable();
  if (noSandbox) {
    report.refused = `refusing to run without the OS sandbox: ${noSandbox}`;
    return report;
  }
  if (planned.length === 0) {
    report.refused = nothingToRun(app, { tests: opts.tests, commands: opts.commands });
    return report;
  }
  report.scope = appWriteScope(root, app);
  // Through safeChildPath: no symlink on the way can send the report into the owner's tree.
  const dir = safeChildPath({ base: outDir, root, label: "--out-dir" }, app.id, "test-apps", stamp());
  mkdirSync(dir, { recursive: true });
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

/**
 * The out dir when --out-dir is not given: $DS_RUN, else `ds-rollout` under the temp base, which must pass
 * safeTempBase (an existing dir outside the owner's tree, not the home itself, not in ~/Library or a
 * credential store), whatever TMPDIR says.
 */
export function defaultOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DS_RUN || join(safeTempBase({ tmp: env.TMPDIR || tmpdir() }), "ds-rollout");
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const outDir = argv.includes("--out-dir") ? undefined : defaultOutDir(env);
  const opts: CliOptions = {
    root: workspaceRoot(),
    registry: REGISTRY_PATH,
    outDir: outDir ?? "",
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
      report = { app: id, root: opts.root, date: new Date().toISOString(), sandbox: SANDBOX_EXEC, scope: { checkouts: [], gitDirs: {}, scan: [], prune: [] }, commands: [], skipped: [], refused: (error as Error).message, ok: false };
    }
    reports.push(report);
    if (opts.json) continue;
    for (const line of report.skipped) console.log(`${id}: ${line}`);
    if (report.refused) console.log(`${id}: REFUSED ${report.refused}`);
    for (const result of report.commands) for (const line of describe(result)) console.log(`${id} ${line}`);
    if (!report.refused) console.log(`${id}: ${report.ok ? "ok" : "FAILED"}; report ${report.reportPath}`);
  }
  if (opts.json) console.log(JSON.stringify(reports, null, 2));
  return reports.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await cli());
