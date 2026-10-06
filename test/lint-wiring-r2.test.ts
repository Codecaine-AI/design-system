/**
 * lint:apps wiring, round 2: fonts from the design-system package only (N1), Tailwind v4 order
 * judged per compilation root (N2), stylesheets that never apply (N7), and conditional loads
 * next to unconditional ones (N13). Fixture apps: test/fixtures/lint/workspace/apps/r2w-*.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDesignSystem, type DesignSystemBuild } from "../scripts/lib/lint/design-system";
import type { Finding } from "../scripts/lib/lint/types";
import type { AppEntry } from "../scripts/lib/registry";
import { appEntry, checkEntry, materialize, type Workspace } from "./lint-support";

let ws: Workspace;
let ds: DesignSystemBuild;

beforeAll(() => {
  ws = materialize();
  ds = loadDesignSystem();
  // @codecaine-ai/text-measure's fonts.css, installed for one app (node_modules is not in git).
  const tm = join(ws.root, "apps/r2w-tm-fonts/node_modules/@codecaine-ai/text-measure");
  mkdirSync(tm, { recursive: true });
  writeFileSync(join(tm, "package.json"), JSON.stringify({ name: "@codecaine-ai/text-measure", exports: { "./fonts.css": "./fonts.css" } }));
  writeFileSync(join(tm, "fonts.css"), '@font-face { font-family: "Inter"; src: url("./fonts/Inter-Regular.woff2"); }\n');
});
afterAll(() => ws?.cleanup());

const at = (file: string, line: number, message: string) => ({ file, line, message: expect.stringContaining(message) });
function expectExactly(findings: Finding[], expected: Array<ReturnType<typeof at>>) {
  expect(findings).toHaveLength(expected.length);
  for (const e of expected) expect(findings).toContainEqual(e);
}

const NO_TAILWIND = { summary: "plain CSS (fixture)", tailwind: "none", packageManager: "bun" } as AppEntry["stack"];
const wiring = (input: Parameters<typeof appEntry>[0]) => checkEntry(ws, ds, appEntry(input), "wiring");
/** Wiring of one entry file in a fixture app dir (an HTML page or a CSS file). */
const entryWiring = (root: string, file: string, extra: Partial<Parameters<typeof appEntry>[0]> = {}) =>
  wiring({ id: `${root.split("/").pop()}-${file}`, root, scan: { paths: [root], exclude: [] }, entryStylesheet: `${root}/${file}`, ...extra });

describe("N1: fonts load from the design-system package only (decision 20)", () => {
  test("text-measure's fonts.css does not count as the fonts: one violation at its line", () => {
    expectExactly(wiring({ id: "r2w-tm-fonts", root: "apps/r2w-tm-fonts" }).violations, [
      at(
        "apps/r2w-tm-fonts/src/main.tsx",
        1,
        "@codecaine-ai/text-measure/fonts.css does not count as the fonts: load @codecaine-ai/design-system/fonts.css (decision 20)",
      ),
    ]);
  });

  test("an app that loads no fonts is told to load the design system's fonts.css (decision 20)", () => {
    const { violations } = wiring({ id: "r2w-no-fonts", root: "apps/fake-loads", entryStylesheet: "apps/fake-loads/src/url-entry.tsx" });
    expectExactly(violations, [at("apps/fake-loads/src/url-entry.tsx", 1, "load @codecaine-ai/design-system/fonts.css (decision 20)")]);
  });
});

describe("N2: Tailwind v4 order per compilation root", () => {
  const R = "apps/r2w-tw-parts";

  test("tailwindcss, strict and tailwind.css imported from JS as separate stylesheets fail", () => {
    expectExactly(wiring({ id: "r2w-split-roots", root: "apps/r2w-split-roots" }).violations, [
      at(
        "apps/r2w-split-roots/src/tw.css",
        1,
        "tailwindcss, tailwind-strict.css and tailwind.css are compiled as separate stylesheets (apps/r2w-split-roots/src/tw.css:1, apps/r2w-split-roots/src/main.tsx:4, apps/r2w-split-roots/src/main.tsx:5); @import all three, in that order, in one stylesheet",
      ),
    ]);
  });

  test("two <style> blocks on a page are two stylesheets", () => {
    expectExactly(entryWiring(R, "index.html").violations, [at(`${R}/index.html`, 6, "are compiled as separate stylesheets")]);
  });

  test("Tailwind's preflight, strict, then Tailwind's theme.css restores the default theme", () => {
    expectExactly(entryWiring(R, "src/parts.css").violations, [
      at(`${R}/src/parts.css`, 4, 'tailwind-strict.css loads before "tailwindcss/theme.css" (apps/r2w-tw-parts/src/parts.css:5)'),
    ]);
  });

  test("tailwindcss/theme after strict restores the default theme, even with tailwindcss before strict", () => {
    expectExactly(entryWiring(R, "src/restored.css").violations, [
      at(`${R}/src/restored.css`, 5, '"tailwindcss/theme" loads after tailwind-strict.css (apps/r2w-tw-parts/src/restored.css:4); it restores Tailwind\'s default theme'),
    ]);
  });

  test("a second stylesheet that imports tailwindcss without strict and tailwind.css after it fails", () => {
    expectExactly(entryWiring(R, "src/second-root.tsx").violations, [
      at(`${R}/src/widget.css`, 1, '"tailwindcss" starts its own Tailwind compilation (apps/r2w-tw-parts/src/widget.css)'),
    ]);
  });

  test("the connected app (fonts from JS, the rest in one stylesheet) still passes", () => {
    expect(wiring({ id: "r2w-connected", root: "apps/connected" })).toMatchObject({ status: "pass", violations: [] });
  });
});

