/**
 * Shared guard and file server for the run-profile fixture servers under apps/fixtures/<id>/.
 *
 * A fixture server reads only the root's repo content and writes only into its --tmp dir.
 * `fixtureArgs` enforces the write side: --tmp must be an absolute path outside every git
 * checkout, so nothing a run produces can land in a repo. Callers read only paths they build
 * from --root.
 *
 * Every check runs on real paths (symlinks resolved): a lexical check passes `/tmp/link` when
 * the link points into a checkout, and a symlink inside --tmp or the site dir would redirect a
 * write or a read out of it.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalPath } from "../../../scripts/lib/safe-paths";

export interface FixtureArgs {
  /** The workspace tree whose repo content the fixture reads (absolute). */
  root: string;
  /** The run's temp dir, canonical (symlinks resolved); every write goes under it, outside any git checkout. */
  tmp: string;
  /** Named ports from `--<name>-port <n>` or `--port <n>` (as "port"). */
  ports: Record<string, number>;
  /** Other `--flag value` pairs. */
  flags: Record<string, string>;
}

/** The nearest ancestor of `path` (inclusive) that holds a `.git` entry, or null. */
export function gitCheckoutOf(path: string): string | null {
  let dir = resolve(path);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parse `--root <dir> --tmp <dir> [--<name>-port <n>]...`; throws with one message on bad input. */
export function parseFixtureArgs(argv: string[], cwd: string = process.cwd()): FixtureArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    flags[a.slice(2)] = v;
    i++;
  }
  if (!flags.root) throw new Error("--root <dir> is required");
  if (!flags.tmp) throw new Error("--tmp <dir> is required");
  const root = resolve(cwd, flags.root);
  if (!isAbsolute(flags.tmp)) throw new Error(`--tmp must be absolute, got "${flags.tmp}" (was {tmp} substituted?)`);
  // Canonical first: the checkout walk must follow the path a write would actually take.
  const tmp = canonicalPath(flags.tmp);
  const checkout = gitCheckoutOf(tmp);
  if (checkout) throw new Error(`--tmp ${flags.tmp} (${tmp}) is inside the git checkout ${checkout}; fixtures never write into a repo`);
  const ports: Record<string, number> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key !== "port" && !key.endsWith("-port")) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`--${key}: invalid port "${value}"`);
    ports[key === "port" ? "port" : key.slice(0, -"-port".length)] = n;
  }
  for (const key of ["root", "tmp"]) delete flags[key];
  for (const key of Object.keys(flags)) if (key === "port" || key.endsWith("-port")) delete flags[key];
  return { root, tmp, ports, flags };
}

/** Whether canonical `path` is canonical `dir` or inside it. */
function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Create `dir` (and parents) and return its canonical path; refuses any path that resolves outside `tmp`. */
export function ensureTmpDir(tmp: string, dir: string): string {
  const full = canonicalPath(dir);
  const root = canonicalPath(tmp);
  if (!inside(full, root)) throw new Error(`refusing to write ${dir} (${full}): outside --tmp ${root}`);
  mkdirSync(full, { recursive: true });
  return full;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
};

/** Resolve a URL path to a real file inside `siteDir`; null when it escapes the dir (also through a symlink) or names no file. */
export function siteFile(siteDir: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]!);
  } catch {
    return null;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const full = resolve(siteDir, "." + (rel.startsWith("/") ? rel : `/${rel}`));
  if (full !== siteDir && !full.startsWith(siteDir + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const real = realpathSync(full);
  return inside(real, realpathSync(siteDir)) ? real : null;
}

/** Serve `siteDir` read-only on 127.0.0.1:port and print a vite-style ready line. */
export function serveSite(siteDir: string, port: number, label: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("read-only", { status: 405 });
      const file = siteFile(siteDir, new URL(request.url).pathname);
      if (!file) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), {
        headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" },
      });
    },
  });
  console.log(`${label} fixture serving ${siteDir}`);
  console.log(`  Local:   http://127.0.0.1:${server.port}/`);
  const stop = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

/** Run `main`, printing one error line and exiting 1 on failure. */
export async function runFixture(name: string, main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
