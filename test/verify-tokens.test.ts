/**
 * verify:apps compares an element with the current build's token value. The expected side comes from
 * dist/json/<theme>.json and is computed by the browser; this proves that path agrees with the CSS
 * the build ships, and pins how two computed values are judged equal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONTEXT_OPTIONS, LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { readProbes } from "../scripts/lib/verify/page-checks.ts";
import { buildValue, loadBuildValues, sameComputedValue, type Theme } from "../scripts/lib/verify/tokens.ts";
import { browserSkip, fixtureResponse, MIRROR } from "./verify-support.ts";

const values = loadBuildValues(DESIGN_SYSTEM_ROOT);

describe("sameComputedValue", () => {
  test.each([
    ["the same color in Chrome's two serializations", "rgb(255, 0, 255)", "color(srgb 1 0 1)", true],
    ["a color-mix float within half an 8-bit step of the hex", "rgb(242, 242, 241)", "color(srgb 0.9505 0.9505 0.9445)", true],
    ["a one-step difference", "rgb(253, 253, 253)", "rgb(252, 253, 253)", false],
    ["different alpha", "rgba(42, 42, 42, 0.84)", "rgb(42, 42, 42)", false],
    ["two fully transparent colors", "rgba(0, 0, 0, 0)", "color(srgb 1 1 1 / 0)", true],
    ["font stacks compared as text", 'Inter, ui-sans-serif, system-ui, sans-serif', "Inter, ui-sans-serif, system-ui, sans-serif", true],
    ["a different font stack", "Times", "Inter, ui-sans-serif, system-ui, sans-serif", false],
  ])("%s", (_, actual, expected, same) => {
    expect(sameComputedValue(actual, expected)).toBe(same);
  });
});

test("buildValue rejects a token the build does not have, so a mistyped probe cannot pass", () => {
  expect(() => buildValue(values, "color.surface.pgae", "light")).toThrow(/not in the current build/);
  expect(buildValue(values, "font.family.sans", "dark")).toBe(values.base["font.family.sans"]);
});

describe.skipIf(Boolean(browserSkip))("in Chromium, with the build's tokens.css", () => {
  const PORT = 46960;
  let server: ReturnType<typeof Bun.serve>;
  let browser: any;

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: PORT,
      fetch: (request) =>
        new URL(request.url).pathname === "/themes.html"
          ? new Response(`<!doctype html><link rel="stylesheet" href="/tokens.css"><div id="light" data-theme="light"></div><div id="dark" data-theme="dark"></div>`, {
              headers: { "content-type": "text/html" },
            })
          : fixtureResponse(new URL(request.url).pathname),
    });
    browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("every theme token's dist/json value computes to what var(--ds-*) computes to in that theme", async () => {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/themes.html`);
      const mismatches: string[] = [];
      for (const theme of ["light", "dark"] as Theme[]) {
        const probes = Object.keys(values.theme[theme]).map((token) => ({
          selector: `#${theme}`,
          property: token.startsWith("shadow.") ? "box-shadow" : "background-color",
          token,
        }));
        expect(probes.length).toBeGreaterThan(100);
        for (const r of await readProbes(page, probes, values, theme)) {
          if (!r.tokenDefined || !sameComputedValue(r.tokenVar!, r.build!)) mismatches.push(`${theme} ${r.token}: var ${r.tokenVar} vs json ${r.build}`);
        }
      }
      expect(mismatches).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