describe("N7: stylesheets that never apply do not count", () => {
  const H = "apps/r2w-html";
  const page = (file: string) => entryWiring(H, file, { stack: NO_TAILWIND }).violations;

  test("rel=\"alternate stylesheet\" and a disabled <link> load nothing", () => {
    expectExactly(page("alternate.html"), [
      at(`${H}/alternate.html`, 1, "does not load fonts.css"),
      at(`${H}/alternate.html`, 1, "does not load @codecaine-ai/design-system/tokens.css"),
    ]);
  });

  test("<style media=\"print\"> passes its media condition to its @imports", () => {
    expectExactly(page("style-print.html"), [
      at(`${H}/style-print.html`, 5, 'css/fonts.css loads only under "print"'),
      at(`${H}/style-print.html`, 6, 'dist/css/tokens.css loads only under "print"'),
      at(`${H}/style-print.html`, 7, 'css/layout.css loads only under "print"'),
      at(`${H}/style-print.html`, 1, "does not load fonts.css"),
      at(`${H}/style-print.html`, 1, "does not load @codecaine-ai/design-system/tokens.css"),
      at(`${H}/style-print.html`, 1, "shell app does not load @codecaine-ai/design-system/layout.css"),
    ]);
  });

  test("nothing inside <noscript> or <template> loads", () => {
    expectExactly(page("noscript.html"), [
      at(`${H}/noscript.html`, 1, "does not load fonts.css"),
      at(`${H}/noscript.html`, 1, "does not load @codecaine-ai/design-system/tokens.css"),
      at(`${H}/noscript.html`, 1, "shell app does not load @codecaine-ai/design-system/layout.css"),
    ]);
  });

  const C = "apps/r2w-css";
  test("an @import after a style rule is ignored in plain CSS: move it above the first rule", () => {
    expectExactly(entryWiring(C, "late-plain.css", { stack: NO_TAILWIND }).violations, [
      at(`${C}/late-plain.css`, 4, "@codecaine-ai/design-system/fonts.css comes after a rule, so it is ignored; move the @import above the first rule"),
      at(`${C}/late-plain.css`, 5, "@codecaine-ai/design-system/tokens.css comes after a rule"),
      at(`${C}/late-plain.css`, 6, "@codecaine-ai/design-system/layout.css comes after a rule"),
      at(`${C}/late-plain.css`, 1, "does not load fonts.css"),
      at(`${C}/late-plain.css`, 1, "does not load @codecaine-ai/design-system/tokens.css"),
      at(`${C}/late-plain.css`, 1, "shell app does not load @codecaine-ai/design-system/layout.css"),
    ]);
  });

  test("a block @layer ends the import prelude too", () => {
    expectExactly(entryWiring(C, "layer-block.css", { stack: NO_TAILWIND }).violations, [
      at(`${C}/layer-block.css`, 5, "@codecaine-ai/design-system/tokens.css comes after a rule"),
      at(`${C}/layer-block.css`, 6, "@codecaine-ai/design-system/layout.css comes after a rule"),
      at(`${C}/layer-block.css`, 1, "does not load @codecaine-ai/design-system/tokens.css"),
      at(`${C}/layer-block.css`, 1, "shell app does not load @codecaine-ai/design-system/layout.css"),
    ]);
  });

  test("@charset, comments, @layer statements and other @imports do not end the prelude", () => {
    expect(entryWiring(C, "prelude.css", { stack: NO_TAILWIND })).toMatchObject({ status: "pass", violations: [] });
  });

  test("Tailwind inlines every @import in a stylesheet that imports it, late ones included", () => {
    expect(entryWiring(C, "late-tailwind.css")).toMatchObject({ status: "pass", violations: [] });
    expect(entryWiring(C, "late-nested.css")).toMatchObject({ status: "pass", violations: [] });
  });

  test("Tailwind leaves a late @import url(…) where it is, so it is still ignored", () => {
    expectExactly(entryWiring(C, "late-url.css").violations, [
      at(`${C}/late-url.css`, 7, "@codecaine-ai/design-system/layout.css comes after a rule"),
      at(`${C}/late-url.css`, 1, "shell app does not load @codecaine-ai/design-system/layout.css"),
    ]);
  });
});

describe("N13: a conditional load fails only without an unconditional one of its kind", () => {
  const C = "apps/r2w-css";
  const H = "apps/r2w-html";

  test("a print-only sheet that re-imports the tokens next to the full wiring passes", () => {
    expect(entryWiring(C, "print-extra.css")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a media list with screen or all in it applies to every view", () => {
    expect(entryWiring(C, "screen-print.css")).toMatchObject({ status: "pass", violations: [] });
  });

  test("<link media=\"print\" onload=\"this.media='all'\"> (the async pattern) applies to every view", () => {
    expect(entryWiring(H, "async.html", { stack: NO_TAILWIND })).toMatchObject({ status: "pass", violations: [] });
  });

  test("a <link media=\"print\"> that is the only fonts load still fails", () => {
    expectExactly(entryWiring(H, "print-link.html", { stack: NO_TAILWIND }).violations, [
      at(`${H}/styles/print.css`, 1, '@codecaine-ai/design-system/fonts.css loads only under "print"'),
      at(`${H}/print-link.html`, 1, "does not load fonts.css"),
    ]);
  });
});
