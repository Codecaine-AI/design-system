/**
 * Stand-in for a capture CLI (test helper): starts the stand-in app, launches Chromium with
 * LAUNCH_OPTIONS, installs app-runner's signal handlers, prints READY, then waits to be signalled.
 * Usage: bun interrupt.ts <root> <out-dir> <playwright-root>
 */
import { installSignalHandlers, startApp } from "../../../scripts/lib/app-runner.ts";
import { LAUNCH_OPTIONS } from "../../../scripts/lib/capture.ts";
import { loadPlaywright } from "../../../scripts/lib/playwright.ts";
import type { AppEntry } from "../../../scripts/lib/registry.ts";

const [root, outDir, playwrightRoot] = process.argv.slice(2) as [string, string, string];
const app = {
  id: "interrupt-fixture",
  root: "app",
  commands: { cwd: "app" },
  run: { mode: "browser", cwd: "app", start: "bun serve.ts", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" },
  runProfile: {
    env: { NO_COLOR: "1", FIXTURE_PORT: "{port:ui}", FIXTURE_HELPER_PORT: "{port:helper}", FIXTURE_STRAY_PORT: "46997" },
    unsetEnv: [],
    tempHome: true,
    fixtures: [],
    flags: [],
    ports: { ui: 46925, helper: 46926 },
    proof: { status: "proven", method: "test fixture" },
  },
} as unknown as AppEntry;

const running = await startApp(app, { root, outDir, timeoutMs: 20_000 });
const browser = await loadPlaywright(playwrightRoot).chromium.launch(LAUNCH_OPTIONS);
installSignalHandlers(() => browser.close());
console.log(`READY ${running.tmp}`);
setInterval(() => {}, 1 << 30);
