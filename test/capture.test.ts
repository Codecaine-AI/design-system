/**
 * captureRoute puts the app in the theme it was asked for, through every registry darkSwitch kind,
 * and leaves the default theme alone. The stand-in server's /themed page (test/fixtures/runner/serve.ts)
 * is white in light and black in dark; each shot's top-left pixel tells which theme it captured. Its
 * /themed-dark page boots dark: a storage verify.lightSwitch reaches light, also after a navigation-only step.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startApp, type RunningApp } from "../scripts/lib/app-runner.ts";
import { captureRoute, LAUNCH_OPTIONS, trackNetwork } from "../scripts/lib/capture.ts";
import { loadPlaywright, playwrightUnavailable } from "../scripts/lib/playwright.ts";
import { decodePng } from "../scripts/lib/png.ts";
import type { AppEntry, RouteSpec, ThemeSwitch, VerifySpec } from "../scripts/lib/registry.ts";
import { finishScratch } from "./leaks.ts";

const mirror = process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds";
const noPlaywright = playwrightUnavailable(mirror);
if (noPlaywright) console.warn(`skipping the capture test: ${noPlaywright}`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-capture-test-")));
afterAll(async () => {
  try {
    await finishScratch(scratch); // stop what this file started, clean crashed runs' records, then no listener may be left
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const app = {
  id: "capture-fixture",
  root: "app",
  theme: { rule: "light-dark" },
  commands: { cwd: "app" },
  run: { mode: "browser", cwd: "app", start: "bun serve.ts", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" },
  runProfile: {
    env: { NO_COLOR: "1", FIXTURE_PORT: "{port:ui}", FIXTURE_HELPER_PORT: "{port:helper}" },
    unsetEnv: [],
    tempHome: true,
    fixtures: [],
    flags: [],
    ports: { ui: 46920, helper: 46921 },
    proof: { status: "proven", method: "test fixture" },
  },
} as unknown as AppEntry;

const route = (path: string): RouteSpec => ({ id: "themed", path, viewport: { width: 40, height: 30 } });

test.skipIf(Boolean(noPlaywright))(
  "captures dark through each darkSwitch kind, and light as the app boots",
  async () => {
    const root = mkdtempSync(join(scratch, "root-"));
    mkdirSync(join(root, "app"));
    cpSync(join(import.meta.dir, "fixtures/runner/serve.ts"), join(root, "app/serve.ts"));
    const running = await startApp(app, { root, outDir: join(scratch, "out"), timeoutMs: 20_000 });
    const browser = await loadPlaywright(mirror).chromium.launch(LAUNCH_OPTIONS);
    try {
      const withSwitch = (darkSwitch?: VerifySpec["darkSwitch"]): RunningApp => ({
        ...running,
        app: { ...app, ...(darkSwitch ? { verify: { probes: [], darkSwitch } } : {}) },
      });
      const cases: Array<[string, RunningApp, string, "light" | "dark", string]> = [
        ["attribute", withSwitch({ kind: "attribute" }), "/themed", "dark", "attribute"],
        ["storage", withSwitch({ kind: "storage", key: "theme", value: "dark" }), "/themed", "dark", "storage"],
        ["query", withSwitch({ kind: "query", param: "theme", value: "dark" }), "/themed", "dark", "query"],
        ["click", withSwitch({ kind: "click", selector: "#dark" }), "/themed", "dark", "click"],
        ["steps", withSwitch({ kind: "steps", steps: [{ action: "click", target: "#dark" }] }), "/themed", "dark", "steps"],
        ["no switch", withSwitch(), "/themed?follow=system", "dark", "prefers-color-scheme"],
        ["light default", withSwitch({ kind: "click", selector: "#dark" }), "/themed", "light", "default"],
      ];
      const results = await Promise.all(cases.map(([, target, path, theme]) => captureRoute(browser, target, route(path), theme)));
      const seen = results.map((result, i) => {
        const pixel = decodePng(result.png).data.subarray(0, 4);
        return [cases[i]![0], result.themeMethod, pixel[0] === 0 ? "dark" : pixel[0] === 255 ? "light" : `rgb ${pixel[0]}`];
      });
      expect(seen).toEqual(cases.map(([name, , , theme, method]) => [name, method, theme]));
    } finally {
      await browser.close();
      await running.stop();
    }
  },
  30_000,
);

test.skipIf(Boolean(noPlaywright))(
  "captures light through a storage lightSwitch on an app that boots dark, also after a navigation-only step; an attribute switch does not survive one",
  async () => {
    const root = mkdtempSync(join(scratch, "root-"));
    mkdirSync(join(root, "app"));
    cpSync(join(import.meta.dir, "fixtures/runner/serve.ts"), join(root, "app/serve.ts"));
    const running = await startApp(app, { root, outDir: join(scratch, "out"), timeoutMs: 20_000 });
    const browser = await loadPlaywright(mirror).chromium.launch(LAUNCH_OPTIONS);
    try {
      const withSwitches = (darkSwitch: ThemeSwitch, lightSwitch?: VerifySpec["lightSwitch"]): RunningApp => ({
        ...running,
        app: { ...app, verify: { probes: [], darkSwitch, ...(lightSwitch ? { lightSwitch } : {}) } },
      });
      // The dark switch writes the same key the light switch does; the page boots dark without either.
      const darkStorage: ThemeSwitch = { kind: "storage", key: "mode", value: "dark" };
      const seeded = withSwitches(darkStorage, { kind: "storage", key: "mode", value: "light" });
      const navigate: RouteSpec = { ...route("/themed-dark"), steps: [{ action: "click", target: "#next" }] };
      const cases: Array<[string, RunningApp, RouteSpec, "light" | "dark", string, "light" | "dark", boolean]> = [
        ["no lightSwitch (the bug: light reads dark)", withSwitches(darkStorage), route("/themed-dark"), "light", "default", "dark", false],
        ["storage lightSwitch", seeded, route("/themed-dark"), "light", "storage", "light", false],
        ["storage lightSwitch, then a navigation-only step", seeded, navigate, "light", "storage", "light", true],
        ["dark with a lightSwitch, after the same step", seeded, navigate, "dark", "storage", "dark", true],
      ];
      const results = await Promise.all(cases.map(([, target, r, theme]) => captureRoute(browser, target, r, theme)));
      const seen = results.map((result, i) => {
        const pixel = decodePng(result.png).data.subarray(0, 4);
        return [cases[i]![0], result.themeMethod, pixel[0] === 0 ? "dark" : pixel[0] === 255 ? "light" : `rgb ${pixel[0]}`, result.reloads > 0];
      });
      expect(seen).toEqual(cases.map(([name, , , , method, expected, navigated]) => [name, method, expected, navigated]));

      // Why lightSwitch takes storage only: a data-theme attribute is set on the first document and is gone
      // after a navigation-only step (shown here with an attribute darkSwitch; capture's theme check refuses the shot).
      await expect(captureRoute(browser, withSwitches({ kind: "attribute" }), navigate, "dark")).rejects.toThrow(/theme check failed: html\[data-theme\]=null, expected dark/);
    } finally {
      await browser.close();
      await running.stop();
    }
  },
  60_000,
);

test.skipIf(Boolean(noPlaywright))(
  "network quiet: a new document drops the old one's routed requests; a hash navigation keeps them",
  async () => {
    // /a starts a fetch that never answers. Every request is routed, as under the request guard.
    let hangs = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/hang") return (hangs++, new Promise<Response>(() => {}));
        const script = path === "/a" ? "<script>fetch('/hang')</script>" : "";
        return new Response(`<!doctype html><title>${path}</title>${script}`, { headers: { "content-type": "text/html" } });
      },
    });
    const browser = await loadPlaywright(mirror).chromium.launch(LAUNCH_OPTIONS);
    const base = `http://127.0.0.1:${server.port}`;
    const openA = async () => {
      const context = await browser.newContext();
      await context.route(() => true, (route: any) => route.fallback());
      const page = await context.newPage();
      const network = trackNetwork(page);
      const before = hangs;
      await page.goto(`${base}/a`);
      while (hangs === before) await Bun.sleep(20);
      return { page, network };
    };
    try {
      const hash = await openA();
      await hash.page.goto(`${base}/a#elsewhere`);
      await expect(hash.network.quiet(200, 1_500)).rejects.toThrow(/pending: .*\/hang/);

      const newDocument = await openA();
      await newDocument.page.goto(`${base}/b`);
      await newDocument.network.quiet(200, 5_000);
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  30_000,
);
