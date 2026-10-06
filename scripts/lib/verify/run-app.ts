/**
 * One app, one runtime session: start it with its run profile (scripts/lib/app-runner.ts), open the
 * verify route in a fresh guarded browser context (or its Electron window), run a page check, then
 * check the bound URL, the served files and the blocked requests, and stop only what this run started.
 * The page sees the fixed clock (capture.ts FIXED_TIME) and prefers-color-scheme light from its first load.
 */
import { fileURLToPath } from "node:url";
import { fixClock, runSteps } from "../capture";
import {
  type EgressStats,
  guardedContext,
  installSignalHandlers,
  launchBrowser,
  OWNER_PORTS,
  refreshStartedPorts,
  type RunningApp,
  servedFromRoot,
  splitBlocked,
  startApp,
} from "../app-runner";
import { type AppEntry, type Registry, type RouteSpec, verifyRoute } from "../registry";
import { type Assertion, fail, pass, type ResponseLog, trackResponses, warn } from "./assertions";

export interface Session {
  /**
   * A browser the caller owns and closes (tests). Without one, each app gets its own Chromium, started
   * after the app inside the OS sandbox with that run's ports only (app-runner launchBrowser).
   */
  browser?: any;
  root: string;
  outDir: string;
  /** The validated registry the apps come from: startApp takes each app's port block from it. */
  registry?: Registry;
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
  servedFiles?: { checked: number; ok: boolean; outside: string[]; unresolved: string[]; crossOrigin?: string[] };
  consoleErrors: string[];
  /** "fixed" when the page saw the fixed clock, else why not. */
  clock?: string;
  /** The runner's egress sampling of the run's processes. */
  egress?: EgressStats;
}

export interface PageContext {
  responses: ResponseLog;
  /** The route's waitFor and steps; re-run after a reload. */
  prepare: (page: any) => Promise<void>;
  /** The running app (served-path mapping, its temp dir). */
  running: RunningApp;
}

/** The route verify:apps checks (registry.ts verifyRoute; re-exported here, where its callers import it). */
export { verifyRoute };

/**
 * Brings a loaded page to the route's state, in capture's order: the steps first (open an editor from
 * the gallery), then waitFor, which is the state they reach. Without steps, waitFor is the page being ready.
 */
