/**
 * The app runner's contract with snapshot and verify:apps: a run sees only a sanitized environment,
 * binds only safe ports, is reachable at the URL its server printed, and stop() leaves nothing running.
 *
 * Runs use test/fixtures/runner/serve.ts (a stand-in server, not an app) on ports 46900-46939.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { spawn } from "node:child_process";

import {
  cleanupRuns,
  guardedContext,
  guardVerdict,
  killRun,
  launchBrowser,
  profileEnv,
  readyUrl,
  rootProc,
  servedFromRoot,
  splitBlocked,
  startApp,
  type RunningApp,
} from "../scripts/lib/app-runner.ts";
import { adoptStyleSheet, DETERMINISM_CSS } from "../scripts/lib/capture.ts";
import { loadPlaywright, playwrightAnchor, playwrightUnavailable } from "../scripts/lib/playwright.ts";
import type { AppEntry } from "../scripts/lib/registry.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-runner-test-")));
const outDir = join(scratch, "out");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const started: RunningApp[] = [];
afterEach(async () => {
  for (const running of started.splice(0)) await running.stop().catch(() => undefined);
});

/** A workspace root holding the stand-in server at app/serve.ts. */
function makeRoot(): string {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "app"));
  cpSync(join(import.meta.dir, "fixtures/runner/serve.ts"), join(root, "app/serve.ts"));
  return root;
}

function fixtureApp(ports: Record<string, number>, overrides: Partial<AppEntry> = {}, run: Partial<AppEntry["run"]> = {}): AppEntry {
  return {
    id: "runner-fixture",
    root: "app",
    commands: { cwd: "app" },
    run: {
      mode: "browser",
      cwd: "app",
      start: "bun serve.ts",
      readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)",
      ...run,
    },
    runProfile: {
      env: {
        NO_COLOR: "1",
        FIXTURE_PORT: "{port:ui}",
        FIXTURE_HELPER_PORT: "{port:helper}",
        FIXTURE_STRAY_PORT: "46939",
        FIXTURE_DEAD_PORT: "46938",
      },
      unsetEnv: [],
      tempHome: true,
      fixtures: [],
      flags: [],
      ports,
      proof: { status: "proven", method: "test fixture" },
    },
    ...overrides,
  } as AppEntry;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function start(app: AppEntry, root: string): Promise<RunningApp> {
  const running = await startApp(app, { root, outDir, timeoutMs: 20_000 });
  started.push(running);
  return running;
}

