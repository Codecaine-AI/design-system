/**
 * Fixed locations and the Playwright loader for the docs-system screenshot
 * harness. Everything the harness writes outside its own folder lives under
 * STAGING_DIR (a throwaway copy of the frozen inputs, recreated every run).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** verification/docs-system — the harness folder (outputs are resolved against it). */
export const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The Core docs-system checkout whose UI is screenshotted. Read-only for the harness. */
export const DOCS_SYSTEM_REPO = "/Users/Ford/workspace/codecaine/core/docs-system";

/** Frozen copy of the corpora + theme state the screenshots render (see fixtures/frozen-inputs.json). */
export const FIXTURE_ARCHIVE = join(HARNESS_DIR, "fixtures", "frozen-inputs.tar.gz");
export const FIXTURE_MANIFEST = join(HARNESS_DIR, "fixtures", "frozen-inputs.json");

/**
 * Throwaway runtime copy of the fixture. A fixed path (not a random temp dir)
 * so nothing path-dependent can differ between two runs.
 */
export const STAGING_DIR = "/tmp/ds-verify-docs-system";

/**
 * The docs kernel URL handed to the served UI. Nothing listens here, and the
 * harness aborts every request to it, so the lab UI never reaches the user's
 * live kernel (127.0.0.1:4840 by default).
 */
export const DEAD_KERNEL_URL = "http://127.0.0.1:4879";

/** Ports reserved for the harness: 4870-4879 (the user's defaults are 4800/4801). */
export const RESERVED_PORTS = { min: 4870, max: 4879 } as const;

/**
 * Playwright comes from Core (docs-workbench depends on it); the design-system
 * package installs nothing. Browsers are the cached ones in
 * ~/Library/Caches/ms-playwright.
 */
export function loadPlaywright(): any {
  const require = createRequire(join(DOCS_SYSTEM_REPO, "packages/docs-workbench/package.json"));
  return require("playwright");
}

export function playwrightVersion(): string {
  const require = createRequire(join(DOCS_SYSTEM_REPO, "packages/docs-workbench/package.json"));
  return (require("playwright/package.json") as { version: string }).version;
}
