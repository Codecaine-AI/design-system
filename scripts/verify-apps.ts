/**
 * Runtime check: proves in a real browser that each app renders from the design-system tokens.
 *
 *   bun run verify:apps [--root <dir>] [--out-dir <dir>] [--pass <1|2|3>] [--registry <apps.json>] [app...]
 *   bun run verify:apps --propagate --root <dir> [--out-dir <dir>] [app...]
 *   bun run verify:apps --restore --root <dir> [--out-dir <dir>]
 *
 * Each app starts with its run profile (scripts/lib/app-runner.ts) and gets its own Chromium, started
 * inside the OS sandbox with that run's ports only (launchBrowser), and a fresh guarded context. Every
 * repository git reads and Playwright are pinned before the first app starts.
 * Assertions: the design-system package the app uses resolves inside --root with the current
 * tokens.css (every run mode), the verify spec probes page, panel, text and border, token probes
 * compute to the current build's values in the default theme and after the dark switch (dark-first:
 * dark is the default), the regular faces of Inter and IBM Plex Mono load from the package's fonts/
 * (IBM Plex Mono rendered only in other faces: those faces too; scripts/lib/verify/fonts.ts),
 * the sidebar state survives a reload (shell apps; n/a at --pass 1 unless the shell renders), the URL
 * came from the server output, every served file is inside --root, and no request was blocked.
 * Run mode none: always the static check (package and entry stylesheet), reported as not
 * runtime-verified; the verify gate's n/a reason covers only the runtime part.
 * Refuses to run while a propagate journal is unrestored or a build holds the sentinel color.
 *
 * Writes <out-dir>/<app>/verify/<timestamp>.json per app (the ISO time with ':' written as '-'; the JSON
 * keeps the ISO `timestamp`) and prints a summary. Exit 1 on any failure; exit 2 on bad arguments, an
 * --out-dir in the owner's tree or in a git checkout, an invalid registry (registry:check's rules), or
 * a result or journal path through a symlink.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GitPinError, pinFor, pinnedGit, pinRepos } from "./lib/git";
import { type AppEntry, DESIGN_SYSTEM_ROOT, getApp, loadRegistry, type PassId, REGISTRY_PATH, type Registry, resolvePath, workspaceRoot, designSystemIn } from "./lib/registry";
import { toolOutputDir } from "./lib/output-dir";
import { safeAppId, safeChildPath, UnsafePathError } from "./lib/safe-paths";
import { type Assertion, fail, na, pass } from "./lib/verify/assertions";
import { checkPage, sentinelAssertions } from "./lib/verify/page-checks";
import {
  buildHashes,
  checkPropagateRoot,
  eligibleApps,
  hashChanges,
  propagateBlocker,
  readJournal,
  Refusal,
  type RestoreResult,
  restoreFromJournal,
  SENTINEL,
  SENTINEL_COMPUTED,
  SENTINEL_TOKEN,
  withSentinel,
} from "./lib/verify/propagate";
import type { RuntimeReport, Session } from "./lib/verify/run-app";
import { fontDiskPath, fontSourceJudge } from "./lib/verify/font-source";
import { PACKAGE, packageCheck, staticCheck } from "./lib/verify/static-check";
import { type BuildValues, loadBuildValues } from "./lib/verify/tokens";

const USAGE = `usage: bun run verify:apps [--root <dir>] [--out-dir <dir>] [--pass <1|2|3>] [--registry <apps.json>] [--propagate | --restore] [app...]`;

interface Args {
  root?: string;
  outDir: string;
  registry: string;
  pass?: PassId;
  propagate: boolean;
  restore: boolean;
  apps: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { outDir: process.env.DS_RUN || join(tmpdir(), "ds-rollout"), registry: REGISTRY_PATH, propagate: false, restore: false, apps: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--root") args.root = value();
    else if (arg === "--out-dir") args.outDir = value();
    else if (arg === "--registry") args.registry = resolve(value());
    else if (arg === "--pass") {
      const p = value();
      if (p !== "1" && p !== "2" && p !== "3") throw new Error(`--pass must be 1, 2 or 3, not ${p}`);
      args.pass = p;
    } else if (arg === "--propagate") args.propagate = true;
    else if (arg === "--restore") args.restore = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else args.apps.push(arg);
  }
  if (args.propagate && args.restore) throw new Error("--propagate and --restore are exclusive");
  // Never the owner's tree (unless --root is that tree) and never a git checkout: the shared destination check.
  args.outDir = toolOutputDir(args.outDir, { root: args.root, label: "--out-dir" });
  return args;
}

// -- results ----------------------------------------------------------------------

interface AppResult {
  app: string;
  name: string;
  timestamp: string;
  root: string;
  mode: AppEntry["run"]["mode"];
  runtimeVerified: boolean;
  pass: PassId | null;
  designSystem: { dir: string; commit: string | null; dirty: boolean | null; tokensCssSha256: string };
  playwright?: string;
  propagate?: { sentinel: string; dsDir: string; journal: string; restore?: Omit<RestoreResult, "build" | "check"> & { build: boolean; check: boolean } };
  ok: boolean;
  assertions: Assertion[];
  blockedRequests: string[];
  expectedBlocked: string[];
  servedFiles?: RuntimeReport["servedFiles"];
  baseUrl?: string;
  ports?: Record<string, number>;
  startedPorts?: number[];
  logPath?: string;
  consoleErrors: string[];
  egress?: RuntimeReport["egress"];
  clock?: string;
}

/**
 * git through git.ts: the system git pinned to the repository as recorded before any app started
 * (pinAppRepos), hook-free, no fsmonitor, no system or global config. Null when git fails or `dir` is in
 * no checkout; a pin that changed throws (GitPinChanged), and the run stops.
 */
