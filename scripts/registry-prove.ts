#!/usr/bin/env bun
/**
 * registry-prove: prove an app's run profile does not reach the owner's services.
 *
 *   bun scripts/registry-prove.ts [--root <workspace>] [--out-dir <dir>] <app>...
 *
 * For each app (run mode not "none"), through the shared runner (scripts/lib/app-runner.ts):
 *   1. `startApp(app, { allowUnproven: true })` starts it with exactly its profile: allowlisted env,
 *      temp HOME/XDG with fixtures, profile ports, its own process group.
 *   2. Loads every route, in each theme the route needs, in a `guardedContext`: the runner's
 *      guard aborts and records every request to a local port the run did not start and to any
 *      non-loopback host.
 *   3. The runner contains every run process in the OS sandbox and samples their TCP connections with
 *      lsof from before the first spawn until stop; every connection that is not to or between the
 *      run's own ports, and every failed sample, is a runner violation.
 *   4. Stops the run (only its own processes) and confirms its ports are free.
 *
 * Proven = every route rendered (so rendering needed none of the requests the guard blocked), the run
 * had no violation, egress sampling took at least one sample and none failed (a missing or failing lsof
 * leaves the proof inconclusive, never proven), and the run stopped clean. Blocked requests are listed
 * per origin. Writes <out-dir>/tooling/registry/proofs/<app>.json and .log.
 * The result is evidence for the registry worker; apps.json records it in runProfile.proof.
 *
 * Every repository the proven apps sit in is pinned (git.ts) before the first app starts; a proof whose
 * app checkouts' `.git` entries changed while it ran is not proven. Chromium runs inside the OS sandbox
 * with the run's ports only (launchBrowser), and the guard follows redirects hop by hop.
 *
 * The registry is validated on load (validateLoadedRegistry). --out-dir is never the owner's tree or a git
 * checkout (toolOutputDir); proofs and logs are written through safeChildPath, each to a new temp file
 * (exclusive create) that is then renamed into place. The runs' own logs and records go to
 * <out-dir>/tooling/registry/runs, which no run process can write (the run sandbox writes only the app's
 * checkouts). SIGINT/SIGTERM/SIGHUP close the browser, stop the app and exit 130/143/129; on start, run
 * records a crashed earlier proof left in <out-dir>/tooling/registry/runs/runs/ are cleaned up (cleanupRuns).
 */
import { constants, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanupRuns, guardedContext, installSignalHandlers, launchBrowser, startApp, validateLoadedRegistry, type RunningApp } from "./lib/app-runner";
import { appScope, changedCheckouts, checkoutStates } from "./lib/checkouts";
import { pinRepos } from "./lib/git";
import { toolOutputDir } from "./lib/output-dir";
import { DESIGN_SYSTEM_ROOT, getApp, lightSeed, loadRegistry, resolvePath, type AppEntry, type Registry, type RouteSpec } from "./lib/registry";
import { safeChildPath } from "./lib/safe-paths";

/** The connection classifier lives in scripts/lib/egress.ts (the runner samples with it). */
export { foreignConnections, parseLsof, type Connection } from "./lib/egress";

/** Count blocked requests per origin ("<route>/<theme>: GET http://host:port/path" lines). */
export function summarizeBlocked(lines: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    const m = line.match(/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|WS|REDIRECT)\s+(\S+)/);
    let key = "?";
    try {
      if (m) key = new URL(m[1]!).origin;
    } catch {}
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RouteResult {
  id: string;
  theme: string;
  url: string;
  ok: boolean;
  error?: string;
  consoleErrors: string[];
  probes?: Array<{ selector: string; property: string; token: string; found: boolean; matches: number; value: string | null }>;
}

export interface ProofResult {
  app: string;
  date: string;
  root: string;
  method: string;
  baseUrl?: string;
  startedPorts: number[];
  env: string[];
  routes: RouteResult[];
  blockedRequests: string[];
  /** Distinct origins the guard blocked, with counts (e.g. "http://127.0.0.1:47022": 18). */
  blockedTargets?: Record<string, number>;
  /** The runner's isolation violations: connections that left the run, owner ports listened on, failed samples. */
  foreign: string[];
  /** Distinct sockets the runner's egress sampling saw. */
  connectionsSeen: number;
  /** Egress sampling: samples taken and failures (any failure, or no sample, leaves the proof inconclusive). */
  egress?: { samples: number; failures: string[] };
  /** Why the proof is inconclusive (egress unobserved), when it is. */
  inconclusive?: string;
  /** What the probe check covers: each probe selector matches exactly one element; computed values are not compared (verify:apps does). */
  probeCheck?: "selectors only";
  stoppedClean: boolean;
  stopError?: string;
  /** `.git` entries of the app's checkouts that changed while it ran (the proof then fails). */
  gitChanged?: string[];
  proven: boolean;
}

