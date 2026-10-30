/**
 * Chromium and axe-core for design:score.
 *
 * Playwright is Core's own (pinPlaywright from lib/playwright.ts, hashed on load). The browser is the
 * headless shell Playwright expects; when that revision is not in the cache, the newest cached
 * chromium_headless_shell-* is used instead and the scorecard says so (design:score installs nothing).
 *
 * axe-core is not a design-system dependency. Its axe.min.js comes from DS_AXE_PATH, else Core's
 * node_modules, else the first known copy on this machine; R-axe is n/a when none is found. The file's
 * path, version and sha256 go into the scorecard.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { LAUNCH_OPTIONS } from "../lib/capture";
import { browserCache, headlessShellIn, headlessShellPath, pinPlaywright, playwrightAnchor, playwrightVersion } from "../lib/playwright";

export interface BrowserInfo {
  browser: any;
  playwright: string;
  executable: string;
  version: string;
  fallback: string | null;
  /** One line for the console when the fallback is used. */
  fallbackLine?: string | null;
}

/** The newest cached chromium_headless_shell-<rev> executable, or null. */
function cachedShell(): string | null {
  const cache = browserCache();
  if (!existsSync(cache)) return null;
  const revs = readdirSync(cache)
    .map((name) => /^chromium_headless_shell-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const rev of revs) {
    const path = headlessShellIn(join(cache, `chromium_headless_shell-${rev}`));
    if (existsSync(path)) return path;
  }
  return null;
}

export async function launch(root: string): Promise<BrowserInfo> {
  const playwright = pinPlaywright(root);
  let executable: string;
  let fallback: string | null = null;
  try {
    executable = headlessShellPath(root).path;
  } catch (error) {
    const shell = cachedShell();
    if (!shell) throw new Error(`no Chromium for Playwright ${playwrightVersion(root)} (${error instanceof Error ? error.message : error}), and no chromium_headless_shell-* is cached`);
    executable = shell;
    fallback = `${error instanceof Error ? error.message : error}; using the cached ${shell}`;
  }
  const rev = (p: string) => /chromium_headless_shell-(\d+)/.exec(p)?.[1] ?? "?";
  const wanted = fallback ? /chromium_headless_shell-(\d+)/.exec(fallback)?.[1] ?? null : null;
  const browser = await playwright.chromium.launch({
    ...LAUNCH_OPTIONS,
    // Animations must run for the motion checks: keep threaded animation on.
    args: LAUNCH_OPTIONS.args.filter((a) => a !== "--disable-threaded-animation"),
    executablePath: executable,
  });
  const fallbackLine = fallback
    ? `Chromium: Playwright ${playwrightVersion(root)} wants headless shell r${wanted ?? "?"}, which is not cached; using cached r${rev(executable)} (Chromium ${browser.version()}). Nothing is downloaded; scores are comparable only between runs on the same build.`
    : null;
  return { browser, playwright: playwrightVersion(root), executable, version: browser.version(), fallback, fallbackLine };
}

export interface AxeSource {
  path: string;
  version: string;
  sha256: string;
  source: string;
}

/** Known copies, relative to the workspace's codebases/ folder (the checked tree, then Ford's own). */
const KNOWN_AXE = ["experiments/skitzo/apps/frontend/node_modules/axe-core/axe.min.js"];

/** axe.min.js, or null (R-axe is then n/a). `root` is the workspace tree the tool checks. */
export function findAxe(root: string): AxeSource | null {
  const candidates: string[] = [];
  if (process.env.DS_AXE_PATH) candidates.push(process.env.DS_AXE_PATH);
  try {
    candidates.push(createRequire(playwrightAnchor(root)).resolve("axe-core/axe.min.js"));
  } catch {
    // not in Core's node_modules
  }
  for (const rel of KNOWN_AXE) candidates.push(join(root, rel), join(homedir(), "workspace/codebases", rel));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const version = /axe v([\d.]+)/.exec(source.slice(0, 400))?.[1] ?? "unknown";
    return { path, version, sha256: createHash("sha256").update(source).digest("hex"), source };
  }
  return null;
}
