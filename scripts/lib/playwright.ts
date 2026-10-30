/**
 * Playwright loader for the rollout tools.
 *
 * design-system installs nothing: Playwright comes from Core's node_modules (<root>/codecaine/core/
 * node_modules/playwright and the playwright-core it loads), never from wherever node resolution happens
 * to find a copy first: a node_modules dir inside an app's checkout (docs-system/node_modules, which
 * docs-workbench runs may write) would come first from deeper anchors. Browsers are the cached ones in
 * Playwright's browser cache (browserCache). `root` is the workspace tree the tool checks (the mirror during the run).
 *
 * Core's node_modules sit inside --root, next to the apps a tool starts. The tool therefore resolves,
 * loads and hashes Playwright (playwright and playwright-core, every file) before the first app starts
 * (pinPlaywright: startApp and launchBrowser call it; once an app from that root started, a Playwright not
 * pinned before is refused), and refuses to use it once the hash changed; the run sandbox keeps those package dirs
 * read-only as well (toolPackageDirs, sandbox.ts runPolicy). Electron (opt-in, DS_ALLOW_ELECTRON=1) is
 * pinned the same way, and its executable is read from path.txt, never by running the package's code.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

/** Where Playwright lives: Core's own node_modules (workspace-relative). */
export const CORE_NODE_MODULES = "codecaine/core/node_modules";

/** The package.json Playwright resolves from, inside `root`: Core's (its node_modules come first). */
export function playwrightAnchor(root: string): string {
  return join(root, "codecaine/core/package.json");
}

