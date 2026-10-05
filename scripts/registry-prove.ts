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
 *   3. Samples `lsof -nP -a -p <pids> -i` for the run's process groups the whole time and flags
 *      every connection that is not to or between the run's own listening ports.
 *   4. Stops the run (only its own processes) and confirms its ports are free.
 *
 * Proven = every route rendered (so rendering needed none of the requests the guard blocked), no
 * foreign connection appeared and the run stopped clean. Blocked requests are listed per origin. Writes <out-dir>/tooling/registry/proofs/<app>.json and .log.
 * The result is evidence for the registry worker; apps.json records it in runProfile.proof.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { guardedContext, startApp, type RunningApp } from "./lib/app-runner";
import { LAUNCH_OPTIONS } from "./lib/capture";
import { loadPlaywright } from "./lib/playwright";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, type AppEntry, type RouteSpec } from "./lib/registry";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface Connection {
  pid: number;
  proto: string;
  local: { host: string; port: number };
  remote?: { host: string; port: number };
  state?: string;
  raw: string;
}

function splitHostPort(s: string): { host: string; port: number } | null {
  const i = s.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(s.slice(i + 1));
  if (s.slice(i + 1) === "" || !Number.isInteger(port)) return null;
  return { host: s.slice(0, i), port };
}

/** Parse `lsof -nP -i` output into connections; the header and unparsable lines are dropped. */
export function parseLsof(output: string): Connection[] {
  const out: Connection[] = [];
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9 || cols[0] === "COMMAND") continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid)) continue;
    const m = cols.slice(8).join(" ").match(/^(\S+?)(?:->(\S+))?(?:\s+\((\w+)\))?$/);
    if (!m) continue;
    const local = splitHostPort(m[1]!);
    if (!local) continue;
    const remote = m[2] ? (splitHostPort(m[2]) ?? undefined) : undefined;
    out.push({ pid, proto: cols[7]!, local, remote, state: m[3], raw: line.trim() });
  }
  return out;
}

/**
 * Connections that leave the run: a non-loopback remote, or a loopback remote on a port outside
 * `ownPorts` (the ports the run started plus the app's named profile ports, which sit in its own
 * block, so a dead-port target such as deadApi reaches nobody). Inbound connections and listeners pass.
 */
export function foreignConnections(conns: Connection[], ownPorts: ReadonlySet<number>): Connection[] {
  return conns.filter((c) => {
    if (!c.remote) return false; // a listener or an unconnected socket
    if (!LOOPBACK.has(c.remote.host)) return true;
    if (ownPorts.has(c.local.port)) return false; // inbound to one of the run's ports
    return !ownPorts.has(c.remote.port);
  });
}

/** Count blocked requests per origin ("<route>/<theme>: GET http://host:port/path" lines). */
export function summarizeBlocked(lines: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    const m = line.match(/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|WS)\s+(\S+)/);
    let key = "?";
    try {
      if (m) key = new URL(m[1]!).origin;
    } catch {}
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every pid in the process groups of the processes listening on `ports`. */
function runPids(ports: number[]): number[] {
  const leaders = new Set<number>();
  for (const port of ports) {
    const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout ?? "";
    for (const pid of out.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0)) leaders.add(pid);
  }
  if (!leaders.size) return [];
  const table = (spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, g]) => Number.isInteger(pid) && Number.isInteger(g)) as Array<[number, number]>;
  const groups = new Set(table.filter(([pid]) => leaders.has(pid)).map(([, g]) => g));
  return table.filter(([, g]) => groups.has(g)).map(([pid]) => pid);
}

function lsofFor(pids: number[]): string {
  if (!pids.length) return "";
  return spawnSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-i"], { encoding: "utf8" }).stdout ?? "";
}

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
  foreign: string[];
  connectionsSeen: number;
  stoppedClean: boolean;
  stopError?: string;
  proven: boolean;
}

