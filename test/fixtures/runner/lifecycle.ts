/**
 * Stand-in for a tool process that ends badly while an app it started is up (test helper). It starts the
 * stand-in server on <ui>/<helper>, prints READY <tmp>, then:
 *   exit      calls process.exit(3) without stopping the app
 *   throw     installs app-runner's handlers, then throws asynchronously (an uncaught exception)
 *   kill      waits to be SIGKILLed (no hook can run)
 *   restart   installs app-runner's handlers; on SIGINT its cleanup tries to start a second app on
 *             <ui2>/<helper2> and prints REFUSED <message> or STARTED <url>
 * Usage: bun lifecycle.ts <mode> <root> <out-dir> <ui> <helper> [<ui2> <helper2>]
 */
import { installSignalHandlers, startApp } from "../../../scripts/lib/app-runner.ts";
import type { AppEntry } from "../../../scripts/lib/registry.ts";

const [mode, root, outDir, ui, helper, ui2, helper2] = process.argv.slice(2) as [string, string, string, string, string, string?, string?];

function app(id: string, uiPort: number, helperPort: number): AppEntry {
  return {
    id,
    root: "app",
    commands: { cwd: "app" },
    run: { mode: "browser", cwd: "app", start: "bun serve.ts", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" },
    runProfile: {
      env: { NO_COLOR: "1", FIXTURE_PORT: "{port:ui}", FIXTURE_HELPER_PORT: "{port:helper}", FIXTURE_STRAY_PORT: "46937" },
      unsetEnv: [],
      tempHome: true,
      fixtures: [],
      flags: [],
      ports: { ui: uiPort, helper: helperPort },
      proof: { status: "proven", method: "test fixture" },
    },
  } as unknown as AppEntry;
}

const running = await startApp(app("lifecycle-fixture", Number(ui), Number(helper)), { root, outDir, timeoutMs: 20_000 });

if (mode === "restart") {
  installSignalHandlers(async () => {
    try {
      const second = await startApp(app("lifecycle-second", Number(ui2), Number(helper2)), { root, outDir, timeoutMs: 20_000 });
      console.log(`STARTED ${second.baseUrl}`);
    } catch (error) {
      console.log(`REFUSED ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
if (mode === "throw") installSignalHandlers();

console.log(`READY ${running.tmp}`);

if (mode === "exit") process.exit(3);
if (mode === "throw")
  setTimeout(() => {
    throw new Error("planted crash");
  }, 50);
setInterval(() => {}, 1 << 30);