/** The package dir (realpath) of `name` as `from` resolves it, or null. */
function packageDir(from: string, name: string): string | null {
  try {
    return realpathSync(dirname(createRequire(from).resolve(`${name}/package.json`)));
  } catch {
    return null;
  }
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Where Playwright resolves from Core, or why it does not resolve to Core's own node_modules. */
function resolvePlaywright(root: string): { dirs: string[] } | { problem: string } {
  const playwright = packageDir(playwrightAnchor(root), "playwright");
  if (!playwright) return { problem: `Playwright does not resolve from ${playwrightAnchor(root)}` };
  const modules = join(root, CORE_NODE_MODULES);
  const expected = existsSync(join(modules, "playwright")) ? realpathSync(join(modules, "playwright")) : null;
  if (playwright !== expected) return { problem: `Playwright resolves to ${playwright}, not ${join(modules, "playwright")}` };
  const core = packageDir(join(playwright, "package.json"), "playwright-core");
  if (!core) return { problem: `playwright-core does not resolve from ${playwright}` };
  const coreHome = existsSync(join(modules, "playwright-core")) ? realpathSync(join(modules, "playwright-core")) : null;
  if (!within(core, playwright) && core !== coreHome) return { problem: `playwright-core resolves to ${core}, outside ${playwright} and ${join(modules, "playwright-core")}` };
  return { dirs: [playwright, core] };
}

/** Playwright's package dirs (playwright, then the playwright-core it loads), realpaths; [] when it does not resolve to Core's own. */
export function playwrightDirs(root: string): string[] {
  const found = resolvePlaywright(root);
  return "dirs" in found ? found.dirs : [];
}

/**
 * The tool's own packages inside --root that no run process may write: Playwright (playwright,
 * playwright-core) and Electron, in Core's node_modules.
 */
export function toolPackageDirs(root: string): string[] {
  const electron = join(root, CORE_NODE_MODULES, "electron");
  return [...new Set([...playwrightDirs(root), ...(existsSync(electron) ? [realpathSync(electron)] : [])])];
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
/** Roots an app was started from (startApp): Playwright inside one of them must have been pinned before. */
const startedRoots = new Set<string>();

/** startApp calls this right before the first process of a run from `root` starts. */
export function noteAppStarted(root: string): void {
  startedRoots.add(realpathSync(root));
}

function check(pin: Pin, what: string): void {
  const now = treeHash(pin.dirs);
  if (now !== pin.hash) throw new PackageChanged(`${what} changed on disk since it was loaded (${pin.dirs.join(", ")}): refusing to use it; something wrote into it during the run`);
}

/**
 * Playwright for `root` (Core's own, resolvePlaywright), loaded and its package tree hashed on the first
 * call, which must come before the first app from `root` starts: startApp calls this before it spawns
 * anything, and after an app from `root` started a first call throws. Every later call re-hashes the tree and throws PackageChanged
 * when a file changed, was added or removed.
 */
export function pinPlaywright(root: string): any {
  const key = realpathSync(root);
  const known = pinned.get(`playwright ${key}`);
  if (known) {
    check(known, "Playwright");
    return known.module;
  }
  if (startedRoots.has(key)) throw new Error(`Playwright in ${root} was not loaded before the first app from there started; refusing to load it now`);
  const found = resolvePlaywright(root);
  if (!("dirs" in found)) throw new Error(found.problem);
  const hash = treeHash(found.dirs);
  const module = createRequire(join(found.dirs[0]!, "package.json"))(found.dirs[0]!);
  const pin = { dirs: found.dirs, hash, module };
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
 * The Electron executable for an app: the electron package resolved from `appDir`, which must lie outside
 * every dir in `writable` (the run's writable checkouts), with its tree hashed on first use and checked on
 * every later one. The path comes from the package's path.txt (`dist/<path.txt>`), the way its index.js
 * computes it, without running any of its code in the tool. Opt-in Electron runs only.
 */
export function pinElectron(appDir: string, writable: readonly string[] = []): string {
  const dir = packageDir(join(appDir, "package.json"), "electron");
  if (!dir) throw new Error(`the electron package does not resolve from ${appDir}`);
  const inside = writable.map((path) => (existsSync(path) ? realpathSync(path) : path)).find((path) => within(dir, path));
  if (inside) throw new Error(`the electron package resolves to ${dir}, inside ${inside}, which the run may write`);
  const executable = () => {
    const text = readFileSync(join(dir, "path.txt"), "utf8").trim();
    const rel = normalize(text);
    if (!text || isAbsolute(rel) || rel.startsWith("..")) throw new Error(`${dir}/path.txt names ${JSON.stringify(text)}, not a path inside its dist/`);
    return join(dir, "dist", rel);
  };
  const known = pinned.get(`electron ${dir}`);
  if (known) {
    check(known, "Electron");
    return executable();
  }
  const pin = { dirs: [dir], hash: treeHash([dir]), module: null };
  pinned.set(`electron ${dir}`, pin);
  return executable();
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
  startedRoots.clear();
}

/**
 * Playwright's browser cache, the folder its registry installs into: PLAYWRIGHT_BROWSERS_PATH, else the
 * platform's cache folder (~/Library/Caches on macOS, $XDG_CACHE_HOME or ~/.cache on Linux,
 * %LOCALAPPDATA% on Windows) + ms-playwright.
 */
export function browserCache(home: string = homedir()): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return join(home, "Library/Caches/ms-playwright");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData/Local"), "ms-playwright");
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright");
}

/** The headless shell's folder and executable inside chromium_headless_shell-<rev>, per platform (Playwright's own names). */
const HEADLESS_SHELL: Record<string, [string, string]> = {
  "darwin-arm64": ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  "darwin-x64": ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  "linux-arm64": ["chrome-headless-shell-linux-arm64", "chrome-headless-shell"],
  "linux-x64": ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  "win32-x64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
};

/** The headless shell executable inside a chromium_headless_shell-<rev> dir, for this platform. Throws on a platform Playwright has no build for. */
export function headlessShellIn(dir: string): string {
  // Playwright's names: every Windows host is win64, and a Mac that is not arm64 is mac-x64.
  const arch = process.platform === "win32" || (process.platform === "darwin" && process.arch !== "arm64") ? "x64" : process.arch;
  const platform = `${process.platform}-${arch}`;
  const shell = HEADLESS_SHELL[platform];
  if (!shell) throw new Error(`Playwright has no Chromium headless shell for ${platform}`);
  return join(dir, ...shell);
}

/**
 * The Chromium headless shell Playwright launches for `headless: true`, from the browsers.json of the
 * pinned playwright-core and Playwright's browser cache (browserCache). Throws when Playwright is not
 * pinned or unchanged, when browsers.json names no plain revision, or when the shell is not installed.
 */
export function headlessShellPath(root: string, home: string = homedir()): { path: string; dir: string } {
  pinPlaywright(root);
  const core = playwrightDirs(root)[1];
  if (!core) throw new Error(`Playwright does not resolve from ${playwrightAnchor(root)}`);
  const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string }> };
  const shell = browsers.browsers.find((browser) => browser.name === "chromium-headless-shell");
  if (!shell || !/^\d+$/.test(String(shell.revision))) throw new Error(`${core}/browsers.json names no chromium-headless-shell revision`);
  const dir = join(browserCache(home), `chromium_headless_shell-${shell.revision}`);
  const path = headlessShellIn(dir);
  if (!existsSync(path)) throw new Error(`the Chromium headless shell is not installed at ${path}`);
  return { path, dir: realpathSync(dir) };
}
