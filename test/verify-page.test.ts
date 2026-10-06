/**
 * verify:apps page assertions, on static fixture pages in Chromium: a page wired to the tokens passes
 * every check, an unconnected page fails each check for its own reason, dark-first surfaces are judged
 * in dark without a switch, and a missing shell is n/a only at --pass 1. The spec must probe page,
 * panel, text and border; a probe is read only in its themes; theme.switch needs a probe checked in
 * both themes; and a sidebar state other than expanded/collapsed never passes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONTEXT_OPTIONS, LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT, type PassId } from "../scripts/lib/registry.ts";
import { type Assertion, trackResponses } from "../scripts/lib/verify/assertions.ts";
import { checkPage } from "../scripts/lib/verify/page-checks.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";
import { browserSkip, fixtureApp, fixtureFontSource, fixtureResponse, FIXTURE_VERIFY, MIRROR, PROBES } from "./verify-support.ts";

const PORT = 46961;
const values = loadBuildValues(DESIGN_SYSTEM_ROOT);

describe.skipIf(Boolean(browserSkip))("checkPage", () => {
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

  async function check(page: string, app: AppEntry, pass?: PassId): Promise<Assertion[]> {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    try {
      const tab = await context.newPage();
      const responses = trackResponses(tab);
      await tab.goto(`http://127.0.0.1:${PORT}/${page}.html`);
      return await checkPage(tab, { app, values, responses, pass, fontSource: fixtureFontSource() });
    } finally {
      await context.close();
    }
  }

  const byId = (assertions: Assertion[]) => Object.fromEntries(assertions.map((a) => [a.id, a]));

  test("a page wired to tokens.css, web fonts and a persisted shell passes every assertion", async () => {
    const assertions = await check("good", fixtureApp());
    const probeIds = PROBES.flatMap((p) => ["light", "dark"].map((theme) => `token.${theme}: ${p.selector} ${p.property}`));
    expect(Object.keys(byId(assertions)).sort()).toEqual(
      [...probeIds, "verify-spec", "font: Inter", "font: IBM Plex Mono", "theme.switch", "sidebar.stored", "sidebar.reload"].sort(),
    );
    expect(assertions.filter((a) => a.status !== "pass").map((a) => `${a.id}: ${a.message}`)).toEqual([]);
  }, 30_000);

  test("an unconnected page fails each check for its own reason", async () => {
    const found = byId(await check("bad", fixtureApp()));
    const expected: Array<[string, RegExp]> = [
      // Right value, hard-coded: tokens.css is not loaded.
      ["token.light: body background-color", /not defined there/],
      ["token.light: .panel background-color", /computes to rgb\(255, 255, 255\); the build's color\.surface\.panel/],
      // Right value, hard-coded, next to a stale copy of the token.
      ["token.light: .panel border-top-color", /stale tokens\.css/],
      ["token.light: body font-family", /the build's font\.family\.sans/],
      ["font: Inter", /local\(\)|none loaded/],
      ["font: IBM Plex Mono", /no @font-face/],
      ["token.dark: body background-color", /the build's color\.surface\.page \(dark\)/],
      ["theme.switch", /changed none/],
      ["sidebar.stored", /fixture\.sidebar is null/],
      ["sidebar.reload", /after a reload data-sidebar is expanded \(was collapsed\)/],
    ];
    for (const [id, message] of expected) {
      expect([id, found[id]?.status, found[id]?.message]).toEqual([id, "fail", expect.stringMatching(message)]);
    }
  }, 30_000);

  test("a dark-first surface is judged in dark without a switch; a missing shell is n/a only at --pass 1", async () => {
    const app = fixtureApp({ theme: { rule: "dark-first" } });
    const pass1 = byId(await check("dark-first", app, "1"));
    const darkIds = PROBES.map((p) => `token.dark (default): ${p.selector} ${p.property}`);
    for (const id of darkIds) expect([id, pass1[id]?.status]).toEqual([id, "pass"]);
    expect(pass1["theme.switch"]).toBeUndefined();
    expect(pass1.sidebar).toMatchObject({ status: "n/a", message: expect.stringMatching(/pass 1/) });

    const final = byId(await check("dark-first", app));
    expect(final.sidebar).toMatchObject({ status: "fail", message: expect.stringMatching(/no \.ds-shell/) });
  }, 30_000);

  test("a probe limited to light is read only in light; theme.switch needs a probe checked in both themes", async () => {
    const lightOnly = { selector: ".panel", property: "color", token: "color.text.body", themes: ["light" as const] };
    const found = byId(await check("good", fixtureApp({ verify: { ...FIXTURE_VERIFY, probes: [...PROBES, lightOnly] } })));
    expect(found["token.light: .panel color"]?.status).toBe("pass");
    expect(found["token.dark: .panel color"]).toBeUndefined();
    expect(found["theme.switch"]?.status).toBe("pass");

    // Every probe limited to one theme: the page is covered in both themes, but nothing shows the switch works.
    const split = PROBES.slice(0, 4).map((probe, i) => ({ ...probe, themes: [i === 0 ? "dark" : "light"] as Array<"light" | "dark"> }));
    const onlySplit = byId(await check("good", fixtureApp({ verify: { ...FIXTURE_VERIFY, probes: [...split, { ...PROBES[0]!, themes: ["light"] }] } })));
    expect(onlySplit["verify-spec"]).toMatchObject({ status: "fail", message: expect.stringContaining("no page probe checked in both light and dark") });
    expect(onlySplit["theme.switch"]).toMatchObject({ status: "fail", message: "no page, panel, text, border probe is checked in both themes: nothing shows the dark switch works" });
  }, 30_000);

  test("an app that boots dark is read in light through its lightSwitch, and in dark through its darkSwitch", async () => {
    const darkSwitch = { kind: "storage" as const, key: "fixture.theme", value: "dark" };
    const lightSwitch = { kind: "storage" as const, key: "fixture.theme", value: "light" };
    const seeded = await check("boots-dark", fixtureApp({ verify: { ...FIXTURE_VERIFY, darkSwitch, lightSwitch } }));
    expect(seeded.filter((a) => a.status !== "pass").map((a) => `${a.id}: ${a.message}`)).toEqual([]);
    expect(byId(seeded)["theme.switch"]?.status).toBe("pass");

    // Without the seed the light reads are the dark boot.
    const unseeded = byId(await check("boots-dark", fixtureApp({ verify: { ...FIXTURE_VERIFY, darkSwitch } })));
    expect(unseeded["token.light: body background-color"]).toMatchObject({ status: "fail", message: expect.stringContaining("color.surface.page") });
  }, 30_000);

  test("a spec without probes, or without a role, fails verify-spec", async () => {
    const empty = byId(await check("good", fixtureApp({ verify: { ...FIXTURE_VERIFY, probes: [] } })));
    expect(empty["verify-spec"]).toMatchObject({ status: "fail", message: expect.stringContaining("verify.probes is empty") });
    expect(empty["theme.switch"]?.status).toBe("fail");
    const noBorder = byId(await check("good", fixtureApp({ verify: { ...FIXTURE_VERIFY, probes: PROBES.filter((p) => !p.token.startsWith("color.border.")) } })));
    expect(noBorder["verify-spec"]).toMatchObject({ status: "fail", message: expect.stringContaining("verify.probes has no border probe") });
  }, 30_000);

  test("a sidebar toggle that writes and restores \"undefined\" fails", async () => {
    const found = byId(await check("sidebar-undefined", fixtureApp()));
    expect(found.sidebar).toMatchObject({ status: "fail", message: "clicking .ds-sidebar-toggle moved data-sidebar from expanded to undefined, not collapsed" });
    expect(found["sidebar.reload"]).toBeUndefined();
  }, 30_000);
});