async function prove(app: AppEntry, opts: { root: string; outDir: string }): Promise<ProofResult> {
  const proofDir = join(opts.outDir, "tooling", "registry", "proofs");
  mkdirSync(proofDir, { recursive: true });
  const result: ProofResult = {
    app: app.id,
    date: new Date().toISOString(),
    root: opts.root,
    method: "scripts/registry-prove.ts: app-runner startApp(allowUnproven) + guardedContext + lsof sampling",
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
  const seen = new Map<string, Connection>();
  let sampling = false;
  let sampler: Promise<void> | undefined;
  try {
    running = await startApp(app, { root: opts.root, outDir: join(opts.outDir, "tooling", "registry", "runs"), allowUnproven: true });
    result.baseUrl = running.baseUrl;
    result.env = Object.keys(running.env).sort();
    sampling = true;
    const live = running;
    sampler = (async () => {
      while (sampling) {
        // Key on everything after the FD column, so one socket counts once across samples.
        for (const c of parseLsof(lsofFor(runPids(live.startedPorts)))) seen.set(`${c.pid} ${c.raw.split(/\s+/).slice(4).join(" ")}`, c);
        await sleep(250);
      }
    })();
    const playwright = loadPlaywright(opts.root);
    const browser = await playwright.chromium.launch(LAUNCH_OPTIONS);
    try {
      for (const route of app.routes) {
        const themes = route.themes ?? (app.theme.rule === "dark-first" ? ["dark"] : ["light", "dark"]);
        for (const theme of themes) result.routes.push(await loadRoute(browser, running, route, theme as "light" | "dark", result));
      }
    } finally {
      await browser.close();
    }
    await sleep(1000);
  } catch (error) {
    result.routes.push({ id: "(start)", theme: "-", url: result.baseUrl ?? "", ok: false, error: String(error).split("\n")[0], consoleErrors: [] });
  } finally {
    sampling = false;
    await sampler;
    if (running) {
      result.startedPorts = [...running.startedPorts];
      try {
        await running.stop();
        result.stoppedClean = true;
      } catch (error) {
        result.stopError = String(error);
      }
      try {
        copyFileSync(running.logPath, join(proofDir, `${app.id}.log`));
      } catch {}
    }
  }
  result.connectionsSeen = seen.size;
  const ownPorts = new Set([...result.startedPorts, ...Object.values(app.runProfile.ports ?? {})]);
  result.foreign = foreignConnections([...seen.values()], ownPorts).map((c) => c.raw);
  // Blocked requests are recorded, not fatal: every route still rendered, so rendering needed none of them.
  result.proven = result.routes.length > 0 && result.routes.every((r) => r.ok) && result.foreign.length === 0 && result.stoppedClean;
  result.blockedTargets = summarizeBlocked(result.blockedRequests);
  writeFileSync(join(proofDir, `${app.id}.json`), JSON.stringify(result, null, 2) + "\n");
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
    for (const step of route.steps ?? []) await runStep(page, step);
    if (route.waitFor) await (await one(page, route.waitFor)).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await sleep(500);
    let probes: RouteResult["probes"];
    if (app.verify && (app.verify.route ?? app.routes[0]?.id) === route.id) {
      probes = await page.evaluate(
        (ps: Array<{ selector: string; property: string; token: string }>) =>
          ps.map((p) => {
            const all = document.querySelectorAll(p.selector);
            const el = all.length === 1 ? all[0]! : null;
            return { ...p, found: !!el, matches: all.length, value: el ? getComputedStyle(el).getPropertyValue(p.property) : null };
          }),
        app.verify.probes,
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
  const outDir = resolve(flag("--out-dir") ?? process.env.DS_RUN ?? join(tmpdir(), "ds-rollout"));
  const registry = loadRegistry();
  let failed = false;
  for (const id of argv) {
    const r = await prove(getApp(registry, id), { root, outDir });
    failed ||= !r.proven;
    console.log(`${id}: ${r.proven ? "PROVEN" : "NOT PROVEN"} url=${r.baseUrl ?? "-"} ports=${r.startedPorts.join(",")} connections=${r.connectionsSeen}`);
    for (const route of r.routes)
      console.log(`  ${route.ok ? "ok  " : "FAIL"} ${route.id}/${route.theme} ${route.error ?? ""}${route.consoleErrors.length ? ` (${route.consoleErrors.length} console errors)` : ""}`);
    for (const [origin, n] of Object.entries(r.blockedTargets ?? {})) console.log(`  blocked ${n}x ${origin}`);
    for (const f of r.foreign) console.log(`  foreign ${f}`);
    if (!r.stoppedClean) console.log(`  NOT STOPPED CLEAN: ${r.stopError ?? ""}`);
    console.log(`  proof: ${join(outDir, "tooling/registry/proofs", `${id}.json`)}`);
  }
  process.exit(failed ? 1 : 0);
}
