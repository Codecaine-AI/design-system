/**
 * Deterministic capture of registry routes, generalized from verification/docs-system/lib/capture.ts.
 *
 * The settings (CONTEXT_OPTIONS, LAUNCH_OPTIONS, SCREENSHOT_OPTIONS, DETERMINISM_CSS) are copied from
 * the docs-system harness; every rollout tool that opens a browser on an app uses them.
 *
 * captureRoute shoots one route in one theme. Browser and static apps get a fresh guarded context per
 * shot (app-runner guardedContext: requests to ports the run did not start and to non-loopback hosts
 * are aborted and recorded). It waits for the page, network quiet, fonts and images, runs the route's
 * navigation-only steps, then shoots until two frames 250 ms apart are byte-identical (up to 12).
 *
 * Theme: the registry's `verify.darkSwitch` (attribute, storage, click, query or navigation-only steps)
 * switches away from the app's default theme (light, or dark on dark-first surfaces); the context's
 * prefers-color-scheme always matches the theme. Without a darkSwitch, prefers-color-scheme is the
 * only switch.
 */
import type { AppEntry, RouteSpec } from "./registry";
import { guardedContext, splitBlocked, type RunningApp } from "./app-runner";
import type { Box, Theme } from "./snapshot-set";

export const CONTEXT_OPTIONS = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "UTC",
  hasTouch: false,
  isMobile: false,
} as const;

/**
 * Chromium launch flags for repeatable pixels. Without them, anti-aliased
 * rounded corners (table corners, scrollbar thumbs, code panels) came out
 * ±1 in a channel from run to run: partial re-raster of invalidated tiles
 * and GPU compositing. Scrollbars stay visible because themes style them
 * (Playwright hides them in headless mode by default).
 *
 * handleSIG* false: Playwright's own handlers close the browser and call
 * process.exit(130) before the tool can stop the app it started, leaving the
 * app's process groups orphaned. Tools install app-runner's
 * installSignalHandlers instead.
 */
export const LAUNCH_OPTIONS = {
  headless: true,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: [
    "--disable-gpu",
    "--force-color-profile=srgb",
    "--disable-partial-raster",
    "--disable-skia-runtime-opts",
    "--run-all-compositor-stages-before-draw",
    "--disable-checker-imaging",
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
  ],
} as const;

export const SCREENSHOT_OPTIONS = {
  type: "png",
  animations: "disabled",
  caret: "hide",
  scale: "css",
} as const;

/**
 * Injected into every frame before the app runs. CSS transitions and
 * animations jump straight to their end state, so nothing is laid out,
 * rasterized or measured mid-motion. Only motion changes; every settled style
 * is the app's own. (Web Animations are finished by the screenshot's
 * `animations: "disabled"`.)
 */
export const DETERMINISM_CSS = `*, *::before, *::after {
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  scroll-behavior: auto !important;
}`;

/** Init script body: installs `css` in every frame before app code runs. Pass to context.addInitScript(fn, css). */
export function installStyleInitScript(css: string) {
  const doc = (globalThis as any).document;
  const install = () => {
    const style = doc.createElement("style");
    style.setAttribute("data-screenshot-harness", "");
    style.textContent = css;
    (doc.head ?? doc.documentElement).appendChild(style);
  };
  if (doc.documentElement) install();
  else doc.addEventListener("DOMContentLoaded", install, { once: true });
}

// -- capture ------------------------------------------------------------------

export type { Box, Theme };

