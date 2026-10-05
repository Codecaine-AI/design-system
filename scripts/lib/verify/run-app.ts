/**
 * One app, one runtime session: start it with its run profile (scripts/lib/app-runner.ts), open the
 * verify route in a fresh guarded browser context (or its Electron window), run a page check, then
 * check the bound URL, the served files and the blocked requests, and stop only what this run started.
 */
import { fileURLToPath } from "node:url";
import { guardedContext, type RunningApp, servedFromRoot, splitBlocked, startApp, stopAllApps } from "../app-runner";
import type { AppEntry, RouteSpec } from "../registry";
import { type Assertion, fail, pass, type ResponseLog, trackResponses } from "./assertions";
import { runStep } from "./page-checks";
import { onInterrupt } from "./propagate";

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
  servedFiles?: { checked: number; ok: boolean; outside: string[] };
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
    for (const step of route?.steps ?? []) await runStep(page, step);
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

/** URLs and paths the app served: same-origin responses, file: URLs, and the runner's static server log. */
async function servedEntries(page: any, responses: ResponseLog, running: RunningApp): Promise<string[]> {
  const urls = new Set(responses.keys());
  const extra: string[] = await page
    .evaluate(() => [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)])
    .catch(() => []);
  for (const url of extra) urls.add(url);
  const origin = running.baseUrl ? new URL(running.baseUrl).origin : null;
  const entries: string[] = [];
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol === "file:") entries.push(fileURLToPath(url));
    else if (origin && url.origin === origin) entries.push(`${url.origin}${url.pathname}`);
  }
  return [...new Set([...entries, ...(running.servedFiles?.() ?? [])])].sort();
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
  let running: RunningApp | undefined;
  // Registered before the start, so an interrupt mid-start still stops what the runner launched.
  const removeStep = onInterrupt(() => (running ? running.stop() : stopAllApps()));
  try {
    running = await startApp(app, { root: session.root, outDir: session.outDir });
  } catch (error) {
    removeStep();
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
    report.servedFiles = { checked: served.length, ok: fromRoot.ok, outside: fromRoot.outside };
    report.assertions.push(
      served.length === 0
        ? fail("served-from-root", "no served file was recorded")
        : fromRoot.ok
          ? pass("served-from-root", `${served.length} served file(s), all inside ${session.root}`)
          : fail("served-from-root", `${fromRoot.outside.length} served file(s) outside the root: ${fromRoot.outside.slice(0, 3).join(", ")}`, {
              outside: fromRoot.outside,
            }),
    );

    // Expected: blocks to a named profile port the run never bound (a dead-service URL the profile sets on purpose).
    const { unexpected, expected } = splitBlocked(running, blocked());
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
  } catch (error) {
    report.assertions.push(fail("session", (error as Error).message.split("\n")[0]));
  } finally {
    await context?.close().catch(() => undefined);
    report.startedPorts = [...running.startedPorts];
    try {
      await running.stop();
    } catch (error) {
      report.assertions.push(fail("stop", `stopping the app failed: ${(error as Error).message}`));
    }
    removeStep();
  }
  return report;
}
