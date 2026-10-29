/**
 * V-judge with no model: the verdicts.json schema, how an agent's verdicts fold into a run (statuses,
 * findings, scores, stale hashes), the carry to later runs by screenshot hash, the pack, and the
 * calibration's both-orders scoring. The browser fixture pair (design-score/fixtures/V-judge) runs in
 * design-score-fixtures.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifest, pairsOf, picked, score, validatePairVerdicts } from "../scripts/design-score/judge-calibrate";
import { judgeRules, judgeRun, refoldRun, STILL_SKIP, validateVerdicts } from "../scripts/design-score/judge";
import { loadRules } from "../scripts/design-score/rules";
import type { PageResult, Scorecard } from "../scripts/design-score/types";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry";

const RULES = judgeRules(DESIGN_SYSTEM_ROOT);
const IDS = RULES.still.map((r) => r.id);
const SHOT = readFileSync(join(DESIGN_SYSTEM_ROOT, "design-score/fixtures/V-judge/shots/good.png"));
const tmp = mkdtempSync(join(tmpdir(), "ds-judge-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const bytes = (id: string) => Buffer.concat([SHOT, Buffer.from(id)]);
const hashOf = (id: string) => createHash("sha256").update(bytes(id)).digest("hex");

/** A finished run folder of `app`: one page per id, each with one state screenshot (different bytes per id) and one passing check. */
function run(app: string, name: string, ids: string[]): string {
  const dir = join(tmp, app, name);
  mkdirSync(join(dir, "shots"), { recursive: true });
  const pages = ids.map((id) => {
    writeFileSync(join(dir, "shots", `${id}.png`), bytes(id));
    return { id, path: `/${id}`, score: 100, checks: { "R-axe": { status: "pass", fails: 0, warns: 0, cut: 0 }, "V-judge": { status: "n/a", fails: 0, warns: 0, cut: 0, note: "not judged" } }, shots: [{ theme: "light", viewport: "800x600", file: `shots/${id}.png`, kind: "state" }], errors: [] } as PageResult;
  });
  const card = { tool: "design-score", version: 1, app, label: null, runId: name, startedAt: "", finishedAt: "", baseUrl: "", config: { path: "", sha256: "" }, provenance: {}, scoring: "", score: 100, checks: [], checkTotals: {}, pages, findings: [], allowed: [], judge: { shots: [], rules: 0, stale: [], pack: null, note: "" } } as unknown as Scorecard;
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(card));
  return dir;
}

const RULE = "a11y-color-not-only-cue";
const verdictsFile = (dir: string, shots: Record<string, Record<string, { verdict: string; reason: string }>>) => {
  const file = join(dir, "agent-verdicts.json");
  writeFileSync(file, JSON.stringify({ version: 1, shots }));
  return file;
};
const statuses = (card: Scorecard) => Object.fromEntries(card.pages.map((p) => [p.id, p.checks["V-judge"]!.status]));

describe("verdicts.json schema", () => {
  const ok = { verdict: "pass", reason: "Each status has a word." };
  const h = "a".repeat(64);

  test("a valid file gives its verdicts", () => {
    expect(validateVerdicts({ version: 1, shots: { [h]: { [RULE]: ok } } }, IDS)).toEqual({ shots: { [h]: { [RULE]: { verdict: "pass", reason: "Each status has a word." } } }, errors: [] });
  });

  test.each([
    ["no version", { shots: {} }, "version must be 1"],
    ["an extra top-level key", { version: 1, shots: {}, notes: "" }, 'unknown top-level key "notes"'],
    ["a hash that is not a sha256", { version: 1, shots: { "shots/home.png": { [RULE]: ok } } }, "is not a sha256"],
    ["a rule outside the still rules", { version: 1, shots: { [h]: { "copy-plain-words": ok } } }, '"copy-plain-words" is not one of the 16 rules'],
    ["a verdict outside the four", { version: 1, shots: { [h]: { [RULE]: { verdict: "n/a", reason: "x" } } } }, 'verdict "n/a" is not pass, warn, fail, unsure'],
    ["an empty reason", { version: 1, shots: { [h]: { [RULE]: { verdict: "fail", reason: " " } } } }, "reason must be a non-empty string"],
    ["a two-line reason", { version: 1, shots: { [h]: { [RULE]: { verdict: "fail", reason: "one\ntwo" } } } }, "reason must be one line"],
    ["an extra key in a verdict", { version: 1, shots: { [h]: { [RULE]: { ...ok, box: null } } } }, 'unknown key "box"'],
  ])("rejects %s, and keeps no verdict", (_, json, error) => {
    const res = validateVerdicts(json, IDS);
    expect(res.errors.join("\n")).toContain(error);
    expect(res.shots).toEqual({});
  });

  test("--judge-verdicts refuses an invalid file and leaves the scorecard as it was", () => {
    const dir = run("refuse", "r1", ["home"]);
    const before = readFileSync(join(dir, "scorecard.json"), "utf8");
    const file = verdictsFile(dir, { [hashOf("home")]: { [RULE]: { verdict: "maybe", reason: "x" } } });
    expect(() => refoldRun(dir, file, DESIGN_SYSTEM_ROOT)).toThrow('verdict "maybe"');
    expect(readFileSync(join(dir, "scorecard.json"), "utf8")).toBe(before);
  });
});

