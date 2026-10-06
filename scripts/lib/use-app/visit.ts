/**
 * One `use:app` visit: one registry route in one theme, in the running app.
 *
 * Browser and static apps get a fresh guarded context per visit (app-runner guardedContext: requests to a
 * port the run does not hold, to an owner port or off the machine are aborted and recorded), with the
 * theme's prefers-color-scheme and the fixed clock. Electron apps reuse their first window: storage
 * cleared, the route's URL, the theme's color scheme, then a reload.
 *
 * In capture's order: load the route, wait for waitFor (when the route has no steps), switch the theme
 * the way the registry's verify.darkSwitch says (light on an entry with a storage verify.lightSwitch: the
 * value is written before the page loads, see capture themePlan; light on an entry with verify.lightSteps:
 * those steps, unless the route sets skipLightSteps), run the route's steps, wait for
 * waitFor, screenshot.
 * Shell apps (verify.sidebar) then get the sidebar toggle clicked, a screenshot, and the toggle clicked
 * again. Last, up to MAX_HOVERS visible, enabled buttons and links outside any form are hovered. Every
 * click and Enter or Space press goes through the safety rules first (safety.ts); a refused step is
 * recorded and never run, and the visit stops there, like a failed one.
 */
import { guardedContext, OWNER_PORTS, type RunningApp, splitBlocked } from "../app-runner";
import { fixClock, runSteps, SCREENSHOT_OPTIONS, type Step, switchSteps, themePlan } from "../capture";
import { type ExpectedFailure, expectedFailure, type RouteSpec } from "../registry";
import type { Action, Theme, Visit } from "./log";
import { shotName } from "./log";
import { activates, describeElement, type ElementInfo, HOVER_SELECTOR, hoverTargets, stepRefusal, stepSelector } from "./safety";

