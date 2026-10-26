#!/usr/bin/env bun
/**
 * Use an app the way APP_BRIEF step 5 says: visit every registry route, using only navigation and view
 * controls. Never submit, save, delete, sync or send.
 *
 *   bun run use:app --app <id> [--root <dir>] [--out-dir <dir>] [--registry <apps.json>]
 *
 * Starts the app under its run profile and the OS sandbox (app-runner startApp) and visits it with a
 * sandboxed Chromium (launchBrowser) through guarded contexts, as verify:apps and snapshot do. For every
 * route, in each theme it is checked in (light then dark; dark only on a dark-first surface), it loads
 * the route, switches the theme with the registry's verify.darkSwitch (light: a storage verify.lightSwitch,
 * when set), runs the route's steps, waits for
 * waitFor and takes a screenshot; shell apps (verify.sidebar) get the sidebar toggled, shot and toggled
 * back; then up to 30 buttons and links are hovered (lib/use-app/visit.ts). Every click and Enter or
 * Space press is checked first: a submit control, anything in a <form>, or a target named like a write is
 * refused and recorded, never clicked (lib/use-app/safety.ts).
 *
 * Writes <out-dir>/<app>/use-app/<ISO time with ':' as '-'>.json (the JSON keeps the ISO `timestamp`)
 * and the screenshots under <out-dir>/<app>/use-app/<same stamp>/<route>-<theme>-<n>-<label>.png. Records
 * per route and theme every action, console error, failed request and blocked request, and the run's
 * isolation (violations, unproven profile, no sandbox). --out-dir defaults to $DS_RUN, else
 * <tmpdir>/ds-rollout; it is never the owner's tree or a git checkout, and no write goes through a symlink.
 *
 * The app's checkout (HEAD and `git status`) is read before the start and again after stop(); a change
 * fails the run.
 *
 * Exit: 0 when the app was used cleanly, and for run mode none (nothing to run); 1 on a console error, a
 * failed request, an unexpected blocked request, an isolation problem, a failed or refused step, a change
 * to the app's checkout, or an app that did not start; 2 on bad arguments, an unknown app, an invalid
 * registry, an unsafe --out-dir, or an Electron app without DS_ALLOW_ELECTRON=1.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  cleanupRuns,
  ELECTRON_OPT_IN,
  installSignalHandlers,
  launchBrowser,
  refreshStartedPorts,
  type RunningApp,
  startApp,
  validateLoadedRegistry,
} from "./lib/app-runner";
import { GitPinError, pinFor, pinnedGit, pinRepos } from "./lib/git";
import { toolOutputDir } from "./lib/output-dir";
import { type AppEntry, DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, type Registry, resolvePath, workspaceRoot, designSystemIn } from "./lib/registry";
import { safeAppId, safeChildPath, UnsafePathError } from "./lib/safe-paths";
import { checkoutChange, type Isolation, judge, type RepoState, stampOf, type Visit, visitPlan } from "./lib/use-app/log";
import { visitRoute } from "./lib/use-app/visit";
import { propagateBlocker } from "./lib/verify/propagate";

const USAGE = "usage: bun run use:app --app <id> [--root <dir>] [--out-dir <dir>] [--registry <apps.json>]";

interface Args {
  app: string;
  root?: string;
  outDir: string;
  registry: string;
}

function parseArgs(argv: string[]): Args {
  let app: string | undefined;
  let root: string | undefined;
  let outDir = process.env.DS_RUN || join(tmpdir(), "ds-rollout");
  let registry = REGISTRY_PATH;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--app") app = value();
    else if (arg === "--root") root = value();
    else if (arg === "--out-dir") outDir = value();
    else if (arg === "--registry") registry = resolve(value());
    else throw new Error(arg.startsWith("--") ? `unknown option ${arg}` : `unexpected argument ${arg} (name the app with --app)`);
  }
  if (!app) throw new Error("--app is required");
  safeAppId(app);
  // Never the owner's tree (unless --root is that tree) and never a git checkout: the shared destination check.
  return { app, root, registry, outDir: toolOutputDir(outDir, { root, label: "--out-dir" }) };
}

/** git through git.ts (the system git, pinned before the app starts); null when it fails or `dir` is in no checkout. */
function git(dir: string, ...args: string[]): string | null {
  const pin = pinFor(dir, { optional: true });
  if (!pin) return null;
  const result = pinnedGit(pin, args);
  return result.status === 0 ? result.stdout.trimEnd() : null;
}

