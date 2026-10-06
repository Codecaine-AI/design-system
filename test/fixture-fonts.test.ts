/**
 * Fixture pages load fonts the way an app does (decision 20): the design-system package's fonts.css with
 * its own fonts/, copied in the package layout so every url() in fonts.css resolves to a byte copy of a
 * package font, and nothing from text-measure. The docs-mcp home fixture links that fonts.css only when the
 * page links none of its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { withPackageFonts } from "../apps/fixtures/docs-mcp-home/serve.ts";
import { copyPackageFiles } from "../apps/fixtures/lib/design-system-package.ts";
import { PKG } from "./support.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ds-fixture-fonts-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("copyPackageFiles", () => {
  test("copies fonts.css and tokens.css in the package layout, and every font file fonts.css names resolves to a byte copy", () => {
    const site = join(tmp, "site");
    const hrefs = copyPackageFiles(PKG, site, "design-system", tmp);
    expect(hrefs).toEqual(["design-system/css/fonts.css", "design-system/dist/css/tokens.css"]);
    const css = readFileSync(join(site, "design-system/css/fonts.css"), "utf8");
    expect(css).toBe(readFileSync(join(PKG, "css/fonts.css"), "utf8"));
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const copy = join(site, "design-system/css", url);
      expect(existsSync(copy)).toBe(true);
      expect(readFileSync(copy).equals(readFileSync(join(PKG, "css", url)))).toBe(true);
    }
  });

  test("refuses a site outside the fixture's --tmp", () => {
    expect(() => copyPackageFiles(PKG, join(dirname(tmp), "elsewhere"), "design-system", tmp)).toThrow("outside --tmp");
  });
});

describe("docs-mcp home fixture: withPackageFonts", () => {
  test("links the package's fonts.css first in <head> when the page links none", () => {
    const html = withPackageFonts("<!doctype html><html><head><style>body{font:16px system-ui}</style></head><body></body></html>");
    expect(html).toContain('<head>\n<link rel="stylesheet" href="/@codecaine-ai/design-system/css/fonts.css" /><style>');
  });

  test("leaves a page that links its own fonts.css as it is", () => {
    const page = '<html><head><link rel="stylesheet" href="/assets/fonts.css"></head></html>';
    expect(withPackageFonts(page)).toBe(page);
  });
});
