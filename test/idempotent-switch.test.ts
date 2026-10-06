/**
 * Idempotent theme switches and expected failed requests:
 * - `check` and `uncheck` steps set a checkbox, a role=switch or a role=checkbox to that state and do
 *   nothing when it is already there (Playwright setChecked), in runSteps and in use:app's safety rules;
 * - verify.lightSteps: themePlan and switchSteps run them in every light visit; entries without them get
 *   exactly the old plan and the old capture spec sha;
 * - validation of steps, lightSteps and verify.expectedFailures (reason required, a "^/" path pattern);
 * - expectedFailure matches only the app's own origin, the method, the status and the path pattern;
 * - end to end through use:app on a stand-in that saves its theme on its server
 *   (test/fixtures/use-app/persisted-theme-serve.ts, docs-workbench's failure): a click darkSwitch makes
 *   the second light visit load dark and the second dark visit toggle back to light; check/uncheck with
 *   lightSteps reach the right theme in every visit, and the expected 404 is reported apart.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startApp } from "../scripts/lib/app-runner.ts";
import { captureRoute, LAUNCH_OPTIONS, runSteps, type Step, switchSteps, themePlan } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { decodePng } from "../scripts/lib/png.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT, expectedFailure, type ExpectedFailure, validateRegistry, type VerifySpec } from "../scripts/lib/registry.ts";
import { captureSha256 } from "../scripts/lib/snapshot-set.ts";
import { judge, type Visit } from "../scripts/lib/use-app/log.ts";
import { activates, describeElement, type ElementInfo, stepRefusal, stepSelector } from "../scripts/lib/use-app/safety.ts";
import { checkPage } from "../scripts/lib/verify/page-checks.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";
import { finishScratch } from "./leaks.ts";
import { snapshotApp, writeRegistry } from "./snapshot-support.ts";
import { browserSkip, fixtureFontSource, MIRROR } from "./verify-support.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-idempotent-switch-")));
afterAll(async () => {
  try {
    await finishScratch(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const waived = (["page", "panel", "text", "border"] as const).map((role) => ({ role, reason: "a stand-in page" }));
const clickDark: VerifySpec["darkSwitch"] = {
  kind: "steps",
  steps: [
    { action: "click", target: "button.colors" },
    { action: "click", target: "input.dark-toggle" },
    { action: "wait", target: 'html[data-theme="dark"]' },
  ],
};
const checkDark: VerifySpec["darkSwitch"] = {
  kind: "steps",
  steps: [
    { action: "click", target: "button.colors" },
    { action: "check", target: "input.dark-toggle" },
    { action: "wait", target: 'html[data-theme="dark"]' },
  ],
};
const uncheckLight: Step[] = [
  { action: "click", target: "button.colors" },
  { action: "uncheck", target: "input.dark-toggle" },
  { action: "wait", target: 'html[data-theme="light"]' },
];
const themeMissing: ExpectedFailure = { method: "GET", urlPattern: "^/api/theme$", status: 404, reason: "no theme is saved until the first switch; the app renders light" };

const entry = (verify: Partial<VerifySpec> = {}, over: Partial<AppEntry> = {}) =>
  snapshotApp({ verify: { probes: [], waivedRoles: waived, darkSwitch: clickDark, ...verify }, ...over });
const problemsOf = (app: AppEntry) => validateRegistry({ version: 1, apps: [app] });

// -- the registry ------------------------------------------------------------------------

test("validation: step actions, check/uncheck targets, lightSteps and expectedFailures", () => {
  expect(problemsOf(entry({ darkSwitch: checkDark, lightSteps: uncheckLight, expectedFailures: [themeMissing] }))).toEqual([]);
  const cases: Array<[string, AppEntry, RegExp]> = [
    ["an unknown route step action", entry({}, { routes: [{ id: "home", path: "/", steps: [{ action: "tick" as never, target: "x" }] }] }), /routes\.home\.steps\[0\]\.action "tick" is not one of click, press, hover, scroll, wait, check, uncheck/],
    ["check without a target", entry({ darkSwitch: { kind: "steps", steps: [{ action: "check" }] } }), /verify\.darkSwitch\.steps\[0\]: check needs a target selector/],
    ["empty lightSteps", entry({ lightSteps: [] }), /verify\.lightSteps is empty/],
    ["lightSteps not an array", entry({ lightSteps: { action: "uncheck" } as never }), /verify\.lightSteps must be an array of steps/],
    ["lightSteps with a lightSwitch", entry({ lightSteps: uncheckLight, lightSwitch: { kind: "storage", key: "mode", value: "light" } }), /lightSteps and verify\.lightSwitch are both set/],
    ["lightSteps on a dark-first entry", entry({ lightSteps: uncheckLight }, { theme: { rule: "dark-first" } }), /lightSteps is set on a dark-first entry/],
    ["an expected failure without a reason", entry({ expectedFailures: [{ ...themeMissing, reason: " " }] }), /expectedFailures\[0\] has no reason/],
    ["a full URL pattern", entry({ expectedFailures: [{ ...themeMissing, urlPattern: "^http://127.0.0.1:47021/api/theme$" }] }), /urlPattern must be a regular expression anchored at the start of a path/],
    ["an unanchored pattern", entry({ expectedFailures: [{ ...themeMissing, urlPattern: "/api/theme" }] }), /urlPattern must be a regular expression anchored/],
    ["a protocol-relative pattern", entry({ expectedFailures: [{ ...themeMissing, urlPattern: "^//evil.example/" }] }), /urlPattern must be a regular expression anchored/],
    ["a bad regex", entry({ expectedFailures: [{ ...themeMissing, urlPattern: "^/api/(" }] }), /urlPattern is not a valid regular expression/],
    // Blanket patterns: a top-level alternative past the anchor, or one that matches the root or a made-up path.
    ...["^/x|", "^/x|/", "^/api/theme$|.*", "^/", "^/.*$", "^/(?:)|.", "^/[^]*", "^/__ds_canary__"].map(
      (urlPattern): [string, AppEntry, RegExp] => [`blanket ${urlPattern}`, entry({ expectedFailures: [{ ...themeMissing, urlPattern }] }), /is a blanket pattern: it also matches/],
    ),
    ["a success status", entry({ expectedFailures: [{ ...themeMissing, status: 200 }] }), /status must be an HTTP error status/],
    ["a lower-case method", entry({ expectedFailures: [{ ...themeMissing, method: "get" }] }), /method must be an upper-case HTTP method/],
  ];
  for (const [name, app, message] of cases) expect([name, problemsOf(app).join("\n")]).toEqual([name, expect.stringMatching(message)]);
});

test("expectedFailure: the app's own origin, the method, the status and the path pattern, nothing else", () => {
  const origin = "http://127.0.0.1:47021";
  const list = [themeMissing, { method: "GET", urlPattern: "^/api/sequence\\?src=[^&]*login-flow\\.sequence\\.json$", status: 404, reason: "corpus bug" }];
  const hit = (method: string, url: string, status: number) => expectedFailure(list, origin, { method, url, status })?.reason ?? null;
  expect(hit("GET", `${origin}/api/theme`, 404)).toBe(themeMissing.reason);
  expect(hit("GET", `${origin}/api/sequence?src=docs%2F40-sequence%2Fassets%2Flogin-flow.sequence.json`, 404)).toBe("corpus bug");
  expect(hit("GET", `${origin}/api/theme#x`, 404)).toBe(themeMissing.reason); // the fragment is not part of the request
  for (const [method, url, status] of [
    ["POST", `${origin}/api/theme`, 404], // another method
    ["GET", `${origin}/api/theme`, 500], // another status
    ["GET", `${origin}/api/theme/x`, 404], // the pattern is anchored at both ends
    ["GET", "http://127.0.0.1:47020/api/theme", 404], // another port of the run
    ["GET", "http://localhost:47021/api/theme", 404], // another host spelling is another origin
    ["GET", "https://example.com/api/theme", 404],
  ] as const)
    expect([method, url, status, hit(method, url, status)]).toEqual([method, url, status, null]);
  expect(expectedFailure(list, undefined, { method: "GET", url: `${origin}/api/theme`, status: 404 })).toBeUndefined(); // no origin read: nothing is expected
  // Every alternative is anchored: "^/a|/b" is ^(?:/a|/b), so /b matches only at the start of the path.
  const both = [{ ...themeMissing, urlPattern: "^/api/theme$|/api/other$" }];
  expect(expectedFailure(both, origin, { method: "GET", url: `${origin}/api/other`, status: 404 })?.reason).toBe(themeMissing.reason);
  expect(expectedFailure(both, origin, { method: "GET", url: `${origin}/assets/api/other`, status: 404 })).toBeUndefined();
  // A blanket pattern that got past validation (a hand-edited log, a direct call) still excuses nothing.
  for (const urlPattern of ["^/api/theme$|", "^/x|/", "^/(?:)|.", "^/.*$", "^/"])
    expect([urlPattern, expectedFailure([{ ...themeMissing, urlPattern }], origin, { method: "GET", url: `${origin}/assets/app.js`, status: 404 })]).toEqual([urlPattern, undefined]);
  // Without a method (a console message), the URL and status decide.
  expect(expectedFailure(list, origin, { url: `${origin}/api/theme`, status: 404 })?.reason).toBe(themeMissing.reason);
  expect(expectedFailure(list, origin, { url: `${origin}/api/theme`, status: 500 })).toBeUndefined();
  expect(expectedFailure(undefined, origin, { method: "GET", url: `${origin}/api/theme`, status: 404 })).toBeUndefined();
});

test("themePlan and switchSteps: lightSteps in every light visit; entries without them get the old plan and sha", () => {
  const keys = (app: AppEntry, theme: "light" | "dark") => {
    const plan = themePlan(app, theme);
    return { keys: Object.keys(plan).sort(), method: plan.method, init: plan.init ?? null };
  };
  const old = entry();
  const withLight = entry({ darkSwitch: checkDark, lightSteps: uncheckLight });
  expect(keys(old, "light")).toEqual({ keys: ["afterLoad", "method", "url", "verify"], method: "default", init: null });
  expect(keys(withLight, "light")).toEqual({ keys: ["afterLoad", "method", "url", "verify"], method: "steps", init: null });
  expect(keys(withLight, "dark")).toEqual(keys(entry({ darkSwitch: checkDark }), "dark"));
  expect(switchSteps(old, "light")).toEqual([]);
  expect(switchSteps(old, "dark")).toEqual(clickDark.kind === "steps" ? clickDark.steps : []);
  expect(switchSteps(withLight, "light")).toEqual(uncheckLight);
  expect(switchSteps(entry({ darkSwitch: { kind: "click", selector: "#dark" } }), "dark")).toEqual([{ action: "click", target: "#dark" }]);
  expect(switchSteps(entry({ darkSwitch: { kind: "attribute" } }), "dark")).toEqual([]);
  // A dark-first entry never runs lightSteps (validation rejects them there too).
  expect(switchSteps(entry({ lightSteps: uncheckLight }, { theme: { rule: "dark-first" } }), "light")).toEqual([]);
  // The capture spec: unchanged without lightSteps; expectedFailures never change it.
  expect(captureSha256({ ...old, verify: { ...old.verify!, lightSteps: undefined } })).toBe(captureSha256(old));
  expect(captureSha256(entry({ expectedFailures: [themeMissing] }))).toBe(captureSha256(old));
  expect(captureSha256(entry({ lightSteps: uncheckLight }))).not.toBe(captureSha256(old));
});

test("use:app's safety rules treat check and uncheck as clicks", () => {
  const el = (over: Partial<ElementInfo> = {}): ElementInfo => ({ name: "input", submit: false, inForm: false, names: [], texts: [], visible: true, enabled: true, ...over });
  for (const action of ["check", "uncheck"] as const) {
    const step: Step = { action, target: "input.dark-toggle" };
    expect([action, activates(step), stepSelector(step)]).toEqual([action, true, "input.dark-toggle"]);
    expect(stepRefusal(step, el({ texts: ["Dark mode"] }))).toBeNull();
    expect(stepRefusal(step, el({ inForm: true }))).toMatch(/inside a <form>/);
    expect(stepRefusal(step, el({ names: ["Sync on save"] }))).toMatch(/names a write/);
    expect(stepRefusal({ action, target: "input.auto-save" }, null)).toMatch(/selector input\.auto-save names a write/);
  }
});

test("judge: expected failed requests are counted apart and never fail a run; the key is absent without them", () => {
  const visit = (over: Partial<Visit> = {}): Visit => ({
    route: "home",
    theme: "light",
    url: "http://127.0.0.1:47021/",
    themeMethod: "default",
    actions: [{ kind: "goto", target: "http://127.0.0.1:47021/", ok: true }],
    screenshots: [],
    consoleErrors: [],
    failedRequests: [],
    blocked: [],
    expectedBlocked: [],
    ...over,
  });
  const clean = { violations: [], unproven: false, unsandboxed: false };
  const expected = judge([visit({ expectedFailedRequests: ["404 GET http://127.0.0.1:47021/api/theme (expected: x)"] }), visit({ expectedFailedRequests: [] })], clean);
  expect([expected.ok, expected.totals.expectedFailedRequests, expected.totals.failedRequests]).toEqual([true, 1, 0]);
  expect("expectedFailedRequests" in judge([visit()], clean).totals).toBe(false);
  expect(judge([visit({ failedRequests: ["404 GET http://127.0.0.1:47021/other"], expectedFailedRequests: [] })], clean).ok).toBe(false);
});

// -- in a browser -----------------------------------------------------------------------

const TOGGLES = `<!doctype html><html><body>
<label>Native <input class="native" type="checkbox" /></label>
<div class="switch" role="switch" aria-checked="false" tabindex="0">Switch</div>
<div class="box" role="checkbox" aria-checked="true" tabindex="0">Box</div>
<script>
  window.clicks = { native: 0, switch: 0, box: 0 };
  document.querySelector(".native").addEventListener("click", () => window.clicks.native++);
  for (const name of ["switch", "box"]) {
    const el = document.querySelector("." + name);
    el.addEventListener("click", () => {
      window.clicks[name]++;
      el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true");
    });
  }
</script></body></html>`;

test.skipIf(Boolean(browserSkip))(
  "check and uncheck are idempotent on a checkbox input, a role=switch and a role=checkbox",
  async () => {
    const browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
    try {
      const page = await browser.newPage();
      await page.setContent(TOGGLES);
      const state = () =>
        page.evaluate(() => ({
          native: (document.querySelector(".native") as HTMLInputElement).checked,
          switch: document.querySelector(".switch")!.getAttribute("aria-checked"),
          box: document.querySelector(".box")!.getAttribute("aria-checked"),
          clicks: (window as any).clicks,
        }));
      const twice = (action: "check" | "uncheck") => ["native", "switch", "box"].flatMap((name): Step[] => [{ action, target: `.${name}` }, { action, target: `.${name}` }]);
      await runSteps(page, twice("check"));
      // The box started checked: its two checks clicked nothing. The others were clicked once each.
      expect(await state()).toEqual({ native: true, switch: "true", box: "true", clicks: { native: 1, switch: 1, box: 0 } });
      await runSteps(page, twice("uncheck"));
      expect(await state()).toEqual({ native: false, switch: "false", box: "false", clicks: { native: 2, switch: 2, box: 1 } });
    } finally {
      await browser.close();
    }
  },
  60_000,
);

/** A root with the persisted-theme stand-in at app/ (index.html), and Playwright from the mirror. */
function tree(pages: Record<string, string> = {}): string {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "app"));
  for (const [file, html] of Object.entries(pages)) writeFileSync(join(root, "app", file), html);
  cpSync(join(import.meta.dir, "fixtures/use-app/persisted-theme-serve.ts"), join(root, "app/serve.ts"));
  cpSync(join(import.meta.dir, "fixtures/use-app/persisted-theme.html"), join(root, "app/index.html"));
  mkdirSync(join(root, "codecaine"));
  symlinkSync(join(MIRROR, "codecaine/core"), join(root, "codecaine/core"));
  return root;
}

