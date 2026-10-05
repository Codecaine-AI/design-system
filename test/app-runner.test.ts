/**
 * The app runner's contract with snapshot and verify:apps: a run sees only a sanitized environment,
 * binds only safe ports, is reachable at the URL its server printed, and stop() leaves nothing running.
 *
 * Runs use test/fixtures/runner/serve.ts (a stand-in server, not an app) on ports 46900-46999.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardedContext, profileEnv, readyUrl, servedFromRoot, startApp, type RunningApp } from "../scripts/lib/app-runner.ts";
import { loadPlaywright, playwrightUnavailable } from "../scripts/lib/playwright.ts";
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
        FIXTURE_STRAY_PORT: "46998",
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

      const allowed = new Set(["PATH", "TERM", "TMPDIR", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "DATA_DIR", "API_URL", "FIXTURES"]);
      expect(Object.keys(env).filter((key) => !allowed.has(key) && !key.startsWith("BUN_INSTALL"))).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH!);
      expect(env.HOME).toBe("/t/run");
      for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(env[key]!.startsWith("/t/run/")).toBe(true);
      expect(env.DATA_DIR).toBe("/t/run/data");
      expect(env.API_URL).toBe("http://127.0.0.1:47011");
      expect(env.FIXTURES).toBe(join(import.meta.dir, "..", "apps/fixtures"));
      expect("LANG" in env).toBe(false);
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

describe("startApp", () => {
  test("serves from the printed URL, runs with the sanitized env, and stop() frees every port the run bound", async () => {
    process.env.GITHUB_TOKEN = "ghp_planted";
    let running: RunningApp;
    try {
      running = await start(fixtureApp({ ui: 46911, helper: 46912 }), makeRoot());
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    expect(running.baseUrl).toBe("http://127.0.0.1:46911");
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

  test.each([
    ["an owner port", fixtureApp({ ui: 3998, helper: 46914 }), /owner port/],
    ["a port outside the run range", fixtureApp({ ui: 5000, helper: 46914 }), /outside 46900-47999/],
    ["an unproven profile", fixtureApp({ ui: 46913, helper: 46914 }, {}), /unproven/],
    ["run mode none", fixtureApp({ ui: 46913, helper: 46914 }, {}, { mode: "none", reason: "library only" }), /run mode none \(library only\)/],
  ])("refuses %s before it spawns anything", async (name, app, message) => {
    if (name === "an unproven profile") app.runProfile.proof = { status: "unproven", method: "" };
    const root = makeRoot();
    app.run.start = `touch ${join(root, "spawned")} && bun serve.ts`;
    await expect(startApp(app, { root, outDir })).rejects.toThrow(message);
    expect(existsSync(join(root, "spawned"))).toBe(false);
  });

  test("static mode builds, then serves staticDir with an SPA fallback", async () => {
    const app = fixtureApp(
      { http: 46915 },
      { commands: { cwd: "app", build: "mkdir -p dist && printf '<h1>home</h1>' > dist/index.html && printf 'js' > dist/app.js" } },
      { mode: "static", start: undefined, readyPattern: undefined, staticDir: "app/dist" },
    );
    app.runProfile.env = {};
    const running = await start(app, makeRoot());
    expect(await (await fetch(`${running.baseUrl}/app.js`)).text()).toBe("js");
    expect(await (await fetch(`${running.baseUrl}/gallery/item`)).text()).toBe("<h1>home</h1>");
    expect((await fetch(`${running.baseUrl}/missing.js`)).status).toBe(404);
    expect(servedFromRoot(running, running.servedFiles!())).toEqual({ ok: true, outside: [] });
    await running.stop();
    expect(await portOpen(46915)).toBe(false);
  });
});

describe("servedFromRoot", () => {
  test("reports served files that resolve outside the root, following symlinks", () => {
    const root = makeRoot();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    writeFileSync(join(elsewhere, "tokens.css"), ":root{}");
    mkdirSync(join(root, "app/src"), { recursive: true });
    writeFileSync(join(root, "app/src/main.tsx"), "");
    mkdirSync(join(root, "app/node_modules"), { recursive: true });
    symlinkSync(elsewhere, join(root, "app/node_modules/linked"));
    const running = { app: fixtureApp({ ui: 46911 }), root, serveRoot: join(root, "app") } as RunningApp;

    const result = servedFromRoot(running, [
      "http://127.0.0.1:46911/src/main.tsx?t=1",
      "/src/main.tsx",
      join(root, "app/src/main.tsx"),
      "/@vite/client",
      `/@fs${elsewhere}/tokens.css`,
      "http://127.0.0.1:46911/node_modules/linked/tokens.css",
      join(elsewhere, "tokens.css"),
    ]);
    const outsideFile = join(elsewhere, "tokens.css");
    expect(result.ok).toBe(false);
    expect(result.outside).toEqual([
      `/@fs${outsideFile} -> ${outsideFile}`,
      `http://127.0.0.1:46911/node_modules/linked/tokens.css -> ${outsideFile}`,
      outsideFile,
    ]);
  });
});

const noPlaywright = playwrightUnavailable(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds");
if (noPlaywright) console.warn(`skipping the request-guard test: ${noPlaywright}`);

describe("guardedContext", () => {
  test.skipIf(Boolean(noPlaywright))(
    "aborts and records requests to local ports the run did not start and to non-loopback hosts",
    async () => {
      const running = await start(fixtureApp({ ui: 46916, helper: 46917 }), makeRoot());
      const { chromium } = loadPlaywright(process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds");
      const browser = await chromium.launch({ headless: true });
      try {
        const { context, blocked } = await guardedContext(browser, running);
        const page = await context.newPage();
        await page.goto(`${running.baseUrl}/`);
        const results = await page.evaluate(() => (window as any).results);
        expect(results).toEqual({ own: "ok", helper: "ok", stray: "failed", external: "failed" });
        expect(blocked().sort()).toEqual(["GET http://127.0.0.1:46998/", "GET http://example.invalid/"]);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