/** Where the proof's runs keep their logs and run records. */
export function proofRunsDir(outDir: string): string {
  return join(outDir, "tooling", "registry", "runs");
}

/** <out-dir>/tooling/registry/proofs[/<file>], no symlink on the way (safeChildPath). */
export function proofPath(outDir: string, root: string, ...file: string[]): string {
  return safeChildPath({ base: outDir, root, label: "proof" }, "tooling", "registry", "proofs", ...file);
}

/**
 * Writes `<dir()>/<name>` through a new temp file next to it (`write` creates it exclusively), then renames
 * it into place: a symlink planted at the destination is replaced, never followed. `dir` is re-validated
 * (safeChildPath) at each step.
 */
export function writeNew(dir: () => string, name: string, write: (tmp: string) => void): string {
  const tmp = dir() + `/.${name}.${process.pid}.${Date.now()}.tmp`;
  try {
    write(tmp);
    const dest = `${dir()}/${name}`;
    renameSync(tmp, dest);
    return dest;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The open browser, so the signal handlers can close it. */
let openBrowser: any;

async function prove(app: AppEntry, opts: { root: string; outDir: string; registry: Registry }): Promise<ProofResult> {
  const proofDir = () => proofPath(opts.outDir, opts.root);
  mkdirSync(proofDir(), { recursive: true });
  // The app's checkouts now (each dir and its `.git` entry, before it starts), compared after it stopped.
  const checkouts = (() => {
    try {
      return { checkouts: appScope(opts.root, app).checkouts };
    } catch {
      return { checkouts: [] };
    }
  })();
  const gitBefore = checkoutStates(checkouts.checkouts);
  const result: ProofResult = {
    app: app.id,
    date: new Date().toISOString(),
    root: opts.root,
    method: "scripts/registry-prove.ts: app-runner startApp(allowUnproven) in the OS sandbox + guardedContext + runner lsof sampling from before spawn",
    startedPorts: [],
    env: [],
    routes: [],
    blockedRequests: [],
    foreign: [],
    connectionsSeen: 0,
    stoppedClean: false,
    proven: false,
  };
  let running: RunningApp | undefined;
  try {
    running = await startApp(app, { root: opts.root, outDir: proofRunsDir(opts.outDir), allowUnproven: true, registry: opts.registry });
    result.baseUrl = running.baseUrl;
    result.env = Object.keys(running.env).sort();
    // Chromium in the OS sandbox with this run's ports only (decision 29).
    const browser = (openBrowser = await launchBrowser(opts.root, { running }));
    try {
      for (const route of app.routes) {
        const themes = route.themes ?? (app.theme.rule === "dark-first" ? ["dark"] : ["light", "dark"]);
        for (const theme of themes) result.routes.push(await loadRoute(browser, running, route, theme as "light" | "dark", result));
      }
    } finally {
      openBrowser = undefined;
      await browser.close();
    }
    await sleep(1000);
  } catch (error) {
    result.routes.push({ id: "(start)", theme: "-", url: result.baseUrl ?? "", ok: false, error: String(error).split("\n")[0], consoleErrors: [] });
  } finally {
    if (running) {
      result.startedPorts = [...running.startedPorts];
      try {
        await running.stop();
        result.stoppedClean = true;
      } catch (error) {
        result.stopError = String(error);
      }
      // Read after stop(): its last sample may add violations.
      result.foreign = [...(running.violations ?? [])];
      result.egress = running.egress && { samples: running.egress.samples, failures: [...running.egress.failures] };
      result.connectionsSeen = running.egress?.connections ?? 0;
      try {
        writeNew(proofDir, `${app.id}.log`, (tmp) => copyFileSync(running!.logPath, tmp, constants.COPYFILE_EXCL));
      } catch {}
    }
  }
  // Every app checkout (the dir and its `.git` entry) must be what it was before the app started.
  const gitChanged = changedCheckouts(gitBefore, checkoutStates(checkouts.checkouts));
  if (gitChanged.length) result.gitChanged = gitChanged;
  if (running && (!result.egress || result.egress.samples === 0)) result.inconclusive = "egress sampling took no sample";
  else if (result.egress?.failures.length) result.inconclusive = `egress sampling failed: ${result.egress.failures[0]}`;
  // Blocked requests are recorded, not fatal: every route still rendered, so rendering needed none of them.
  result.proven =
    result.routes.length > 0 && result.routes.every((r) => r.ok) && result.foreign.length === 0 && result.stoppedClean && !result.inconclusive && !result.gitChanged;
  result.blockedTargets = summarizeBlocked(result.blockedRequests);
  if (result.routes.some((r) => r.probes?.length)) result.probeCheck = "selectors only";
  writeNew(proofDir, `${app.id}.json`, (tmp) => writeFileSync(tmp, JSON.stringify(result, null, 2) + "\n", { flag: "wx" }));
  return result;
}

async function loadRoute(browser: any, running: RunningApp, route: RouteSpec, theme: "light" | "dark", result: ProofResult): Promise<RouteResult> {
  const app = running.app;
  const url = new URL(route.path.replace(/^\//, ""), running.baseUrl + "/").toString();
  const consoleErrors: string[] = [];
  const { context, blocked } = await guardedContext(browser, running, { colorScheme: theme, viewport: route.viewport });
  const page = await context.newPage();
  page.on("console", (m: any) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e: any) => consoleErrors.push(String(e)));
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    if (theme === "dark" && app.theme.rule !== "dark-first" && app.verify?.darkSwitch) await applyDark(page, app, url);
    // A light-dark app that boots dark: its storage lightSwitch, before the route's steps, in every light load.
    const light = theme === "light" ? lightSeed(app) : undefined;
    if (light) {
      await page.evaluate(([k, v]: string[]) => localStorage.setItem(k!, v!), [light.key, light.value]);
      await page.reload({ waitUntil: "load" });
    }
    for (const step of route.steps ?? []) await runStep(page, step);
    if (route.waitFor) await (await one(page, route.waitFor)).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await sleep(500);
    let probes: RouteResult["probes"];
    if (app.verify && (app.verify.route ?? app.routes[0]?.id) === route.id) {
      // A probe may list the themes it applies to (`themes`); skip it in the others.
      const forTheme = app.verify.probes.filter((p) => {
        const themes = (p as { themes?: unknown }).themes;
        return !Array.isArray(themes) || themes.includes(theme);
      });
      probes = await page.evaluate(
        (ps: Array<{ selector: string; property: string; token: string }>) =>
          ps.map((p) => {
            const all = document.querySelectorAll(p.selector);
            const el = all.length === 1 ? all[0]! : null;
            return { ...p, found: !!el, matches: all.length, value: el ? getComputedStyle(el).getPropertyValue(p.property) : null };
          }),
        forTheme.map(({ selector, property, token }) => ({ selector, property, token })),
      );
    }
    const ambiguous = (probes ?? []).filter((p) => p.matches !== 1);
    if (ambiguous.length) throw new Error(`probe selectors must match exactly 1 element: ${ambiguous.map((p) => `${p.selector} (${p.matches})`).join(", ")}`);
    return { id: route.id, theme, url: page.url(), ok: true, consoleErrors, probes };
  } catch (error) {
    return { id: route.id, theme, url, ok: false, error: String(error).split("\n")[0], consoleErrors };
  } finally {
    for (const b of blocked()) result.blockedRequests.push(`${route.id}/${theme}: ${b}`);
    await context.close();
  }
}

async function applyDark(page: any, app: AppEntry, url: string) {
  const sw = app.verify!.darkSwitch;
  if (sw.kind === "attribute") {
    await page.evaluate((target: string) => {
      const el = document.querySelector(target) ?? document.documentElement;
      el.setAttribute("data-theme", "dark");
      el.classList.add("dark");
    }, sw.target ?? "html");
  } else if (sw.kind === "storage") {
    await page.evaluate(([k, v]: string[]) => localStorage.setItem(k!, v!), [sw.key, sw.value]);
    await page.reload({ waitUntil: "load" });
  } else if (sw.kind === "click") {
    await (await one(page, sw.selector)).click({ timeout: 30_000 });
  } else if (sw.kind === "query") {
    const u = new URL(url);
    u.searchParams.set(sw.param, sw.value);
    await page.goto(u.toString(), { waitUntil: "load" });
  } else if (sw.kind === "steps") {
    for (const step of sw.steps) await runStep(page, step);
  }
}

/** Locators are strict, the way snapshot and verify:apps use them: a selector must match exactly one element. */
async function one(page: any, selector: string) {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state: "attached", timeout: 30_000 });
  const n = await locator.count();
  if (n !== 1) throw new Error(`selector ${selector} matches ${n} elements, not exactly 1`);
  return locator;
}