/** Runs use:app on the stand-in with `verify`; the log, and per visit its theme, its steps and the loaded shot's top-left pixel. */
function useApp(name: string, port: number, verify: Partial<VerifySpec>) {
  const root = tree();
  const out = join(scratch, `${name}-out`);
  const registry = join(mkdtempSync(join(scratch, "registry-")), "apps.json");
  const routes = ["one", "two"].map((id) => ({ id, path: "/", waitFor: "p.ready" }));
  writeRegistry(registry, [entry(verify, { routes, runProfile: { ...snapshotApp().runProfile, ports: { ui: port } } })]);
  const result = Bun.spawnSync([process.execPath, join(DESIGN_SYSTEM_ROOT, "scripts/use-app.ts"), "--app", "demo", "--root", root, "--registry", registry, "--out-dir", out], { env: { ...process.env } });
  const dir = join(out, "demo", "use-app");
  const log = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((file) => file.endsWith(".json"))!), "utf8"));
  const seen = (log.visits as Visit[]).map((visit) => {
    const shot = visit.screenshots.find((path) => /-(loaded|stopped)\.png$/.test(path));
    const pixel = shot ? decodePng(readFileSync(shot)).data[0] : undefined;
    const failed = visit.actions.filter((a) => a.kind === "step" && !a.ok).map((a) => a.target);
    return `${visit.route}-${visit.theme}: ${pixel === 0 ? "dark" : pixel === 255 ? "light" : `pixel ${pixel}`}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`;
  });
  return { exitCode: result.exitCode, log, seen, stdout: result.stdout.toString() };
}

