/**
 * Deterministic capture settings, copied from verification/docs-system/lib/capture.ts.
 * Every rollout tool that opens a browser on an app uses them (snapshot, verify:apps).
 */

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
