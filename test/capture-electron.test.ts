/**
 * captureRoute on an Electron stand-in (a one-file main.js, not an app): every shot starts fresh. A
 * storage dark switch from one shot never leaks into the next light shot, the shot's theme reaches
 * prefers-color-scheme, and the page sees the fixed clock. The top-left pixel tells the theme.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type RunningApp, startApp } from "../scripts/lib/app-runner.ts";
import { captureRoute, FIXED_TIME } from "../scripts/lib/capture.ts";
import { playwrightAnchor, playwrightUnavailable } from "../scripts/lib/playwright.ts";
import { decodePng } from "../scripts/lib/png.ts";
import type { AppEntry, RouteSpec } from "../scripts/lib/registry.ts";

const mirror = process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds";
const electronDir = (() => {
  try {
    return dirname(createRequire(join(mirror, "system-view/package.json")).resolve("electron/package.json"));
  } catch {
    return null;
  }
})();
const skip = playwrightUnavailable(mirror) ?? (electronDir ? null : "electron does not resolve from the mirror's system-view");
if (skip) console.warn(`skipping the electron capture test: ${skip}`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-capture-electron-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** White by default; black when localStorage says dark, or (with #follow) when prefers-color-scheme is dark. */
const PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; background: #fff; }
  html[data-theme="dark"] body { background: #000; }
  @media (prefers-color-scheme: dark) { html.follow body { background: #000; } }
</style></head><body><script>
  if (location.hash === "#follow") document.documentElement.classList.add("follow");
  if (localStorage.getItem("theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");
  document.title = new Date().toISOString();
</script></body></html>`;

const app = {
  id: "electron-capture",
  root: "app",
  theme: { rule: "light-dark" },
  commands: { cwd: "app" },
  run: { mode: "electron", cwd: "app", electron: { build: "true", main: "app/main.js" } },
  runProfile: { env: {}, unsetEnv: [], tempHome: true, fixtures: [], flags: [], ports: {}, proof: { status: "proven", method: "test fixture" } },
} as unknown as AppEntry;

const route = (path: string): RouteSpec => ({ id: "page", path, viewport: { width: 40, height: 30 } });

test.skipIf(Boolean(skip))(
  "each Electron shot resets storage, takes its theme's color scheme and sees the fixed clock",
  async () => {
    const root = mkdtempSync(join(scratch, "root-"));
    mkdirSync(join(root, "app/node_modules"), { recursive: true });
    symlinkSync(electronDir!, join(root, "app/node_modules/electron"));
    mkdirSync(join(root, "node_modules"));
    symlinkSync(dirname(createRequire(playwrightAnchor(mirror)).resolve("playwright/package.json")), join(root, "node_modules/playwright"));
    writeFileSync(join(root, "app/package.json"), JSON.stringify({ name: "stand-in", main: "main.js" }));
    writeFileSync(join(root, "app/index.html"), PAGE);
    writeFileSync(
      join(root, "app/main.js"),
      `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => new BrowserWindow({ width: 320, height: 240, show: false }).loadFile(require("path").join(__dirname, "index.html")));
app.on("window-all-closed", () => app.quit());`,
    );
    const running = await startApp(app, { root, outDir: join(scratch, "out"), timeoutMs: 30_000 });
    try {
      const stored: RunningApp = { ...running, app: { ...app, verify: { probes: [], darkSwitch: { kind: "storage", key: "theme", value: "dark" } } } };
      const pixel = async (target: RunningApp, path: string, theme: "light" | "dark") => {
        const result = await captureRoute(undefined, target, route(path), theme);
        const red = decodePng(result.png).data[0];
        return [path, theme, result.themeMethod, red === 0 ? "dark" : red === 255 ? "light" : `rgb ${red}`, result.clock];
      };
      // In order: the storage switch's dark shot, then a light shot that must not inherit it; then prefers-color-scheme both ways.
      const seen = [await pixel(stored, "/", "dark"), await pixel(stored, "/", "light"), await pixel(running, "#follow", "dark"), await pixel(running, "#follow", "light")];
      expect(seen).toEqual([
        ["/", "dark", "storage", "dark", "fixed"],
        ["/", "light", "default", "light", "fixed"],
        ["#follow", "dark", "prefers-color-scheme", "dark", "fixed"],
        ["#follow", "light", "default", "light", "fixed"],
      ]);
      expect(await (await running.electron!.window()).title()).toBe(FIXED_TIME);
    } finally {
      await running.stop();
    }
  },
  90_000,
);