describe("folding verdicts into a run", () => {
  test("fail fails, warn and unsure warn, pass passes, a shot with no verdict stays n/a, a stale hash is ignored and reported", () => {
    const dir = run("fold", "r1", ["passes", "warns", "fails", "unsure", "missing"]);
    const v = (verdict: string) => ({ [RULE]: { verdict, reason: `status cue ${verdict}` } });
    const stale = "f".repeat(64);
    const file = verdictsFile(dir, { [hashOf("passes")]: v("pass"), [hashOf("warns")]: v("warn"), [hashOf("fails")]: v("fail"), [hashOf("unsure")]: v("unsure"), [stale]: v("fail") });
    const card = refoldRun(dir, file, DESIGN_SYSTEM_ROOT);
    expect(statuses(card)).toEqual({ passes: "pass", warns: "warn", fails: "fail", unsure: "warn", missing: "n/a" });
    expect(card.findings.map((f) => [f.page, f.severity, f.rules, f.measured])).toEqual([
      ["warns", "warn", [RULE], "status cue warn"],
      ["fails", "fail", [RULE], "status cue fail"],
      ["unsure", "warn", [RULE], "status cue unsure"],
    ]);
    // Each page has R-axe pass plus V-judge: pass 1, warn 0.5, fail 0, n/a left out.
    expect(card.pages.map((p) => p.score)).toEqual([100, 75, 50, 75, 100]);
    expect(card.score).toBe(80);
    expect(card.judge.stale).toEqual([stale]);
    // The scorecard on disk and the run's own verdicts.json are the folded ones.
    expect(statuses(JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8")))).toEqual(statuses(card));
    expect(JSON.parse(readFileSync(join(dir, "judge", "verdicts.json"), "utf8")).shots[hashOf("fails")]).toEqual(v("fail"));
  });

  test("a refold replaces the earlier V-judge findings instead of adding to them", () => {
    const dir = run("refold", "r1", ["home"]);
    refoldRun(dir, verdictsFile(dir, { [hashOf("home")]: { [RULE]: { verdict: "fail", reason: "dot alone" } } }), DESIGN_SYSTEM_ROOT);
    const card = refoldRun(dir, verdictsFile(dir, { [hashOf("home")]: { [RULE]: { verdict: "pass", reason: "word beside dot" } } }), DESIGN_SYSTEM_ROOT);
    expect(card.findings).toEqual([]);
    expect(statuses(card)).toEqual({ home: "pass" });
  });

  test("a later run carries verdicts by screenshot hash, and its pack lists only the changed screenshot", () => {
    const first = run("carry", "2026-01-01T00-00-00", ["home", "settings"]);
    refoldRun(first, verdictsFile(first, { [hashOf("home")]: { [RULE]: { verdict: "fail", reason: "dot alone" } }, [hashOf("settings")]: { [RULE]: { verdict: "pass", reason: "labels" } } }), DESIGN_SYSTEM_ROOT);
    // The second run: home is unchanged, settings has new pixels.
    const second = run("carry", "2026-01-02T00-00-00", ["home", "changed"]);
    const card = JSON.parse(readFileSync(join(second, "scorecard.json"), "utf8")) as Scorecard;
    judgeRun(card, second, DESIGN_SYSTEM_ROOT, { pack: true });
    expect(statuses(card)).toEqual({ home: "fail", changed: "n/a" });
    expect(card.judge.shots.map((s) => [s.page, s.from])).toEqual([["home", "carried"], ["changed", "none"]]);
    const pack = readFileSync(join(second, "judge", "pack.md"), "utf8");
    expect(pack).toContain(hashOf("changed"));
    expect(pack).not.toContain(hashOf("home"));
    for (const id of IDS) expect(pack).toContain(`\`${id}\``);
  });

  test("the run's own verdict wins over a carried one for the same hash", () => {
    const first = run("own-wins", "2026-01-01T00-00-00", ["home"]);
    refoldRun(first, verdictsFile(first, { [hashOf("home")]: { [RULE]: { verdict: "fail", reason: "dot alone" } } }), DESIGN_SYSTEM_ROOT);
    const second = run("own-wins", "2026-01-02T00-00-00", ["home"]);
    const card = refoldRun(second, verdictsFile(second, { [hashOf("home")]: { [RULE]: { verdict: "pass", reason: "fixed: word beside dot" } } }), DESIGN_SYSTEM_ROOT);
    expect(statuses(card)).toEqual({ home: "pass" });
  });
});

describe("V-judge rules", () => {
  test("the still rules are the V-judge rules minus the ones a still cannot show, and every skipped id is a V-judge rule", () => {
    const vjudge = loadRules(DESIGN_SYSTEM_ROOT).rules.filter((r) => [r.check ?? []].flat().includes("V-judge")).map((r) => r.id);
    for (const id of Object.keys(STILL_SKIP)) expect(vjudge).toContain(id);
    expect([...IDS].sort()).toEqual(vjudge.filter((id) => !(id in STILL_SKIP)).sort());
    expect(IDS.length).toBe(16);
  });
});

describe("judge calibration", () => {
  const { items } = loadManifest();
  const pairs = pairsOf(items);
  const all = judgeRules(DESIGN_SYSTEM_ROOT).all.map((r) => r.id);

  test.each([
    ["AB", "A", 1],
    ["AB", "B", 2],
    ["BA", "A", 2],
    ["BA", "B", 1],
    ["AB", "same", null],
    ["BA", "unsure", null],
  ] as const)("order %s answer %s picks option %p", (order, better, option) => {
    expect(picked(order, better)).toBe(option);
  });

  test("the 24 visual items split 12 and 12, each half with 5 stills and 7 motion items", () => {
    expect(items.map((i) => i.q).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 26]);
    for (const split of ["tune", "held-out"]) {
      const half = items.filter((i) => i.split === split);
      expect([half.filter((i) => i.kind === "still").length, half.filter((i) => i.kind === "motion").length]).toEqual([5, 7]);
    }
  });

  test("every item appears in both orders under 48 distinct pair ids", () => {
    expect(new Set(pairs.map((p) => p.id)).size).toBe(48);
    for (const i of items) expect(pairs.filter((p) => p.q === i.q).map((p) => p.order).sort()).toEqual(["AB", "BA"]);
  });

  test("a judge that always says A agrees on no item; one that knows the answers agrees on all 24", () => {
    const always = Object.fromEntries(pairs.map((p) => [p.id, { better: "A" as const, rule: all[0]!, reason: "x" }]));
    expect(score({ items }, pairs, always).summary.all).toEqual({ agreed: 0, total: 24 });
    const good = new Map(items.map((i) => [i.q, i.good]));
    const oracle = Object.fromEntries(pairs.map((p) => [p.id, { better: ((p.order === "AB") === (good.get(p.q) === 1) ? "A" : "B") as "A" | "B", rule: all[0]!, reason: "x" }]));
    const s = score({ items }, pairs, oracle).summary;
    expect([s.all, s.judgeable, s.heldOut]).toEqual([{ agreed: 24, total: 24 }, { agreed: 17, total: 17 }, { agreed: 12, total: 12 }]);
  });

  test("a pair with no verdict is a miss, and a verdicts file with an unknown pair or rule is rejected", () => {
    const tune = pairsOf(items.filter((i) => i.split === "tune"));
    expect(score({ items }, tune, {}).summary).toMatchObject({ all: { agreed: 0, total: 12 }, misses: items.filter((i) => i.split === "tune").map((i) => i.q) });
    const res = validatePairVerdicts({ version: 1, pairs: { pzzzzzz: { better: "A", rule: "not-a-rule", reason: "x" } } }, tune.map((p) => p.id), all);
    expect(res.errors).toEqual(['pairs: "pzzzzzz" is not a pair in the pack', 'pairs.pzzzzzz: rule "not-a-rule" is not a rule id']);
  });
});