export interface VisitTarget {
  running: RunningApp;
  /** The Chromium the run's browser and static visits use (unused for Electron). */
  browser?: any;
  /** The path a screenshot file name is written to (checked: no symlink on the way, inside the out dir). */
  shotPath: (file: string) => string;
  /** Writes a screenshot to the path; refuses an existing file. */
  writeShot: (path: string, png: Buffer) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

interface Surface {
  page: any;
  url: string;
  load: () => Promise<void>;
  blocked: () => string[];
  close: () => Promise<void>;
}

/** Electron: the first window's URL (without its hash) at the run's first visit. */
const electronHome = new WeakMap<RunningApp, string>();

async function openSurface(target: VisitTarget, route: RouteSpec, theme: Theme, plan: ReturnType<typeof themePlan>): Promise<Surface> {
  const { running } = target;
  if (running.electron) {
    const page = await running.electron.window();
    const before = running.blocked?.().length ?? 0;
    if (!electronHome.has(running)) electronHome.set(running, String(page.url()).split("#")[0]!);
    const home = electronHome.get(running)!;
    const path = route.path ?? "";
    if (path && path !== "/" && path !== "main" && !path.startsWith("#")) throw new Error(`use:app drives the first Electron window only; route ${route.id} names ${path}`);
    const url = path.startsWith("#") ? `${home}${path}` : home;
    await page.emulateMedia({ colorScheme: theme });
    if (route.viewport) await page.setViewportSize(route.viewport);
    await fixClock(running.electron.app.context());
    const load = async () => {
      await page.evaluate(
        ({ url, storage }: { url: string; storage: Record<string, string> }) => {
          const win = globalThis as any;
          win.localStorage.clear();
          win.sessionStorage.clear();
          for (const [key, value] of Object.entries(storage)) win.localStorage.setItem(key, value);
          if (win.location.href !== url) win.history.replaceState(null, "", url);
        },
        { url, storage: plan.init?.storage ?? {} },
      );
      await page.reload({ waitUntil: "load", timeout: 60_000 });
    };
    return { page, url, load, blocked: () => (running.blocked?.() ?? []).slice(before), close: async () => undefined };
  }
  if (!running.baseUrl) throw new Error(`${running.app.id}: the runner read no URL from the server output`);
  const { context, blocked } = await guardedContext(target.browser, running, { colorScheme: theme, ...(route.viewport ? { viewport: route.viewport } : {}) });
  try {
    if (plan.init) {
      await context.addInitScript((storage: Record<string, string>) => {
        try {
          for (const [key, value] of Object.entries(storage)) (globalThis as any).localStorage.setItem(key, value);
        } catch {
          // opaque-origin frames have no storage
        }
      }, plan.init.storage);
    }
    await fixClock(context);
    const page = await context.newPage();
    const url = plan.url(`${running.baseUrl}${route.path || "/"}`);
    return { page, url, load: () => page.goto(url, { waitUntil: "load", timeout: 60_000 }), blocked, close: () => context.close().catch(() => undefined) };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

/** Chromium's console error for a response >= 400: its status; the resource URL is the message's location. */
const LOAD_FAILED = /^Failed to load resource: the server responded with a status of (\d{3})\b/;

/**
 * Records console errors, page errors, failed requests and responses >= 400 into the visit; returns the
 * unsubscribe. A response the registry's verify.expectedFailures covers goes to `expectedFailedRequests`
 * (with its reason), and so does Chromium's "Failed to load resource" console error for it.
 */
function watch(page: any, visit: Visit, expected: { list?: ExpectedFailure[]; origin?: string } = {}): () => void {
  const covered = (method: string, url: string, status: number) => expectedFailure(expected.list, expected.origin, { method, url, status });
  const handlers: Record<string, (event: any) => void> = {
    console: (message) => {
      // A request the guard blocked is reported in `blocked`, not again as a console error.
      if (message.type() !== "error" || /net::ERR_BLOCKED_BY_CLIENT/.test(message.text())) return;
      const status = Number(LOAD_FAILED.exec(message.text())?.[1]);
      const url = String(message.location?.()?.url ?? "");
      // Reported with its response (the console error names the URL and status, not the method; it may come first).
      if (status && expected.list?.some((e) => covered(e.method, url, status))) return;
      visit.consoleErrors.push(message.text().slice(0, 300));
    },
    pageerror: (error) => visit.consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 300)}`),
    requestfailed: (request) => {
      const why = request.failure()?.errorText ?? "failed";
      // Blocked by the guard (reported in `blocked`) or cancelled by the page itself (navigation, unmount).
      if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(why)) visit.failedRequests.push(`${request.method()} ${request.url()}: ${why}`);
    },
    response: (response) => {
      if (response.status() < 400) return;
      const line = `${response.status()} ${response.request().method()} ${response.url()}`;
      const hit = covered(response.request().method(), response.url(), response.status());
      if (!hit) return void visit.failedRequests.push(line);
      (visit.expectedFailedRequests ??= []).push(`${line} (expected: ${hit.reason})`);
    },
  };
  for (const [event, handler] of Object.entries(handlers)) page.on(event, handler);
  return () => {
    for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
  };
}

/** The guard's entries split like verify:apps: expected only for an unbound named profile port that is no owner port. */
function splitVisitBlocked(running: RunningApp, entries: string[]): { blocked: string[]; expectedBlocked: string[] } {
  const owner = (entry: string) => {
    try {
      const url = new URL(entry.slice(entry.indexOf(" ") + 1));
      return OWNER_PORTS.includes(Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80)));
    } catch {
      return false;
    }
  };
  const { unexpected, expected } = splitBlocked(running, entries);
  return { blocked: [...unexpected, ...expected.filter(owner)], expectedBlocked: expected.filter((entry) => !owner(entry)) };
}

/** Visits one route in one theme. Never throws: every failure is a recorded action. */
export async function visitRoute(target: VisitTarget, route: RouteSpec, theme: Theme): Promise<Visit> {
  const app = target.running.app;
  const plan = themePlan(app, theme, route);
  const visit: Visit = { route: route.id, theme, url: "", themeMethod: plan.method, actions: [], screenshots: [], consoleErrors: [], failedRequests: [], blocked: [], expectedBlocked: [] };
  // Only an entry that names expected failures gets the list (every other log stays as it was).
  const expectedFailures = app.verify?.expectedFailures;
  if (expectedFailures?.length) visit.expectedFailedRequests = [];
  const record = (action: Action) => {
    visit.actions.push(action);
    return action.ok;
  };
  /** Runs `work` as one action; false when it failed. */
  const act = async (kind: Action["kind"], what: string, work: () => Promise<unknown>) => {
    try {
      await work();
      return record({ kind, target: what, ok: true });
    } catch (error) {
      return record({ kind, target: what, ok: false, error: firstLine(error) });
    }
  };

  let surface: Surface | undefined;
  let unwatch: (() => void) | undefined;
  try {
    surface = await openSurface(target, route, theme, plan);
    const { page } = surface;
    visit.url = surface.url;
    unwatch = watch(page, visit, { list: expectedFailures, origin: target.running.baseUrl });

    /** A registry step, run only when the safety rules let it. */
    const step = async (s: Step, origin: string, kind: Action["kind"] = "step") => {
      const what = `${origin}${s.action}${s.target !== undefined ? ` ${s.target}` : ""}${s.value !== undefined ? ` ${s.value}` : ""}`;
      try {
        let refused = stepRefusal(s, null);
        if (!refused && activates(s)) {
          const selector = stepSelector(s);
          const info: ElementInfo = selector
            ? await page.locator(selector).first().evaluate(describeElement, undefined, { timeout: 15_000 })
            : await page.evaluateHandle(() => (globalThis as any).document.activeElement ?? (globalThis as any).document.body).then(async (handle: any) => {
                try {
                  return await handle.evaluate(describeElement);
                } finally {
                  await handle.dispose();
                }
              });
          refused = stepRefusal(s, info);
        }
        if (refused) return record({ kind, target: what, ok: false, refused });
        await runSteps(page, [s]);
        return record({ kind, target: what, ok: true });
      } catch (error) {
        return record({ kind, target: what, ok: false, error: firstLine(error) });
      }
    };
    const waitFor = () => act("step", `waitFor ${route.waitFor}`, () => page.locator(route.waitFor).first().waitFor({ state: "visible", timeout: 30_000 }));
    const shoot = (label: string) =>
      act("screenshot", label, async () => {
        await sleep(300);
        const path = target.shotPath(shotName(route.id, theme, visit.screenshots.length + 1, label));
        target.writeShot(path, await page.screenshot(SCREENSHOT_OPTIONS));
        visit.screenshots.push(path);
      });

    /** Ends the visit early (a failed or refused step): the screenshot shows where it stopped. */
    const stop = async () => {
      await shoot("stopped");
      return visit;
    };

    if (!(await act("goto", surface.url, surface.load))) return visit;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const steps = route.steps ?? [];
    if (!steps.length && route.waitFor && !(await waitFor())) return await stop();

    // The theme, the way capture switches it: darkSwitch clicks and steps, and lightSteps, go through the safety rules.
    const origin = theme === "light" ? "lightSteps " : "darkSwitch ";
    for (const s of switchSteps(app, theme, route)) if (!(await step(s, origin))) return await stop();
    if (plan.method === "attribute" && !(await act("step", "darkSwitch attribute data-theme=dark", () => plan.afterLoad(page, undefined as never)))) return await stop();

    for (const s of steps) if (!(await step(s, ""))) return await stop();
    if (steps.length && route.waitFor && !(await waitFor())) return await stop();
    if (plan.method === "attribute" && !(await act("step", "theme check", () => plan.verify(page)))) return await stop();
    await page.mouse.move(0, 0);
    await shoot("loaded");

    const sidebar = app.verify?.sidebar;
    if (sidebar) {
      const toggle = sidebar.toggle ?? ".ds-sidebar-toggle";
      if ((await page.locator(toggle).count()) === 0) {
        record({ kind: "sidebar-toggle", target: toggle, ok: true, skipped: `no ${toggle} on the page` });
      } else if (await step({ action: "click", target: `${toggle} >> nth=0` }, "", "sidebar-toggle")) {
        await page.mouse.move(0, 0);
        await shoot("sidebar-toggled");
        await step({ action: "click", target: `${toggle} >> nth=0` }, "restore ", "sidebar-toggle");
      }
    }

    const handles: any[] = await page.$$(HOVER_SELECTOR);
    try {
      const infos = await Promise.all(handles.map((handle) => handle.evaluate(describeElement).catch(() => null)));
      for (const i of hoverTargets(infos)) await act("hover", infos[i]!.name, () => handles[i].hover({ timeout: 2_000 }));
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
    }
    await page.mouse.move(0, 0).catch(() => undefined);
  } catch (error) {
    // Opening the page failed (goto), or the page went away mid-visit.
    record({ kind: surface ? "step" : "goto", target: surface ? "visit" : route.path, ok: false, error: firstLine(error) });
  } finally {
    unwatch?.();
    if (surface) Object.assign(visit, splitVisitBlocked(target.running, surface.blocked()));
    await surface?.close();
    for (const key of ["consoleErrors", "failedRequests", "blocked", "expectedBlocked"] as const) visit[key] = [...new Set(visit[key])];
    if (visit.expectedFailedRequests) visit.expectedFailedRequests = [...new Set(visit.expectedFailedRequests)];
  }
  return visit;
}