function git(dir: string, ...args: string[]): string | null {
  const pin = pinFor(dir, { optional: true });
  if (!pin) return null;
  const result = pinnedGit(pin, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Pins every repository this run reads (git.ts) before the first app starts: the design-system checkouts and each app's. */
function pinAppRepos(root: string, apps: AppEntry[]) {
  const dirs = apps.flatMap((app) => [app.repo, app.root, ...(app.scan?.paths ?? [])].filter((path): path is string => typeof path === "string").map((path) => resolvePath(root, path)));
  pinRepos([DESIGN_SYSTEM_ROOT, designSystemIn(root), ...dirs.filter((dir) => existsSync(dir))]);
}

function designSystemMeta(values: BuildValues): AppResult["designSystem"] {
  const status = git(values.dir, "status", "--porcelain");
  return { dir: values.dir, commit: git(values.dir, "rev-parse", "HEAD"), dirty: status === null ? null : status !== "", tokensCssSha256: values.tokensCssSha256 };
}

function newResult(app: AppEntry, args: Args, root: string, meta: AppResult["designSystem"]): AppResult {
  return {
    app: app.id,
    name: app.name,
    timestamp: new Date().toISOString(),
    root,
    mode: app.run.mode,
    runtimeVerified: false,
    pass: args.pass ?? null,
    designSystem: meta,
    ok: false,
    assertions: [],
    blockedRequests: [],
    expectedBlocked: [],
    consoleErrors: [],
  };
}

function absorb(result: AppResult, report: RuntimeReport) {
  result.runtimeVerified = !report.assertions.some((a) => a.id === "start");
  result.assertions.push(...report.assertions);
  result.blockedRequests = report.blockedRequests;
  result.expectedBlocked = report.expectedBlocked;
  result.servedFiles = report.servedFiles;
  result.baseUrl = report.baseUrl;
  result.ports = report.ports;
  result.startedPorts = report.startedPorts;
  result.logPath = report.logPath;
  result.consoleErrors = [...new Set(report.consoleErrors)];
  if (report.egress) result.egress = report.egress;
  if (report.clock) result.clock = report.clock;
}

/** <out-dir>/<segments...>, every segment safe and no component a symlink (safeChildPath); throws UnsafePathError. */
function outPath(args: Args, label: string, ...segments: string[]): string {
  return safeChildPath({ base: args.outDir, root: args.root, label }, ...segments);
}

/** <out-dir>/<app>/verify: checked before an app runs, so a planted symlink refuses the run instead of its result. */
const resultDir = (args: Args, app: string) => outPath(args, "verify result", safeAppId(app), "verify");

function writeResult(args: Args, result: AppResult): string {
  result.ok = !result.assertions.some((a) => a.status === "fail");
  // An ISO timestamp has ':', which is not a safe path segment; the JSON keeps the ISO form.
  const segments = [safeAppId(result.app), "verify", `${result.timestamp.replace(/:/g, "-")}.json`];
  mkdirSync(dirname(outPath(args, "verify result", ...segments)), { recursive: true });
  // Checked again after mkdir (a link planted meanwhile is refused); "wx" never follows a link at the file itself.
  const path = outPath(args, "verify result", ...segments);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return path;
}

function printSummary(results: Array<{ result: AppResult; path: string }>) {
  for (const { result, path } of results) {
    for (const a of result.assertions.filter((x) => x.status === "fail")) console.log(`${result.app} ${a.id} ${a.message}`);
    const count = (s: Assertion["status"]) => result.assertions.filter((a) => a.status === s).length;
    const allNa = result.assertions.every((a) => a.status === "n/a");
    const state = allNa ? "n/a" : result.ok ? "ok" : "FAIL";
    const note = result.mode === "none" ? " (not runtime-verified)" : "";
    console.log(`${result.app} ${state}${note}: ${count("pass")} pass, ${count("fail")} fail, ${count("n/a")} n/a -> ${path}`);
  }
  const failed = results.filter(({ result }) => !result.ok).length;
  console.log(`verify:apps: ${results.length - failed} of ${results.length} app(s) ok${failed ? `, ${failed} failed` : ""}`);
}

// -- browser ------------------------------------------------------------------------

/**
 * Playwright, loaded and its package hashed before the first app starts (playwright.ts pinPlaywright).
 * Each app gets its own Chromium, sandboxed to that run's ports (run-app.ts inRunningApp, launchBrowser).
 */
async function preparePlaywright(root: string, apps: AppEntry[]): Promise<{ ready: boolean; version?: string; error?: string }> {
  if (!apps.some((app) => app.run.mode === "browser" || app.run.mode === "static")) return { ready: false };
  try {
    const { pinPlaywright, playwrightVersion } = await import("./lib/playwright");
    pinPlaywright(root);
    return { ready: true, version: playwrightVersion(root) };
  } catch (error) {
    return { ready: false, error: `Playwright did not load: ${(error as Error).message.split("\n")[0]}` };
  }
}

async function runtime(app: AppEntry, session: Session, check: Parameters<typeof import("./lib/verify/run-app").inRunningApp>[2]): Promise<RuntimeReport> {
  const { inRunningApp } = await import("./lib/verify/run-app");
  return inRunningApp(app, session, check);
}

// -- modes ----------------------------------------------------------------------------

/** The design-system checkouts whose fonts/ count for an app without a resolved package (host-css): the root's own. */
function rootPackageDir(root: string): string | null {
  const dir = designSystemIn(root);
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PACKAGE ? realpathSync(dir) : null;
  } catch {
    return null;
  }
}

async function verifyMode(args: Args, registry: Registry): Promise<number> {
  const root = realpathSync(resolve(args.root ?? workspaceRoot()));
  const blocker = propagateBlocker({ outDirs: [args.outDir, process.env.DS_RUN], dsDirs: [designSystemIn(root), DESIGN_SYSTEM_ROOT] });
  if (blocker) throw new Refusal(`refusing to verify: ${blocker}`);
  // Processes a crashed earlier run left behind (the runner's records in <out-dir>/runs).
  const { cleanupRuns } = await import("./lib/app-runner");
  for (const line of await cleanupRuns(args.outDir)) console.error(`verify:apps: cleanup: ${line}`);
  const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
  const meta = designSystemMeta(values);
  const unknown = args.apps.filter((id) => !registry.apps.some((app) => app.id === id));
  if (unknown.length) throw new Refusal(`apps.json has no app ${unknown.map((id) => `"${id}"`).join(", ")}`);
  const apps = args.apps.length ? args.apps.map((id) => getApp(registry, id)) : registry.apps;
  if (apps.length === 0) {
    console.error("verify:apps: apps.json lists no apps");
    return 1;
  }
  for (const app of apps) resultDir(args, app.id);
  const runtimeApps = apps.filter((app) => app.gates.verify.required && app.run.mode !== "none");
  // Before the first app starts: every repository git reads, and Playwright.
  pinAppRepos(root, runtimeApps);
  const { ready: browser, version, error } = await preparePlaywright(root, runtimeApps);
  const session: Session = { root, outDir: args.outDir, registry };
  const results: Array<{ result: AppResult; path: string }> = [];
  {
    for (const app of apps) {
      const result = newResult(app, args, root, meta);
      result.playwright = version;
      if (app.run.mode === "none") {
        // Static, whatever the gate says: the gate's n/a reason covers only the runtime part.
        result.assertions.push(...staticCheck(app, root, values));
        if (!app.gates.verify.required) result.assertions.push(na("gate", `runtime verify gate is n/a: ${app.gates.verify.reason}`));
      } else if (!app.gates.verify.required) {
        result.assertions.push(na("gate", `verify gate is n/a: ${app.gates.verify.reason}`));
      } else {
        // Every run mode: the package the app uses is inside the root and carries the current build.
        const pkg = packageCheck(app, root, values);
        result.assertions.push(...pkg.assertions);
        if (!browser && app.run.mode !== "electron") {
          result.assertions.push(fail("playwright", error ?? "no browser"));
        } else {
          console.error(`verify:apps: ${app.id}: starting (${app.run.mode})`);
          const packageDirs = [pkg.dir ?? (app.consume.via === "host-css" ? rootPackageDir(root) : null)].filter((dir): dir is string => dir !== null);
          absorb(
            result,
            await runtime(app, session, (page, ctx) =>
              checkPage(page, {
                app,
                values,
                responses: ctx.responses,
                pass: args.pass,
                prepare: ctx.prepare,
                fontSource: fontSourceJudge({
                  packageDirs,
                  buildFontsDir: join(DESIGN_SYSTEM_ROOT, "fonts"),
                  buildFontsCss: join(DESIGN_SYSTEM_ROOT, "css/fonts.css"),
                  copyDirs: [ctx.running.tmp, ...(app.consume.via === "copy" ? [resolvePath(root, app.repo)] : [])],
                  diskPath: (url) => fontDiskPath(ctx.running, url),
                }),
              }),
            ),
          );
        }
      }
      results.push({ result, path: writeResult(args, result) });
    }
  }
  printSummary(results);
  return results.every(({ result }) => result.ok) ? 0 : 1;
}

async function propagateMode(args: Args, registry: Registry): Promise<number> {
  const root = checkPropagateRoot(args.root);
  const dsDir = designSystemIn(root);
  const journalDir = outPath(args, "propagate journal", "propagate-journal");
  const statePath = join(process.env.DS_RUN || args.outDir, "STATE.md");
  const eligibility = eligibleApps(registry, args.apps, existsSync(statePath) ? readFileSync(statePath, "utf8") : null);
  for (const problem of eligibility.problems) console.error(`verify:apps: --propagate: ledger: ${problem}`);
  for (const skip of eligibility.skipped) console.error(`verify:apps: --propagate skips ${skip.id}: ${skip.reason}`);
  if (eligibility.apps.length === 0) {
    console.error("verify:apps: --propagate found no eligible app (none listed, none done in the ledger with a live link); nothing changed");
    return 1;
  }
  for (const app of eligibility.apps) resultDir(args, app.id);
  // Before the first app starts: every repository git reads, and Playwright.
  pinAppRepos(root, eligibility.apps);
  const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
  const meta = designSystemMeta(values);
  const { ready: browser, version, error } = await preparePlaywright(root, eligibility.apps);
  const session: Session = { root, outDir: args.outDir, registry };
  // Content, not git status: a file already modified before the run must come back byte-for-byte too.
  const hashesBefore = buildHashes(dsDir);
  const pending: AppResult[] = [];
  let restore: RestoreResult;
  try {
    ({ restore } = await withSentinel(dsDir, journalDir, async () => {
      console.error(`verify:apps: ${SENTINEL_TOKEN} is ${SENTINEL} in ${dsDir}, rebuilt`);
      for (const app of eligibility.apps) {
        const result = newResult(app, args, root, meta);
        result.playwright = version;
        result.propagate = { sentinel: SENTINEL, dsDir, journal: journalDir };
        if (app.run.mode === "none") result.assertions.push(fail("sentinel", `run mode none (${app.run.reason}): the sentinel cannot be checked at runtime`));
        else if (!browser && app.run.mode !== "electron") result.assertions.push(fail("playwright", error ?? "no browser"));
        else {
          console.error(`verify:apps: ${app.id}: starting (${app.run.mode}) with the sentinel`);
          absorb(result, await runtime(app, session, (page) => sentinelAssertions(page, app, SENTINEL_TOKEN, SENTINEL_COMPUTED)));
        }
        pending.push(result);
      }
    }));
  } catch (error) {
    // withSentinel restored (or says how to restore) before it threw.
    console.error(`verify:apps: --propagate failed: ${(error as Error).message}`);
    return 1;
  }
  const changes = hashChanges(hashesBefore, buildHashes(dsDir));
  const restoreAssertions: Assertion[] = [
    restore.ok
      ? pass("restore", `restored ${restore.restored.length} theme file(s); bun run build and bun run check passed in ${restore.dsDir}`)
      : fail("restore", `restore incomplete: build ${restore.build.ok ? "ok" : "FAILED"}, check ${restore.check.ok ? "ok" : "FAILED"}\n${restore.check.output}`),
    changes.length === 0
      ? pass("restore.files", `tokens/themes and dist are byte-identical to before the run (${Object.keys(hashesBefore).length} files, sha256)`)
      : fail("restore.files", `${changes.length} file(s) under tokens/themes or dist differ from before the run: ${changes.slice(0, 5).join(", ")}`, { changes }),
  ];
  console.error(`verify:apps: restored ${dsDir} (${restore.restored.join(", ")}); build ${restore.build.ok ? "ok" : "FAILED"}, check ${restore.check.ok ? "ok" : "FAILED"}`);
  const results = pending.map((result) => {
    result.assertions.push(...restoreAssertions);
    result.propagate!.restore = { ...restore, build: restore.build.ok, check: restore.check.ok };
    return { result, path: writeResult(args, result) };
  });
  printSummary(results);
  return results.every(({ result }) => result.ok) ? 0 : 1;
}

function restoreMode(args: Args): number {
  const root = checkPropagateRoot(args.root, "--restore");
  const journalDir = outPath(args, "propagate journal", "propagate-journal");
  const manifest = readJournal(journalDir);
  if (!manifest) {
    console.error(`verify:apps --restore: no propagate journal at ${journalDir}; nothing restored`);
    return 1;
  }
  const dsDir = realpathSync(designSystemIn(root));
  if (manifest.dsDir !== dsDir) throw new Refusal(`--restore: the journal is for ${manifest.dsDir}, not ${dsDir}`);
  const result = restoreFromJournal(journalDir);
  // A build the crashed run left running is stopped before anything is restored.
  if (result.stoppedBuild) console.log(`verify:apps --restore: earlier build ${result.stoppedBuild.script} (pid ${result.stoppedBuild.pid}): ${result.stoppedBuild.outcome}`);
  console.log(
    `verify:apps --restore: ${result.restored.length ? `restored ${result.restored.join(", ")}` : `journal already restored at ${readJournal(journalDir)?.restoredAt}`} in ${dsDir}; build ${result.build.ok ? "ok" : "FAILED"}, check ${result.check.ok ? "ok" : "FAILED"}`,
  );
  if (!result.ok) console.error(`${result.build.output}\n${result.check.output}`);
  return result.ok ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`verify:apps: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  // Ctrl-C stops every app this process started (and runs the cleanups registered later) before exiting 130.
  const { installSignalHandlers, validateLoadedRegistry } = await import("./lib/app-runner");
  installSignalHandlers();
  try {
    if (args.restore) return restoreMode(args);
    let registry: Registry;
    try {
      // registry:check's rules, before anything is checked or started.
      registry = validateLoadedRegistry(loadRegistry(args.registry), args.registry);
    } catch (error) {
      console.error(`verify:apps: ${(error as Error).message}`);
      return 2;
    }
    return args.propagate ? await propagateMode(args, registry) : await verifyMode(args, registry);
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`verify:apps: ${error.message}`);
      return 1;
    }
    if (error instanceof UnsafePathError) {
      console.error(`verify:apps: ${error.message}`);
      return 2;
    }
    if (error instanceof GitPinError) {
      // A repository's `.git` entry changed while apps ran, or one was never pinned: git must not run there.
      console.error(`verify:apps: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(await main());
