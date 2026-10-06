/**
 * use:app: the safety rules (what it may click, what it hovers), the visit plan, when a run fails, the
 * CLI's refusals, and the CLI end to end on a stand-in server (test/fixtures/verify/serve.ts, not an app):
 * a route whose step clicks a submit button in a form, or a control named like a write, is refused and
 * never clicked; console errors and failed requests are recorded per route and theme; the shell's
 * sidebar is toggled and restored; hovers skip disabled and in-form controls; the log and screenshots
 * land under <out>/<app>/use-app/.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Step } from "../scripts/lib/capture.ts";
import type { AppEntry, RouteSpec } from "../scripts/lib/registry.ts";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { judge, stampOf, type Visit, visitPlan } from "../scripts/lib/use-app/log.ts";
import { type ElementInfo, hoverTargets, stepRefusal } from "../scripts/lib/use-app/safety.ts";
import { main } from "../scripts/use-app.ts";
import { finishScratch } from "./leaks.ts";
import { snapshotApp, writeRegistry } from "./snapshot-support.ts";
import { browserSkip, FIXTURES, MIRROR } from "./verify-support.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-use-app-")));
afterAll(async () => {
  try {
    await finishScratch(scratch); // stop what this file started, clean crashed runs' records, then no listener may be left
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const el = (over: Partial<ElementInfo> = {}): ElementInfo => ({ name: "button", submit: false, inForm: false, labels: [], visible: true, enabled: true, ...over });

test("the step safety filter refuses submit, form and write-named targets, and passes plain view steps", () => {
  const cases: Array<[string, Step, ElementInfo | null, RegExp | null]> = [
    ["a submit button", { action: "click", target: "button.go" }, el({ submit: true, inForm: true }), /submit control/],
    ["a plain button inside a form", { action: "click", target: ".row button" }, el({ inForm: true }), /inside a <form>/],
    ["a control titled Delete", { action: "click", target: ".icon" }, el({ labels: ["Delete draft"] }), /names a write/],
    ["a control whose text says Saved", { action: "click", target: ".status" }, el({ labels: ["Saved changes"] }), /names a write/],
    ["a selector naming send", { action: "click", target: 'button:has-text("Send")' }, null, /selector .* names a write/],
    ["Enter on a focused field in a form", { action: "press", value: "Enter" }, el({ inForm: true }), /inside a <form>/],
    ["Control+Enter on a sync button", { action: "press", target: ".btn", value: "Control+Enter" }, el({ labels: ["Sync now"] }), /names a write/],
    ["a view toggle", { action: "click", target: ".rail-section-toggle" }, el({ labels: ["Collapse surface"] }), null],
    ["the registry's example card", { action: "click", target: 'button[title="Open a new draft seeded from Login flow"]' }, el({ labels: ["Open a new draft seeded from Login flow", "Login flow Example"] }), null],
    ["Escape in a form (not an activation key)", { action: "press", value: "Escape" }, el({ inForm: true }), null],
    ["a hover on a Delete button (hovers never activate)", { action: "hover", target: ".delete" }, el({ labels: ["Delete"] }), null],
    ["a word that only contains a write word", { action: "click", target: ".async-panel" }, el({ labels: ["Unsaved preview"] }), null],
  ];
  for (const [name, step, target, expected] of cases) {
    const reason = stepRefusal(step, target);
    if (expected) expect([name, reason]).toEqual([name, expect.stringMatching(expected)]);
    else expect([name, reason]).toEqual([name, null]);
  }
});

test("hovers go to visible, enabled controls outside forms, in document order, at most the cap", () => {
  const infos = [el({ name: "a" }), el({ name: "hidden", visible: false }), el({ name: "disabled", enabled: false }), el({ name: "in form", inForm: true }), null, el({ name: "b" }), el({ name: "c" })];
  expect(hoverTargets(infos).map((i) => infos[i]!.name)).toEqual(["a", "b", "c"]);
  expect(hoverTargets(infos, 2).map((i) => infos[i]!.name)).toEqual(["a", "b"]);
});

test("the visit plan: every route light then dark, dark only on a dark-first app, a route's own themes win", () => {
  const routes: RouteSpec[] = [
    { id: "home", path: "/" },
    { id: "print", path: "/print", themes: ["light"] },
  ];
  const plan = (rule: "light-dark" | "dark-first") => visitPlan({ theme: { rule }, routes } as AppEntry).map(({ route, theme }) => `${route.id}-${theme}`);
  expect(plan("light-dark")).toEqual(["home-light", "home-dark", "print-light"]);
  expect(plan("dark-first")).toEqual(["home-dark", "print-light"]);
});

test("a run fails on a console error, a failed request, an unexpected block, a failed or refused step, or an isolation problem; hover errors and expected blocks do not", () => {
  const visit = (over: Partial<Visit> = {}): Visit => ({
    route: "home",
    theme: "light",
    url: "http://127.0.0.1:47010/",
    themeMethod: "default",
    actions: [{ kind: "goto", target: "http://127.0.0.1:47010/", ok: true }],
    screenshots: [],
    consoleErrors: [],
    failedRequests: [],
    blocked: [],
    expectedBlocked: [],
    ...over,
  });
  const clean = { violations: [], unproven: false, unsandboxed: false };
  const cases: Array<[string, Visit, typeof clean, boolean]> = [
    ["clean", visit(), clean, true],
    ["a hover that did not happen", visit({ actions: [{ kind: "hover", target: "button", ok: false, error: "covered" }] }), clean, true],
    ["an expected block", visit({ expectedBlocked: ["GET http://127.0.0.1:47011/api"] }), clean, true],
    ["a skipped sidebar toggle", visit({ actions: [{ kind: "sidebar-toggle", target: ".ds-sidebar-toggle", ok: true, skipped: "none" }] }), clean, true],
    ["a console error", visit({ consoleErrors: ["boom"] }), clean, false],
    ["a failed request", visit({ failedRequests: ["404 GET http://127.0.0.1:47010/x.png"] }), clean, false],
    ["an unexpected block", visit({ blocked: ["GET http://127.0.0.1:4820/"] }), clean, false],
    ["a refused step", visit({ actions: [{ kind: "step", target: "click .go", ok: false, refused: "submit" }] }), clean, false],
    ["a failed screenshot", visit({ actions: [{ kind: "screenshot", target: "loaded", ok: false, error: "closed" }] }), clean, false],
    ["an isolation violation", visit(), { ...clean, violations: ["egress: x"] }, false],
    ["an unsandboxed run", visit(), { ...clean, unsandboxed: true }, false],
  ];
  for (const [name, v, isolation, ok] of cases) expect([name, judge([v], isolation).ok]).toEqual([name, ok]);
  expect(judge([visit()], clean, ["the app did not start"]).problems).toEqual(["the app did not start"]);
});

// -- the CLI --------------------------------------------------------------------------

const waived = (["page", "panel", "text", "border"] as const).map((role) => ({ role, reason: "a use:app stand-in page" }));
const NA = { required: false, reason: "a use:app stand-in" } as const;

/** A root with the stand-in server and `pages` at app/, and Playwright from the mirror (as every tool loads it). */
function tree(pages: Record<string, string> = {}): string {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "app"));
  cpSync(join(FIXTURES, "serve.ts"), join(root, "app/serve.ts"));
  for (const [file, html] of Object.entries(pages)) writeFileSync(join(root, "app", file), html);
  mkdirSync(join(root, "codecaine"));
  symlinkSync(join(MIRROR, "codecaine/core"), join(root, "codecaine/core"));
  return root;
}