async function runStep(page: any, step: NonNullable<RouteSpec["steps"]>[number]) {
  switch (step.action) {
    case "click":
      return (await one(page, step.target!)).click({ timeout: 30_000 });
    case "hover":
      return (await one(page, step.target!)).hover({ timeout: 30_000 });
    case "press":
      return page.keyboard.press(String(step.value));
    case "wait":
      return step.target ? (await one(page, step.target)).waitFor({ state: "visible", timeout: 30_000 }) : sleep(Number(step.value ?? 500));
    case "scroll":
      return page.evaluate(
        ([sel, top]: [string | undefined, number]) => (sel ? document.querySelector(sel) : document.scrollingElement)?.scrollTo({ top }),
        [step.target, Number(step.value ?? 0)] as [string | undefined, number],
      );
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const root = resolve(flag("--root") ?? resolve(DESIGN_SYSTEM_ROOT, ".."));
  let outDir: string;
  let registry: Registry;
  let apps: AppEntry[];
  try {
    // Never the owner's tree, never a git checkout (where a commit or `git clean` could pick proofs up).
    outDir = toolOutputDir(flag("--out-dir") ?? process.env.DS_RUN ?? join(tmpdir(), "ds-rollout"), { root, label: "--out-dir" });
    registry = validateLoadedRegistry(loadRegistry());
    apps = argv.map((id) => getApp(registry, id));
  } catch (error) {
    console.error(`registry-prove: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  installSignalHandlers(() => openBrowser?.close());
  for (const line of await cleanupRuns(proofRunsDir(outDir))) console.error(`registry-prove: cleanup: ${line}`);
  // Every repository the proofs touch, pinned before the first app starts (git.ts).
  pinRepos([
    DESIGN_SYSTEM_ROOT,
    join(root, "design-system"),
    ...apps.flatMap((app) => [app.repo, app.root, ...(app.scan?.paths ?? [])].filter((path): path is string => typeof path === "string").map((path) => resolvePath(root, path))),
  ]);
  let failed = false;
  for (const app of apps) {
    const id = app.id;
    const r = await prove(app, { root, outDir, registry });
    failed ||= !r.proven;
    console.log(
      `${id}: ${r.proven ? "PROVEN" : r.inconclusive ? "INCONCLUSIVE" : "NOT PROVEN"} url=${r.baseUrl ?? "-"} ports=${r.startedPorts.join(",")} connections=${r.connectionsSeen} samples=${r.egress?.samples ?? 0}`,
    );
    if (r.inconclusive) console.log(`  inconclusive: ${r.inconclusive}`);
    for (const route of r.routes)
      console.log(`  ${route.ok ? "ok  " : "FAIL"} ${route.id}/${route.theme} ${route.error ?? ""}${route.consoleErrors.length ? ` (${route.consoleErrors.length} console errors)` : ""}`);
    if (r.probeCheck) console.log(`  probes: ${r.probeCheck} (each selector matches one element; verify:apps compares the values)`);
    for (const [origin, n] of Object.entries(r.blockedTargets ?? {})) console.log(`  blocked ${n}x ${origin}`);
    for (const f of r.foreign) console.log(`  foreign ${f}`);
    if (!r.stoppedClean) console.log(`  NOT STOPPED CLEAN: ${r.stopError ?? ""}`);
    if (r.gitChanged) console.log(`  checkouts or their .git entries changed while it ran: ${r.gitChanged.join(", ")}`);
    console.log(`  proof: ${join(outDir, "tooling/registry/proofs", `${id}.json`)}`);
  }
  process.exit(failed ? 1 : 0);
}
