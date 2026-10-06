#!/usr/bin/env bun
/**
 * Fixture server for the docs-mcp home page (the directory page the docs service serves at `/`).
 *
 *   bun apps/fixtures/docs-mcp-home/serve.ts --root <workspace> --tmp <dir> --port <n>
 *
 * Imports `directoryHtml` from the root's docs-mcp (home.ts imports only types, so this has no
 * side effects; supervisor.ts is never imported) and serves it with synthetic projects. The page's
 * own script polls /api/projects, /api/discovery and /api/status; this server answers them from
 * the same fixture data, in memory, so the page renders its settled state. POST /api/discovery
 * starts nothing: it returns the completed fixture scan. The page is written to
 * <tmp>/docs-mcp-home-site/index.html (run.staticDir) and served from there.
 *
 * Fonts: the site also carries the design-system package docs-mcp resolves (its fonts.css with fonts/, and
 * tokens.css, in the package layout under /@codecaine-ai/design-system/; ../lib/design-system-package.ts).
 * When the page links no fonts.css of its own (home.ts today inlines all its CSS), the fixture links the
 * package's fonts.css first in <head>, where the docs service will serve it once pass 1 wires the page.
 * That only declares the faces: the font check still fails until the page's own CSS uses
 * var(--ds-font-family-sans), so it judges the real page, never the fixture.
 *
 * Reads only the root's repo content; writes only under --tmp.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { copyPackageFiles, resolvedPackage } from "../lib/design-system-package";
import { ensureTmpDir, parseFixtureArgs, runFixture, siteFile } from "../lib/fixture-server";

/** Where the site carries the design-system package's files. */
export const PACKAGE_PREFIX = "@codecaine-ai/design-system";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2" };

/** The page with the package's fonts.css linked first in <head>, unless it already links a fonts.css. */
export function withPackageFonts(html: string, href = `/${PACKAGE_PREFIX}/css/fonts.css`): string {
  if (/<link\b[^>]*href="[^"]*fonts\.css"/i.test(html)) return html;
  const link = `<link rel="stylesheet" href="${href}" />`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}\n${link}`) : `${link}\n${html}`;
}

const DOCS_MCP = "codecaine/core/docs-system/packages/docs-mcp";

/** Synthetic projects: names and folders shaped like the workspace's docs corpora. */
export const PROJECTS = [
  { id: "docs-system", name: "docs-system", root: "~/workspace/codecaine/core/docs-system", docsRoot: "~/workspace/codecaine/core/docs-system/docs", products: ["docs"] },
  { id: "canvas", name: "canvas", root: "~/workspace/codecaine/core/canvas", docsRoot: "~/workspace/codecaine/core/canvas/docs", products: ["docs"] },
  { id: "sequence", name: "sequence", root: "~/workspace/codecaine/core/sequence", docsRoot: "~/workspace/codecaine/core/sequence/docs", products: ["docs"] },
  { id: "design-system", name: "design-system", root: "~/workspace/design-system", docsRoot: "~/workspace/design-system/docs", products: ["docs"] },
];
export const SCAN = { phase: "complete", folders: 128, added: PROJECTS.length, skipped: 0, warnings: [] as string[] };
export const STATUS = { ready: true };

async function main() {
  const args = parseFixtureArgs(process.argv.slice(2));
  const port = args.ports.port;
  if (!port) throw new Error("--port <n> is required");
  const pkg = join(args.root, DOCS_MCP);
  if (!existsSync(join(pkg, "src/background/home.ts"))) throw new Error(`no docs-mcp at ${pkg}`);
  const { directoryHtml } = (await import(join(pkg, "src/background/home.ts"))) as { directoryHtml: (p: typeof PROJECTS, v: string) => string };
  const version = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string }).version;
  const json = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
  const site = ensureTmpDir(args.tmp, join(args.tmp, "docs-mcp-home-site"));
  copyPackageFiles(resolvedPackage(pkg), site, PACKAGE_PREFIX, args.tmp);
  writeFileSync(join(site, "index.html"), withPackageFonts(directoryHtml(PROJECTS, version)));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/projects") return json({ projects: PROJECTS });
      if (pathname === "/api/discovery") return json(SCAN);
      if (pathname === "/api/status") return json(STATUS);
      if (request.method !== "GET") return new Response("read-only", { status: 405 });
      const file = siteFile(site, pathname);
      if (!file) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" } });
    },
  });
  console.log(`docs-mcp-home fixture: ${PROJECTS.length} synthetic projects, docs-mcp ${version}`);
  console.log(`  Local:   http://127.0.0.1:${server.port}/`);
  const stop = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) await runFixture("docs-mcp-home fixture", main);
