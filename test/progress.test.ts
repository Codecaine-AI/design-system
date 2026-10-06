/**
 * bun run progress: the ledger parser, the merge of registry + ledger + lint report, the totals,
 * the two output files, and the linter hand-off (a real child process against a stand-in checkout).
 * "Literals removed" is only ever lint baseline minus lint now: the ledger's audit baseline is another count.
 * Fixtures: test/fixtures/progress/ (a STATE.md in the real column order, the same rows reordered,
 * a registry and a lint:apps --json report). Expected values are worked out by hand from them.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedger } from "../scripts/lib/progress/ledger.ts";
import { checkLintReport, type LintReport, type LintSource, parseLintJson, readLintFile, runLinter } from "../scripts/lib/progress/lint.ts";
import { buildProgress, type ProgressModel } from "../scripts/lib/progress/model.ts";
import { renderHtml } from "../scripts/lib/progress/render-html.ts";
import { renderMarkdown } from "../scripts/lib/progress/render-md.ts";
import { loadRegistry } from "../scripts/lib/registry.ts";
import { declaredVars, PKG, readText } from "./support.ts";

const FIXTURES = join(PKG, "test", "fixtures", "progress");
const fixture = (name: string) => join(FIXTURES, name);
const STATE = readFileSync(fixture("STATE.md"), "utf8");

function model(lint: LintSource = readLintFile(fixture("lint.json")), state = STATE, lintBaseline: LintSource | null = null): ProgressModel {
  return buildProgress({
    registry: loadRegistry(fixture("registry.json")),
    registryPath: fixture("registry.json"),
    ledger: parseLedger(state),
    ledgerPath: fixture("STATE.md"),
    lint,
    lintBaseline,
    root: "/fixture/root",
    now: new Date("2026-10-05T12:00:00Z"),
  });
}

/** The fixture lint report, changed by `edit`. */
function lintWith(edit: (report: LintReport) => void): LintSource {
  const report = parseLintJson(readFileSync(fixture("lint.json"), "utf8"));
  edit(report);
  return { available: true, origin: "test", report };
}

/** A lint baseline (before the apps moved) with these hard counts. */
const baselineOf = (hard: Record<string, number>): LintSource => ({
  available: true,
  origin: "baseline.json",
  report: { root: "/fixture/root", pass: null, designSystem: null, apps: Object.entries(hard).map(([id, n]) => ({ id, ok: false, checks: [], literals: { hard: n, floor: 0 } })) },
});

const row = (m: ProgressModel, id: string) => m.rows.find((r) => r.id === id)!;
const UNAVAILABLE: LintSource = { available: false, origin: "test", reason: "linter not merged" };