export interface CaptureResult {
  png: Buffer;
  url: string;
  viewport: { width: number; height: number };
  /** Frames shot until two consecutive ones matched. */
  frames: number;
  stable: boolean;
  durationMs: number;
  /** How the theme was applied: "default", "attribute", "storage", "click", "query" or "prefers-color-scheme". */
  themeMethod: string;
  /** Mask selectors and the boxes they covered (CSS px, clipped to the viewport). */
  masks: Array<{ selector: string; boxes: Box[] }>;
  /** Requests the guard blocked that the app should not have made (a port the run did not start, a non-loopback host). */
  blocked: string[];
  /** Blocked requests to the app's own named profile ports the run never bound (a dead kernel URL): expected. */
  expectedBlocked: string[];
  consoleErrors: string[];
  /** Page loads after the first (a Vite reload mid-capture). */
  reloads: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_VIEWPORT = CONTEXT_OPTIONS.viewport;

/** Themes a route is captured in: its own list, else light+dark (dark only on a dark-first surface). */
export function routeThemes(app: AppEntry, route: RouteSpec): Theme[] {
  return route.themes ?? (app.theme?.rule === "dark-first" ? ["dark"] : ["light", "dark"]);
}

/** The shot key: `<route>-<theme>`. */
export function shotKey(route: RouteSpec, theme: Theme): string {
  return `${route.id}-${theme}`;
}

function defaultTheme(app: AppEntry): Theme {
  return app.theme?.rule === "dark-first" ? "dark" : "light";
}

type Network = ReturnType<typeof trackNetwork>;

/** Tracks in-flight requests so "network quiet" ignores long-lived streams (SSE, websockets). */
function trackNetwork(page: any) {
  const inflight = new Set<any>();
  let lastChange = Date.now();
  const ignore = (request: any) => {
    const type = request.resourceType();
    return type === "websocket" || type === "eventsource" || /\/(events|sse|stream)(\?|$)/.test(request.url());
  };
  page.on("request", (request: any) => {
    if (ignore(request)) return;
    inflight.add(request);
    lastChange = Date.now();
  });
  const done = (request: any) => {
    if (inflight.delete(request)) lastChange = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    async quiet(quietMs = 500, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inflight.size === 0 && Date.now() - lastChange >= quietMs) return;
        await sleep(50);
      }
      const pending = [...inflight].map((request) => request.url()).slice(0, 5);
      throw new Error(`network did not go quiet within ${timeoutMs} ms; pending: ${pending.join(", ")}`);
    },
  };
}

/**
 * The bundled faces (Inter 400-700, IBM Plex Mono 400-600). Loading every declared one explicitly means
 * "fonts ready" never depends on which faces the visible text happened to request first.
 */
const BUNDLED_FACES = [
  "400 16px Inter",
  "500 16px Inter",
  "600 16px Inter",
  "700 16px Inter",
  '400 16px "IBM Plex Mono"',
  '500 16px "IBM Plex Mono"',
  '600 16px "IBM Plex Mono"',
];

