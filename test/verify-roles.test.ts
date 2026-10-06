/**
 * theme.switch judges every chrome role checked in both themes on its own: a dark switch that reaches the
 * page and its text but leaves the panel and its border light fails, and a role with no probe checked in
 * both themes leaves the switch unchecked for that role. Chromium on a static fixture page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONTEXT_OPTIONS, LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { type Assertion, trackResponses } from "../scripts/lib/verify/assertions.ts";
import { checkPage } from "../scripts/lib/verify/page-checks.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";
import { browserSkip, fixtureApp, fixtureFontSource, fixtureResponse, FIXTURE_VERIFY, MIRROR, PROBES } from "./verify-support.ts";

const PORT = 46971;
const values = loadBuildValues(DESIGN_SYSTEM_ROOT);

describe.skipIf(Boolean(browserSkip))("theme.switch per role", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: any;

  beforeAll(async () => {
    server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: (request) => fixtureResponse(new URL(request.url).pathname) });
    browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function themeSwitch(app: AppEntry): Promise<Assertion | undefined> {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    try {
      const tab = await context.newPage();
      const responses = trackResponses(tab);
      await tab.goto(`http://127.0.0.1:${PORT}/roles-partial-dark.html`);
      const assertions = await checkPage(tab, { app, values, responses, pass: "1", fontSource: fixtureFontSource() });
      return assertions.find((a) => a.id === "theme.switch");
    } finally {
      await context.close();
    }
  }

  test("a dark switch that changes the page and text but not the panel and its border fails", async () => {
    const found = await themeSwitch(fixtureApp({ shell: false }));
    expect(found).toMatchObject({
      status: "fail",
      message:
        "the attribute switch changed none of the 1 panel probe(s) whose token differs in dark; " +
        "the attribute switch changed none of the 1 border probe(s) whose token differs in dark",
      detail: { roles: { page: { changed: 1, candidates: 1 }, panel: { changed: 0, candidates: 1 }, text: { changed: 1, candidates: 1 }, border: { changed: 0, candidates: 1 } } },
    });
  }, 30_000);

  test("a role whose probes are each limited to one theme leaves the switch unchecked for that role", async () => {
    // Panel and border waived in dark (theme.switch skips them); the border is probed in light and in dark, never both.
    const [page, panel, text, border] = PROBES;
    const verify = {
      ...FIXTURE_VERIFY,
      probes: [page!, { ...panel!, themes: ["light" as const] }, text!, { ...border!, themes: ["light" as const] }, { ...border!, selector: "body", themes: ["dark" as const] }],
      waivedRoles: [{ role: "panel" as const, themes: ["dark" as const], reason: "the panel region is pinned to light" }],
    };
    const found = await themeSwitch(fixtureApp({ shell: false, verify }));
    expect(found).toMatchObject({
      status: "fail",
      message: "no border probe checked in both themes has a token that differs in dark: the switch is unchecked for border",
      detail: { roles: { page: { changed: 1, candidates: 1 }, text: { changed: 1, candidates: 1 }, border: { changed: 0, candidates: 0 } } },
    });
  }, 30_000);
});