test.skipIf(Boolean(browserSkip))(
  "before: a click darkSwitch on a theme the server keeps loads the second light visit dark and toggles the second dark visit back to light",
  () => {
    const { exitCode, log, seen } = useApp("before", 46951, {});
    expect(seen).toEqual([
      "one-light: light",
      "one-dark: dark",
      "two-light: dark", // the wrong theme: the first dark visit's choice was saved on the server
      'two-dark: light (failed: darkSwitch wait html[data-theme="dark"])', // the click toggled it back
    ]);
    // Without verify.expectedFailures, the first loads' 404 is a failed request and a console error.
    expect(log.visits[0].failedRequests).toEqual(["404 GET http://127.0.0.1:46951/api/theme"]);
    expect(log.visits[0].consoleErrors).toEqual([expect.stringMatching(/^Failed to load resource: the server responded with a status of 404/)]);
    expect("expectedFailedRequests" in log.visits[0]).toBe(false);
    expect("expectedFailedRequests" in log.totals).toBe(false);
    expect([exitCode, log.ok]).toEqual([1, false]);
  },
  180_000,
);

test.skipIf(Boolean(browserSkip))(
  "after: check/uncheck with lightSteps reach the right theme in every visit, and the expected 404 is reported apart",
  () => {
    const { exitCode, log, seen, stdout } = useApp("after", 46952, { darkSwitch: checkDark, lightSteps: uncheckLight, expectedFailures: [themeMissing] });
    expect(seen).toEqual(["one-light: light", "one-dark: dark", "two-light: light", "two-dark: dark"]);
    expect(log.visits.map((visit: Visit) => [visit.themeMethod, visit.actions.filter((a) => a.kind === "step").map((a) => a.target)])).toEqual([
      ["steps", ["waitFor p.ready", "lightSteps click button.colors", "lightSteps uncheck input.dark-toggle", 'lightSteps wait html[data-theme="light"]']],
      ["steps", ["waitFor p.ready", "darkSwitch click button.colors", "darkSwitch check input.dark-toggle", 'darkSwitch wait html[data-theme="dark"]']],
      ["steps", ["waitFor p.ready", "lightSteps click button.colors", "lightSteps uncheck input.dark-toggle", 'lightSteps wait html[data-theme="light"]']],
      ["steps", ["waitFor p.ready", "darkSwitch click button.colors", "darkSwitch check input.dark-toggle", 'darkSwitch wait html[data-theme="dark"]']],
    ]);
    // The first two loads have no saved theme yet: their 404 (and its console error) is expected, with the reason.
    const expected = `404 GET http://127.0.0.1:46952/api/theme (expected: ${themeMissing.reason})`;
    expect(log.visits.map((visit: Visit) => [visit.failedRequests, visit.consoleErrors, visit.expectedFailedRequests])).toEqual([
      [[], [], [expected]],
      [[], [], [expected]],
      [[], [], []],
      [[], [], []],
    ]);
    expect(log.totals).toMatchObject({ failedRequests: 0, expectedFailedRequests: 2, consoleErrors: 0, failedActions: 0, refused: 0 });
    expect(stdout).toContain("failed requests 0 (expected 2)");
    expect([exitCode, log.ok]).toEqual([0, true]);
  },
  180_000,
);

