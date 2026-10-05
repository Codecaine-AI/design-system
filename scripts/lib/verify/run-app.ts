/**
 * One app, one runtime session: start it with its run profile (scripts/lib/app-runner.ts), open the
 * verify route in a fresh guarded browser context (or its Electron window), run a page check, then
 * check the bound URL, the served files and the blocked requests, and stop only what this run started.
 */
import { fileURLToPath } from "node:url";
import { runSteps } from "../capture";
import { guardedContext, OWNER_PORTS, type RunningApp, servedFromRoot, splitBlocked, startApp } from "../app-runner";
import type { AppEntry, RouteSpec } from "../registry";
import { type Assertion, fail, pass, type ResponseLog, trackResponses, warn } from "./assertions";

export interface Session {
  browser: any;
  root: string;
  outDir: string;
}

export interface RuntimeReport {
  baseUrl?: string;
  ports?: Record<string, number>;
  startedPorts?: number[];
  logPath?: string;
  assertions: Assertion[];
  blockedRequests: string[];
  /** Blocked requests to the profile's own named ports that the run did not bind: reported, not failures. */
  expectedBlocked: string[];
  servedFiles?: { checked: number; ok: boolean; outside: string[]; unresolved: string[] };
  consoleErrors: string[];
}

export interface PageContext {
  responses: ResponseLog;
  /** The route's waitFor and steps; re-run after a reload. */
  prepare: (page: any) => Promise<void>;
}

/** The route verify:apps checks: verify.route, else the first route. */
export function verifyRoute(app: AppEntry): RouteSpec | undefined {
  const id = app.verify?.route;
  return id ? app.routes.find((route) => route.id === id) : app.routes[0];
}

function routePreparer(route: RouteSpec | undefined) {
  return async (page: any) => {
    if (route?.waitFor) await page.locator(route.waitFor).first().waitFor({ state: "visible", timeout: 30_000 });
    if (route?.steps?.length) await runSteps(page, route.steps);
  };
}

/** The bound URL came from the server's output, on a port the run's own processes bound. */
function boundUrlAssertion(running: RunningApp): Assertion {
  if (!running.baseUrl) return fail("bound-url", "the runner read no URL from the server output");
  const url = new URL(running.baseUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const detail = { baseUrl: running.baseUrl, ports: running.ports, startedPorts: running.startedPorts };
  return running.startedPorts.includes(port)
    ? pass("bound-url", `${running.baseUrl} read from the server output; port ${port} is bound by the run`, detail)
    : fail("bound-url", `${running.baseUrl} is not on a port this run bound (${running.startedPorts.join(", ") || "none"})`, detail);
}

/** Resource types that are files (modules, styles, fonts, images); page routes and API calls are not. */
const FILE_TYPES = new Set(["script", "stylesheet", "font", "image", "media"]);

/**
 * Files the app served: successful same-origin script, stylesheet, font, image and media responses,
 * file: URLs (Electron), and the runner's static-server log.
 */
async function servedEntries(page: any, responses: ResponseLog, running: RunningApp): Promise<string[]> {
  const origin = running.baseUrl ? new URL(running.baseUrl).origin : null;
  const entries: string[] = [];
  for (const [raw, { status, type }] of responses) {
    if (!FILE_TYPES.has(type) || !((status >= 200 && status < 300) || status === 304)) continue;
    const url = new URL(raw);
    if (url.protocol === "file:") entries.push(fileURLToPath(url));
    else if (origin && url.origin === origin) entries.push(`${url.origin}${url.pathname}`);
  }
  // Electron may load file: resources without response events.
  const fileUrls: string[] = await page
    .evaluate(() => [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)].filter((u) => u.startsWith("file:")))
    .catch(() => []);
  for (const url of fileUrls) entries.push(fileURLToPath(url));
  return [...new Set([...entries, ...(running.servedFiles?.() ?? [])])].sort();
}

/** The loopback port a guard entry ("GET http://...", "WS ws://...") targets, or null. */
function loopbackPort(entry: string): number | null {
  try {
    const url = new URL(entry.slice(entry.indexOf(" ") + 1));
    if (!["localhost", "[::1]", "0.0.0.0"].includes(url.hostname) && !/^127(\.\d{1,3}){3}$/.test(url.hostname)) return null;
    return Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80));
  } catch {
    return null;
  }
}

