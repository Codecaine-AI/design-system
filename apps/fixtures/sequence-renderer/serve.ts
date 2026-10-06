#!/usr/bin/env bun
/**
 * Fixture page for the sequence renderer (a library with no UI of its own).
 *
 *   bun apps/fixtures/sequence-renderer/serve.ts --root <workspace> --tmp <dir> --port <n>
 *
 * Renders the engine's own example programs (loginFlow, combinedFragments, minimal) with
 * `renderSequenceSvgString` into one HTML page each, inline, the way a host embeds them, and
 * serves them from <tmp>/site. The page is the host: it loads the design-system package the sequence
 * package resolves (fonts.css with its fonts/, then tokens.css, copied with the package layout; see
 * ../lib/design-system-package.ts), then any CSS file the sequence package exports, and sets data-theme
 * from `?theme=light|dark`. No font comes from text-measure (decision 20): its files are byte-identical
 * to the package's, so the renderer's measured layout matches what the browser draws.
 *
 * Reads only the root's repo content; writes only under --tmp (see ../lib/fixture-server.ts).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { copyPackageFiles, resolvedPackage } from "../lib/design-system-package";
import { ensureTmpDir, parseFixtureArgs, runFixture, serveSite } from "../lib/fixture-server";

export const SAMPLES = [
  { id: "login-flow", label: "Login flow", exportName: "loginFlow" },
  { id: "combined-fragments", label: "Combined fragments", exportName: "combinedFragments" },
  { id: "minimal", label: "Minimal", exportName: "minimal" },
] as const;

const SEQUENCE_PKG = "codecaine/core/sequence/packages/sequence";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The stylesheet links the host page carries, in load order (fonts, tokens, package CSS). */
export function pageHtml(title: string, stylesheets: string[], body: string): string {
  const links = stylesheets.map((href) => `    <link rel="stylesheet" href="${href}" />`).join("\n");
  return `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <script>
      // ?theme=dark|light picks the design-system theme before first paint.
      var t = new URLSearchParams(location.search).get("theme");
      if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
    </script>
${links}
    <style>
      body { margin: 0; padding: 32px; background: var(--ds-color-surface-page); color: var(--ds-color-text-body); font-family: var(--ds-font-family-sans); }
      h1 { font-size: var(--ds-font-size-ui-lg); font-weight: var(--ds-font-weight-semibold); margin: 0 0 16px; }
      figure { margin: 0 0 32px; }
      figcaption { color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-md); margin-bottom: 8px; }
      a { color: var(--ds-color-link); }
    </style>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

async function main() {
  const args = parseFixtureArgs(process.argv.slice(2));
  const port = args.ports.port;
  if (!port) throw new Error("--port <n> is required");
  const pkgDir = join(args.root, SEQUENCE_PKG);
  if (!existsSync(join(pkgDir, "package.json"))) throw new Error(`no sequence package at ${pkgDir}`);
  const site = ensureTmpDir(args.tmp, join(args.tmp, "sequence-renderer-site"));

  // The host's stylesheets in the contract's order: the package's fonts.css, then tokens.css.
  const stylesheets: string[] = copyPackageFiles(resolvedPackage(pkgDir), site, "design-system", args.tmp);
  // Any stylesheet the sequence package exports. The renderer's var(--seq-*, var(--ds-*, hex)) chain
  // needs none; a package sheet that set --seq-* on the <svg> would override the host's aliases.
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports?: Record<string, unknown> };
  for (const target of Object.values(pkg.exports ?? {})) {
    if (typeof target !== "string" || !target.endsWith(".css")) continue;
    const name = target.replace(/^\.\//, "").replace(/\//g, "__");
    ensureTmpDir(args.tmp, join(site, "sequence"));
    copyFileSync(join(pkgDir, target), join(site, "sequence", name));
    stylesheets.push(`sequence/${name}`);
  }

  const sequence = (await import(join(pkgDir, "src/index.ts"))) as Record<string, any>;
  const links: string[] = [];
  for (const sample of SAMPLES) {
    const document = sequence[sample.exportName];
    if (!document) throw new Error(`@codecaine-ai/sequence exports no ${sample.exportName}`);
    const svg: string = sequence.renderSequenceSvgString(document);
    const body = `    <h1>${escapeHtml(sample.label)}</h1>\n    <figure data-sample="${sample.id}">\n      <figcaption>${escapeHtml(sample.label)}</figcaption>\n      ${svg}\n    </figure>`;
    writeFileSync(join(site, `${sample.id}.html`), pageHtml(`Sequence renderer: ${sample.label}`, stylesheets, body));
    links.push(`      <li><a href="${sample.id}.html">${escapeHtml(sample.label)}</a></li>`);
  }
  writeFileSync(join(site, "index.html"), pageHtml("Sequence renderer fixtures", stylesheets, `    <h1>Sequence renderer fixtures</h1>\n    <ul>\n${links.join("\n")}\n    </ul>`));
  serveSite(site, port, "sequence-renderer");
}

if (import.meta.main) await runFixture("sequence-renderer fixture", main);
