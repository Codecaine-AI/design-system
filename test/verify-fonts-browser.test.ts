/**
 * verify:apps font checks in Chromium, through checkPage: the check judges the faces the page loaded
 * on its own. Inter declared but used by no text fails (the check never forces it); IBM Plex Mono that
 * no text uses is force-loaded and passes as available, not rendered. Byte copies of the package's
 * fonts pass only when the winning @font-face rule sits in a copy of the package's fonts.css, followed
 * through @import; text-measure's fonts.css loaded last (the sequence-renderer fixture's order) fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_OPTIONS, LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { type Assertion, trackResponses } from "../scripts/lib/verify/assertions.ts";
import { fontSourceJudge } from "../scripts/lib/verify/font-source.ts";
import { checkPage } from "../scripts/lib/verify/page-checks.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";
import { browserSkip, FIXTURES, FONT_DIR, fixtureApp, MIRROR } from "./verify-support.ts";

const PORT = 46964;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TEXT_MEASURE_CSS = join(MIRROR, "codecaine/core/canvas/packages/text-measure/fonts.css");
const DECISION_20 = "the winning @font-face rule is not in the design-system package's fonts.css (decision 20)";
const values = loadBuildValues(DESIGN_SYSTEM_ROOT);

describe.skipIf(Boolean(browserSkip))("font checks in Chromium", () => {
  let scratch: string;
  /** /copy/...: byte copies of the package's fonts.css and font files, and of text-measure's fonts.css, as a build in the run's temp dir holds them. */
  let copies: string;
  let server: ReturnType<typeof Bun.serve>;
  let browser: any;

  beforeAll(async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-fonts-browser-")));
    copies = join(scratch, "copy");
    mkdirSync(join(copies, "design-system/css"), { recursive: true });
    copyFileSync(join(DESIGN_SYSTEM_ROOT, "css/fonts.css"), join(copies, "design-system/css/fonts.css"));
    cpSync(join(DESIGN_SYSTEM_ROOT, "fonts"), join(copies, "design-system/fonts"), { recursive: true });
    if (existsSync(TEXT_MEASURE_CSS)) {
      mkdirSync(join(copies, "text-measure"));
      copyFileSync(TEXT_MEASURE_CSS, join(copies, "text-measure/fonts.css"));
      // text-measure's woff2 files are byte-identical to the package's (decision 20): only the stylesheet differs.
      cpSync(join(DESIGN_SYSTEM_ROOT, "fonts"), join(copies, "text-measure/fonts"), { recursive: true });
    }
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: PORT,
      fetch(request) {
        const { pathname } = new URL(request.url);
        const file = diskPath(pathname);
        return file && existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
      },
    });
    browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  /** /fonts/<file> is the package's fonts/ (FONT_DIR), /copy/<path> the copies, /<page>.html a fixture page. */
  function diskPath(pathname: string): string | null {
    if (pathname.startsWith("/fonts/")) return join(FONT_DIR!, pathname.slice("/fonts/".length));
    if (pathname.startsWith("/copy/")) return join(copies, pathname.slice("/copy/".length));
    if (/^\/fonts-[a-z-]+\.html$/.test(pathname)) return join(FIXTURES, pathname.slice(1));
    return null;
  }

  const fontSource = () =>
    fontSourceJudge({
      packageDirs: [dirname(FONT_DIR!)],
      buildFontsDir: join(DESIGN_SYSTEM_ROOT, "fonts"),
      buildFontsCss: join(DESIGN_SYSTEM_ROOT, "css/fonts.css"),
      copyDirs: [copies],
      diskPath: (url) => (url.startsWith(`${ORIGIN}/`) ? diskPath(new URL(url).pathname) : null),
    });

  /** The font assertions checkPage makes on a fixture page, by id. */
  async function fonts(page: string): Promise<Record<string, Pick<Assertion, "status" | "message">>> {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    try {
      const tab = await context.newPage();
      const responses = trackResponses(tab);
      await tab.goto(`${ORIGIN}/${page}.html`);
      const assertions = await checkPage(tab, { app: fixtureApp({ shell: false }), values, responses, fontSource: fontSource() });
      return Object.fromEntries(assertions.filter((a) => a.id.startsWith("font: ")).map((a) => [a.id, { status: a.status, message: a.message }]));
    } finally {
      await context.close();
    }
  }

  test("declared fonts no text uses: Inter fails (never forced); IBM Plex Mono is forced and passes as available, not rendered", async () => {
    expect(await fonts("fonts-unrendered")).toEqual({
      "font: Inter": { status: "fail", message: expect.stringMatching(/^regular face of Inter: none loaded by the page before the check \(400 normal unloaded\)/) },
      "font: IBM Plex Mono": { status: "pass", message: expect.stringMatching(new RegExp(`^available, not rendered on this route: regular face loaded from ${ORIGIN}/fonts/IBMPlexMono-Regular\\.woff2`)) },
    });
  }, 30_000);

  test("byte copies declared in a copy of the package's fonts.css pass, its rules read through @import", async () => {
    const found = await fonts("fonts-copied-sheet");
    for (const family of ["Inter", "IBM Plex Mono"]) {
      expect(found[`font: ${family}`]).toEqual({ status: "pass", message: expect.stringContaining("declared in the package's fonts.css") });
    }
  }, 30_000);

  test.skipIf(!existsSync(TEXT_MEASURE_CSS))("the same byte copies declared last by text-measure's fonts.css fail", async () => {
    const found = await fonts("fonts-two-sheets");
    for (const family of ["Inter", "IBM Plex Mono"]) {
      expect(found[`font: ${family}`]).toEqual({ status: "fail", message: expect.stringContaining(`${DECISION_20}: it is in ${join(copies, "text-measure/fonts.css")}`) });
    }
  }, 30_000);
});