function registryFile(apps: AppEntry[]): string {
  const path = join(mkdtempSync(join(scratch, "registry-")), "apps.json");
  writeRegistry(path, apps);
  return path;
}

const cli = (args: string[]) => Bun.spawnSync([process.execPath, join(DESIGN_SYSTEM_ROOT, "scripts/use-app.ts"), ...args], { env: { ...process.env } });

/** The one log under <out>/<app>/use-app/, its path, and the stamp that names it. */
function readLog(out: string, app: string) {
  const dir = join(out, app, "use-app");
  const file = readdirSync(dir).find((name) => name.endsWith(".json"))!;
  const log = JSON.parse(readFileSync(join(dir, file), "utf8"));
  return { log, file, dir };
}

describe("refusals", () => {
  const ports = (ui: number) => ({ ...snapshotApp().runProfile, ports: { ui } });
  const none = snapshotApp({ id: "idle", run: { mode: "none", reason: "a library" }, gates: { ...snapshotApp().gates, snapshot: NA, pixelDiff: NA }, runProfile: ports(46927) });
  const electron = snapshotApp({ id: "desk", run: { mode: "electron", electron: { build: "true", main: "main.js" } }, runProfile: ports(46928) });
  const registry = registryFile([none, electron]);
  const out = join(scratch, "refusals-out");
  const args = (...extra: string[]) => [...extra, "--registry", registry, "--out-dir", out];

  test.each([
    ["no --app", args(), 2, /--app is required/],
    ["an unknown option", args("--app", "idle", "--bogus"), 2, /unknown option --bogus/],
    ["an --out-dir inside a git checkout", ["--app", "idle", "--registry", registry, "--out-dir", join(DESIGN_SYSTEM_ROOT, "use-app-out")], 2, /inside the git checkout/],
    ["an app the registry does not list", args("--app", "nope"), 2, /no app "nope"/],
    ["an Electron app without the opt-in", args("--app", "desk"), 2, /desk: Electron runs are refused/],
    ["run mode none", args("--app", "idle"), 0, /idle: run mode none \(a library\): nothing to run/],
  ] as Array<[string, string[], number, RegExp]>)("%s exits %d", async (_name, argv, code, message) => {
    const optIn = process.env.DS_ALLOW_ELECTRON;
    delete process.env.DS_ALLOW_ELECTRON;
    const printed: string[] = [];
    const error = spyOn(console, "error").mockImplementation((line: unknown) => void printed.push(String(line)));
    const log = spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
    try {
      expect(await main(argv)).toBe(code);
    } finally {
      error.mockRestore();
      log.mockRestore();
      if (optIn !== undefined) process.env.DS_ALLOW_ELECTRON = optIn;
    }
    expect(printed.join("\n")).toMatch(message);
    expect(existsSync(out)).toBe(false); // nothing ran, nothing was written
  });
});