/** served-from-root: outside files fail; unresolved ones fail, except a warning for a static fixture server that builds into {tmp}. */
function servedAssertion(app: AppEntry, root: string, served: string[], result: { outside: string[]; unresolved: string[] }): Assertion[] {
  const out: Assertion[] = [];
  if (served.length === 0) return [fail("served-from-root", "no served file was recorded")];
  out.push(
    result.outside.length === 0
      ? pass("served-from-root", `${served.length} served file(s), all inside ${root}`)
      : fail("served-from-root", `${result.outside.length} served file(s) outside the root: ${result.outside.slice(0, 3).join(", ")}`, { outside: result.outside }),
  );
  if (result.unresolved.length) {
    const message = `${result.unresolved.length} served URL(s) map to no file: ${result.unresolved.slice(0, 3).join(", ")}`;
    const fixtureServer = app.run.mode === "static" && Boolean(app.run.start) && !app.run.staticDir;
    out.push(fixtureServer ? warn("served-unresolved", `${message} (static fixture server without a staticDir)`, { unresolved: result.unresolved }) : fail("served-unresolved", message, { unresolved: result.unresolved }));
  }
  return out;
}

/**
 * Starts the app, shows its verify route and runs `check` on the page. Every failure to start or load
 * becomes a failed assertion; the app is always stopped.
 */
export async function inRunningApp(
  app: AppEntry,
  session: Session,
  check: (page: any, ctx: PageContext) => Promise<Assertion[]>,
): Promise<RuntimeReport> {
  const report: RuntimeReport = { assertions: [], blockedRequests: [], expectedBlocked: [], consoleErrors: [] };
  // An interrupt stops this app through the runner's installSignalHandlers (stopAllApps), which the CLI installs.
  let running: RunningApp;
  try {
    running = await startApp(app, { root: session.root, outDir: session.outDir });
  } catch (error) {
    report.assertions.push(fail("start", `the app did not start: ${(error as Error).message}`));
    return report;
  }
  report.baseUrl = running.baseUrl;
  report.ports = running.ports;
  report.startedPorts = running.startedPorts;
  report.logPath = running.logPath;
  let context: any;
  try {
    let page: any;
    let blocked: () => string[];
    if (app.run.mode === "electron") {
      if (!running.electron) throw new Error("the runner returned no Electron handle");
      page = await running.electron.window();
      blocked = running.blocked ?? (() => []);
    } else {
      ({ context, blocked } = await guardedContext(session.browser, running, { colorScheme: "light" }));
      page = await context.newPage();
    }
    const responses = trackResponses(page);
    page.on("console", (message: any) => {
      if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error: any) => report.consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 300)}`));

    const route = verifyRoute(app);
    const prepare = routePreparer(route);
    if (app.run.mode === "electron") {
      await page.waitForLoadState("load", { timeout: 60_000 });
    } else {
      report.assertions.push(boundUrlAssertion(running));
      await page.goto(`${running.baseUrl}${route?.path ?? "/"}`, { waitUntil: "load", timeout: 60_000 });
    }
    try {
      await prepare(page);
      report.assertions.push(...(await check(page, { responses, prepare })));
    } catch (error) {
      report.assertions.push(fail("page", `the verify route did not finish: ${(error as Error).message.split("\n")[0]}`));
    }

    const served = await servedEntries(page, responses, running);
    const fromRoot = servedFromRoot(running, served);
    report.servedFiles = { checked: served.length, ok: fromRoot.ok, outside: fromRoot.outside, unresolved: fromRoot.unresolved };
    report.assertions.push(...servedAssertion(app, session.root, served, fromRoot));

    // Expected: blocks to a named profile port the run never bound (a dead-service URL the profile sets on purpose).
    // An owner port is never expected, whatever the profile says.
    const split = splitBlocked(running, blocked());
    const owner = [...split.unexpected, ...split.expected].filter((entry) => OWNER_PORTS.includes(loopbackPort(entry) ?? -1));
    const expected = split.expected.filter((entry) => !owner.includes(entry));
    const unexpected = [...split.unexpected.filter((entry) => !owner.includes(entry)), ...owner];
    report.blockedRequests = unexpected;
    report.expectedBlocked = expected;
    const expectedNote = expected.length ? `; ${expected.length} expected-blocked to the profile's unbound named port(s): ${[...new Set(expected)].slice(0, 3).join(", ")}` : "";
    report.assertions.push(
      unexpected.length === 0
        ? pass("requests", `no request to a port the run did not start, and none off the machine${expectedNote}`, { expectedBlocked: expected })
        : fail("requests", `${unexpected.length} request(s) blocked: ${[...new Set(unexpected)].slice(0, 3).join(", ")}${expectedNote}`, {
            blocked: unexpected,
            expectedBlocked: expected,
          }),
    );
    if (owner.length) report.assertions.push(fail("requests.owner-port", `the app tried to reach the owner's services: ${[...new Set(owner)].join(", ")}`));
  } catch (error) {
    report.assertions.push(fail("session", (error as Error).message.split("\n")[0]));
  } finally {
    await context?.close().catch(() => undefined);
    report.startedPorts = [...running.startedPorts];
    for (const violation of running.violations ?? []) report.assertions.push(fail("owner-port-bound", violation));
    try {
      await running.stop();
    } catch (error) {
      report.assertions.push(fail("stop", `stopping the app failed: ${(error as Error).message}`));
    }
  }
  return report;
}
