/**
 * The lint:apps CLI (scripts/lint-apps.ts) on the fixture workspace: exit codes, the text
 * line format and the --json report shape from rollout/TOOLING_CONTRACT.md.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { materialize, REAL_TOKENS_CSS, sha256, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;

beforeAll(() => {
  ws = materialize();
});
afterAll(() => ws?.cleanup());

function lintCli(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, "scripts/lint-apps.ts", "--root", ws.root, "--registry", ws.registryPath, ...args], { cwd: PKG });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test("a connected app exits 0; --json reports the root, the pass, the build and the literal counts", () => {
  const { code, stdout } = lintCli("--json", "--pass", "3", "connected");
  expect(code).toBe(0);
  const report = JSON.parse(stdout);
  const head = Bun.spawnSync(["git", "-C", PKG, "rev-parse", "HEAD"]).stdout.toString().trim();
  expect(report.root).toBe(ws.root);
  expect(report.pass).toBe(3);
  expect(report.designSystem.commit).toBe(head);
  expect(report.designSystem.tokensCssSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(report.designSystem.tokensCssSha256).toBe(sha256(readFileSync(REAL_TOKENS_CSS, "utf8")));
  expect(report.apps.map((a: any) => ({ id: a.id, ok: a.ok, literals: a.literals }))).toEqual([{ id: "connected", ok: true, literals: { hard: 0, floor: 0 } }]);
});

test("an unconnected app exits 1 with one `<app> <check> <file>:<line> <message>` line per finding, then a summary", () => {
  const { code, stdout } = lintCli("unconnected");
  expect(code).toBe(1);
  const lines = stdout.trimEnd().split("\n");
  const summary = lines.pop()!;
  expect(summary).toStartWith("unconnected: FAIL;");
  for (const line of lines) expect(line).toMatch(/^unconnected (resolution|wiring|literals|names|shell|structure) \S+:\d+ \S/);
  expect(lines).toContainEqual(expect.stringMatching(/^unconnected resolution apps\/unconnected\/package\.json:1 does not declare @codecaine-ai\/design-system/));
  expect(lines).toContainEqual("unconnected literals apps/unconnected/src/index.css:4 hard literal #ff0000 (hex, inline)");
});

test("an app id the registry does not have exits 2", () => {
  const { code, stdout, stderr } = lintCli("no-such-app");
  expect(code).toBe(2);
  expect(stderr).toContain("no-such-app");
  expect(stdout).toBe("");
});