const repoState = (dir: string): RepoState => {
  const status = git(dir, "status", "--porcelain");
  return { dir, head: git(dir, "rev-parse", "HEAD"), status: status === null ? null : status.split("\n").filter(Boolean) };
};

async function useApp(app: AppEntry, registry: Registry, args: Args): Promise<number> {
  const root = realpathSync(resolve(args.root ?? workspaceRoot()));
  const timestamp = new Date().toISOString();
  const stamp = stampOf(timestamp);
  const base = { base: args.outDir, root: args.root, label: "use:app output" };
  const logPath = safeChildPath(base, app.id, "use-app", `${stamp}.json`);
  const shotPath = (file: string) => safeChildPath(base, app.id, "use-app", stamp, file);
  mkdirSync(dirname(shotPath("x.png")), { recursive: true });

  // Every repository git reads, pinned before the app starts (git.ts); what the run used.
  const dsInRoot = designSystemIn(root);
  const appRepo = resolvePath(root, app.repo);
  pinRepos([DESIGN_SYSTEM_ROOT, dsInRoot, appRepo, resolvePath(root, app.root)].filter((dir) => existsSync(dir)));
  const meta = {
    designSystem: { tool: { dir: DESIGN_SYSTEM_ROOT, commit: git(DESIGN_SYSTEM_ROOT, "rev-parse", "HEAD") }, root: { dir: dsInRoot, commit: git(dsInRoot, "rev-parse", "HEAD") } },
    appRepo: repoState(appRepo),
  };

  // Processes a crashed earlier run left behind (the runner's records in <out-dir>/runs).
  for (const line of await cleanupRuns(args.outDir)) console.error(`use:app: cleanup: ${line}`);
  let running: RunningApp | undefined;
  let browser: any;
  let chromium: string | undefined;
  let startError: string | undefined;
  let stopError: string | undefined;
  const visits: Visit[] = [];
  // Ctrl-C closes the browser, stops the app (app-runner) and exits 130; the log is not written then.
  const removeCleanup = installSignalHandlers(() => browser?.close());
  try {
    console.error(`use:app: ${app.id}: starting (${app.run.mode}) from ${root}`);
    running = await startApp(app, { root, outDir: args.outDir, registry });
    if (!running.electron) {
      browser = await launchBrowser(root, { running });
      chromium = browser.version();
    }
    const target = { running, browser, shotPath, writeShot: (path: string, png: Buffer) => writeFileSync(path, png, { flag: "wx" }) };
    for (const { route, theme } of visitPlan(app)) {
      const visit = await visitRoute(target, route, theme);
      const bad = visit.actions.filter((action) => action.kind !== "hover" && (!action.ok || action.refused)).length;
      console.error(`use:app: ${route.id} (${theme}): ${visit.actions.filter((a) => a.kind === "hover" && a.ok).length} hovers, ${visit.screenshots.length} shots${bad ? `, ${bad} failed or refused` : ""}`);
      visits.push(visit);
    }
  } catch (error) {
    startError = `the app did not start or the browser failed: ${(error as Error).message.split("\n")[0]}`;
  } finally {
    await browser?.close().catch(() => undefined);
    if (running) {
      // A port bound after the start (an owner port included) is only known after a fresh read.
      refreshStartedPorts(running);
      await running.stop().catch((error) => {
        stopError = `stopping the app failed: ${(error as Error).message}`;
      });
    }
    removeCleanup();
  }

  // stop() takes the last egress sample: the violations are complete only now. The app's checkout is
  // read again too: a run that only views leaves it as it was.
  const isolation: Isolation = { violations: [...(running?.violations ?? [])], unproven: Boolean(running?.unproven), unsandboxed: Boolean(running?.unsandboxed) };
  const repoAfter = repoState(appRepo);
  const writeError = checkoutChange(meta.appRepo, repoAfter) ?? undefined;
  const { totals, problems, ok } = judge(visits, isolation, [startError, stopError, writeError]);
  const log = {
    app: app.id,
    name: app.name,
    timestamp,
    root,
    mode: app.run.mode,
    ...meta,
    appRepo: { ...meta.appRepo, after: { head: repoAfter.head, status: repoAfter.status } },
    chromium,
    baseUrl: running?.baseUrl,
    ports: running?.ports,
    startedPorts: running?.startedPorts,
    runLog: running?.logPath,
    shotsDir: dirname(shotPath("x.png")),
    visits,
    totals,
    isolation: { ...isolation, ok: isolation.violations.length === 0 && !isolation.unproven && !isolation.unsandboxed },
    ...(startError ? { startError } : {}),
    ...(stopError ? { stopError } : {}),
    problems,
    ok,
  };
  // Checked again before the write (a link planted meanwhile is refused); "wx" never follows a link at the file.
  writeFileSync(safeChildPath(base, app.id, "use-app", `${stamp}.json`), `${JSON.stringify(log, null, 2)}\n`, { flag: "wx" });

  const themes = [...new Set(visits.map((visit) => visit.theme))].join(", ") || "none";
  console.log(
    `use:app ${app.id}: ${totals.visits} visit(s) (${app.routes.length} route(s) x ${themes}), ${totals.screenshots} screenshot(s), ${totals.hovers} hover(s)` +
      `${totals.hoverErrors ? ` (${totals.hoverErrors} not done)` : ""}; console errors ${totals.consoleErrors}, failed requests ${totals.failedRequests}, ` +
      `blocked ${totals.blocked} (expected ${totals.expectedBlocked}), refused ${totals.refused}, failed actions ${totals.failedActions}, violations ${totals.violations}`,
  );
  for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`);
  if (problems.length > 20) console.log(`  ... ${problems.length - 20} more in the log`);
  console.log(`use:app: ${ok ? "ok" : "FAIL"} -> ${logPath}`);
  return ok ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  let registry: Registry;
  let app: AppEntry;
  try {
    args = parseArgs(argv);
    // registry:check's rules, before anything starts from it.
    registry = validateLoadedRegistry(loadRegistry(args.registry), args.registry);
    app = getApp(registry, args.app);
  } catch (error) {
    console.error(`use:app: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (app.run.mode === "none") {
    console.log(`use:app: ${app.id}: run mode none (${app.run.reason ?? "no reason given"}): nothing to run`);
    return 0;
  }
  if (app.run.mode === "electron" && process.env[ELECTRON_OPT_IN] !== "1") {
    console.error(`use:app: ${app.id}: Electron runs are refused: an Electron launch writes ~/Library/Preferences through cfprefsd, which the sandbox cannot stop; set ${ELECTRON_OPT_IN}=1 only where the owner allows it`);
    return 2;
  }
  const blocker = propagateBlocker({ outDirs: [args.outDir, process.env.DS_RUN], dsDirs: [designSystemIn(resolve(args.root ?? workspaceRoot())), DESIGN_SYSTEM_ROOT] });
  if (blocker) {
    console.error(`use:app: refusing to run: ${blocker}`);
    return 1;
  }
  try {
    return await useApp(app, registry, args);
  } catch (error) {
    if (error instanceof UnsafePathError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`use:app: ${(error as Error).message}`);
      return 2;
    }
    if (error instanceof GitPinError) {
      // A repository's `.git` entry changed while the app ran: git must not run there.
      console.error(`use:app: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(await main());