describe("profileEnv", () => {
  test("keeps only the allowlist, puts HOME and XDG in tmp, applies env, then removes unsetEnv", () => {
    const planted = {
      DOCS_SHARED_API_URL: "http://127.0.0.1:4820",
      DOCS_SHARED_API_TOKEN: "secret",
      GITHUB_TOKEN: "ghp_secret",
      OPENAI_API_KEY: "sk-secret",
      NODE_OPTIONS: "--require /tmp/hook.js",
      XDG_CONFIG_HOME: "/Users/someone/.config",
    };
    const saved = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    try {
      const app = fixtureApp({ api: 47011 });
      app.runProfile.env = { DATA_DIR: "{tmp}/data", API_URL: "http://127.0.0.1:{port:api}", FIXTURES: "{ds}/apps/fixtures", DROP_ME: "x" };
      app.runProfile.unsetEnv = ["DROP_ME", "LANG"];
      const env = profileEnv(app, { root: "/r", tmp: "/t/run" });

      const allowed = new Set(["PATH", "TERM", "TMPDIR", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "BUN_OPTIONS", "DATA_DIR", "API_URL", "FIXTURES"]);
      expect(Object.keys(env).filter((key) => !allowed.has(key) && !key.startsWith("BUN_INSTALL"))).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH!);
      expect(env.HOME).toBe("/t/run");
      for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(env[key]!.startsWith("/t/run/")).toBe(true);
      expect(env.DATA_DIR).toBe("/t/run/data");
      expect(env.API_URL).toBe("http://127.0.0.1:47011");
      expect(env.FIXTURES).toBe(join(import.meta.dir, "..", "apps/fixtures"));
      expect("LANG" in env).toBe(false);
      // The sandbox denies .env reads; bun must skip them instead of exiting 1 without a word.
      expect(env.BUN_OPTIONS).toBe("--no-env-file");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("readyUrl", () => {
  test.each([
    ["Vite with colors", "  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m46950\u001b[22m/\u001b[39m", "Local:\\s+(http://\\S+)", "http://127.0.0.1:46950", 46950],
    ["bare port", "listening on port 47001\n", "port (\\d+)", "http://127.0.0.1:47001", 47001],
    ["wildcard host and a base path", "ready http://0.0.0.0:47002/app/\n", "ready (\\S+)", "http://127.0.0.1:47002/app", 47002],
  ])("%s", (_, output, pattern, baseUrl, port) => {
    expect(readyUrl(output, pattern)).toEqual({ baseUrl, port });
  });

  test("returns null until the pattern matches", () => {
    expect(readyUrl("vite v7 building...\n", "Local:\\s+(http://\\S+)")).toBeNull();
  });
});

describe("guardVerdict", () => {
  const allowed = new Set([47010, 4820]);
  test.each([
    ["the run's own port", "http://127.0.0.1:47010/src/main.tsx", "ok"],
    ["an owner port, even when allowed", "http://127.0.0.1:4820/api", "owner-port"],
    ["an owner port over websocket", "ws://localhost:4840/", "owner-port"],
    ["a docs-system dev service canvas studio calls", "http://localhost:4803/api/docs", "owner-port"],
    ["a local port the run did not start", "http://127.0.0.1:47099/", "local-port"],
    ["a public host that starts with 127.", "http://127.0.0.1.nip.io:47010/", "external"],
    ["a public host", "https://fonts.googleapis.com/css", "external"],
    ["a data URL", "data:text/plain,hi", "ok"],
  ] as Array<[string, string, ReturnType<typeof guardVerdict>]>)("%s", (_, url, verdict) => {
    expect(guardVerdict(new URL(url), allowed)).toBe(verdict);
  });
});

describe("killRun", () => {
  test("stops a run process that shares the tool's process group without signalling that group", async () => {
    // Children spawned without detached: they share this test process's group. Signalling the group
    // would also kill the sibling and this test runner.
    const target = Bun.spawn(["sleep", "30"]);
    const sibling = Bun.spawn(["sleep", "30"]);
    try {
      await killRun([rootProc(target.pid)], 2_000);
      expect(await target.exited).not.toBe(0);
      expect(sibling.exitCode).toBeNull();
    } finally {
      sibling.kill();
      target.kill();
    }
  });

  test("leaves a process alone whose pid was reused (its start time changed)", async () => {
    const other = Bun.spawn(["sleep", "30"]);
    try {
      await killRun([{ pid: other.pid, started: "Thu Jan  1 00:00:00 1970" }], 1_000);
      expect(other.exitCode).toBeNull();
    } finally {
      other.kill();
    }
  });

  test("stops a descendant seen earlier that left the run's groups, revalidating its start time first", async () => {
    // Detached: its own session and group, like a daemon a run process spawned with setsid.
    const daemon = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const reused = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = new Promise((done) => daemon.once("exit", done));
    try {
      const seen = (pid: number, started: string) => ({ pid, ppid: 1, pgid: pid, started });
      await killRun([], 2_000, [seen(daemon.pid!, rootProc(daemon.pid!).started), seen(reused.pid!, "Thu Jan  1 00:00:00 1970")]);
      await exited;
      expect(daemon.exitCode ?? daemon.signalCode).not.toBeNull();
      expect(reused.exitCode).toBeNull();
      expect(reused.signalCode).toBeNull();
    } finally {
      daemon.kill("SIGKILL");
      reused.kill("SIGKILL");
    }
  });
});

describe("startApp", () => {
  test("serves from the printed URL, runs with the sanitized env, and stop() frees every port the run bound", async () => {
    process.env.GITHUB_TOKEN = "ghp_planted";
    // The server starts in app/ but serves app/web (like docs-workbench: cwd docs-system, Vite root web/).
    const root = makeRoot();
    mkdirSync(join(root, "app/web/src"), { recursive: true });
    writeFileSync(join(root, "app/web/src/main.tsx"), "");
    let running: RunningApp;
    try {
      running = await start(fixtureApp({ ui: 46911, helper: 46912 }, {}, { serveRoot: "app/web" }), root);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    expect(running.baseUrl).toBe("http://127.0.0.1:46911");
    expect(servedFromRoot(running, ["http://127.0.0.1:46911/src/main.tsx?v=1"])).toEqual({ ok: true, outside: [], unresolved: [] });
    expect(await (await fetch(`${running.baseUrl}/ping`)).text()).toBe("pong");
    expect(running.startedPorts).toEqual(expect.arrayContaining([46911, 46912]));

    const childEnv = JSON.parse(readFileSync(join(running.tmp, "env.json"), "utf8"));
    expect(childEnv.HOME).toBe(running.tmp);
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();

    await running.stop();
    expect(await portOpen(46911)).toBe(false);
    expect(await portOpen(46912)).toBe(false); // the helper child went with its group
    expect(existsSync(running.tmp)).toBe(false);
  });

  test("rejects when the start command exits before it is ready, naming the log", async () => {
    const app = fixtureApp({ ui: 46913, helper: 46914 }, {}, { start: "echo boom; exit 3" });
    await expect(startApp(app, { root: makeRoot(), outDir, timeoutMs: 10_000 })).rejects.toThrow(/exited \(code 3\).*see .*\.log/);
  });

  test("refuses a ready URL that is not on one of its profile ports, before contacting it", async () => {
    let hits = 0;
    const other = Bun.serve({ hostname: "127.0.0.1", port: 46939, fetch: () => (hits++, new Response("not the app")) });
    try {
      const app = fixtureApp({ ui: 46913, helper: 46914 }, {}, { start: "echo 'Local: http://127.0.0.1:46939/'; sleep 30" });
      await expect(startApp(app, { root: makeRoot(), outDir, timeoutMs: 10_000 })).rejects.toThrow(/not on one of its profile ports/);
      expect(hits).toBe(0);
    } finally {
      other.stop(true);
    }
  });

  test.each([
    ["an owner port", fixtureApp({ ui: 3998, helper: 46914 }), /owner port/],
    ["an owner port in allowedLocalPorts", fixtureApp({ ui: 46913, helper: 46914 }, {}), /allowedLocalPorts lists owner port 4820/],
    ["a port outside the run range", fixtureApp({ ui: 5000, helper: 46914 }), /outside 46900-47999/],
    ["an unproven profile", fixtureApp({ ui: 46913, helper: 46914 }, {}), /unproven/],
    ["run mode none", fixtureApp({ ui: 46913, helper: 46914 }, {}, { mode: "none", reason: "library only" }), /run mode none \(library only\)/],
    ["an app id that climbs out of the out dir", fixtureApp({ ui: 46913, helper: 46914 }, { id: "../../escape" }), /app id "\.\.\/\.\.\/escape" does not match/],
  ])("refuses %s before it spawns anything", async (name, app, message) => {
    if (name === "an unproven profile") app.runProfile.proof = { status: "unproven", method: "" };
    if (name === "an owner port in allowedLocalPorts") app.runProfile.allowedLocalPorts = [4820];
    const root = makeRoot();
    app.run.start = `touch ${join(root, "spawned")} && bun serve.ts`;
    await expect(startApp(app, { root, outDir })).rejects.toThrow(message);
    expect(existsSync(join(root, "spawned"))).toBe(false);
  });

  test("static mode builds, then serves staticDir with an SPA fallback", async () => {
    const secret = join(mkdtempSync(join(scratch, "outside-")), "owner-data.json");
    writeFileSync(secret, '{"token":"planted"}');
    const app = fixtureApp(
      { http: 46915 },
      {
        commands: {
          cwd: "app",
          build: `mkdir -p dist && printf '<h1>home</h1>' > dist/index.html && printf 'js' > dist/app.js && ln -s '${secret}' dist/data.json`,
        },
      },
      { mode: "static", start: undefined, readyPattern: undefined, staticDir: "app/dist" },
    );
    app.runProfile.env = {};
    const running = await start(app, makeRoot());
    expect(await (await fetch(`${running.baseUrl}/app.js`)).text()).toBe("js");
    // A symlink in the static dir that points outside it is never served.
    expect((await fetch(`${running.baseUrl}/data.json`)).status).toBe(404);
    expect(await (await fetch(`${running.baseUrl}/gallery/item`)).text()).toBe("<h1>home</h1>");
    expect((await fetch(`${running.baseUrl}/missing.js`)).status).toBe(404);
    expect(servedFromRoot(running, running.servedFiles!())).toEqual({ ok: true, outside: [], unresolved: [] });
    await running.stop();
    expect(await portOpen(46915)).toBe(false);
  });

  test("refuses an out dir that resolves into the owner's tree, before it creates or spawns anything", async () => {
    const root = makeRoot();
    const link = join(scratch, `owner-link-${Date.now()}`);
    symlinkSync("/Users/Ford/workspace", link); // only stat'ed: the refusal comes before any write
    const app = fixtureApp({ ui: 46913, helper: 46914 });
    app.run.start = `touch ${join(root, "spawned")} && bun serve.ts`;
    await expect(startApp(app, { root, outDir: join(link, "ds-runner-test-out") })).rejects.toThrow(/owner's tree/);
    expect(existsSync("/Users/Ford/workspace/ds-runner-test-out")).toBe(false);
    expect(existsSync(join(root, "spawned"))).toBe(false);
  });

  test("runs its processes in the OS sandbox: no non-loopback egress, no .env reads, and bun still starts next to a .env", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "app/.env"), "FIXTURE_SECRET=planted\n");
    // TEST-NET-1 (192.0.2.1) is unroutable: the sandbox refuses the connect before a packet leaves.
    const probe = "(cat .env > \"$HOME/dotenv.txt\" 2>&1; /usr/bin/nc -v -z -G 2 192.0.2.1 9 > \"$HOME/nc.txt\" 2>&1)";
    const running = await start(fixtureApp({ ui: 46901, helper: 46902 }, {}, { start: `${probe}; bun serve.ts` }), root);
    expect(running.unsandboxed).toBeUndefined();
    expect(readFileSync(join(running.tmp, "dotenv.txt"), "utf8")).toContain("Operation not permitted");
    expect(readFileSync(join(running.tmp, "nc.txt"), "utf8")).toContain("Operation not permitted");
    expect(JSON.parse(readFileSync(join(running.tmp, "env.json"), "utf8")).FIXTURE_SECRET).toBeUndefined();
  });

  test("records a server-side connection to a loopback port the run does not own as a violation", async () => {
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 46939, fetch: () => new Response("foreign"), idleTimeout: 30 });
    try {
      // A run process that, after the run is ready, holds a connection to 46939 (not an owner port, so the
      // sandbox lets it through: only the egress sampling sees it).
      const app = fixtureApp({ ui: 46903, helper: 46904 }, {}, { start: "(sleep 1; /usr/bin/nc -d 127.0.0.1 46939) & bun serve.ts" });
      const running = await start(app, makeRoot());
      expect(running.violations ?? []).toEqual([]);
      const deadline = Date.now() + 8_000;
      while (!(running.violations ?? []).some((v) => v.includes("->127.0.0.1:46939")) && Date.now() < deadline) await Bun.sleep(100);
      await running.stop();
      expect(running.violations).toEqual([expect.stringMatching(/^egress: nc\(\d+\) TCP 127\.0\.0\.1:\d+->127\.0\.0\.1:46939/)]);
      expect(running.egress!.samples).toBeGreaterThan(0);
      expect(running.egress!.failures).toEqual([]);
    } finally {
      foreign.stop(true);
    }
  });
});

describe("servedFromRoot", () => {
  test("reports served files outside the root (following symlinks) and paths it cannot map", () => {
    const root = makeRoot();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    writeFileSync(join(elsewhere, "tokens.css"), ":root{}");
    mkdirSync(join(root, "app/src"), { recursive: true });
    writeFileSync(join(root, "app/src/main.tsx"), "");
    mkdirSync(join(root, "app/node_modules"), { recursive: true });
    symlinkSync(elsewhere, join(root, "app/node_modules/linked"));
    // Served under a base path, like Vite with `base: "/studio/"`.
    const running = { app: fixtureApp({ ui: 46911 }), root, serveRoot: join(root, "app"), baseUrl: "http://127.0.0.1:46911/studio" } as RunningApp;

    const result = servedFromRoot(running, [
      "http://127.0.0.1:46911/studio/src/main.tsx?t=1",
      "/src/main.tsx",
      join(root, "app/src/main.tsx"),
      "/@vite/client",
      `/@fs${elsewhere}/tokens.css`,
      "http://127.0.0.1:46911/studio/node_modules/linked/tokens.css",
      join(elsewhere, "tokens.css"),
      "http://127.0.0.1:46911/studio/src/gone.tsx",
    ]);
    const outsideFile = join(elsewhere, "tokens.css");
    expect(result.ok).toBe(false);
    expect(result.outside).toEqual([
      `/@fs${outsideFile} -> ${outsideFile}`,
      `http://127.0.0.1:46911/studio/node_modules/linked/tokens.css -> ${outsideFile}`,
      outsideFile,
    ]);
    expect(result.unresolved).toEqual([`http://127.0.0.1:46911/studio/src/gone.tsx -> ${join(root, "app/src/gone.tsx")}`]);
  });
});

const noPlaywright = playwrightUnavailable(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds");
if (noPlaywright) console.warn(`skipping the request-guard test: ${noPlaywright}`);

describe("guardedContext", () => {
  test.skipIf(Boolean(noPlaywright))(
    "aborts and records requests to local ports the run did not start and to non-loopback hosts",
    async () => {
      // 46939 is a live server this test started, not the run: only the guard keeps the page off it.
      // 46938 is a named profile port nothing binds (like a dead kernel URL): blocked, but expected.
      let strayHits = 0;
      const stray = Bun.serve({
        hostname: "127.0.0.1",
        port: 46939,
        fetch: () => (strayHits++, new Response("stray", { headers: { "access-control-allow-origin": "*" } })),
      });
      const running = await start(fixtureApp({ ui: 46916, helper: 46917, deadKernel: 46938 }), makeRoot());
      const { chromium } = loadPlaywright(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds");
      const browser = await chromium.launch({ headless: true });
      try {
        const { context, blocked } = await guardedContext(browser, running);
        const page = await context.newPage();
        await page.goto(`${running.baseUrl}/`);
        const results = await page.evaluate(() => (globalThis as any).results);
        expect(results).toEqual({ own: "ok", helper: "ok", stray: "failed", dead: "failed", external: "failed" });
        expect(strayHits).toBe(0);
        expect(splitBlocked(running, blocked())).toEqual({
          unexpected: ["GET http://127.0.0.1:46939/", "GET http://example.invalid/"],
          expected: ["GET http://127.0.0.1:46938/"],
        });
      } finally {
        await browser.close();
        stray.stop(true);
      }
    },
    30_000,
  );
});

describe("guardedContext and ports the run gave up", () => {
  test.skipIf(Boolean(noPlaywright))(
    "blocks a port the run once held after another process takes it over",
    async () => {
      const running = await start(fixtureApp({ ui: 46905, helper: 46906 }), makeRoot());
      expect(running.startedPorts).toContain(46906);
      // The run's helper exits; an unrelated server (this test) binds its old port.
      for (const pid of Bun.spawnSync(["lsof", "-nP", "-iTCP:46906", "-sTCP:LISTEN", "-t"]).stdout.toString().trim().split("\n").map(Number)) process.kill(pid, "SIGKILL");
      while (await portOpen(46906)) await Bun.sleep(50);
      let hits = 0;
      const squatter = Bun.serve({ hostname: "127.0.0.1", port: 46906, fetch: () => (hits++, new Response("squatter", { headers: { "access-control-allow-origin": "*" } })) });
      const browser = await launchBrowser(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds");
      try {
        await Bun.sleep(700); // past the guard's listener cache
        const { context, blocked } = await guardedContext(browser, running);
        const page = await context.newPage();
        await page.goto(`${running.baseUrl}/ping`);
        const result = await page.evaluate(() => fetch("http://127.0.0.1:46906/").then(() => "ok", () => "failed"));
        expect(result).toBe("failed");
        expect(hits).toBe(0);
        expect(blocked()).toEqual(["GET http://127.0.0.1:46906/"]);
      } finally {
        await browser.close();
        squatter.stop(true);
      }
    },
    30_000,
  );
});

describe("guardedContext determinism", () => {
  test.skipIf(Boolean(noPlaywright))(
    "applies DETERMINISM_CSS on a page whose CSP blocks inline styles (guarded context and Electron's injection)",
    async () => {
      const running = await start(fixtureApp({ ui: 46918, helper: 46919 }), makeRoot());
      const browser = await loadPlaywright(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds").chromium.launch({ headless: true });
      try {
        const transition = async (determinism: boolean) => {
          const { context } = await guardedContext(browser, running, { determinism });
          const page = await context.newPage();
          await page.goto(`${running.baseUrl}/csp`);
          const value = await page.locator("#box").evaluate((element: any) => (globalThis as any).getComputedStyle(element).transitionDuration);
          await context.close();
          return value;
        };
        expect(await transition(false)).toBe("2s"); // the app's own stylesheet loads under its CSP
        expect(await transition(true)).toBe("0s");

        // The Electron path cannot bypass CSP; it adopts a constructed stylesheet instead.
        const plain = await browser.newContext();
        const page = await plain.newPage();
        await page.goto(`${running.baseUrl}/csp`);
        await page.evaluate(adoptStyleSheet, DETERMINISM_CSS);
        expect(await page.locator("#box").evaluate((element: any) => (globalThis as any).getComputedStyle(element).transitionDuration)).toBe("0s");
        await plain.close();
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});

describe("installSignalHandlers", () => {
  test.skipIf(Boolean(noPlaywright))(
    "Ctrl-C in a tool with a browser open stops the app's whole process group before exiting",
    async () => {
      const root = makeRoot();
      const tool = Bun.spawn(["bun", join(import.meta.dir, "fixtures/runner/interrupt.ts"), root, outDir, process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds"], {
        stdout: "pipe",
        stderr: "inherit",
      });
      let output = "";
      const reader = tool.stdout.getReader();
      const deadline = Date.now() + 25_000;
      while (!output.includes("READY") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      const tmp = /READY (\S+)/.exec(output)?.[1];
      expect(tmp).toBeDefined();
      expect(await portOpen(46926)).toBe(true);

      tool.kill("SIGINT");
      expect(await tool.exited).toBe(130);
      expect(await portOpen(46925)).toBe(false);
      expect(await portOpen(46926)).toBe(false);
      expect(existsSync(tmp!)).toBe(false);
    },
    40_000,
  );
});

/** Runs test/fixtures/runner/lifecycle.ts; resolves once it printed READY, with its tmp dir. */
async function lifecycle(mode: string, ports: number[], outDirFor = outDir) {
  const tool = Bun.spawn(["bun", join(import.meta.dir, "fixtures/runner/lifecycle.ts"), mode, makeRoot(), outDirFor, ...ports.map(String)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const reader = tool.stdout.getReader();
  const read = async (until: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (!output.includes(until) && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), Bun.sleep(ms).then(() => ({ value: undefined, done: true }))]);
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    return output;
  };
  await read("READY", 25_000);
  const tmp = /READY (\S+)/.exec(output)?.[1];
  return { tool, tmp, read };
}

async function portsClosed(ports: number[], ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await Promise.all(ports.map(portOpen))).some(Boolean)) return true;
    await Bun.sleep(100);
  }
  return false;
}

describe("a tool that ends without stopping its apps", () => {
  test("process.exit: the exit hook kills the run's processes", async () => {
    const { tool, tmp } = await lifecycle("exit", [46909, 46910]);
    expect(tmp).toBeDefined();
    expect(await tool.exited).toBe(3);
    expect(await portsClosed([46909, 46910])).toBe(true);
  }, 40_000);

  test("an uncaught exception: the handlers stop the apps, then exit 1", async () => {
    const { tool, tmp } = await lifecycle("throw", [46922, 46923]);
    expect(await tool.exited).toBe(1);
    expect(await portsClosed([46922, 46923], 1_000)).toBe(true);
    expect(existsSync(tmp!)).toBe(false);
  }, 40_000);

  test("a signal: a run started during shutdown is refused", async () => {
    const { tool, read } = await lifecycle("restart", [46927, 46928, 46932, 46933]);
    tool.kill("SIGINT");
    expect(await read("REFUSED", 15_000)).toMatch(/REFUSED .*shutting down/);
    expect(await tool.exited).toBe(130);
    expect(await portsClosed([46927, 46928, 46932, 46933], 1_000)).toBe(true);
  }, 40_000);

  test("a signal while the tool's own stop() is in flight: the handler waits for it, nothing is left", async () => {
    const { tool, tmp } = await lifecycle("stop-race", [46934, 46935]);
    expect(tmp).toBeDefined();
    expect(await tool.exited).toBe(130);
    expect(await portsClosed([46934, 46935], 1_000)).toBe(true);
    expect(existsSync(tmp!)).toBe(false);
  }, 40_000);

  test("a signal while startApp waits for the ready line: the spawned server is stopped", async () => {
    const tool = Bun.spawn(["bun", join(import.meta.dir, "fixtures/runner/lifecycle.ts"), "before-ready", makeRoot(), outDir, "46936", "46929"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (!(await portOpen(46936)) && Date.now() < deadline) await Bun.sleep(50);
    expect(await portOpen(46936)).toBe(true);
    tool.kill("SIGINT");
    expect(await tool.exited).toBe(130);
    expect(await portsClosed([46936, 46929], 1_000)).toBe(true);
  }, 40_000);

  test("SIGKILL: the run record lets --cleanup stop exactly the orphans", async () => {
    const records = join(scratch, "cleanup-out");
    const { tool, tmp } = await lifecycle("kill", [46907, 46908], records);
    tool.kill("SIGKILL");
    await tool.exited;
    expect(await portOpen(46907)).toBe(true); // orphaned: no hook ran
    expect(existsSync(join(records, "runs", "lifecycle-fixture.json"))).toBe(true);
    const report = await cleanupRuns(records);
    expect(report).toEqual([expect.stringMatching(/^lifecycle-fixture: stopped (\d+) of \1 leftover process\(es\)/)]);
    expect(await portsClosed([46907, 46908], 2_000)).toBe(true);
    expect(existsSync(join(records, "runs", "lifecycle-fixture.json"))).toBe(false);
    expect(existsSync(tmp!)).toBe(false);
  }, 40_000);
});

describe("launchBrowser", () => {
  test("starts the browser with the sanitized env and a temp HOME it removes afterwards", async () => {
    // A stand-in browser executable that records the environment it got, then fails the launch.
    const dump = join(scratch, "browser-env.txt");
    const fake = join(scratch, "fake-browser");
    writeFileSync(fake, `#!/bin/sh\nenv > '${dump}'\nexit 1\n`, { mode: 0o755 });
    process.env.GITHUB_TOKEN = "ghp_planted";
    try {
      await expect(launchBrowser(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds", { executablePath: fake, timeout: 10_000 })).rejects.toThrow();
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    const env = Object.fromEntries(
      readFileSync(dump, "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HOME).toStartWith(join(realpathSync(tmpdir()), "ds-browser-"));
    expect(env.XDG_CONFIG_HOME).toStartWith(env.HOME);
    expect(existsSync(env.HOME)).toBe(false);
  }, 30_000);
});

const mirror = process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds";
const electronDir = (() => {
  try {
    return dirname(createRequire(join(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds", "system-view/package.json")).resolve("electron/package.json"));
  } catch {
    return null;
  }
})();
if (!electronDir) console.warn("skipping the electron test: electron does not resolve from the mirror's system-view");

describe("startApp electron", () => {
  test.skipIf(Boolean(noPlaywright) || !electronDir)(
    "guards the first window's first load, and stop() ends the app and keeps Playwright's signal handlers out",
    async () => {
      const root = makeRoot();
      mkdirSync(join(root, "app/node_modules"), { recursive: true });
      symlinkSync(electronDir!, join(root, "app/node_modules/electron"));
      // The runner loads Playwright from <root>/codecaine/core/...; link the mirror's copy into this root.
      mkdirSync(join(root, "node_modules"));
      symlinkSync(dirname(createRequire(playwrightAnchor(mirror)).resolve("playwright/package.json")), join(root, "node_modules/playwright"));
      writeFileSync(join(root, "app/package.json"), JSON.stringify({ name: "stand-in", main: "main.js" }));
      writeFileSync(
        join(root, "app/main.js"),
        `const { app, BrowserWindow } = require("electron");
// The main process is inside the OS sandbox: a non-loopback connect (TEST-NET-1) is refused at once.
globalThis.__egress = new Promise((done) => {
  const socket = require("net").connect({ host: "192.0.2.1", port: 9 });
  socket.once("error", (error) => done(error.code));
  socket.once("connect", () => (socket.destroy(), done("connected")));
  setTimeout(() => done("timeout"), 3000);
});
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 320, height: 240, show: false });
  win.loadURL("data:text/html,<title>stand-in</title><script>fetch('http://127.0.0.1:46937/first-load').catch(() => {})</script>");
});
app.on("window-all-closed", () => app.quit());`,
      );
      const app = fixtureApp({}, {}, { mode: "electron", start: undefined, readyPattern: undefined, electron: { build: "true", main: "app/main.js" } });
      app.runProfile.env = {};
      const listeners = () => ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => process.listenerCount(sig as NodeJS.Signals));
      const before = listeners();
      const running = await start(app, root);
      expect(listeners()).toEqual(before);
      const window = await running.electron!.window();
      await window.waitForLoadState("load");
      await window.waitForTimeout(300);
      expect(await window.title()).toBe("stand-in");
      expect(running.blocked!()).toEqual(["GET http://127.0.0.1:46937/first-load"]);
      // Electron ignores $HOME on macOS: every profile path must be in the run's temp dir, never the owner's.
      const paths = await running.electron!.app.evaluate(({ app }: any) =>
        Object.fromEntries(["userData", "sessionData", "logs", "crashDumps", "appData"].map((name) => [name, app.getPath(name)])),
      );
      for (const [name, path] of Object.entries(paths as Record<string, string>)) expect(`${name} ${path}`).toStartWith(`${name} ${running.tmp}/`);
      expect(await running.electron!.app.evaluate(() => process.argv.some((arg: string) => arg.startsWith("--user-data-dir")))).toBe(false);
      expect(await running.electron!.app.evaluate(() => (globalThis as any).__egress)).toBe("EPERM");
      const pid = running.electron!.app.process().pid;
      await running.stop();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(running.tmp)).toBe(false);
    },
    60_000,
  );
});
