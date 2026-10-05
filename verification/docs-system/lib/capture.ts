/**
 * Deterministic capture of one shot (one view in one theme).
 *
 * Every shot gets a FRESH browser context: empty localStorage, fixed viewport
 * 1440x900 @1x, reducedMotion "reduce", locale en-US, timezone UTC. Nothing a
 * shot does can persist:
 *   - every non-GET request to /api is answered 403 by the harness (and logged),
 *     so a stray rail change or annotation never reaches even the staged server;
 *   - requests to the dead kernel URL are aborted;
 *   - requests to any non-loopback origin are aborted (and logged).
 *
 * Light/dark: the app takes `dark` from the shared GLOBAL theme manifest
 * (App.tsx boot: `nextDark = resolved.manifest.dark` under the global theme).
 * The harness rewrites `manifest.dark` in the GET /api/themes/global response,
 * which is exactly the value the style rail's light/dark toggle would have
 * saved, without saving anything.
 */
import type { ShotSpec, Step, Theme } from "./shots";
import { DEAD_KERNEL_URL } from "./env";

export interface CaptureResult {
  png: Buffer;
  attempts: number;
  stable: boolean;
  durationMs: number;
  blockedWrites: string[];
  blockedExternal: string[];
  consoleErrors: string[];
  reloads: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STYLE_RAIL_TOGGLE = 'button[aria-label="Expand style controls"], button[aria-label="Collapse style controls"]';

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
 * and GPU compositing. Scrollbars stay visible because the theme styles them
 * (Playwright hides them in headless mode by default).
 */
export const LAUNCH_OPTIONS = {
  headless: true,
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
 * animations jump straight to their end state, so nothing is laid out or
 * rasterized mid-motion: the peek drawer's 300 ms width transition otherwise
 * left sub-pixel scrollbar differences between runs. Only motion changes;
 * every settled style is the app's own. (Web Animations are finished by the
 * screenshot's `animations: "disabled"`.)
 */
export const DETERMINISM_CSS = `*, *::before, *::after {
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  scroll-behavior: auto !important;
}`;

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

/** localStorage presets for the docs app; written before any app code runs. */
function storagePresets(spec: ShotSpec): Record<string, string> {
  const presets: Record<string, string> = {};
  if (spec.app === "docs") {
    // StyleRail collapse (App.tsx STYLE_RAIL_COLLAPSE_KEY). A fresh browser opens the rail.
    presets["docs-style-rail-collapsed"] = spec.rail === "open" ? "false" : "true";
    // Selected rail pane (StyleRail.tsx SELECTED_PANE_STORAGE_KEY); default "theme.presets".
    if (spec.railPane) presets["docs-style-rail-selected"] = spec.railPane;
  }
  return { ...presets, ...(spec.localStorage ?? {}) };
}

/** Tracks in-flight requests so "network quiet" ignores the long-lived SSE stream. */
function trackNetwork(page: any) {
  const inflight = new Set<any>();
  let lastChange = Date.now();
  const ignore = (request: any) => {
    const url = request.url();
    return url.includes("/api/events") || request.resourceType() === "websocket" || request.resourceType() === "eventsource";
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

async function allFrames(page: any): Promise<any[]> {
  return page.frames().filter((frame: any) => !frame.isDetached());
}

/**
 * The bundled faces (@codecaine-ai/text-measure fonts.css: Inter 400-700, IBM
 * Plex Mono 400-600). Loading them all explicitly means "fonts ready" never
 * depends on which faces the visible text happened to request first.
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

/** Fonts settled + visible images decoded, in every frame (15 s cap per frame, never a hang). */
async function waitForAssets(page: any) {
  for (const frame of await allFrames(page)) {
    await frame
      .evaluate(async (faces: string[]) => {
        const settle = async () => {
          const declared = new Set(Array.from(document.fonts).map((face) => face.family.replace(/["']/g, "")));
          await Promise.all(
            faces
              .filter((face) => declared.has(face.replace(/^\d+ 16px /, "").replace(/"/g, "")))
              .map((face) => document.fonts.load(face).catch(() => undefined)),
          );
          await document.fonts.ready;
          const pending = Array.from(document.fonts).filter((face) => face.status === "loading");
          await Promise.all(pending.map((face) => face.loaded.catch(() => undefined)));
          const visible = Array.from(document.images).filter((img) => {
            const rect = img.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && rect.width > 0;
          });
          await Promise.all(
            visible.map(async (img) => {
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

async function nextFrames(page: any, count = 2) {
  await page.evaluate(
    (n: number) =>
      new Promise<void>((resolve) => {
        const tick = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
        tick(n);
      }),
    count,
  );
}

async function waitForDocsApp(page: any, theme: Theme) {
  // Theme boot finished: the rail (or its collapse tab) only renders once
  // themeReady && !themeLocked, and the theme folder CSS is installed.
  await page.waitForSelector(STYLE_RAIL_TOGGLE, { timeout: 30_000 });
  await page.waitForSelector("style#docs-theme-folder-css", { state: "attached", timeout: 30_000 });
  await page.waitForFunction(
    (expected: string) => document.documentElement.getAttribute("data-theme") === expected,
    theme,
    { timeout: 30_000 },
  );
  // Tree loaded, and the doc page finished its transition in. (Data attributes
  // and ARIA only: a CSS migration may rename classes, never these hooks.)
  await page.waitForSelector('nav[aria-label="Docs tree"]', { timeout: 30_000 });
  await page.waitForSelector('main [data-docs-page-transition="idle"][aria-busy="false"] [data-docs-mode]', { timeout: 30_000 });
}

async function waitForPlayground(page: any) {
  for (const title of ["light", "dark"]) {
    const frame = page.frameLocator(`iframe[title="${title}"]`);
    await frame.locator("main > *").first().waitFor({ state: "attached", timeout: 30_000 });
  }
}

async function runStep(page: any, step: Step, network: ReturnType<typeof trackNetwork>) {
  switch (step.action) {
    case "click":
      await page.locator(step.selector).click({ timeout: 15_000 });
      break;
    case "dblclick":
      await page.locator(step.selector).dblclick({ timeout: 15_000 });
      break;
    case "press":
      await page.keyboard.press(step.key);
      break;
    case "scroll":
      await page.locator(step.selector).evaluate((element: HTMLElement, top: number) => {
        element.scrollTop = top;
      }, step.top);
      break;
    case "waitFor":
      await page.locator(step.selector).first().waitFor({ state: step.state ?? "visible", timeout: 30_000 });
      break;
    case "wait":
      await sleep(step.ms);
      break;
    case "hover":
      await page.locator(step.selector).hover({ timeout: 15_000 });
      break;
    case "dispatch":
      await page.evaluate(
        ({ event, detail }: { event: string; detail: unknown }) => {
          document.dispatchEvent(new CustomEvent(event, { detail }));
        },
        { event: step.event, detail: step.detail ?? null },
      );
      break;
    default:
      throw new Error(`Unknown step ${JSON.stringify(step)}`);
  }
  await network.quiet();
}

export async function captureShot(browser: any, origin: string, spec: ShotSpec, theme: Theme): Promise<CaptureResult> {
  const started = Date.now();
  const blockedWrites: string[] = [];
  const blockedExternal: string[] = [];
  const consoleErrors: string[] = [];
  const context = await browser.newContext(CONTEXT_OPTIONS);
  try {
    const presets = storagePresets(spec);
    await context.addInitScript(
      ({ entries, css }: { entries: Record<string, string>; css: string }) => {
        try {
          for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
        } catch {
          // opaque-origin frames (sandboxed html blocks) have no storage
        }
        const install = () => {
          const style = document.createElement("style");
          style.setAttribute("data-screenshot-harness", "");
          style.textContent = css;
          (document.head ?? document.documentElement).appendChild(style);
        };
        if (document.documentElement) install();
        else document.addEventListener("DOMContentLoaded", install, { once: true });
      },
      { entries: presets, css: DETERMINISM_CSS },
    );

    await context.route((url: URL) => url.href.startsWith(DEAD_KERNEL_URL), (route: any) => route.abort("connectionrefused"));
    await context.route(
      (url: URL) => (url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url),
      (route: any) => {
        blockedExternal.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort("blockedbyclient");
      },
    );
    await context.route(
      (url: URL) => isLoopback(url) && url.pathname.startsWith("/api/"),
      async (route: any) => {
        const request = route.request();
        const method = request.method();
        if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          blockedWrites.push(`${method} ${new URL(request.url()).pathname}`);
          return route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Blocked by the screenshot harness: shots never write." }),
          });
        }
        if (spec.app === "docs" && method === "GET" && new URL(request.url()).pathname === "/api/themes/global") {
          const response = await route.fetch();
          const json = await response.json();
          if (json?.theme?.manifest) json.theme.manifest.dark = theme === "dark";
          return route.fulfill({ response, json });
        }
        return route.fallback();
      },
    );

    const page = await context.newPage();
    page.on("console", (message: any) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error: any) => consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 300)}`));
    const network = trackNetwork(page);

    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });

    await page.goto(`${origin}${spec.url}`, { waitUntil: "load", timeout: 60_000 });
    await network.quiet();
    if (spec.app === "docs") await waitForDocsApp(page, theme);
    else await waitForPlayground(page);
    for (const selector of spec.waitFor ?? []) {
      await page.locator(selector).first().waitFor({ state: "attached", timeout: 30_000 });
    }
    await network.quiet();
    await waitForAssets(page);

    for (const step of spec.steps ?? []) await runStep(page, step, network);

    // A neutral pointer: (0,0) is the sidebar's "Docs" title / the playground
    // caption, which have no hover styles. Steps that click leave the pointer
    // over a control otherwise.
    await page.mouse.move(0, 0);
    await network.quiet();
    await waitForAssets(page);
    await sleep(spec.settleMs ?? 400);
    await nextFrames(page);

    if (spec.app === "docs") {
      const actual = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      if (actual !== theme) throw new Error(`theme check failed: data-theme=${actual}, expected ${theme}`);
    }

    const mask = (spec.masks ?? []).map((entry) => page.locator(entry.selector));
    const shoot = () => page.screenshot({ ...SCREENSHOT_OPTIONS, mask, maskColor: "#FF00FF" }) as Promise<Buffer>;

    // Stability: keep shooting until two consecutive frames are byte-identical.
    let previous = await shoot();
    let attempts = 1;
    let stable = false;
    while (attempts < 12) {
      await sleep(250);
      const current = await shoot();
      attempts += 1;
      if (current.equals(previous)) {
        stable = true;
        break;
      }
      previous = current;
    }
    return {
      png: previous,
      attempts,
      stable,
      durationMs: Date.now() - started,
      blockedWrites,
      blockedExternal,
      consoleErrors: [...new Set(consoleErrors)],
      reloads: Math.max(0, loads - 1),
    };
  } finally {
    await context.close();
  }
}

/** Load each distinct app once so vite transforms (and dependency pre-bundling) settle before capture. */
export async function warmUp(browser: any, origin: string, urls: string[]) {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  try {
    await context.route((url: URL) => url.href.startsWith(DEAD_KERNEL_URL), (route: any) => route.abort("connectionrefused"));
    await context.route(
      (url: URL) => (url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url),
      (route: any) => route.abort("blockedbyclient"),
    );
    await context.route(
      (url: URL) => isLoopback(url) && url.pathname.startsWith("/api/"),
      (route: any) => {
        const method = route.request().method();
        if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
        }
        return route.fallback();
      },
    );
    const page = await context.newPage();
    const network = trackNetwork(page);
    for (const url of urls) {
      await page.goto(`${origin}${url}`, { waitUntil: "load", timeout: 120_000 });
      await network.quiet(1500, 120_000);
      await waitForAssets(page);
    }
  } finally {
    await context.close();
  }
}
