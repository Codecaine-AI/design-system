/**
 * bun run progress: the ledger parser, the merge of registry + ledger + lint report, the totals,
 * the two output files, and the linter hand-off (a real child process against a stand-in checkout).
 * Fixtures: test/fixtures/progress/ (a STATE.md in the real column order, the same rows reordered,
 * a registry and a lint:apps --json report). Expected values are worked out by hand from them.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedger } from "../scripts/lib/progress/ledger.ts";
import { type LintSource, readLintFile, runLinter } from "../scripts/lib/progress/lint.ts";
import { buildProgress, type ProgressModel } from "../scripts/lib/progress/model.ts";
import { renderHtml } from "../scripts/lib/progress/render-html.ts";
import { renderMarkdown } from "../scripts/lib/progress/render-md.ts";
import { loadRegistry } from "../scripts/lib/registry.ts";
import { declaredVars, PKG, readText } from "./support.ts";

const FIXTURES = join(PKG, "test", "fixtures", "progress");
const fixture = (name: string) => join(FIXTURES, name);
const STATE = readFileSync(fixture("STATE.md"), "utf8");

function model(lint: LintSource = readLintFile(fixture("lint.json")), state = STATE): ProgressModel {
  return buildProgress({
    registry: loadRegistry(fixture("registry.json")),
    registryPath: fixture("registry.json"),
    ledger: parseLedger(state),
    ledgerPath: fixture("STATE.md"),
    lint,
    root: "/fixture/root",
    now: new Date("2026-10-05T12:00:00Z"),
  });
}

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
    // The measured count replaces the ledger's; the floor comes from the registry.
    expect(row(m, "alpha").literals).toEqual({ baseline: 120, now: 2, nowFrom: "lint", floor: 0 });
    expect(row(m, "epsilon").literals).toEqual({ baseline: 10, now: 7, nowFrom: "ledger", floor: 0 });
    expect(row(m, "gamma").lint).toEqual({ kind: "missing" });
    // A check the linter reports n/a without a reason takes the registry's.
    const alpha = row(m, "alpha");
    expect(alpha.lint.kind === "result" && alpha.lint.checks.find((c) => c.id === "structure")?.reason).toBe("library: no folder standard");
  });

  test("without a lint report every app shows lint unavailable and keeps the ledger count", () => {
    const m = model(UNAVAILABLE);
    expect(new Set(m.rows.map((r) => r.lint.kind))).toEqual(new Set(["unavailable"]));
    expect(row(m, "alpha").literals).toEqual({ baseline: 120, now: 4, nowFrom: "ledger", floor: 0 });
    expect(m.notes).toContain("lint unavailable: linter not merged");
  });

  test("the registry decides which passes apply and every disagreement becomes a note", () => {
    const m = model();
    expect(row(m, "alpha").passes["3"]).toEqual({ status: "n/a", applicable: false, reason: "library: no folder standard" });
    expect(row(m, "alpha").notes).toEqual(["p3: ledger says todo, apps.json marks it n/a (library: no folder standard)"]);
    expect(row(m, "delta").notes).toEqual(["not in apps.json"]);
    expect(m.rows.map((r) => r.id)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
    expect(row(m, "zeta").notes).toEqual(["not in the STATE.md ledger"]);
  });

  test("totals: done, in flight, blocked, todo and literals removed", () => {
    const m = model();
    expect(Object.fromEntries(m.rows.map((r) => [r.id, r.state]))).toEqual({
      alpha: "done",
      beta: "in flight",
      gamma: "blocked",
      delta: "todo",
      epsilon: "in flight",
      zeta: "todo",
    });
    // Removed: alpha 120-2, beta 60-31, epsilon 10-7. gamma and delta have no current count.
    expect(m.totals).toEqual({ apps: 6, done: 1, inFlight: 2, blocked: 1, todo: 2, literals: { baseline: 229, measured: 3, removed: 150 } });
  });
});

describe("outputs", () => {
  test("progress.md: totals first, one row per app, lint per check and the owner actions", () => {
    const md = renderMarkdown(model());
    const lines = md.split("\n");
    expect(lines).toContain("| 6 | 1 | 2 | 1 | 2 | 150 (3 of 6 apps measured, baseline 229) |");
    expect(lines).toContain(
      "| beta | in flight | 1 | `repos/beta` | `design-system/beta` | working | todo | todo | 60 / 31 / 0 | 1 | lint: fail: wiring (2), literals (1) |",
    );
    expect(lines).toContain("| epsilon | in flight | 2 | `repos/epsilon` | `design-system/epsilon` | review | n/a | n/a | 10 / 7* / 0 | – | lint: no result |");
    expect(lines).toContain("| beta | pass | fail (2) | fail (1) | warn | pass | pass |");
    expect(lines).toContain("| gamma | Uncommitted `package.json` (version 0.1.0 → 0.0.1) | commit or revert it |");
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

  test("bun run progress writes progress.html and progress.md into --out-dir", () => {
    const out = mkdtempSync(join(tmpdir(), "ds-progress-test-"));
    const args = ["--root", out, "--out-dir", out, "--lint-json", fixture("lint.json"), "--state", fixture("STATE.md"), "--registry", fixture("registry.json")];
    const run = spawnSync("bun", ["scripts/progress.ts", ...args], { cwd: PKG, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("6 apps: 1 done, 2 in flight, 1 blocked, 2 todo; 150 literals removed (3 measured)");
    expect(existsSync(join(out, "progress.html"))).toBe(true);
    expect(readFileSync(join(out, "progress.md"), "utf8")).toContain("| 6 | 1 | 2 | 1 | 2 |");

    const missing = spawnSync("bun", ["scripts/progress.ts", ...args.slice(0, 6), "--state", join(out, "nope.md")], { cwd: PKG, encoding: "utf8" });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("nope.md does not exist");
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

  test("is unavailable, with the linter's last words, when lint:apps prints no report", () => {
    const result = runLinter(checkout(`console.error("cannot read apps.json"); process.exit(2);`), "/fixture/root");
    expect(result).toMatchObject({ available: false });
    expect(!result.available && result.reason).toContain("lint:apps exited 2: output is not JSON (cannot read apps.json)");
  });
});