describe("parseLedger", () => {
  test("finds columns by header: the reordered table with an unknown column parses to the same rows", () => {
    const canonical = parseLedger(STATE);
    const reordered = parseLedger(readFileSync(fixture("STATE-reordered.md"), "utf8"));
    expect(canonical.problems).toEqual([]);
    expect(reordered.problems).toEqual([]);
    // Only the ledger table: the owner_snapshot and open_findings tables also have an id column.
    expect(canonical.rows.map((r) => r.id)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    const comparable = (rows: typeof canonical.rows) => rows.map(({ workers, extra, ...rest }) => rest);
    expect(comparable(reordered.rows)).toEqual(comparable(canonical.rows));
    expect(reordered.rows[0].extra).toEqual({ notes: "pilot app" });
    expect(canonical.rows[0]).toMatchObject({
      id: "alpha",
      wave: 1,
      dependsOn: "tooling (pilot 1)",
      repo: "repos/alpha",
      branch: "design-system/alpha",
      workers: "w1",
      passes: { "1": "done", "2": "done", "3": "todo" },
      literals: { baseline: 120, now: 4 },
      rounds: 3,
      blocked: null,
    });
  });

  test("reads missing cells and dashes as no value, and splits the blocked cell at its last arrow", () => {
    const rows = parseLedger(STATE).rows;
    const [beta, gamma, delta, epsilon] = ["beta", "gamma", "delta", "epsilon"].map((id) => rows.find((r) => r.id === id)!);
    expect(beta.literals).toEqual({ baseline: 60, now: null });
    expect(epsilon.rounds).toBeNull();
    // delta's row stops after p1.
    expect(delta).toMatchObject({ passes: { "1": "todo", "2": null, "3": null }, literals: { baseline: null, now: null }, rounds: null, blocked: null });
    expect(gamma.blocked).toEqual({ reason: "Uncommitted `package.json` (version 0.1.0 → 0.0.1)", ownerAction: "commit or revert it" });
  });

  test.each([
    ["6 / –", { baseline: 6, now: null }],
    ["– / –", { baseline: null, now: null }],
    ["—", { baseline: null, now: null }],
    ["1757 / 0", { baseline: 1757, now: 0 }],
    ["12", { baseline: 12, now: null }],
  ])("literals cell %p", (cell, literals) => {
    const ledger = parseLedger(`## app_ledger\n\n| id | literals |\n| --- | --- |\n| a | ${cell} |\n`);
    expect(ledger).toEqual({ rows: [expect.objectContaining({ literals })], problems: [] });
  });

  test("reports what it cannot read instead of throwing", () => {
    expect(parseLedger("# STATE\n\n## tooling\n\n| id |\n| --- |\n| a |\n").problems).toEqual(['STATE.md has no "## app_ledger" table']);
    expect(parseLedger("## app_ledger\n\n| app name | p1 |\n| --- | --- |\n| a | todo |\n").problems).toEqual([
      'the app_ledger table has no "id" column',
    ]);
    const ledger = parseLedger("## app_ledger\n\n| id | literals | rounds |\n| --- | --- | --- |\n| a | about 60 | 1 |\n| a | 3 / 1 | x |\n");
    expect(ledger.rows.map((r) => r.literals)).toEqual([{ baseline: null, now: null }]);
    expect(ledger.problems).toEqual(['a: literal baseline "about 60" is not a whole number', "a: duplicate ledger row (the first one is used)"]);
  });
});

describe("buildProgress", () => {
  test("merges the lint report per app: check statuses, measured count, apps without a result", () => {
    const m = model();
    const beta = row(m, "beta");
    expect(beta.lint.kind === "result" && beta.lint.checks.map((c) => [c.id, c.status, c.violations.length])).toEqual([
      ["resolution", "pass", 0],
      ["wiring", "fail", 2],
      ["literals", "fail", 1],
      ["names", "warn", 0],
      ["shell", "pass", 0],
      ["structure", "pass", 0],
    ]);
    // The measured count replaces the ledger's; the floor comes from the registry. No lint baseline: nothing removed.
    expect(row(m, "alpha").literals).toEqual({ baseline: 120, lintBaseline: null, now: 2, nowFrom: "lint", floor: 0, removed: null });
    expect(row(m, "epsilon").literals).toEqual({ baseline: 10, lintBaseline: null, now: 7, nowFrom: "ledger", floor: 0, removed: null });
    expect(row(m, "gamma").lint).toEqual({ kind: "missing" });
    // A check the linter reports n/a without a reason takes the registry's.
    const alpha = row(m, "alpha");
    expect(alpha.lint.kind === "result" && alpha.lint.checks.find((c) => c.id === "structure")?.reason).toBe("library: no folder standard");
  });

  test("without a lint report every app shows lint unavailable and keeps the ledger count", () => {
    const m = model(UNAVAILABLE);
    expect(new Set(m.rows.map((r) => r.lint.kind))).toEqual(new Set(["unavailable"]));
    expect(row(m, "alpha").literals).toEqual({ baseline: 120, lintBaseline: null, now: 4, nowFrom: "ledger", floor: 0, removed: null });
    expect(m.notes).toContain("lint unavailable: linter not merged");
  });

  test("the registry decides which passes apply and every disagreement becomes a note", () => {
    const m = model();
    expect(row(m, "alpha").passes["3"]).toEqual({ status: "n/a", applicable: false, reason: "library: no folder standard" });
    expect(row(m, "alpha").notes).toEqual(["p3: ledger says todo, apps.json marks it n/a (library: no folder standard)"]);
    expect(row(m, "delta").notes).toEqual(["not in apps.json"]);
    expect(m.rows.map((r) => r.id)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
    expect(row(m, "zeta").notes).toEqual([
      "not in the STATE.md ledger",
      // zeta's lint result holds only resolution; apps.json requires every check.
      "the lint report has no wiring, literals, names, shell, structure result, which apps.json requires",
    ]);
  });

  test("a done app whose lint fails, and a --pass 1 report that lacks required checks, get notes", () => {
    const failing = model(
      lintWith((report) => {
        const alpha = report.apps.find((a) => a.id === "alpha")!;
        alpha.ok = false;
        alpha.checks.find((c) => c.id === "wiring")!.status = "fail";
      }),
    );
    expect(row(failing, "alpha").state).toBe("done");
    expect(row(failing, "alpha").notes).toContain("done in the ledger, but lint:apps fails: wiring");

    const pass1 = model(
      lintWith((report) => {
        report.pass = "1";
        for (const app of report.apps) app.checks = app.checks.filter((c) => !["shell", "structure"].includes(c.id));
      }),
    );
    expect(row(pass1, "alpha").notes).toContain("the lint report has no shell result (it ran --pass 1), which apps.json requires");
    expect(row(pass1, "beta").notes).toContain("the lint report has no shell, structure result (it ran --pass 1), which apps.json requires");
  });

  test("totals: done, in flight, blocked, todo; literals removed is never audit baseline minus lint count", () => {
    const m = model();
    expect(Object.fromEntries(m.rows.map((r) => [r.id, r.state]))).toEqual({
      alpha: "done",
      beta: "in flight",
      gamma: "blocked",
      delta: "todo",
      epsilon: "in flight",
      zeta: "todo",
    });
    // The ledger's baselines are the audit's counts: no removal is claimed. Now: alpha 2, beta 31, epsilon 7 (ledger), zeta 0.
    expect(m.totals).toEqual({ apps: 6, done: 1, inFlight: 2, blocked: 1, todo: 2, literals: { baseline: 229, now: 40, measured: 0, removed: null } });
  });

  test("with a lint baseline, removed is lint baseline minus lint now, only for apps lint:apps measured both times", () => {
    // epsilon's current count comes from the ledger, so its baseline does not make it measured.
    const m = model(undefined, STATE, baselineOf({ alpha: 118, beta: 40, epsilon: 9 }));
    expect(row(m, "alpha").literals).toMatchObject({ baseline: 120, lintBaseline: 118, now: 2, removed: 116 });
    expect(row(m, "epsilon").literals).toMatchObject({ lintBaseline: 9, now: 7, nowFrom: "ledger", removed: null });
    expect(m.totals.literals).toEqual({ baseline: 229, now: 40, measured: 2, removed: 116 + 9 });
  });
});

describe("outputs", () => {
  test("progress.md: totals first, one row per app, lint per check and the owner actions", () => {
    const md = renderMarkdown(model());
    const lines = md.split("\n");
    expect(lines).toContain("| 6 | 1 | 2 | 1 | 2 | – (no lint baseline; audit 229, now 40) |");
    expect(lines).toContain(
      "| beta | in flight | 1 | `repos/beta` | `design-system/beta` | working | todo | todo | 60 / 31 / 0 | 1 | lint: fail: wiring (2), literals (1) |",
    );
    const measured = renderMarkdown(model(undefined, STATE, baselineOf({ beta: 40 }))).split("\n");
    expect(measured).toContain("| 6 | 1 | 2 | 1 | 2 | 9 (1 of 6 apps measured against a lint baseline) |");
    expect(measured).toContain(
      "| beta | in flight | 1 | `repos/beta` | `design-system/beta` | working | todo | todo | 60 (lint 40) / 31 / 0, 9 removed | 1 | lint: fail: wiring (2), literals (1) |",
    );
    expect(lines).toContain("| epsilon | in flight | 2 | `repos/epsilon` | `design-system/epsilon` | review | n/a | n/a | 10 / 7* / 0 | – | lint: no result |");
    expect(lines).toContain("| beta | pass | fail (2) | fail (1) | warn | pass | pass |");
    expect(lines).toContain("| gamma | Uncommitted `package.json` (version 0.1.0 → 0.0.1) | commit or revert it |");
  });

  test("progress.html shows a removal meter only against a lint baseline", () => {
    const tokens = readText("dist/css/tokens.css");
    expect(renderHtml(model(), tokens)).not.toContain("p-meter\"");
    expect(renderHtml(model(), tokens)).toContain("no lint baseline · audit 229 · now 40");
    const html = renderHtml(model(undefined, STATE, baselineOf({ beta: 40 })), tokens);
    expect(html).toContain('<span class="p-sub">23% removed (lint baseline)</span>');
  });

  test("progress.html is self-contained, styled only with declared --ds-* names, and escapes ledger text", () => {
    const tokens = readText("dist/css/tokens.css");
    const state = STATE.replace("| 10 / 7 | – | |", "| 10 / 7 | – | <img src=x onerror=alert(1)> → ask |");
    const html = renderHtml(model(undefined, state), tokens);
    expect(html).toContain(tokens.trim());
    expect(html).not.toMatch(/<(?:link|img|iframe|object|embed)\b|<script[^>]*\ssrc=|\shref=|@import|url\(|https?:\/\//);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const declared = declaredVars();
    expect([...html.matchAll(/var\(\s*(--ds-[a-z0-9-]+)/g)].map((m) => m[1]).filter((name) => !declared.has(name))).toEqual([]);
  });

  test("bun run progress writes progress.html and progress.md into --out-dir; a lint report of another root is unavailable", () => {
    const out = mkdtempSync(join(tmpdir(), "ds-progress-test-"));
    // The fixture report is for /fixture/root, and so is this run.
    const args = ["--root", "/fixture/root", "--out-dir", out, "--lint-json", fixture("lint.json"), "--state", fixture("STATE.md"), "--registry", fixture("registry.json")];
    const run = spawnSync("bun", ["scripts/progress.ts", ...args], { cwd: PKG, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("6 apps: 1 done, 2 in flight, 1 blocked, 2 todo; no lint baseline: audit 229 literals, 40 now");
    // The fixture report was made at another design-system commit.
    expect(run.stderr).toContain("note: the lint report was made at design-system 0123456789ab");
    expect(existsSync(join(out, "progress.html"))).toBe(true);
    expect(readFileSync(join(out, "progress.md"), "utf8")).toContain("| 6 | 1 | 2 | 1 | 2 |");

    const otherRoot = spawnSync("bun", ["scripts/progress.ts", ...args.slice(2), "--root", out], { cwd: PKG, encoding: "utf8" });
    expect(otherRoot.status).toBe(0);
    expect(readFileSync(join(out, "progress.md"), "utf8")).toContain(`- Lint: unavailable (the lint report is for root /fixture/root, not ${out})`);

    const missing = spawnSync("bun", ["scripts/progress.ts", ...args.slice(0, 6), "--state", join(out, "nope.md")], { cwd: PKG, encoding: "utf8" });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("nope.md does not exist");
  });
});

describe("checkLintReport", () => {
  const source = (root: string, commit = "c0ffee"): LintSource => ({
    available: true,
    origin: "lint.json",
    report: { root, pass: null, designSystem: { commit, tokensCssSha256: "aa" }, apps: [] },
  });
  const here = realpathSync(tmpdir());

  test("a report for another root is unavailable; another commit or tokens.css is a note", () => {
    expect(checkLintReport(source("/elsewhere"), { root: here, commit: "c0ffee", tokensCssSha256: "aa" })).toEqual({
      source: { available: false, origin: "lint.json", reason: `the lint report is for root /elsewhere, not ${here}` },
      notes: [],
    });
    const stale = checkLintReport(source(here, "0ld"), { root: here, commit: "c0ffee", tokensCssSha256: "bb" });
    expect(stale.source.available).toBe(true);
    expect(stale.notes).toEqual([
      "the lint report was made at design-system 0ld, this checkout is at c0ffee: its results may be stale",
      "the lint report checked against another tokens.css (sha256 aa, the build is bb)",
    ]);
  });
});

describe("runLinter", () => {
  /** A stand-in design-system checkout whose lint:apps script is `body`. */
  function checkout(body: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "ds-progress-lint-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "lint:apps": "bun scripts/lint-apps.ts" } }));
    if (body !== null) {
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "lint-apps.ts"), body);
    }
    return dir;
  }

  test("degrades to unavailable when the checkout has no lint:apps", () => {
    expect(runLinter(checkout(null), "/fixture/root")).toMatchObject({ available: false, reason: "scripts/lint-apps.ts is not in this design-system checkout yet" });
  });

  test("reads the report when lint:apps exits 1 for failing checks, and passes --json --root", () => {
    const dsRoot = checkout(`
      const argv = process.argv.slice(2);
      if (!argv.includes("--json")) process.exit(3);
      console.log(JSON.stringify({ root: argv[argv.indexOf("--root") + 1], pass: null, apps: [{ id: "beta", ok: false, checks: [{ id: "wiring", status: "fail", violations: [], warnings: [] }] }] }));
      process.exit(1);
    `);
    const result = runLinter(dsRoot, "/fixture/root");
    expect(result.available && result.report).toMatchObject({ root: "/fixture/root", apps: [{ id: "beta", ok: false }] });
  });

  test("reads the whole report from the linter's --out-dir file when a > 2 MB stdout is cut off at exit, and passes --registry", () => {
    // Writes the report file, then prints it and exits at once: a pipe keeps only the first 1.5 MB.
    const dsRoot = checkout(`
      import { mkdirSync, writeFileSync } from "node:fs";
      const argv = process.argv.slice(2);
      const at = (flag) => argv[argv.indexOf(flag) + 1];
      const violations = Array.from({ length: 30000 }, (_, i) => ({ file: "src/x.css", line: i + 1, message: "hard literal #123456 (hex, inline)" }));
      const report = JSON.stringify({ root: at("--root"), pass: null, registry: at("--registry"), apps: [{ id: "beta", ok: false, checks: [{ id: "literals", status: "fail", violations, warnings: [] }] }] });
      if (argv.includes("--out-dir")) {
        mkdirSync(at("--out-dir") + "/lint", { recursive: true });
        writeFileSync(at("--out-dir") + "/lint/2026-10-05T12-00-00-000Z.json", report);
      }
      process.stdout.write(report);
      process.exit(1);
    `);
    const result = runLinter(dsRoot, "/fixture/root", { registry: "/fixture/apps.json" });
    expect(result.available && result.report.apps[0]!.checks[0]!.violations.length).toBe(30000);
    expect(result.origin).toBe("bun run lint:apps --json --root /fixture/root --registry /fixture/apps.json (its --out-dir report)");
  });

  test("is unavailable, with the linter's last words, when lint:apps prints no report", () => {
    const result = runLinter(checkout(`console.error("cannot read apps.json"); process.exit(2);`), "/fixture/root");
    expect(result).toMatchObject({ available: false });
    expect(!result.available && result.reason).toContain("lint:apps exited 2: output is not JSON (cannot read apps.json)");
  });
});