export function routePreparer(route: RouteSpec | undefined) {
  return async (page: any) => {
    if (route?.steps?.length) await runSteps(page, route.steps);
    if (route?.waitFor) await page.locator(route.waitFor).first().waitFor({ state: "visible", timeout: 30_000 });
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
 * file: URLs (Electron), and the runner's static-server log. A file from any other http(s) origin (another
 * port of the run, a redirect) cannot be mapped to a file under --root: it is listed in `crossOrigin`,
 * which fails served-from-root.
 */
async function servedEntries(page: any, responses: ResponseLog, running: RunningApp): Promise<{ entries: string[]; crossOrigin: string[] }> {
  const origin = running.baseUrl ? new URL(running.baseUrl).origin : null;
  const entries: string[] = [];
  const crossOrigin: string[] = [];
  for (const [raw, { status, type }] of responses) {
    if (!FILE_TYPES.has(type) || !((status >= 200 && status < 300) || status === 304)) continue;
    const url = new URL(raw);
    if (url.protocol === "file:") entries.push(fileURLToPath(url));
    else if (origin && url.origin === origin) entries.push(`${url.origin}${url.pathname}`);
    else if (url.protocol === "http:" || url.protocol === "https:") crossOrigin.push(`${url.origin}${url.pathname}`);
  }
  // Electron may load file: resources without response events.
  const fileUrls: string[] = await page
    .evaluate(() => [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)].filter((u) => u.startsWith("file:")))
    .catch(() => []);
  for (const url of fileUrls) entries.push(fileURLToPath(url));
  return { entries: [...new Set([...entries, ...(running.servedFiles?.() ?? [])])].sort(), crossOrigin: [...new Set(crossOrigin)].sort() };
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

/**
 * served-from-root: outside files fail, and so do files from another origin than the app's (no file under
 * the root can be named for them); unresolved ones fail, except a warning for a static fixture server that
 * builds into {tmp}.
 */
export function servedAssertion(app: AppEntry, root: string, served: string[], result: { outside: string[]; unresolved: string[]; crossOrigin?: string[] }): Assertion[] {
  const out: Assertion[] = [];
  const crossOrigin = result.crossOrigin ?? [];
  if (served.length === 0 && crossOrigin.length === 0) return [fail("served-from-root", "no served file was recorded")];
  out.push(
    result.outside.length === 0 && crossOrigin.length === 0
      ? pass("served-from-root", `${served.length} served file(s), all inside ${root}`)
      : fail(
          "served-from-root",
          [
            result.outside.length ? `${result.outside.length} served file(s) outside the root: ${result.outside.slice(0, 3).join(", ")}` : "",
            crossOrigin.length ? `${crossOrigin.length} file(s) from another origin than the app's: ${crossOrigin.slice(0, 3).join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; "),
          { outside: result.outside, crossOrigin },
        ),
  );
  if (result.unresolved.length) {
    const message = `${result.unresolved.length} served URL(s) map to no file: ${result.unresolved.slice(0, 3).join(", ")}`;
    const fixtureServer = app.run.mode === "static" && Boolean(app.run.start) && !app.run.staticDir;
    out.push(fixtureServer ? warn("served-unresolved", `${message} (static fixture server without a staticDir)`, { unresolved: result.unresolved }) : fail("served-unresolved", message, { unresolved: result.unresolved }));
  }
  return out;
}

/**
 * The run's isolation, read after stop(): every violation the runner found (an owner port a process
 * listened on, a connection that left the run, a failed egress sample) fails, and so does a run that
 * was unproven or had no OS sandbox. Such a run never counts for a gate.
 */
export function isolationAssertions(running: Pick<RunningApp, "violations" | "unproven" | "unsandboxed">): Assertion[] {
  const out = (running.violations ?? []).map((violation) => fail("isolation", violation));
  if (running.unproven) out.push(fail("isolation.profile", "the run profile is unproven: its results do not count for a gate"));
  if (running.unsandboxed) out.push(fail("isolation.sandbox", "the run had no OS sandbox (allowUnsandboxed): its results do not count for a gate"));
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
    running = await startApp(app, { root: session.root, outDir: session.outDir, registry: session.registry });
  } catch (error) {
    report.assertions.push(fail("start", `the app did not start: ${(error as Error).message}`));
    return report;
  }
  report.baseUrl = running.baseUrl;
  report.ports = running.ports;
  report.startedPorts = running.startedPorts;
  report.logPath = running.logPath;
  let context: any;
  // This app's own Chromium (sandboxed to its ports) unless the caller brought one.
  let ownBrowser: any;
  let removeCleanup: (() => void) | undefined;
  try {
    let page: any;
    let blocked: () => string[];
    if (app.run.mode === "electron") {
      if (!running.electron) throw new Error("the runner returned no Electron handle");
      page = await running.electron.window();
      blocked = running.blocked ?? (() => []);
    } else {
      let browser = session.browser;
      if (!browser) {
        browser = ownBrowser = await launchBrowser(session.root, { running });
        removeCleanup = installSignalHandlers(() => ownBrowser?.close());
      }
      ({ context, blocked } = await guardedContext(browser, running, { colorScheme: "light" }));
      report.clock = await fixClock(context);
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
      // The window loaded at launch: load it again under light and the fixed clock, with the response log attached.
      await page.emulateMedia({ colorScheme: "light" });
      report.clock = await fixClock(running.electron!.app.context());
      await page.reload({ waitUntil: "load", timeout: 60_000 });
    } else {
      report.assertions.push(boundUrlAssertion(running));
      await page.goto(`${running.baseUrl}${route?.path ?? "/"}`, { waitUntil: "load", timeout: 60_000 });
    }
    try {
      await prepare(page);
      report.assertions.push(...(await check(page, { responses, prepare, running })));
    } catch (error) {
      report.assertions.push(fail("page", `the verify route did not finish: ${(error as Error).message.split("\n")[0]}`));
    }

    const { entries: served, crossOrigin } = await servedEntries(page, responses, running);
    const fromRoot = servedFromRoot(running, served);
    report.servedFiles = { checked: served.length, ok: fromRoot.ok && crossOrigin.length === 0, outside: fromRoot.outside, unresolved: fromRoot.unresolved, crossOrigin };
    report.assertions.push(...servedAssertion(app, session.root, served, { ...fromRoot, crossOrigin }));

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
    await ownBrowser?.close().catch(() => undefined);
    removeCleanup?.();
    // A port bound after the start (an owner port included) is only known after a fresh read.
    refreshStartedPorts(running);
    report.startedPorts = [...running.startedPorts];
    try {
      await running.stop();
    } catch (error) {
      report.assertions.push(fail("stop", `stopping the app failed: ${(error as Error).message}`));
    }
    // stop() takes the last egress sample: the violations are complete only now.
    report.assertions.push(...isolationAssertions(running));
    report.egress = running.egress;
  }
  return report;
}
