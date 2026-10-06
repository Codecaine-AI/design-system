/**
 * lint:apps --out-dir and registry loading (round 2): the report lands only in a validated
 * `<out-dir>/lint/<timestamp>.json`, never through a symlinked `lint/`, never inside a git checkout;
 * the registry passes the same port rules every registry-loading tool applies.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;
let tmp: string;

beforeAll(() => {
  ws = materialize();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lint-outdir-")));
});
afterAll(() => {
  ws?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function lintCli(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, "scripts/lint-apps.ts", "--root", ws.root, "--registry", ws.registryPath, ...args], { cwd: PKG });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test("--out-dir writes one parseable report to <out-dir>/lint/<timestamp>.json", () => {
  const out = join(tmp, "plain");
  const { code, stderr } = lintCli("--out-dir", out, "connected");
  expect(code).toBe(0);
  const files = readdirSync(join(out, "lint"));
  expect(files).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d-]+Z\.json$/)]);
  expect(JSON.parse(readFileSync(join(out, "lint", files[0]), "utf8")).apps[0].id).toBe("connected");
  expect(stderr).toContain(join(out, "lint", files[0]));
});

test("a symlinked lint/ under --out-dir exits 2 and writes nothing through it", () => {
  const out = join(tmp, "linked");
  const elsewhere = join(tmp, "elsewhere");
  mkdirSync(out, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(out, "lint"));
  const { code, stdout, stderr } = lintCli("--out-dir", out, "connected");
  expect(code).toBe(2);
  expect(stderr).toContain("is a symlink");
  expect(stdout).toBe("");
  expect(readdirSync(elsewhere)).toEqual([]);
});

test("an --out-dir inside a git checkout exits 2 and writes nothing", () => {
  const repo = join(tmp, "checkout");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
  const { code, stdout, stderr } = lintCli("--out-dir", join(repo, "reports"), "connected");
  expect(code).toBe(2);
  expect(stderr).toContain(`is inside the git checkout ${repo}`);
  expect(stdout).toBe("");
  expect(existsSync(join(repo, "reports"))).toBe(false);
});

test("a registry that breaks the shared port rules exits 2 before any check runs", () => {
  const bad = join(ws.root, "registry/owner-port.json");
  const apps = ws.registry.apps.map((a) => (a.id === "connected" ? { ...a, runProfile: { ...a.runProfile, ports: { web: 4820 } } } : a));
  writeFileSync(bad, JSON.stringify({ version: 1, apps }));
  const r = Bun.spawnSync([process.execPath, "scripts/lint-apps.ts", "--root", ws.root, "--registry", bad, "connected"], { cwd: PKG });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("connected: port web=4820 is an owner port");
  expect(r.stdout.toString()).toBe("");
});
