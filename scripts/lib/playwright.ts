/**
 * Playwright loader for the rollout tools.
 *
 * design-system installs nothing: Playwright resolves from Core, where
 * docs-workbench depends on it. Browsers are the cached ones in
 * ~/Library/Caches/ms-playwright. `root` is the workspace tree the tool checks
 * (the mirror during the run).
 */
import { createRequire } from "node:module";
import { join } from "node:path";

/** The package.json Playwright resolves from, inside `root`. */
export function playwrightAnchor(root: string): string {
  return join(root, "codecaine/core/docs-system/packages/docs-workbench/package.json");
}

export function loadPlaywright(root: string): any {
  return createRequire(playwrightAnchor(root))("playwright");
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
