/**
 * What an app run may write (decision 29, scripts/lib/checkouts.ts appScope) and the Playwright pin
 * (scripts/lib/playwright.ts: loaded and hashed before the first app, refused once it changed; Opus R3
 * P0-2). Scratch trees only; no app, no port.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appScope, gitDirsOf, writeScope } from "../scripts/lib/checkouts.ts";
import { markAppsStarted, pinRepos, resetPinsForTests } from "../scripts/lib/git.ts";
import { PackageChanged, pinPlaywright, playwrightDirs, resetPlaywrightPinsForTests, toolPackageDirs } from "../scripts/lib/playwright.ts";
import type { AppEntry } from "../scripts/lib/registry.ts";
import { runPolicy } from "../scripts/lib/sandbox.ts";
import { SYSTEM_BIN } from "../scripts/lib/system-bin.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-checkouts-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => {
  resetPinsForTests();
  resetPlaywrightPinsForTests();
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([SYSTEM_BIN.git, "-c", "user.email=test@example.invalid", "-c", "user.name=test", "-C", cwd, ...args], { env: { PATH: "/usr/bin:/bin", HOME: scratch } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "x");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "x");
}

const entry = (fields: Partial<AppEntry>) => ({ id: "scope-fixture", ...fields }) as unknown as AppEntry;

/**
 * A mirror-like root: Core (a checkout) holding the app's repository (a nested checkout, like
 * codecaine/core/sequence) with another repository nested in it (like docs-system's external/*), a
 * sibling app, and Core's node_modules with a stand-in Playwright.
 */
function tree() {
  const root = mkdtempSync(join(scratch, "root-"));
  const core = join(root, "codecaine", "core");
  const app = join(core, "sequence");
  const nested = join(app, "external", "canvas");
  const sibling = join(core, "canvas");
  repo(core);
  repo(app);
  repo(nested);
  repo(sibling);
  for (const name of ["playwright", "playwright-core"]) {
    const dir = join(core, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), `module.exports = { name: ${JSON.stringify(name)} };\n`);
  }
  mkdirSync(join(core, "docs-system", "packages", "docs-workbench"), { recursive: true });
  return { root, core, app, nested, sibling };
}

describe("appScope (decision 29)", () => {
  test("the app's own checkout only: not the Core checkout around it, not a repository nested in it, not a sibling", () => {
    const t = tree();
    const scope = appScope(t.root, entry({ repo: "codecaine/core/sequence", root: "codecaine/core/sequence/packages/studio", scan: { paths: ["codecaine/core/sequence/src"], exclude: [] } }));
    expect(scope.writable).toEqual([realpathSync(t.app)]);
    expect(scope.checkouts).toEqual([realpathSync(t.app)]);
    expect(scope.readOnly).toEqual(expect.arrayContaining([realpathSync(t.nested), realpathSync(join(t.app, ".git")), realpathSync(join(t.nested, ".git"))]));
    expect(scope.readOnly).not.toContain(realpathSync(t.sibling));
    expect(scope.fallback).toBeUndefined();
    // The policy built from it: Core and its node_modules (Playwright) are not writable, and Playwright is
    // listed read-only by name besides.
    const policy = runPolicy({ root: t.root, tmp: join(scratch, "tmp"), outDir: join(t.root, "rollout"), writable: scope.writable, readOnly: scope.readOnly, home: join(scratch, "home"), ownerTree: join(scratch, "owner") });
    expect(policy.writable).toEqual([realpathSync(t.app), join(scratch, "tmp")]);
    expect(policy.readOnly).toEqual(expect.arrayContaining(playwrightDirs(t.root)));
    expect(toolPackageDirs(t.root)).toEqual([realpathSync(join(t.core, "node_modules", "playwright")), realpathSync(join(t.core, "node_modules", "playwright-core"))]);
  });

  test("an app in no checkout inside --root gets its own folder, never --root itself", () => {
    const root = mkdtempSync(join(scratch, "plain-"));
    mkdirSync(join(root, "app", "src"), { recursive: true });
    expect(appScope(root, entry({ repo: "app", root: "app", scan: { paths: ["app/src"], exclude: [] } }))).toEqual({
      writable: [realpathSync(join(root, "app"))],
      checkouts: [],
      readOnly: [],
      fallback: realpathSync(join(root, "app")),
    });
    expect(() => appScope(root, entry({ repo: ".", root: "." }))).toThrow(/--root itself/);
  });

  test("an app whose checkout is --root's own (the owner's workspace repository) falls back to its folder", () => {
    const root = mkdtempSync(join(scratch, "rootrepo-"));
    repo(root);
    mkdirSync(join(root, "system-view", "src"), { recursive: true });
    expect(appScope(root, entry({ repo: "system-view", root: "system-view" })).writable).toEqual([realpathSync(join(root, "system-view"))]);
  });

  test("after the first app started, checkouts come from the pins, never from git (an unpinned one is refused)", () => {
    const t = tree();
    pinRepos([t.app]);
    markAppsStarted();
    expect(appScope(t.root, entry({ repo: "codecaine/core/sequence", root: "codecaine/core/sequence" })).writable).toEqual([realpathSync(t.app)]);
    expect(() => appScope(t.root, entry({ repo: "codecaine/core/canvas", root: "codecaine/core/canvas" }))).toThrow(/not recorded before the first app started/);
  });

  test("gitDirsOf reads a worktree's git dir and common dir from its `.git` file, without git", () => {
    const t = tree();
    const linked = join(t.root, "linked");
    git(t.sibling, "worktree", "add", "-q", "--detach", linked);
    const [gitDir, common] = gitDirsOf(linked);
    expect(gitDir).toBe(realpathSync(join(t.sibling, ".git", "worktrees", "linked")));
    expect(common).toBe(realpathSync(join(t.sibling, ".git")));
  });
});

describe("writeScope (test:apps)", () => {
  test("enclosing checkouts by default; only the touched ones without", () => {
    const t = tree();
    const withEnclosing = writeScope(t.root, [join(t.app, "README.md")]);
    expect(withEnclosing.scan).toEqual([realpathSync(t.core)]);
    expect(withEnclosing.prune).toEqual([realpathSync(t.sibling)]);
    expect(writeScope(t.root, [join(t.app, "README.md")], { enclosing: false }).scan).toEqual([realpathSync(t.app)]);
  });
});

describe("pinPlaywright (Opus R3 P0-2)", () => {
  test("loads and hashes Playwright once; a file changed, added or removed afterwards refuses it", () => {
    const t = tree();
    expect(pinPlaywright(t.root)).toEqual({ name: "playwright" });
    expect(pinPlaywright(t.root)).toEqual({ name: "playwright" }); // unchanged: the same module
    appendFileSync(join(t.core, "node_modules", "playwright-core", "index.js"), "require('child_process').execSync('touch /tmp/pwned');\n");
    expect(() => pinPlaywright(t.root)).toThrow(PackageChanged);
  });

  test("a file planted in the package (a lazily required module) refuses it too", () => {
    const t = tree();
    pinPlaywright(t.root);
    writeFileSync(join(t.core, "node_modules", "playwright", "lazy.js"), "module.exports = 1;\n");
    expect(() => pinPlaywright(t.root)).toThrow(PackageChanged);
  });
});
