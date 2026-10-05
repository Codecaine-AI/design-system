/**
 * Guards the run-profile fixture servers rely on: they never write into a git checkout, never serve
 * a file outside their site dir, and the docs-workbench launcher refuses to start unless its docs
 * state points into the run's temp dir and no shared docs authority is configured.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolationProblems } from "../apps/fixtures/docs-workbench/serve.ts";
import { parseFixtureArgs, siteFile } from "../apps/fixtures/lib/fixture-server.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-fixture-guards-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("parseFixtureArgs", () => {
  test("accepts an absolute --tmp outside any checkout and names the ports", () => {
    const args = parseFixtureArgs(["--root", "/ws", "--tmp", scratch, "--api-port", "47020", "--port", "47021"]);
    expect(args).toMatchObject({ root: "/ws", tmp: scratch, ports: { api: 47020, port: 47021 } });
  });

  test("refuses a --tmp inside a git checkout", () => {
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(() => parseFixtureArgs(["--root", "/ws", "--tmp", join(repo, "out")])).toThrow("inside the git checkout");
  });

  test("refuses an unsubstituted placeholder", () => {
    expect(() => parseFixtureArgs(["--root", "/ws", "--tmp", "{tmp}"])).toThrow("--tmp must be absolute");
  });
});

describe("siteFile", () => {
  const site = join(scratch, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "index.html"), "<p>hi</p>");
  writeFileSync(join(scratch, "secret.txt"), "outside");

  test("maps / to index.html", () => {
    expect(siteFile(site, "/")).toBe(join(site, "index.html"));
  });

  test.each(["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"])("refuses %s", (path) => {
    expect(siteFile(site, path)).toBeNull();
  });
});

describe("docs-workbench isolationProblems", () => {
  const tmp = join(scratch, "run");
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
  ])("refuses %s", (_, env, message) => {
    expect(isolationProblems(env, tmp).some((p) => p.includes(message))).toBe(true);
  });
});
