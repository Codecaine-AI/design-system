/**
 * Guards the run-profile fixture servers rely on: they never write into a git checkout, never serve
 * a file outside their site dir, and the docs-workbench launcher refuses to start unless its docs
 * state points into the run's temp dir and no shared docs authority is configured. Every guard must
 * hold through symlinks, not only for the path as written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolationProblems } from "../apps/fixtures/docs-workbench/serve.ts";
import { ensureTmpDir, parseFixtureArgs, siteFile } from "../apps/fixtures/lib/fixture-server.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-fixture-guards-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in checkout (a `.git` folder is all gitCheckoutOf looks for), a plain dir, and links to both. */
const repo = join(scratch, "repo");
const plain = join(scratch, "plain");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(join(repo, "sub"));
mkdirSync(plain);
symlinkSync(join(repo, "sub"), join(scratch, "to-checkout"));
symlinkSync(join(repo, "later"), join(scratch, "dangling-to-checkout"));
symlinkSync(plain, join(scratch, "to-plain"));

describe("parseFixtureArgs", () => {
  test("accepts an absolute --tmp outside any checkout and names the ports", () => {
    const args = parseFixtureArgs(["--root", "/ws", "--tmp", scratch, "--api-port", "47020", "--port", "47021"]);
    expect(args).toMatchObject({ root: "/ws", tmp: scratch, ports: { api: 47020, port: 47021 } });
  });

  test("stores the real --tmp, not the symlink it was given", () => {
    expect(parseFixtureArgs(["--root", "/ws", "--tmp", join(scratch, "to-plain", "run")]).tmp).toBe(join(plain, "run"));
  });

  test.each([
    ["inside a git checkout", join(repo, "out")],
    ["a symlink to a dir inside a checkout", join(scratch, "to-checkout")],
    ["under a symlink to a dir inside a checkout", join(scratch, "to-checkout", "run")],
    ["under a dangling symlink into a checkout", join(scratch, "dangling-to-checkout", "run")],
  ])("refuses a --tmp %s", (_, tmp) => {
    expect(() => parseFixtureArgs(["--root", "/ws", "--tmp", tmp])).toThrow("inside the git checkout");
  });

  test("refuses an unsubstituted placeholder", () => {
    expect(() => parseFixtureArgs(["--root", "/ws", "--tmp", "{tmp}"])).toThrow("--tmp must be absolute");
  });
});

describe("ensureTmpDir", () => {
  const tmp = join(scratch, "tmp");
  const outside = join(scratch, "outside");
  mkdirSync(tmp);
  mkdirSync(outside);
  symlinkSync(outside, join(tmp, "escape"));
  symlinkSync(join(outside, "not-yet"), join(tmp, "dangling-escape"));

  test("creates a dir under --tmp and returns its real path", () => {
    expect(ensureTmpDir(tmp, join(tmp, "site", "assets"))).toBe(join(tmp, "site", "assets"));
    expect(existsSync(join(tmp, "site", "assets"))).toBe(true);
  });

  test.each([
    ["a sibling of --tmp", join(scratch, "elsewhere"), join(scratch, "elsewhere")],
    ["a symlink inside --tmp that points out", join(tmp, "escape", "site"), join(outside, "site")],
    ["a dangling symlink inside --tmp that points out", join(tmp, "dangling-escape"), join(outside, "not-yet")],
  ])("refuses %s and creates nothing", (_, dir, landing) => {
    expect(() => ensureTmpDir(tmp, dir)).toThrow("outside --tmp");
    expect(existsSync(landing)).toBe(false);
  });
});

describe("siteFile", () => {
  const site = join(scratch, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "index.html"), "<p>hi</p>");
  writeFileSync(join(scratch, "secret.txt"), "outside");
  symlinkSync(join(scratch, "secret.txt"), join(site, "leak.txt"));
  symlinkSync(scratch, join(site, "up"));
  symlinkSync(join(site, "index.html"), join(site, "alias.html"));

  test("maps / to index.html", () => {
    expect(siteFile(site, "/")).toBe(join(site, "index.html"));
  });

  test("serves a symlink that stays inside the site dir", () => {
    expect(siteFile(site, "/alias.html")).toBe(join(site, "index.html"));
  });

  test.each([
    ["/../secret.txt", "a traversal"],
    ["/%2e%2e/secret.txt", "an encoded traversal"],
    ["/..%2fsecret.txt", "an encoded separator"],
    ["/leak.txt", "a symlink to a file outside the site dir"],
    ["/up/secret.txt", "a file under a symlinked dir outside the site dir"],
  ])("refuses %s (%s)", (path) => {
    expect(siteFile(site, path)).toBeNull();
  });
});

describe("docs-workbench isolationProblems", () => {
  const tmp = join(scratch, "run");
  mkdirSync(tmp);
  symlinkSync(join(scratch, "outside-state"), join(tmp, "escape"));
  const isolated = {
    CODECAINE_DOCS_STATE_DIR: join(tmp, "docs-state"),
    CODECAINE_DOCS_GLOBAL_THEMES: join(tmp, "docs-state/themes"),
    CODECAINE_DOCS_CODE_THEMES: join(tmp, "docs-state/code-themes"),
    PATH: "/usr/bin",
  };

  test("an isolated environment has no problems", () => {
    expect(isolationProblems(isolated, tmp)).toEqual([]);
  });

  test.each<[string, Record<string, string | undefined>, string]>([
    ["a missing state dir", { ...isolated, CODECAINE_DOCS_STATE_DIR: undefined }, "CODECAINE_DOCS_STATE_DIR is unset"],
    ["live global themes", { ...isolated, CODECAINE_DOCS_GLOBAL_THEMES: "/Users/x/.local/state/codecaine-docs/themes" }, "is outside --tmp"],
    ["a shared docs authority", { ...isolated, DOCS_SHARED_API_URL: "http://127.0.0.1:4820" }, "DOCS_SHARED_API_URL is set"],
    ["DOCS_API", { ...isolated, DOCS_API: "http://localhost:4800" }, "DOCS_API is set"],
    ["a state dir under a symlink out of --tmp", { ...isolated, CODECAINE_DOCS_STATE_DIR: join(tmp, "escape", "docs-state") }, "is outside --tmp"],
  ])("refuses %s", (_, env, message) => {
    expect(isolationProblems(env, tmp).some((p) => p.includes(message))).toBe(true);
  });
});
