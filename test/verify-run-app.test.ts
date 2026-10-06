/**
 * verify:apps on a running app: a stand-in server started by the real app runner (not an app). A wired
 * app passes the bound-URL, served-from-root and request checks along with the page checks; a
 * stylesheet served through a symlink out of the root and a request to a port the run did not start
 * both fail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import type { Assertion } from "../scripts/lib/verify/assertions.ts";
import { checkPage } from "../scripts/lib/verify/page-checks.ts";
import { fontDiskPath, fontSourceJudge } from "../scripts/lib/verify/font-source.ts";
import { inRunningApp, isolationAssertions } from "../scripts/lib/verify/run-app.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";
import { browserSkip, MIRROR, makeFixtureRoot, runnableFixtureApp } from "./verify-support.ts";
import { assertNoLeaks } from "./leaks.ts";

const UI_PORT = 46963;
const STRAY_PORT = 46969;
/** A named profile port the run never binds (like a dead service URL the profile points at). */
const DEAD_PORT = 46968;
/** A port the stand-in server binds only when the page asks it to (after the run is ready). */
const LATE_PORT = 46967;
const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-run-")));
afterAll(() => {
  try {
    assertNoLeaks(scratch); // no app this file started may still listen
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const makeRoot = () => makeFixtureRoot(scratch);
const runnableApp = (path = "/") => runnableFixtureApp({ ui: UI_PORT, deadService: DEAD_PORT }, path);

test("a run with an isolation violation, an unproven profile or no OS sandbox fails, whatever the page showed", () => {
  expect(isolationAssertions({})).toEqual([]);
  const found = isolationAssertions({ violations: ["egress: 127.0.0.1:4820 (node 123)"], unproven: true, unsandboxed: true }).map((a) => [a.id, a.status]);
  expect(found).toEqual([
    ["isolation", "fail"],
    ["isolation.profile", "fail"],
    ["isolation.sandbox", "fail"],
  ]);
});

describe.skipIf(Boolean(browserSkip))("inRunningApp", () => {
  let browser: any;
  beforeAll(async () => {
    browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
  });
  afterAll(async () => {
    await browser?.close();
  });

  // The fixture app serves byte copies of the package's fonts and fonts.css from its own folder (like consume.via copy).
  const verify = (app: AppEntry, root: string) =>
    inRunningApp(app, { browser, root, outDir: join(scratch, "out") }, (page, ctx) =>
      checkPage(page, {
        app,
        values,
        responses: ctx.responses,
        prepare: ctx.prepare,
        fontSource: fontSourceJudge({
          packageDirs: [],
          buildFontsDir: join(DESIGN_SYSTEM_ROOT, "fonts"),
          buildFontsCss: join(DESIGN_SYSTEM_ROOT, "css/fonts.css"),
          copyDirs: [root],
          diskPath: (url) => fontDiskPath(ctx.running, url),
        }),
      }),
    );
  const byId = (assertions: Assertion[]) => Object.fromEntries(assertions.map((a) => [a.id, a]));

  test("a wired app passes every assertion, including the bound URL, served files and requests", async () => {
    const report = await verify(runnableApp(), makeRoot());
    expect(report.assertions.filter((a) => a.status !== "pass").map((a) => `${a.id}: ${a.message}`)).toEqual([]);
    const found = byId(report.assertions);
    for (const id of ["bound-url", "served-from-root", "requests", "font: Inter", "sidebar.reload"]) expect([id, found[id]?.status]).toEqual([id, "pass"]);
    expect(report.baseUrl).toBe(`http://127.0.0.1:${UI_PORT}`);
    expect(report.blockedRequests).toEqual([]);
    expect(report.clock).toBe("fixed");
  }, 60_000);

  test("a verify route whose waitFor appears only after its steps: steps first, then waitFor (capture's order)", async () => {
    const app = runnableApp();
    app.routes = [{ id: "home", path: "/", steps: [{ action: "click", target: ".reveal" }], waitFor: ".revealed" }];
    const report = await verify(app, makeRoot());
    expect(report.assertions.filter((a) => a.status !== "pass").map((a) => `${a.id}: ${a.message}`)).toEqual([]);
  }, 60_000);

  test("a port the app binds after it is ready is read again before the report: it shows in startedPorts", async () => {
    const report = await verify(runnableApp(`/?bind=${LATE_PORT}`), makeRoot());
    expect(report.startedPorts).toContain(LATE_PORT);
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
