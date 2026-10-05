/**
 * verify:apps on a running app: a stand-in server started by the real app runner (not an app). A wired
 * app passes the bound-URL, served-from-root and request checks along with the page checks; a
 * stylesheet served through a symlink out of the root and a request to a port the run did not start
 * both fail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { type Assertion, checkPage } from "../scripts/lib/verify/page-checks.ts";
import { inRunningApp } from "../scripts/lib/verify/run-app.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";
import { browserSkip, FIXTURE_VERIFY, FIXTURES, FONT_DIR, FONT_FILES, fixtureApp, MIRROR } from "./verify-support.ts";

const UI_PORT = 46963;
const STRAY_PORT = 46969;
/** A named profile port the run never binds (like a dead service URL the profile points at). */
const DEAD_PORT = 46968;
const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-run-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A workspace root with the stand-in server and the good fixture page at app/. */
function makeRoot(): string {
  const root = mkdtempSync(join(scratch, "root-"));
  const app = join(root, "app");
  mkdirSync(join(app, "fonts"), { recursive: true });
  cpSync(join(FIXTURES, "serve.ts"), join(app, "serve.ts"));
  cpSync(join(FIXTURES, "good.html"), join(app, "index.html"));
  writeFileSync(join(app, "tokens.css"), readFileSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css")));
  for (const file of FONT_FILES) copyFileSync(join(FONT_DIR!, file), join(app, "fonts", file));
  return root;
}

function runnableApp(path = "/"): AppEntry {
  return fixtureApp({
    // The fixture's own dark-mode button, reached through registry steps.
    verify: { ...FIXTURE_VERIFY, darkSwitch: { kind: "steps", steps: [{ action: "click", target: ".theme-toggle" }] } },
    root: "app",
    commands: { cwd: "app" },
    routes: [{ id: "home", path }],
    run: { mode: "browser", cwd: "app", start: "bun serve.ts", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" },
    runProfile: {
      env: { NO_COLOR: "1", FIXTURE_PORT: "{port:ui}" },
      unsetEnv: [],
      tempHome: true,
      fixtures: [],
      flags: [],
      ports: { ui: UI_PORT, deadService: DEAD_PORT },
      proof: { status: "proven", method: "test fixture" },
    },
  });
}

describe.skipIf(Boolean(browserSkip))("inRunningApp", () => {
  let browser: any;
  beforeAll(async () => {
    browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
  });
  afterAll(async () => {
    await browser?.close();
  });

  const verify = (app: AppEntry, root: string) =>
    inRunningApp(app, { browser, root, outDir: join(scratch, "out") }, (page, ctx) =>
      checkPage(page, { app, values, responses: ctx.responses, prepare: ctx.prepare }),
    );
  const byId = (assertions: Assertion[]) => Object.fromEntries(assertions.map((a) => [a.id, a]));

  test("a wired app passes every assertion, including the bound URL, served files and requests", async () => {
    const report = await verify(runnableApp(), makeRoot());
    expect(report.assertions.filter((a) => a.status !== "pass").map((a) => `${a.id}: ${a.message}`)).toEqual([]);
    const found = byId(report.assertions);
    for (const id of ["bound-url", "served-from-root", "requests", "font: Inter", "sidebar.reload"]) expect([id, found[id]?.status]).toEqual([id, "pass"]);
    expect(report.baseUrl).toBe(`http://127.0.0.1:${UI_PORT}`);
    expect(report.blockedRequests).toEqual([]);
  }, 60_000);

  test("a stylesheet served from outside the root and a request to a port the run did not start fail; a request to an unbound named port is expected-blocked", async () => {
    const root = makeRoot();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    const tokens = join(root, "app/tokens.css");
    writeFileSync(join(elsewhere, "tokens.css"), readFileSync(tokens));
    rmSync(tokens);
    symlinkSync(join(elsewhere, "tokens.css"), tokens);

    const report = await verify(runnableApp(`/?fetch=${STRAY_PORT}&fetch=${DEAD_PORT}`), root);
    const found = byId(report.assertions);
    expect(found["served-from-root"]).toMatchObject({ status: "fail", message: expect.stringContaining(join(elsewhere, "tokens.css")) });
    expect(found.requests).toMatchObject({ status: "fail", message: expect.stringMatching(new RegExp(`127\\.0\\.0\\.1:${STRAY_PORT}.*expected-blocked`)) });
    // The page fetches on every load (the sidebar check reloads it), so the same request is blocked more than once.
    expect([...new Set(report.blockedRequests)]).toEqual([`GET http://127.0.0.1:${STRAY_PORT}/`]);
    expect([...new Set(report.expectedBlocked)]).toEqual([`GET http://127.0.0.1:${DEAD_PORT}/`]);
  }, 60_000);
});
