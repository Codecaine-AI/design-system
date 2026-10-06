/**
 * Fixture pages load fonts the way an app does (decision 20): the design-system package's fonts.css with
 * its own fonts/, copied in the package layout so every url() in fonts.css resolves to a byte copy of a
 * package font, and nothing from text-measure. The docs-mcp home fixture never adds a font to the page: it
 * serves the page as rendered and the resolved package at /@codecaine-ai/design-system/<package path>.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

describe("docs-mcp home fixture (decision 30)", () => {
  /** A stand-in docs-mcp whose directoryHtml inlines its CSS and links no fonts.css, like home.ts today. */
  const PAGE = (version: string, n: number) => `<!doctype html><html><head><style>body{font:16px system-ui}</style></head><body><h1>docs ${version}: ${n}</h1></body></html>`;
  const port = 46946;
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  afterAll(async () => {
    server?.kill("SIGTERM");
    await server?.exited;
  });

  test("serves the page exactly as rendered (no font, link or style added) and the resolved package at /@codecaine-ai/design-system/<package path>", async () => {
    const root = join(tmp, "workspace");
    const docsMcp = join(root, "codecaine/core/docs-system/packages/docs-mcp");
    mkdirSync(join(docsMcp, "src/background"), { recursive: true });
    writeFileSync(
      join(docsMcp, "src/background/home.ts"),
      "export const directoryHtml = (projects: unknown[], version: string) =>\n" +
        "  `<!doctype html><html><head><style>body{font:16px system-ui}</style></head><body><h1>docs ${version}: ${projects.length}</h1></body></html>`;\n",
    );
    writeFileSync(join(docsMcp, "package.json"), '{ "name": "docs-mcp", "version": "9.9.9" }\n');
    mkdirSync(join(root, "codecaine/core/node_modules/@codecaine-ai"), { recursive: true });
    symlinkSync(PKG, join(root, "codecaine/core/node_modules/@codecaine-ai/design-system"));
    const site = join(tmp, "run");
    mkdirSync(site);
    server = Bun.spawn([process.execPath, "--no-env-file", "apps/fixtures/docs-mcp-home/serve.ts", "--root", root, "--tmp", site, "--port", String(port)], { cwd: PKG, stdout: "pipe", stderr: "inherit" });
    const reader = server.stdout.getReader();
    let printed = "";
    while (!printed.includes("Local:")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the fixture exited: ${printed}`);
      printed += new TextDecoder().decode(value);
    }
    reader.releaseLock();

    expect(await (await get("/")).text()).toBe(PAGE("9.9.9", 4));
    const font = readdirSync(join(PKG, "fonts")).find((name) => name.endsWith(".woff2"))!;
    for (const rel of ["package.json", "css/fonts.css", "dist/css/tokens.css", "dist/css/tokens-dark-first.css", `fonts/${font}`]) {
      const response = await get(`/@codecaine-ai/design-system/${rel}`);
      expect({ rel, status: response.status }).toEqual({ rel, status: 200 });
      expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(PKG, rel)))).toBe(true);
    }
    expect((await get("/@codecaine-ai/design-system/apps.json")).status).toBe(404);
  }, 30_000);
});