/** Fonts settled and visible images decoded, in every frame (15 s cap per frame, never a hang). */
async function waitForAssets(page: any) {
  for (const frame of page.frames().filter((f: any) => !f.isDetached())) {
    await frame
      .evaluate(async (faces: string[]) => {
        const doc = (globalThis as any).document;
        const settle = async () => {
          const declared = new Set(Array.from(doc.fonts as Iterable<any>).map((face: any) => face.family.replace(/["']/g, "")));
          await Promise.all(
            faces
              .filter((face) => declared.has(face.replace(/^\d+ 16px /, "").replace(/"/g, "")))
              .map((face) => doc.fonts.load(face).catch(() => undefined)),
          );
          await doc.fonts.ready;
          const pending = Array.from(doc.fonts as Iterable<any>).filter((face: any) => face.status === "loading");
          await Promise.all(pending.map((face: any) => face.loaded.catch(() => undefined)));
          const win = globalThis as any;
          const visible = Array.from(doc.images as Iterable<any>).filter((img: any) => {
            const rect = img.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < win.innerHeight && rect.right > 0 && rect.left < win.innerWidth && rect.width > 0;
          });
          await Promise.all(
            visible.map(async (img: any) => {
              if (!img.complete) {
                await new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                });
              }
              await img.decode().catch(() => undefined);
            }),
          );
        };
        await Promise.race([settle(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
      }, BUNDLED_FACES)
      .catch(() => undefined); // a frame that navigated away mid-check
  }
}

/** Two animation frames, or 5 s (a page with requestAnimationFrame throttled never ticks). */
async function nextFrames(page: any, count = 2) {
  await page.evaluate(
    (n: number) =>
      new Promise<void>((resolve) => {
        const raf = (globalThis as any).requestAnimationFrame;
        const tick = (left: number) => (left <= 0 ? resolve() : raf(() => tick(left - 1)));
        tick(n);
        setTimeout(resolve, 5_000);
      }),
    count,
  );
}

/** Overall cap on one capture; the context is closed when it fires, which ends any pending step. */
export const CAPTURE_DEADLINE_MS = 180_000;

/** Error from captureRoute. `blocked` holds what the guard blocked before the failure. */
export class CaptureError extends Error {
  constructor(
    message: string,
    readonly blocked: string[],
    readonly expectedBlocked: string[],
  ) {
    super(message);
  }
}

function deadline<T>(work: Promise<T>, ms: number, what: string, onTimeout: () => Promise<unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout();
      reject(new Error(`${what} did not finish within ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

type Step = NonNullable<RouteSpec["steps"]>[number];

async function runStep(page: any, step: Step, network: ReturnType<typeof trackNetwork>) {
  const need = () => {
    if (!step.target) throw new Error(`step ${step.action} needs a target: ${JSON.stringify(step)}`);
    return step.target;
  };
  switch (step.action) {
    case "click":
      await page.locator(need()).click({ timeout: 15_000 });
      break;
    case "hover":
      await page.locator(need()).hover({ timeout: 15_000 });
      break;
    case "press":
      if (step.target && step.value !== undefined) await page.locator(step.target).press(String(step.value), { timeout: 15_000 });
      else await page.keyboard.press(String(step.value ?? step.target));
      break;
    case "scroll":
      if (step.target) {
        await page.locator(step.target).evaluate((element: any, top: number) => {
          element.scrollTop = top;
        }, Number(step.value ?? 0));
      } else {
        await page.evaluate((top: number) => (globalThis as any).scrollTo(0, top), Number(step.value ?? 0));
      }
      break;
    case "wait":
      if (step.target) await page.locator(step.target).first().waitFor({ state: "visible", timeout: 30_000 });
      else await sleep(Number(step.value ?? 0));
      break;
    default:
      throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
  await network.quiet();
}

/** Boxes of every element a mask selector matches, clipped to the viewport and rounded outward. */
async function maskBoxes(page: any, selectors: string[], viewport: { width: number; height: number }) {
  const out: Array<{ selector: string; boxes: Box[] }> = [];
  for (const selector of selectors) {
    const boxes: Box[] = [];
    for (const handle of await page.locator(selector).all()) {
      const box = await handle.boundingBox().catch(() => null);
      if (!box) continue;
      const x0 = Math.max(0, Math.floor(box.x));
      const y0 = Math.max(0, Math.floor(box.y));
      const x1 = Math.min(viewport.width, Math.ceil(box.x + box.width));
      const y1 = Math.min(viewport.height, Math.ceil(box.y + box.height));
      if (x1 > x0 && y1 > y0) boxes.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
    out.push({ selector, boxes });
  }
  return out;
}

/** Shoots until two consecutive frames 250 ms apart are byte-identical, up to 12 frames. */
async function stableShot(page: any, masks: string[]) {
  const mask = masks.map((selector) => page.locator(selector));
  const shoot = () => page.screenshot({ ...SCREENSHOT_OPTIONS, mask, maskColor: "#FF00FF" }) as Promise<Buffer>;
  let previous = await shoot();
  let frames = 1;
  while (frames < 12) {
    await sleep(250);
    const current = await shoot();
    frames += 1;
    if (current.equals(previous)) return { png: previous, frames, stable: true };
    previous = current;
  }
  return { png: previous, frames, stable: false };
}

/** Waits, runs the steps, applies post-load theme switches, then takes the stable shot. */
async function settleAndShoot(page: any, network: ReturnType<typeof trackNetwork>, route: RouteSpec, viewport: { width: number; height: number }, afterLoad: () => Promise<void>, verifyTheme: () => Promise<void>) {
  const waitFor = async () => {
    if (route.waitFor) await page.locator(route.waitFor).first().waitFor({ state: "visible", timeout: 30_000 });
    await network.quiet();
  };
  await network.quiet();
  // route.waitFor is the state to capture. Without steps it is also "the app is ready" for the theme
  // switch; with steps, it is reached by them (each step waits for its own target).
  if (!route.steps?.length) await waitFor();
  await waitForAssets(page);
  await afterLoad();
  for (const step of route.steps ?? []) await runStep(page, step, network);
  if (route.steps?.length) await waitFor();
  // A neutral pointer: steps that click or hover leave it over a control otherwise.
  await page.mouse.move(0, 0);
  await network.quiet();
  await waitForAssets(page);
  await sleep(400);
  await nextFrames(page);
  await verifyTheme();
  const shot = await stableShot(page, route.masks ?? []);
  const masks = await maskBoxes(page, route.masks ?? [], viewport);
  return { ...shot, masks };
}

interface ThemePlan {
  method: string;
  url: (url: string) => string;
  init?: { storage: Record<string, string> };
  afterLoad: (page: any, network: Network) => Promise<void>;
  verify: (page: any) => Promise<void>;
}

/** How to put the app in `theme`. Only the non-default theme is switched; the default is left as the app boots. */
export function themePlan(app: AppEntry, theme: Theme): ThemePlan {
  const none: ThemePlan = { method: "default", url: (url) => url, afterLoad: async () => undefined, verify: async () => undefined };
  if (theme === defaultTheme(app)) return none;
  const sw = app.verify?.darkSwitch;
  if (!sw) return { ...none, method: "prefers-color-scheme" };
  if (theme !== "dark") return { ...none, method: "prefers-color-scheme" }; // darkSwitch only knows how to reach dark
  switch (sw.kind) {
    case "attribute": {
      const target = sw.target ?? "html";
      const set = (page: any) =>
        page.locator(target).first().evaluate((element: any, value: string) => element.setAttribute("data-theme", value), theme);
      return {
        ...none,
        method: "attribute",
        afterLoad: set,
        verify: async (page) => {
          const actual = await page.locator(target).first().getAttribute("data-theme");
          if (actual !== theme) throw new Error(`theme check failed: ${target}[data-theme]=${actual}, expected ${theme}`);
        },
      };
    }
    case "storage":
      return { ...none, method: "storage", init: { storage: { [sw.key]: sw.value } } };
    case "click":
      return { ...none, method: "click", afterLoad: (page) => page.locator(sw.selector).click({ timeout: 15_000 }) };
    case "steps":
      return {
        ...none,
        method: "steps",
        afterLoad: async (page, network) => {
          for (const step of sw.steps) await runStep(page, step, network);
        },
      };
    case "query":
      return {
        ...none,
        method: "query",
        url: (raw) => {
          const url = new URL(raw);
          url.searchParams.set(sw.param, sw.value);
          return url.href;
        },
      };
  }
}

function storageInitScript(entries: Record<string, string>) {
  try {
    for (const [key, value] of Object.entries(entries)) (globalThis as any).localStorage.setItem(key, value);
  } catch {
    // opaque-origin frames have no storage
  }
}

/** One route in one theme. Browser and static apps: a fresh guarded context. Electron: the app's first window. */
export async function captureRoute(browser: any, running: RunningApp, route: RouteSpec, theme: Theme): Promise<CaptureResult> {
  const started = Date.now();
  const viewport = route.viewport ?? DEFAULT_VIEWPORT;
  const plan = themePlan(running.app, theme);
  const consoleErrors: string[] = [];
  const watch = (page: any) => {
    page.on("console", (message: any) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error: any) => consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 300)}`));
  };

  if (running.electron) {
    const before = running.blocked?.().length ?? 0;
    const blockedSince = () => splitBlocked(running, (running.blocked?.() ?? []).slice(before));
    try {
      return await deadline(captureElectron(), CAPTURE_DEADLINE_MS, `capture of ${route.id} (${theme})`, async () => undefined);
    } catch (error) {
      const { unexpected, expected } = blockedSince();
      throw new CaptureError(error instanceof Error ? error.message : String(error), unexpected, expected);
    }
  }

  async function captureElectron(): Promise<CaptureResult> {
    const page = await electronPage(running, route);
    await page.setViewportSize(viewport);
    await page.addStyleTag({ content: DETERMINISM_CSS });
    watch(page);
    if (plan.init) {
      await page.evaluate(storageInitScript, plan.init.storage);
      await page.reload({ waitUntil: "load" });
      await page.addStyleTag({ content: DETERMINISM_CSS });
    }
    const network = trackNetwork(page);
    const before = running.blocked?.().length ?? 0;
    const shot = await settleAndShoot(page, network, route, viewport, () => plan.afterLoad(page, network), () => plan.verify(page));
    const { unexpected, expected } = splitBlocked(running, (running.blocked?.() ?? []).slice(before));
    return {
      ...shot,
      url: page.url(),
      viewport,
      durationMs: Date.now() - started,
      themeMethod: plan.method,
      blocked: unexpected,
      expectedBlocked: expected,
      consoleErrors: [...new Set(consoleErrors)],
      reloads: 0,
    };
  }

  if (!running.baseUrl) throw new Error(`${running.app.id}: no baseUrl to capture`);
  const { context, blocked } = await guardedContext(browser, running, { colorScheme: theme, viewport });
  try {
    return await deadline(captureInContext(), CAPTURE_DEADLINE_MS, `capture of ${route.id} (${theme})`, () => context.close().catch(() => undefined));
  } catch (error) {
    const { unexpected, expected } = splitBlocked(running, blocked());
    throw new CaptureError(error instanceof Error ? error.message : String(error), unexpected, expected);
  } finally {
    await context.close().catch(() => undefined);
  }

  async function captureInContext(): Promise<CaptureResult> {
    if (plan.init) await context.addInitScript(storageInitScript, plan.init.storage);
    const page = await context.newPage();
    watch(page);
    const network = trackNetwork(page);
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    const url = plan.url(`${running.baseUrl}${route.path || "/"}`);
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    const shot = await settleAndShoot(page, network, route, viewport, () => plan.afterLoad(page, network), () => plan.verify(page));
    const { unexpected, expected } = splitBlocked(running, blocked());
    return {
      ...shot,
      url,
      viewport,
      durationMs: Date.now() - started,
      themeMethod: plan.method,
      blocked: unexpected,
      expectedBlocked: expected,
      consoleErrors: [...new Set(consoleErrors)],
      reloads: Math.max(0, loads - 1),
    };
  }
}

/** Electron: the window whose title or URL contains route.path; "", "/" or "main" is the first window. */
async function electronPage(running: RunningApp, route: RouteSpec): Promise<any> {
  const first = await running.electron!.window();
  const wanted = route.path;
  if (!wanted || wanted === "/" || wanted === "main") return first;
  if (wanted.startsWith("#")) {
    await first.evaluate((hash: string) => ((globalThis as any).location.hash = hash), wanted);
    return first;
  }
  for (const page of running.electron!.app.windows()) {
    const title = await page.title().catch(() => "");
    if (title.includes(wanted) || page.url().includes(wanted)) return page;
  }
  throw new Error(`${running.app.id}: no electron window matches route ${route.id} (${wanted})`);
}

/**
 * Loads each distinct route URL once, so Vite transforms and dependency pre-bundling settle before capture.
 * Returns what the guard blocked meanwhile.
 */
export async function warmUp(browser: any, running: RunningApp, routes: RouteSpec[]): Promise<{ blocked: string[]; expectedBlocked: string[] }> {
  if (running.electron || !running.baseUrl) return { blocked: [], expectedBlocked: [] };
  const { context, blocked } = await guardedContext(browser, running);
  try {
    const page = await context.newPage();
    const network = trackNetwork(page);
    for (const path of [...new Set(routes.map((route) => route.path || "/"))]) {
      await page.goto(`${running.baseUrl}${path}`, { waitUntil: "load", timeout: 120_000 });
      await network.quiet(1500, 120_000);
      await waitForAssets(page);
    }
  } finally {
    await context.close();
  }
  const { unexpected, expected } = splitBlocked(running, blocked());
  return { blocked: unexpected, expectedBlocked: expected };
}
