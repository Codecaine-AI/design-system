/**
 * Playwright loader for the rollout tools.
 *
 * design-system installs nothing: Playwright resolves from Core, where docs-workbench depends on it.
 * Browsers are the cached ones in ~/Library/Caches/ms-playwright. `root` is the workspace tree the tool
 * checks (the mirror during the run).
 *
 * Core's node_modules sit inside --root, next to the apps a tool starts. The tool therefore resolves,
 * loads and hashes Playwright (playwright and playwright-core, every file) before the first app starts
 * (pinPlaywright: startApp and launchBrowser call it), and refuses to use it once the hash changed; the
 * run sandbox keeps those package dirs read-only as well (toolPackageDirs, sandbox.ts runPolicy).
 * Electron (opt-in, DS_ALLOW_ELECTRON=1) is pinned the same way (pinElectron).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/** The package.json Playwright resolves from, inside `root`. */
export function playwrightAnchor(root: string): string {
  return join(root, "codecaine/core/docs-system/packages/docs-workbench/package.json");
}

/** The package dir (realpath) of `name` as `from` resolves it, or null. */
function packageDir(from: string, name: string): string | null {
  try {
    return realpathSync(dirname(createRequire(from).resolve(`${name}/package.json`)));
  } catch {
    return null;
  }
}

/** Playwright's package dirs (playwright, then the playwright-core it loads), realpaths; [] when it does not resolve. */
export function playwrightDirs(root: string): string[] {
  const playwright = packageDir(playwrightAnchor(root), "playwright");
  if (!playwright) return [];
  const core = packageDir(join(playwright, "package.json"), "playwright-core");
  return core ? [playwright, core] : [playwright];
}

/**
 * The tool's own packages inside --root that no run process may write: Playwright (playwright,
 * playwright-core) and Electron, as they resolve from the Playwright anchor (Core's node_modules).
 */
export function toolPackageDirs(root: string): string[] {
  const electron = packageDir(playwrightAnchor(root), "electron");
  return [...new Set([...playwrightDirs(root), ...(electron ? [electron] : [])])];
}

/** sha256 over sorted `<rel>\0<sha256 or link text>\n` of every file under `dirs` (lstat: links are never followed). */
export function treeHash(dirs: readonly string[]): string {
  const lines: string[] = [];
  const walk = (base: string, dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = `${base}\0${relative(base, path)}`;
      if (stat.isSymbolicLink()) lines.push(`${rel}\0link:${readlinkSync(path)}\n`);
      else if (stat.isDirectory()) walk(base, path);
      else if (stat.isFile()) lines.push(`${rel}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
      else lines.push(`${rel}\0other\n`);
    }
  };
  for (const dir of dirs) walk(dir, dir);
  return createHash("sha256").update(lines.sort().join("")).digest("hex");
}

export class PackageChanged extends Error {
  override name = "PackageChanged";
}

interface Pin {
  dirs: string[];
  hash: string;
  module: any;
}

const pinned = new Map<string, Pin>();

function check(pin: Pin, what: string): void {
  const now = treeHash(pin.dirs);
  if (now !== pin.hash) throw new PackageChanged(`${what} changed on disk since it was loaded (${pin.dirs.join(", ")}): refusing to use it; something wrote into it during the run`);
}

/**
 * Playwright for `root`, loaded and its package tree hashed on the first call (before the first app
 * starts: startApp calls this before it spawns anything); every later call re-hashes the tree and throws
 * PackageChanged when a file changed, was added or removed.
 */
export function pinPlaywright(root: string): any {
  const key = realpathSync(root);
  const known = pinned.get(`playwright ${key}`);
  if (known) {
    check(known, "Playwright");
    return known.module;
  }
  const dirs = playwrightDirs(root);
  if (dirs.length < 2) throw new Error(`Playwright does not resolve from ${playwrightAnchor(root)}`);
  const hash = treeHash(dirs);
  const module = createRequire(playwrightAnchor(root))("playwright");
  const pin = { dirs, hash, module };
  // Hashed before and after the load: a change between the two would load a file the hash never saw.
  check(pin, "Playwright");
  pinned.set(`playwright ${key}`, pin);
  return module;
}

/** The Playwright module (pinned: see pinPlaywright). */
export function loadPlaywright(root: string): any {
  return pinPlaywright(root);
}

/**
 * The Electron executable for an app (the electron package resolved from `appDir`), with that package's
 * tree hashed on first use and checked on every later one. Opt-in Electron runs only.
 */
export function pinElectron(appDir: string): string {
  const dir = packageDir(join(appDir, "package.json"), "electron");
  if (!dir) throw new Error(`the electron package does not resolve from ${appDir}`);
  const known = pinned.get(`electron ${dir}`);
  if (known) {
    check(known, "Electron");
    return known.module;
  }
  const hash = treeHash([dir]);
  const executable = createRequire(join(appDir, "package.json"))("electron") as string;
  const pin = { dirs: [dir], hash, module: executable };
  check(pin, "Electron");
  pinned.set(`electron ${dir}`, pin);
  return executable;
}

export function playwrightVersion(root: string): string {
  return (createRequire(playwrightAnchor(root))("playwright/package.json") as { version: string }).version;
}

/** Why Playwright cannot load from `root`, or null when it can. Tests use it to skip with a clear message. */
export function playwrightUnavailable(root: string): string | null {
  try {
    createRequire(playwrightAnchor(root)).resolve("playwright");
    return null;
  } catch (error) {
    return `Playwright does not resolve from ${playwrightAnchor(root)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

/** Tests only: forget the pins (a test that rewrites a stand-in package). */
export function resetPlaywrightPinsForTests(): void {
  pinned.clear();
}

/**
 * The Chromium headless shell Playwright launches for `headless: true`, from the browsers.json of the
 * pinned playwright-core and Playwright's browser cache (PLAYWRIGHT_BROWSERS_PATH, else
 * ~/Library/Caches/ms-playwright). Throws when it is not installed.
 */
export function headlessShellPath(root: string, home: string = homedir()): string {
  const dirs = playwrightDirs(root);
  const core = dirs[1];
  if (!core) throw new Error(`Playwright does not resolve from ${playwrightAnchor(root)}`);
  const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string }> };
  const shell = browsers.browsers.find((browser) => browser.name === "chromium-headless-shell");
  if (!shell) throw new Error(`${core}/browsers.json names no chromium-headless-shell`);
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, "Library/Caches/ms-playwright");
  const arch = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  const path = join(cache, `chromium_headless_shell-${shell.revision}`, `chrome-headless-shell-${arch}`, "chrome-headless-shell");
  if (!existsSync(path)) throw new Error(`the Chromium headless shell is not installed at ${path}`);
  return path;
}
