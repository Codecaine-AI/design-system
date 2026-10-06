/**
 * registry:check's contract: every way an entry can be unusable against a tree produces its own
 * message, and the committed apps.json passes against the mirror (or the owner's tree).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkRegistry } from "../scripts/registry-check.ts";
import { DESIGN_SYSTEM_ROOT, loadRegistry, type AppEntry, type Registry } from "../scripts/lib/registry.ts";

const scratch = mkdtempSync(join(tmpdir(), "ds-registry-check-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const req = { required: true } as const;
const na = { required: false, reason: "not here" } as const;

/** A tree with one app at app/ and a design-system checkout holding one allowlist and one fixture. */
function makeTrees() {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "app/src"), { recursive: true });
  writeFileSync(join(root, "app/src/index.css"), "");
  const ds = mkdtempSync(join(scratch, "ds-"));
  mkdirSync(join(ds, "apps/allowlists"), { recursive: true });
  mkdirSync(join(ds, "apps/fixtures/demo"), { recursive: true });
  writeFileSync(join(ds, "apps/allowlists/demo.json"), JSON.stringify({ literals: [{ file: "app/src/x.ts", reason: "data colors" }], twClasses: [] }));
  writeFileSync(join(ds, "apps/fixtures/demo/serve.ts"), "");
  return { root, ds };
}

function entry(over: Partial<AppEntry> = {}): AppEntry {
  return {
    id: "demo",
    name: "Demo",
    wave: 1,
    kind: "app",
    repo: "app",
    root: "app",
    scan: { paths: ["app/src"], exclude: [] },
    stack: { summary: "", tailwind: "none", packageManager: "bun" },
    consume: { via: "workspace", detail: "" },
    entryStylesheet: "app/src/index.css",
    theme: { rule: "light-dark" },
    literalFloor: 1,
    allowlist: "apps/allowlists/demo.json",
    shell: false,
    folderStandard: false,
    passes: { "1": req, "2": na, "3": na },
    checks: { resolution: req, wiring: req, literals: req, names: req, shell: na, structure: na },
    gates: { lint: req, verify: req, snapshot: req, pixelDiff: na, tests: na },
    run: { mode: "browser", cwd: "app", start: "bun --no-env-file {ds}/apps/fixtures/demo/serve.ts --port {port:ui}", readyPattern: "(http://\\S+)" },
    commands: { cwd: "app" },
    tests: { safe: [] },
    routes: [{ id: "home", path: "/" }],
    runProfile: {
      env: {},
      unsetEnv: [],
      tempHome: true,
      fixtures: ["apps/fixtures/demo/serve.ts"],
      flags: [],
      ports: { ui: 47000 },
      proof: { status: "proven", method: "test", date: "2026-10-05" },
    },
    verify: { probes: [], darkSwitch: { kind: "attribute" } },
    exceptions: [],
    ...over,
  };
}

const check = (apps: AppEntry[]) => {
  const { root, ds } = makeTrees();
  return checkRegistry({ version: 1, apps } as Registry, { root, dsRoot: ds });
};

describe("registry:check", () => {
  test("a complete entry against its trees has no problems", () => {
    expect(check([entry()])).toEqual([]);
  });

  const profile = (over: Partial<AppEntry["runProfile"]>) => ({ ...entry().runProfile, ...over });
  test.each<[string, AppEntry[], string]>([
    ["a missing scan path", [entry({ scan: { paths: ["app/missing"], exclude: [] } })], "scan path app/missing does not exist"],
    ["a missing entry stylesheet", [entry({ entryStylesheet: "app/src/nope.css" })], "entryStylesheet app/src/nope.css does not exist"],
    ["a port outside the run range", [entry({ runProfile: profile({ ports: { ui: 5173 } }) })], "is outside 47000-47999"],
    ["a port outside the app's block", [entry({ runProfile: profile({ ports: { ui: 47010 } }) })], "is outside its block 47000-47009"],
    [
      "a port shared by two apps",
      [entry(), entry({ id: "other", allowlist: null, runProfile: profile({ ports: { ui: 47000 }, fixtures: [] }) })],
      "is also used by demo.ui",
    ],
    ["a missing allowlist file", [entry({ id: "demo2", allowlist: "apps/allowlists/demo2.json", runProfile: profile({ fixtures: [] }) })], "allowlist apps/allowlists/demo2.json does not exist"],
    ["a missing fixture", [entry({ runProfile: profile({ fixtures: ["apps/fixtures/demo/data.json"] }) })], "fixture apps/fixtures/demo/data.json does not exist"],
    ["a .env fixture", [entry({ runProfile: profile({ fixtures: ["apps/fixtures/demo/.env.local"] }) })], "is a .env file"],
    ["a missing {ds} start script", [entry({ run: { ...entry().run, start: "bun {ds}/apps/fixtures/demo/gone.ts" } })], "names {ds}/apps/fixtures/demo/gone.ts"],
    ["a placeholder for an undeclared port", [entry({ run: { ...entry().run, start: "bun {ds}/apps/fixtures/demo/serve.ts --port {port:api}" } })], "{port:api} names no runProfile.ports entry"],
    ["a proven profile without a date", [entry({ runProfile: profile({ proof: { status: "proven", method: "x" } }) })], "needs proof.method and proof.date"],
    ["a runnable app with an unproven profile", [entry({ runProfile: profile({ proof: { status: "unproven", method: "" } }) })], "needs a proven run profile"],
    ["verify required with run mode none", [entry({ run: { mode: "none", reason: "blocked" } })], "gates.verify is required but run mode is none"],
  ])("reports %s", (_, apps, message) => {
    const problems = check(apps);
    expect(problems.some((p) => p.includes(message))).toBe(true);
  });

  test("reports an allowlist entry without a reason", () => {
    const { root, ds } = makeTrees();
    writeFileSync(join(ds, "apps/allowlists/demo.json"), JSON.stringify({ literals: [{ file: "app/src/x.ts" }], twClasses: [] }));
    expect(checkRegistry({ version: 1, apps: [entry()] }, { root, dsRoot: ds })).toContain("demo: allowlist literals[0] has no reason");
  });
});

