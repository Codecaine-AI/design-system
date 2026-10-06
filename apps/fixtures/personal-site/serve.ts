#!/usr/bin/env bun
/**
 * Run-profile fixture for personal-site: its content pages on Vite's dev server, without the
 * app's vite.config.ts.
 *
 *   bun --no-env-file apps/fixtures/personal-site/serve.ts --root <workspace> --tmp <dir> --port <n>
 *
 * The app's config cannot load in a run: at load it regenerates blog/, public/blog/, the sitemap,
 * robots.txt, legacy-redirects.json and the tracked public/resume/ford-lascari-resume.md in the
 * checkout, and its dev server mounts a page editor that writes HTML files, a draft proxy to the
 * owner's docs service on :4820 and two feedback endpoints that write JSON files. So this starts
 * Vite through its JS API (resolved from the app's own node_modules) with `configFile: false`,
 * the app checkout as root, and only the app's plugins that neither write nor proxy:
 *
 *   sitePages (scripts/site-pages.mjs)      composes header, footer, sidebar and theme script into
 *                                           every page; reads only
 *   resume content (scripts/resume-pages.mjs) the plugin's own transform (line 42) rebuilt from its
 *                                           pure exports readResume and resumeContent; the plugin
 *                                           itself is not used, its configResolved writes the
 *                                           resume markdown into public/resume (lines 26-35)
 *   inlineLandingLoader                     reads only; touches only the landing (id="scene-root")
 *   externalLinks                           rewrites external anchors; reads only (its write
 *                                           branch runs only as a CLI, line 61)
 *   @tailwindcss/vite                       no file writes; a no-op on the content pages' CSS
 *
 * Left out: devContentEditor (POST /__dev-content-edit writes page HTML), resumePages (writes the
 * resume markdown), watchBlog and generateBlog (rewrite blog/ and public/), writingDraftPreview
 * (proxies /blog/drafts/__docs/api to :4820) and the logo and landing feedback handlers (write
 * design-reviews/). Without generateBlog there are no current blog pages, so every path it
 * generates (/blog and everything under it, the sitemap, robots.txt, legacy-redirects.json)
 * answers 404 here instead of serving stale ignored output from an earlier run. The guard reads the
 * path from the raw request target, decodes it, resolves dot segments and compares it
 * case-insensitively (APFS serves /BLOG/x/ from blog/x/). A target it cannot read one way answers
 * 400: one not starting with /, one with // or a backslash raw or decoded (//blog/x/ parses as host
 * "blog"; /%2Fblog/x/ decodes to //blog/x/), or a bad escape.
 *
 * Vite writes only its dependency cache, and that goes to <tmp>/personal-site-vite. Discovery is
 * off (the content pages import no bare modules), the file watcher is off, .env loading is off,
 * and the server refuses every method but GET and HEAD.
 *
 * Reads only the root's repo content; writes only under --tmp.
 */
import { existsSync } from "node:fs";
import { join, posix } from "node:path";

import { ensureTmpDir, parseFixtureArgs, runFixture } from "../lib/fixture-server";

const APP = "lascari-ai/personal-site";

/** URL paths scripts/blog-pages.mjs generateBlog() writes (lines 86-99, 104, 155-159); none is current here. */
const GENERATED_PATHS = ["/blog/", "/sitemap.xml", "/robots.txt", "/legacy-redirects.json"];

/** True when `path` is generated output this fixture does not serve. Case-insensitive, as APFS is. */
function isGenerated(path: string): boolean {
  const p = path.toLowerCase();
  return GENERATED_PATHS.some((g) => (g.endsWith("/") ? p === g.slice(0, -1) || p.startsWith(g) : p === g));
}

const EMPTY_SEGMENT_OR_BACKSLASH = /\/\/|\\/;

/**
 * The path a raw request target names: query and fragment cut, percent-decoded, dot segments
 * resolved. Null when the target is ambiguous (see the header). Not a WHATWG URL parse: that reads
 * //blog/x/ as host "blog" with path /x/.
 */
function requestPath(target: string): string | null {
  const raw = target.split(/[?#]/, 1)[0];
  if (!raw.startsWith("/") || EMPTY_SEGMENT_OR_BACKSLASH.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (EMPTY_SEGMENT_OR_BACKSLASH.test(decoded)) return null;
  const path = posix.normalize(decoded);
  // The checks above already rule both out; this keeps a later change to them from letting a path escape /.
  return path.startsWith("/") && !path.includes("//") ? path : null;
}

type Middleware = (req: { method?: string; url?: string }, res: any, next: () => void) => void;

/** Runs before Vite's own middlewares: read-only, and no generated paths. */
export function readOnlyGuard(): Middleware {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
      res.end("read-only fixture");
      return;
    }
    const path = requestPath(req.url ?? "/");
    if (path === null) {
      res.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("ambiguous request path");
      return;
    }
    if (isGenerated(path)) {
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("generated by the app's vite.config.ts; not served by this fixture");
      return;
    }
    next();
  };
}

async function main() {
  const args = parseFixtureArgs(process.argv.slice(2));
  const port = args.ports.port;
  if (!port) throw new Error("--port <n> is required");
  const appDir = join(args.root, APP);
  if (!existsSync(join(appDir, "scripts/site-pages.mjs"))) throw new Error(`no personal-site checkout at ${appDir}`);
  if (!existsSync(join(appDir, "node_modules/vite"))) throw new Error(`${appDir} has no node_modules (run npm ci there first)`);

  const vite = await import(Bun.resolveSync("vite", appDir));
  const tailwindcss = (await import(Bun.resolveSync("@tailwindcss/vite", appDir))).default;
  const script = (name: string) => import(join(appDir, "scripts", name));
  const { sitePages } = await script("site-pages.mjs");
  const { inlineLandingLoader } = await script("inline-landing-loader.mjs");
  const { externalLinks } = await script("external-links.mjs");
  const { readResume, resumeContent } = await script("resume-pages.mjs");

  const cacheDir = ensureTmpDir(args.tmp, join(args.tmp, "personal-site-vite"));
  const fixture = {
    name: "personal-site-fixture",
    configureServer(server: { middlewares: { use(fn: Middleware): void } }) {
      server.middlewares.use(readOnlyGuard());
    },
  };
  // scripts/resume-pages.mjs:42, without the configResolved write (lines 26-35).
  const resumeContentPlugin = {
    name: "personal-site-fixture:resume-content",
    transformIndexHtml: {
      order: "pre" as const,
      handler: (html: string) =>
        html.includes("<!-- resume-content -->") ? html.replace("<!-- resume-content -->", resumeContent(readResume(appDir))) : html,
    },
  };

  const server = await vite.createServer({
    configFile: false,
    root: appDir,
    envDir: false,
    cacheDir,
    appType: "mpa",
    clearScreen: false,
    logLevel: "info",
    // Inline (empty) PostCSS config: no config-file search up the tree.
    css: { postcss: {} },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port, strictPort: true, watch: null },
    // The app's plugin order (vite.config.ts:14), minus every plugin that writes or proxies.
    plugins: [fixture, resumeContentPlugin, sitePages(), inlineLandingLoader(), externalLinks(), tailwindcss()],
  });
  await server.listen();
  console.log(`personal-site fixture: Vite ${vite.version}, root ${appDir}, cache ${cacheDir}`);
  console.log(`  Local:   http://127.0.0.1:${port}/`);

  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]).finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) await runFixture("personal-site fixture", main);