test("an app that does not start: the log is still written, named by the run's ISO time, and the run exits 1", () => {
  const root = tree();
  const out = join(scratch, "nostart-out");
  const app = snapshotApp({ run: { mode: "browser", cwd: "app", start: "echo boom; exit 3", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" }, runProfile: { ...snapshotApp().runProfile, ports: { ui: 46926 } } });
  const result = cli(["--app", "demo", "--root", root, "--registry", registryFile([app]), "--out-dir", out]);
  expect(result.exitCode).toBe(1);
  const { log, file, dir } = readLog(out, "demo");
  expect(file).toBe(`${stampOf(log.timestamp)}.json`);
  expect(log).toMatchObject({ app: "demo", root, ok: false, visits: [], startError: expect.stringContaining("did not start") });
  expect(existsSync(join(dir, stampOf(log.timestamp)))).toBe(true);
  expect(result.stdout.toString()).toContain(`FAIL -> ${join(dir, file)}`);
}, 60_000);

const HOME = `<!doctype html><html><head><title>home</title></head><body>
<a class="skip" href="#main" style="position: fixed; top: 8px; transform: translateY(-200%)">Skip to content</a>
<div class="ds-shell" data-sidebar="expanded">
  <button class="ds-sidebar-toggle" type="button">Toggle sidebar</button>
  <button class="reveal" type="button" onclick="this.insertAdjacentHTML('afterend', '<div class=&quot;revealed&quot;>revealed</div>')">Reveal</button>
  <a class="more" href="#more">Read more</a>
  <button class="trash" type="button" title="Delete everything" onclick="fetch('/deleted')">Trash</button>
  <button class="off" type="button" disabled>Off</button>
  <form onsubmit="event.preventDefault(); fetch('/submitted')"><input name="q" /><button class="go">Go</button></form>
</div>
<script>
  const shell = document.querySelector(".ds-shell");
  shell.dataset.sidebar = localStorage.getItem("demo.sidebar") ?? "expanded";
  document.querySelector(".ds-sidebar-toggle").addEventListener("click", () => {
    shell.dataset.sidebar = shell.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
    localStorage.setItem("demo.sidebar", shell.dataset.sidebar);
  });
</script></body></html>`;

/** A page with a console error, a missing image, a submit button in a form and a control named like a write. */
const TRAP = `<!doctype html><html><head><title>trap</title></head><body>
<img src="/missing.png" alt="" />
<form action="/submitted"><button class="go-it" type="submit">Go</button></form>
<button class="wipe" type="button" aria-label="Remove all drafts" onclick="fetch('/wiped')">x</button>
<script>console.error("boom")</script>
</body></html>`;

test.skipIf(Boolean(browserSkip))(
  "uses each route in each theme: refuses a submit and a write-named click, records errors, toggles the sidebar back, hovers what is safe",
  () => {
    const root = tree({ "index.html": HOME, "trap.html": TRAP });
    const out = join(scratch, "use-out");
    const app = snapshotApp({
      routes: [
        { id: "home", path: "/", steps: [{ action: "click", target: ".reveal" }], waitFor: ".revealed" },
        { id: "form", path: "/trap.html", themes: ["light"], steps: [{ action: "click", target: "form .go-it" }] },
        { id: "wipe", path: "/trap.html", themes: ["light"], steps: [{ action: "hover", target: ".wipe" }, { action: "click", target: ".wipe" }] },
      ],
      verify: { probes: [], waivedRoles: waived, darkSwitch: { kind: "attribute" }, sidebar: { storageKey: "demo.sidebar" } },
      runProfile: { ...snapshotApp().runProfile, ports: { ui: 46926 } },
    });
    const result = cli(["--app", "demo", "--root", root, "--registry", registryFile([app]), "--out-dir", out]);
    const { log, dir } = readLog(out, "demo");
    expect([result.exitCode, log.ok]).toEqual([1, false]);
    const visit = (route: string, theme: string) => log.visits.find((v: Visit) => v.route === route && v.theme === theme) as Visit;
    expect(log.visits.map((v: Visit) => `${v.route}-${v.theme}`)).toEqual(["home-light", "home-dark", "form-light", "wipe-light"]);

    for (const theme of ["light", "dark"]) {
      const home = visit("home", theme);
      expect([theme, home.consoleErrors, home.failedRequests, home.blocked]).toEqual([theme, [], [], []]);
      expect(home.actions.filter((a) => a.kind !== "hover").every((a) => a.ok)).toBe(true);
      expect(home.actions.filter((a) => a.kind === "sidebar-toggle").map((a) => a.target)).toEqual(["click .ds-sidebar-toggle >> nth=0", "restore click .ds-sidebar-toggle >> nth=0"]);
      // The disabled button, the one in the form and the skip link no scroll reaches are never hovered; the
      // Delete-titled one is (a hover activates nothing).
      expect(home.actions.filter((a) => a.kind === "hover").map((a) => [a.ok, a.target])).toEqual(
        ["Toggle sidebar", "Reveal", "Read more", "Delete everything"].map((label) => [true, expect.stringContaining(label)]),
      );
      expect(home.screenshots.map((path) => path.slice(path.lastIndexOf("/") + 1))).toEqual([`home-${theme}-1-loaded.png`, `home-${theme}-2-sidebar-toggled.png`]);
      for (const path of home.screenshots) expect([path.startsWith(`${join(dir, stampOf(log.timestamp))}/`), existsSync(path)]).toEqual([true, true]);
    }
    expect(visit("home", "dark").themeMethod).toBe("attribute");

    const form = visit("form", "light");
    const wipe = visit("wipe", "light");
    expect(form.actions.find((a) => a.refused)?.refused).toMatch(/submit control/);
    expect(wipe.actions.find((a) => a.refused)?.refused).toMatch(/"Remove all drafts" names a write/);
    expect(wipe.actions.find((a) => a.target === "hover .wipe")?.ok).toBe(true);
    for (const trap of [form, wipe]) {
      expect(trap.consoleErrors).toContain("boom");
      expect(trap.failedRequests).toContainEqual(expect.stringMatching(/^404 GET http:\/\/127\.0\.0\.1:46926\/missing\.png$/));
      // Refused means never clicked: neither the form's submit nor the wipe button's fetch happened.
      expect(trap.failedRequests.filter((request) => /submitted|wiped/.test(request))).toEqual([]);
    }
    expect(log.totals).toMatchObject({ visits: 4, refused: 2, failedActions: 0, blocked: 0, violations: 0 });
    expect(log.isolation.ok).toBe(true);
  },
  120_000,
);
