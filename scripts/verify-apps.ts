/**
 * Runtime check: proves in a real browser that each app renders from the design-system tokens.
 *
 *   bun run verify:apps [--root <dir>] [--out-dir <dir>] [--pass <1|2|3>] [--registry <apps.json>] [app...]
 *   bun run verify:apps --propagate --root <dir> [--out-dir <dir>] [app...]
 *   bun run verify:apps --restore --root <dir> [--out-dir <dir>]
 *
 * Each app starts with its run profile (scripts/lib/app-runner.ts) and a fresh browser context.
 * Assertions: the design-system package the app uses resolves inside --root with the current
 * tokens.css (every run mode), the verify spec probes page, panel, text and border, token probes
 * compute to the current build's values in the default theme and after the dark switch (dark-first:
 * dark is the default), the regular faces of Inter and IBM Plex Mono load from the package's fonts/,
 * the sidebar state survives a reload (shell apps; n/a at --pass 1 unless the shell renders), the URL
 * came from the server output, every served file is inside --root, and no request was blocked.
 * Run mode none: always the static check (package and entry stylesheet), reported as not
 * runtime-verified; the verify gate's n/a reason covers only the runtime part.
 * Refuses to run while a propagate journal is unrestored or a build holds the sentinel color.
 *
 * Writes <out-dir>/<app>/verify/<ISO timestamp>.json per app and prints a summary. Exit 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AppEntry, DESIGN_SYSTEM_ROOT, getApp, loadRegistry, type PassId, REGISTRY_PATH, type Registry, resolvePath } from "./lib/registry";
import { safeAppId, safeOutputPath } from "./lib/safe-paths";
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
import { fontSourceJudge, servedDiskPath } from "./lib/verify/font-source";
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
  // Never the owner's tree (unless --root is that tree): the shared destination check.
  args.outDir = safeOutputPath(args.outDir, { root: args.root, label: "--out-dir" });
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
}

function git(dir: string, ...args: string[]): string | null {
  const result = spawnSync("git", ["--no-optional-locks", "-C", dir, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
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
}

function writeResult(outDir: string, result: AppResult): string {
  result.ok = !result.assertions.some((a) => a.status === "fail");
  const dir = join(outDir, safeAppId(result.app), "verify");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
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

async function openBrowser(root: string, apps: AppEntry[]): Promise<{ browser?: any; version?: string; error?: string }> {
  if (!apps.some((app) => app.run.mode === "browser" || app.run.mode === "static")) return {};
  try {
    const { loadPlaywright, playwrightVersion } = await import("./lib/playwright");
    const { LAUNCH_OPTIONS } = await import("./lib/capture");
    const { installSignalHandlers } = await import("./lib/app-runner");
    // LAUNCH_OPTIONS keeps Playwright's own signal handlers off; the runner's handler closes the browser.
    const browser = await loadPlaywright(root).chromium.launch(LAUNCH_OPTIONS);
    installSignalHandlers(() => browser.close());
    return { browser, version: playwrightVersion(root) };
  } catch (error) {
    return { error: `Playwright did not start: ${(error as Error).message.split("\n")[0]}` };
  }
}

async function runtime(app: AppEntry, session: Session, check: Parameters<typeof import("./lib/verify/run-app").inRunningApp>[2]): Promise<RuntimeReport> {
  const { inRunningApp } = await import("./lib/verify/run-app");
  return inRunningApp(app, session, check);
}

// -- modes ----------------------------------------------------------------------------

/** The design-system checkouts whose fonts/ count for an app without a resolved package (host-css): the root's own. */
function rootPackageDir(root: string): string | null {
  const dir = join(root, "design-system");
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PACKAGE ? realpathSync(dir) : null;
  } catch {
    return null;
  }
}

async function verifyMode(args: Args, registry: Registry): Promise<number> {
  const root = realpathSync(resolve(args.root ?? join(DESIGN_SYSTEM_ROOT, "..")));
  const blocker = propagateBlocker({ outDirs: [args.outDir, process.env.DS_RUN], dsDirs: [join(root, "design-system"), DESIGN_SYSTEM_ROOT] });
  if (blocker) throw new Refusal(`refusing to verify: ${blocker}`);
  const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
  const meta = designSystemMeta(values);
  const unknown = args.apps.filter((id) => !registry.apps.some((app) => app.id === id));
  if (unknown.length) throw new Refusal(`apps.json has no app ${unknown.map((id) => `"${id}"`).join(", ")}`);
  const apps = args.apps.length ? args.apps.map((id) => getApp(registry, id)) : registry.apps;
  if (apps.length === 0) {
    console.error("verify:apps: apps.json lists no apps");
    return 1;
  }
  const runtimeApps = apps.filter((app) => app.gates.verify.required && app.run.mode !== "none");
  const { browser, version, error } = await openBrowser(root, runtimeApps);
  const session: Session = { browser, root, outDir: args.outDir };
  const results: Array<{ result: AppResult; path: string }> = [];
  try {
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
                  copyDirs: [ctx.running.tmp, ...(app.consume.via === "copy" ? [resolvePath(root, app.repo)] : [])],
                  diskPath: (url) => servedDiskPath(ctx.running, url),
                }),
              }),
            ),
          );
        }
      }
      results.push({ result, path: writeResult(args.outDir, result) });
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }
  printSummary(results);
  return results.every(({ result }) => result.ok) ? 0 : 1;
}

async function propagateMode(args: Args, registry: Registry): Promise<number> {
  const root = checkPropagateRoot(args.root);
  const dsDir = join(root, "design-system");
  const journalDir = join(args.outDir, "propagate-journal");
  const statePath = join(process.env.DS_RUN || args.outDir, "STATE.md");
  const eligibility = eligibleApps(registry, args.apps, existsSync(statePath) ? readFileSync(statePath, "utf8") : null);
  for (const problem of eligibility.problems) console.error(`verify:apps: --propagate: ledger: ${problem}`);
  for (const skip of eligibility.skipped) console.error(`verify:apps: --propagate skips ${skip.id}: ${skip.reason}`);
  if (eligibility.apps.length === 0) {
    console.error("verify:apps: --propagate found no eligible app (none listed, none done in the ledger with a live link); nothing changed");
    return 1;
  }
  const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
  const meta = designSystemMeta(values);
  const { browser, version, error } = await openBrowser(root, eligibility.apps);
  const session: Session = { browser, root, outDir: args.outDir };
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
  } finally {
    await browser?.close().catch(() => undefined);
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
    return { result, path: writeResult(args.outDir, result) };
  });
  printSummary(results);
  return results.every(({ result }) => result.ok) ? 0 : 1;
}

function restoreMode(args: Args): number {
  const root = checkPropagateRoot(args.root, "--restore");
  const journalDir = join(args.outDir, "propagate-journal");
  const manifest = readJournal(journalDir);
  if (!manifest) {
    console.error(`verify:apps --restore: no propagate journal at ${journalDir}; nothing restored`);
    return 1;
  }
  const dsDir = realpathSync(join(root, "design-system"));
  if (manifest.dsDir !== dsDir) throw new Refusal(`--restore: the journal is for ${manifest.dsDir}, not ${dsDir}`);
  const result = restoreFromJournal(journalDir);
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
  const { installSignalHandlers } = await import("./lib/app-runner");
  installSignalHandlers();
  try {
    if (args.restore) return restoreMode(args);
    const registry = loadRegistry(args.registry);
    return args.propagate ? await propagateMode(args, registry) : await verifyMode(args, registry);
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`verify:apps: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(await main());
