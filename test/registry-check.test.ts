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

/** One probe per role: page, panel, text, border. */
const PROBES = [
  { selector: "body", property: "background-color", token: "color.surface.page" },
  { selector: ".panel", property: "background-color", token: "color.surface.panel" },
  { selector: "body", property: "color", token: "color.text.body" },
  { selector: ".panel", property: "border-top-color", token: "color.border.default" },
];

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
    verify: { probes: PROBES, darkSwitch: { kind: "attribute" } },
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

  test("a role is covered in each checked theme by a probe active there or by a waiver for that theme with a reason", () => {
    const attribute = { kind: "attribute" as const };
    // An explicit role on a property the role does not read holds only with a roleReason.
    const border = { selector: "hr", property: "color", token: "color.status.neutral.line", role: "border" as const, roleReason: "the hr draws its rule in currentColor" };
    expect(check([entry({ verify: { probes: [...PROBES.slice(0, 3), border], darkSwitch: attribute } })])).toEqual([]);
    const waived = { probes: PROBES.slice(0, 3), waivedRoles: [{ role: "border" as const, reason: "a canvas app with no bordered chrome" }], darkSwitch: attribute };
    expect(check([entry({ verify: waived })])).toEqual([]);
    // A probe limited to light covers its role in light only: dark needs a probe or a waiver for dark.
    const lightOnlyPanel = [PROBES[0]!, { ...PROBES[1]!, themes: ["light" as const] }, ...PROBES.slice(2)];
    expect(check([entry({ verify: { probes: lightOnlyPanel, darkSwitch: attribute } })])).toContain(
      'demo: verify.probes has no panel probe checked in dark (add one, or a verify.waivedRoles entry { role, themes: ["dark"], reason })',
    );
    const darkWaiver = [{ role: "panel" as const, themes: ["dark" as const], reason: "the panel is board data, drawn light in both themes" }];
    expect(check([entry({ verify: { probes: lightOnlyPanel, waivedRoles: darkWaiver, darkSwitch: attribute } })])).toEqual([]);
    // SVG roles: fill paints a page, a panel or text; stroke draws a border.
    const svg = [
      { selector: "svg rect.bg", property: "fill", token: "color.surface.page" },
      { selector: "svg rect.box", property: "fill", token: "color.surface.panel" },
      { selector: "svg text", property: "fill", token: "color.text.body" },
      { selector: "svg rect.box", property: "stroke", token: "color.border.default" },
    ];
    expect(check([entry({ verify: { probes: svg, darkSwitch: attribute } })])).toEqual([]);
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
    [
      "verify probes that miss a role",
      [entry({ verify: { probes: PROBES.slice(0, 3), darkSwitch: { kind: "attribute" } } })],
      "verify.probes has no border probe",
    ],
    [
      "a page probe limited to light on a light-dark app",
      [entry({ verify: { probes: [{ ...PROBES[0]!, themes: ["light"] }, ...PROBES.slice(1)], darkSwitch: { kind: "attribute" } } })],
      "verify.probes has no page probe checked in dark",
    ],
    [
      "a role waiver without a reason",
      [entry({ verify: { probes: PROBES.slice(0, 3), waivedRoles: [{ role: "border", reason: " " }], darkSwitch: { kind: "attribute" } } })],
      "verify.probes has no border probe",
    ],
    [
      "a role probed only in dark on a light-dark app",
      [entry({ verify: { probes: [...PROBES.slice(0, 2), { ...PROBES[2]!, themes: ["dark"] }, PROBES[3]!], darkSwitch: { kind: "attribute" } } })],
      'verify.probes has no text probe checked in light (add one, or a verify.waivedRoles entry { role, themes: ["light"], reason })',
    ],
    [
      "a waiver for a theme a dark-first app is not checked in",
      [entry({ theme: { rule: "dark-first" }, verify: { probes: PROBES.slice(0, 3), waivedRoles: [{ role: "border", themes: ["light"], reason: "no border in light" }], darkSwitch: { kind: "attribute" } } })],
      "verify.waivedRoles[0] (border) waives light, a theme the app is not checked in (dark)",
    ],
    [
      "a waiver with an empty themes list",
      [entry({ verify: { probes: PROBES.slice(0, 3), waivedRoles: [{ role: "border", themes: [], reason: "no border" }], darkSwitch: { kind: "attribute" } } })],
      "verify.waivedRoles[0] (border) has an empty themes list",
    ],
    [
      "a waiver for a role that is not a probe role",
      [entry({ verify: { probes: PROBES, waivedRoles: [{ role: "chrome" as never, reason: "no chrome" }], darkSwitch: { kind: "attribute" } } })],
      'verify.waivedRoles[0] role "chrome" is not one of page, panel, text, border',
    ],
    [
      "a page probe on a property the page role does not read",
      [entry({ verify: { probes: [{ selector: "body", property: "color", token: "color.surface.page" }, ...PROBES.slice(1)], darkSwitch: { kind: "attribute" } } })],
      "verify.probes[0] (body color) is a page probe, but a page probe reads background-color or fill",
    ],
    [
      "an explicit border role on color without a roleReason",
      [entry({ verify: { probes: [...PROBES.slice(0, 3), { selector: "hr", property: "color", token: "color.status.neutral.line", role: "border", roleReason: " " }], darkSwitch: { kind: "attribute" } } })],
      "verify.probes[3] (hr color) is a border probe, but a border probe reads border-*-color, outline-color or stroke",
    ],
    [
      "a role with a light-only and a dark-only probe but none checked in both themes",
      [entry({ verify: { probes: [PROBES[0]!, { ...PROBES[1]!, themes: ["light"] }, { ...PROBES[1]!, selector: ".aside", themes: ["dark"] }, ...PROBES.slice(2)], darkSwitch: { kind: "attribute" } } })],
      "verify.probes has no panel probe checked in both light and dark: theme.switch cannot show the dark switch reaches panel",
    ],
    ["a route id that climbs out of the output dir", [entry({ routes: [{ id: "../x", path: "/" }] })], 'demo: route id "../x" does not match'],
    ["a route id with a separator", [entry({ routes: [{ id: "a/b", path: "/" }] })], 'demo: route id "a/b" does not match'],
    ["an unsafe verify.route", [entry({ routes: [{ id: "a/b", path: "/" }], verify: { route: "a/b", probes: PROBES, darkSwitch: { kind: "attribute" } } })], 'demo: verify.route "a/b" does not match'],
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
    ["a bun behind timeout without --no-env-file", safe("timeout 60 bun test src"), "runs bun without --no-env-file"],
    ["a bun behind env -i without --no-env-file", safe("env -i PATH=/usr/bin bun run x"), "runs bun without --no-env-file"],
    ["an explicit --env-file", safe("bun --no-env-file --env-file secrets.local test src"), "passes --env-file"],
    ["utilityClasses on a Tailwind app", { stack: { summary: "", tailwind: "v4", packageManager: "bun", utilityClasses: true, hostTailwind: "v4" } }, "stack.utilityClasses is redundant"],
    ["a baseline for a command the entry lacks", { tests: { safe: [], baselines: { "tests.safe[0]": { exit: 1, date: "2026-10-05", method: "test:apps" } } } }, `tests.baselines["tests.safe[0]"] names no command`],
    ["a baseline recorded for another command", { tests: { safe: [{ cmd: "true", cwd: "app" }], baselines: { "tests.safe[0]": { cmd: "false", exit: 1, date: "2026-10-05", method: "test:apps" } } } }, "was recorded for another command (false)"],
    ["a baseline without a date", { tests: { safe: [{ cmd: "true", cwd: "app" }], baselines: { "tests.safe[0]": { exit: 1, method: "test:apps" } as never } } }, "needs a YYYY-MM-DD date"],
    ["utilityClasses without the host's Tailwind", { stack: { summary: "", tailwind: "none", packageManager: "bun", utilityClasses: true } }, "stack.utilityClasses needs stack.hostTailwind"],
    ["a hostTailwind that is no Tailwind", { stack: { summary: "", tailwind: "none", packageManager: "bun", utilityClasses: true, hostTailwind: "v2" as never } }, "stack.hostTailwind must be one of v3, v4, uno"],
    ["a hostTailwind without utilityClasses", { stack: { summary: "", tailwind: "none", packageManager: "bun", hostTailwind: "v3" } }, "stack.hostTailwind is set without stack.utilityClasses"],
    ["bunx without --no-env-file", safe("bunx --bun tsc"), "tests.safe[0] runs bun without --no-env-file"],
    ["bun x without --no-env-file", safe("bun x --bun vite build"), "tests.safe[0] runs bun without --no-env-file"],
    ["bun after a lone &", safe("true & bun run dev"), "runs bun without --no-env-file"],
    ["bun in a subshell", safe("(bun run dev)"), "runs bun without --no-env-file"],
    ["--no-env-file after the script", safe("bun run typecheck --no-env-file"), "tests.safe[0] puts --no-env-file after typecheck"],
    ["--no-env-file after the file", safe("bun file.ts --no-env-file"), "tests.safe[0] puts --no-env-file after file.ts"],
    ["an encoded owner port in a route path", { routes: [{ id: "home", path: "/?next=http%3A%2F%2Flocalhost%3A4840" }] }, "routes[0].path names owner port 4840"],
    ["a loopback URL in a route's waitFor", { routes: [{ id: "home", path: "/", waitFor: 'iframe[src="http://localhost/app"]' }] }, "routes[0].waitFor names loopback URL http://localhost/app without an explicit port"],
    [
      "a loopback port in a route step's target",
      { routes: [{ id: "home", path: "/", steps: [{ action: "click", target: 'a[href="http://127.0.0.1:47130"]' }] }] },
      "routes[0].steps[0].target names port 47130 outside its block",
    ],
    ["an owner port in a route step's value", { routes: [{ id: "home", path: "/", steps: [{ action: "press", target: "#api", value: "localhost:5432" }] }] }, "routes[0].steps[0].value names owner port 5432"],
    [
      "a port in a storage darkSwitch value",
      { verify: { probes: PROBES, darkSwitch: { kind: "storage", key: "api", value: '{"port":47130}' } } },
      "verify.darkSwitch.value names port 47130 outside its block",
    ],
    [
      "a loopback URL in a darkSwitch step",
      { verify: { probes: PROBES, darkSwitch: { kind: "steps", steps: [{ action: "click", target: 'a[href="https://localhost"]' }] } } },
      "verify.darkSwitch.steps[0].target names loopback URL https://localhost without an explicit port",
    ],
  ])("reports %s", (_, over, message) => {
    const problems = check([entry(over)]);
    expect(problems.some((p) => p.includes(message))).toBe(true);
  });

  const env = (value: string) => entry({ runProfile: profile({ env: { API: value } }) });
  test.each([
    "localhost.:47130",
    "LOCALHOST:47130",
    "127.0.1:47130",
    "127.1%3A47130",
    "[::ffff:127.0.0.1]:47130",
    "[0:0:0:0:0:0:0:1]:47130",
    "http://127.1:47130/api",
    "http://[::ffff:7f00:1]:47130",
    "http://0x7f.1:47130",
  ])("reports the loopback port outside the block in %s", (value) => {
    expect(check([env(value)]).some((p) => p.includes("runProfile.env.API names port 47130 outside its block 47000-47009"))).toBe(true);
  });

  test.each(["http://localhost/x", "https://127.0.0.1", "postgres://localhost/db", "redis://127.0.0.1", "ws://[::1]/", "postgres://u:p@localhost/db"])(
    "reports the loopback URL %s, which has no explicit port",
    (url) => {
      expect(check([env(url)]).some((p) => p.includes(`runProfile.env.API names loopback URL ${url} without an explicit port`))).toBe(true);
    },
  );

  test.each(["-p 47130", "-p47130", "-p=47130", "--port:47130", "--Port 47130", "-port 47130", "port=47130", "api_port:47130"])("reports the port option %s outside the block", (flag) => {
    const problems = check([entry({ runProfile: profile({ flags: [flag] }) })]);
    expect(problems.some((p) => p.includes("runProfile.flags names port 47130 outside its block"))).toBe(true);
  });

  test("accepts the app's own ports, placeholders, non-port options and bun runs that pass --no-env-file first", () => {
    const ok = entry({
      run: { ...entry().run, start: "bun --no-env-file {ds}/apps/fixtures/demo/serve.ts --port {port:ui} -p {port:ui} --strictPort --host 127.0.0.1 && bun --no-env-file x --bun vite" },
      commands: { cwd: "app", install: "bun install --frozen-lockfile", build: "bun x --no-env-file --bun vite build", typecheck: "bunx --no-env-file --bun tsc -p tsconfig.json" },
      runProfile: profile({
        env: { KERNEL: "http://127.0.0.1:{port:ui}", OWN: "http://localhost:47009", HOSTS: "file://localhost/etc/hosts" },
        flags: ["--api-port", "47001", "--report", "x"],
        allowedLocalPorts: [47008],
      }),
      tests: {
        safe: [
          { cmd: "export FOO=1 && bun --no-env-file run typecheck && bun run --no-env-file lint && mkdir -p {tmp}/x", cwd: "app" },
          { cmd: "bun --no-env-file test src && bun test --no-env-file ./src/a.test.ts && bun --version", cwd: "app" },
        ],
      },
      routes: [{ id: "home", path: "/?api=http://127.0.0.1:{port:ui}", waitFor: "main", steps: [{ action: "scroll", target: "main", value: 5173 }] }],
      stack: { summary: "", tailwind: "none", packageManager: "bun", utilityClasses: true, hostTailwind: "uno" },
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