describe("registry:check keeps runs off the owner's ports and .env files", () => {
  const profile = (over: Partial<AppEntry["runProfile"]>) => ({ ...entry().runProfile, ...over });
  const safe = (cmd: string) => ({ tests: { safe: [{ cmd, cwd: "app" }] } });

  test.each<[string, Partial<AppEntry>, string]>([
    ["an owner port in allowedLocalPorts", { runProfile: profile({ allowedLocalPorts: [4820] }) }, "allowedLocalPorts lists owner port 4820"],
    ["an allowed local port outside the block", { runProfile: profile({ allowedLocalPorts: [47011] }) }, "allowedLocalPorts port 47011 is outside its block 47000-47009"],
    ["an owner port in an env URL", { runProfile: profile({ env: { STUDIO_URL: "http://localhost:3999" } }) }, "runProfile.env.STUDIO_URL names owner port 3999"],
    ["a loopback port outside the block in an env URL", { runProfile: profile({ env: { API: "http://127.0.0.1:47130/api" } }) }, "runProfile.env.API names port 47130 outside its block"],
    ["a port option outside the block in the flags", { runProfile: profile({ flags: ["--kernel-port", "47990"] }) }, "runProfile.flags names port 47990 outside its block"],
    ["an owner port in a safe test command", safe("bun --no-env-file test --port=4840"), "tests.safe[0] names owner port 4840"],
    ["a bun test without --no-env-file", safe("bun test src"), "tests.safe[0] runs bun without --no-env-file"],
    ["a bun script without --no-env-file after a cd", safe("cd sub && exec bun run typecheck"), "runs bun without --no-env-file"],
    ["utilityClasses on a Tailwind app", { stack: { summary: "", tailwind: "v4", packageManager: "bun", utilityClasses: true } }, "stack.utilityClasses is redundant"],
  ])("reports %s", (_, over, message) => {
    const problems = check([entry(over)]);
    expect(problems.some((p) => p.includes(message))).toBe(true);
  });

  test("accepts the app's own ports, placeholders, bun x and --no-env-file", () => {
    const ok = entry({
      run: { ...entry().run, start: "bun --no-env-file {ds}/apps/fixtures/demo/serve.ts --port {port:ui} && bun x --bun vite" },
      runProfile: profile({ env: { KERNEL: "http://127.0.0.1:{port:ui}", OWN: "http://localhost:47009" }, flags: ["--api-port", "47001"], allowedLocalPorts: [47008] }),
      tests: { safe: [{ cmd: "bunx --bun tsc && bun --no-env-file test ./src/a.test.ts", cwd: "app" }] },
      stack: { summary: "", tailwind: "none", packageManager: "bun", utilityClasses: true },
    });
    expect(check([ok])).toEqual([]);
  });
});

describe("the committed apps.json", () => {
  // The mirror during the rollout, the owner's tree after merge. Skipped where neither tree exists.
  const root = [process.env.DS_MIRROR, resolve(DESIGN_SYSTEM_ROOT, "..")].find((r) => r && existsSync(join(r, "codecaine/core")));
  test.skipIf(!root)("passes registry:check against the workspace tree", () => {
    expect(checkRegistry(loadRegistry(), { root: root!, dsRoot: DESIGN_SYSTEM_ROOT })).toEqual([]);
  });
});