test("skipLightSteps: a route without the theme control skips lightSteps, with a reason, only beside lightSteps", () => {
  const playground = { id: "playground", path: "/playground.html", themes: ["light" as const], skipLightSteps: "draws both themes itself; no Style rail" };
  const app = entry({ darkSwitch: checkDark, lightSteps: uncheckLight }, { routes: [{ id: "home", path: "/" }, playground] });
  expect(problemsOf(app)).toEqual([]);
  expect(switchSteps(app, "light", app.routes[0])).toEqual(uncheckLight);
  expect(switchSteps(app, "light", playground)).toEqual([]);
  expect(themePlan(app, "light", playground).method).toBe("default");
  expect(problemsOf(entry({}, { routes: [playground] })).join("\n")).toMatch(/route playground sets skipLightSteps, but the entry has no verify\.lightSteps/);
  expect(problemsOf(entry({ lightSteps: uncheckLight }, { routes: [{ ...playground, skipLightSteps: " " }] })).join("\n")).toMatch(/skipLightSteps must be the reason/);
});

/**
 * Snapshot capture runs every route in one app run too (route by route, light then dark): the same failure
 * and the same fix, through captureRoute. Each case is its own app run, so the server starts with no theme.
 */
async function captureSequence(port: number, verify: Partial<VerifySpec>) {
  const root = tree();
  const app = entry(verify, { runProfile: { ...snapshotApp().runProfile, ports: { ui: port } } });
  const running = await startApp(app, { root, outDir: join(scratch, `capture-${port}`), timeoutMs: 20_000 });
  const browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
  const seen: string[] = [];
  try {
    for (const [id, theme] of [["one", "light"], ["one", "dark"], ["two", "light"], ["two", "dark"]] as const) {
      try {
        const result = await captureRoute(browser, running, { id, path: "/", waitFor: "p.ready", viewport: { width: 320, height: 200 } }, theme);
        const pixel = decodePng(result.png).data[0];
        seen.push(`${id}-${theme}: ${result.themeMethod} ${pixel === 0 ? "dark" : pixel === 255 ? "light" : `pixel ${pixel}`}`);
      } catch (error) {
        seen.push(`${id}-${theme}: failed: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    await browser.close();
    await running.stop();
  }
  return seen;
}

test.skipIf(Boolean(browserSkip))(
  "capture: a click darkSwitch leaks the saved dark into the next light shot; check/uncheck with lightSteps capture every shot in its theme",
  async () => {
    const before = await captureSequence(46953, {});
    expect(before.slice(0, 3)).toEqual(["one-light: default light", "one-dark: steps dark", "two-light: default dark"]);
    expect(before[3]).toBe("two-dark: failed: waitFor: Timeout 30000ms exceeded."); // the darkSwitch wait for dark: the click toggled the saved dark back to light
    expect(await captureSequence(46954, { darkSwitch: checkDark, lightSteps: uncheckLight })).toEqual([
      "one-light: steps light",
      "one-dark: steps dark",
      "two-light: steps light",
      "two-dark: steps dark",
    ]);
  },
  240_000,
);

// -- fix round 1: the accessible name, blanket patterns in a run, verify's lightSteps ----------------

/** Write-labelled toggles (each handler fetches /fired-<n>, a 404 a run would record), and docs-workbench's Dark mode row. */
const LABELLED = `<!doctype html><html><body>
<label>Delete all records<input id="wrapped" type="checkbox" onclick="fetch('/fired-wrapped')" /></label>
<label for="external">Remove every draft</label><input id="external" type="checkbox" onclick="fetch('/fired-external')" />
<span id="sync-label">Sync all folders</span>
<div id="switch" role="switch" aria-checked="true" aria-labelledby="sync-label" tabindex="0" onclick="fetch('/fired-switch'); this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')">on</div>
<label class="flex min-h-8 items-center justify-between gap-3 text-ui-xs"><span class="style-rail-row-label"><span></span><span>Dark mode</span></span><input class="style-toggle" type="checkbox" /></label>
<script>fetch("/unrelated.js")</script>
</body></html>`;

test.skipIf(Boolean(browserSkip))(
  "describeElement reads a control's accessible name: write-labelled checkboxes and switches are refused, the Dark mode row passes",
  async () => {
    const browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
    try {
      const page = await browser.newPage();
      await page.setContent(LABELLED);
      const refusal = async (action: Step["action"], target: string) => stepRefusal({ action, target }, await page.locator(target).evaluate(describeElement));
      for (const action of ["check", "uncheck", "click"] as const) {
        expect([action, await refusal(action, "#wrapped")]).toEqual([action, expect.stringContaining('"Delete all records" names a write')]);
        expect([action, await refusal(action, "#external")]).toEqual([action, expect.stringContaining('"Remove every draft" names a write')]);
        expect([action, await refusal(action, "#switch")]).toEqual([action, expect.stringContaining('"Sync all folders" names a write')]);
        expect([action, await refusal(action, 'label:has-text("Dark mode") input.style-toggle')]).toEqual([action, null]);
      }
    } finally {
      await browser.close();
    }
  },
  60_000,
);

test.skipIf(Boolean(browserSkip))(
  "use:app refuses check and uncheck on write-labelled controls without firing them; an unrelated 404 stays a failure beside an expected one",
  () => {
    const root = tree({ "labelled.html": LABELLED });
    const out = join(scratch, "labelled-out");
    const registry = join(mkdtempSync(join(scratch, "registry-")), "apps.json");
    const routes = [
      { id: "wrapped", path: "/labelled.html", themes: ["light" as const], steps: [{ action: "check" as const, target: "#wrapped" }] },
      { id: "switch", path: "/labelled.html", themes: ["light" as const], steps: [{ action: "uncheck" as const, target: "#switch" }] },
      { id: "dark-mode", path: "/labelled.html", themes: ["light" as const], steps: [{ action: "check" as const, target: 'label:has-text("Dark mode") input.style-toggle' }] },
    ];
    // The page fetches only /unrelated.js, which the expected entry (/api/theme) does not cover.
    writeRegistry(registry, [entry({ expectedFailures: [themeMissing] }, { routes, runProfile: { ...snapshotApp().runProfile, ports: { ui: 46955 } } })]);
    const result = Bun.spawnSync([process.execPath, join(DESIGN_SYSTEM_ROOT, "scripts/use-app.ts"), "--app", "demo", "--root", root, "--registry", registry, "--out-dir", out], { env: { ...process.env } });
    const dir = join(out, "demo", "use-app");
    const log = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((file) => file.endsWith(".json"))!), "utf8"));
    const visit = (id: string) => (log.visits as Visit[]).find((v) => v.route === id)!;
    expect(visit("wrapped").actions.find((a) => a.target === "check #wrapped")?.refused).toMatch(/"Delete all records" names a write/);
    expect(visit("switch").actions.find((a) => a.target === "uncheck #switch")?.refused).toMatch(/"Sync all folders" names a write/);
    expect(visit("dark-mode").actions.find((a) => a.target.startsWith("check label"))).toMatchObject({ ok: true });
    for (const v of log.visits as Visit[]) {
      // Never fired: no /fired-* request in any visit (hovers never activate either).
      expect([v.route, v.failedRequests.filter((r) => r.includes("/fired-"))]).toEqual([v.route, []]);
      // /unrelated.js is no expected failure: it fails the visit; nothing was expected here.
      expect([v.route, v.failedRequests, v.expectedFailedRequests]).toEqual([v.route, ["404 GET http://127.0.0.1:46955/unrelated.js"], []]);
      expect(v.consoleErrors).toEqual([expect.stringMatching(/^Failed to load resource: the server responded with a status of 404/)]);
    }
    expect(log.totals).toMatchObject({ refused: 2, failedRequests: 3, expectedFailedRequests: 0 });
    expect([result.exitCode, log.ok]).toEqual([1, false]);
  },
  180_000,
);

test.skipIf(Boolean(browserSkip))(
  "verify checkPage runs lightSteps after the route is prepared and reads light, though the server saved dark; then the darkSwitch reads dark",
  async () => {
    const root = tree();
    const app = entry(
      { probes: [{ selector: "body", property: "background-color", token: "color.surface.page" }], darkSwitch: checkDark, lightSteps: uncheckLight },
      { routes: [{ id: "home", path: "/", waitFor: "p.ready" }], runProfile: { ...snapshotApp().runProfile, ports: { ui: 46956 } } },
    );
    const running = await startApp(app, { root, outDir: join(scratch, "verify-out"), timeoutMs: 20_000 });
    const browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
    try {
      // A previous visit saved dark on the server.
      await fetch(`${running.baseUrl}/api/theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dark: true }) });
      const page = await browser.newPage();
      const order: string[] = [];
      await page.exposeFunction("recordToggle", (checked: boolean) => void order.push(`toggle ${checked ? "dark" : "light"}`));
      await page.addInitScript(() => document.addEventListener("change", (event) => (window as any).recordToggle((event.target as HTMLInputElement).checked), true));
      await page.goto(`${running.baseUrl}/`);
      const prepare = async (p: any) => {
        await p.locator("p.ready").waitFor({ state: "visible" });
        order.push(`prepared ${await p.evaluate(() => document.documentElement.getAttribute("data-theme"))}`);
      };
      await prepare(page);
      const assertions = await checkPage(page, { app, values: loadBuildValues(DESIGN_SYSTEM_ROOT), responses: new Map(), fontSource: fixtureFontSource(), prepare });
      const actual = (id: string) => String(assertions.find((a) => a.id === id)?.message.match(/rgb\([^)]*\)/)?.[0]);
      // The page loaded the saved dark; lightSteps (after preparation) unchecked it, then the darkSwitch checked it.
      expect(order).toEqual(["prepared dark", "toggle light", "toggle dark"]);
      expect([actual("token.light: body background-color"), actual("token.dark: body background-color")]).toEqual(["rgb(255, 255, 255)", "rgb(0, 0, 0)"]);
    } finally {
      await browser.close();
      await running.stop();
    }
  },
  120_000,
);
