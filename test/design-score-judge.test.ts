/**
 * V-judge with the model stubbed: the cascade from a cheap to a strong model, how verdicts become page
 * statuses and findings, the screenshot cache, the call cap, the Messages API request, and the calibration's
 * both-orders scoring. The browser fixture pair (design-score/fixtures/V-judge) runs in
 * design-score-fixtures.test.ts.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifest, picked } from "../scripts/design-score/judge-calibrate";
import { anthropicCall, judgeRules, runJudge, STILL_SKIP, type ModelCall, type ModelRequest, type RuleVerdict } from "../scripts/design-score/judge";
import { loadRules } from "../scripts/design-score/rules";
import type { PageResult } from "../scripts/design-score/types";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry";

const RULES = judgeRules(DESIGN_SYSTEM_ROOT);
const SHOT = join(DESIGN_SYSTEM_ROOT, "design-score/fixtures/V-judge/shots/good.png");
const tmp = mkdtempSync(join(tmpdir(), "ds-judge-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A run folder whose pages each have one state screenshot, with different bytes per page id (the cache key is the pixels). */
function run(name: string, ids: string[]): { dir: string; pages: PageResult[] } {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "shots"), { recursive: true });
  const pages = ids.map((id) => {
    writeFileSync(join(dir, "shots", `${id}.png`), Buffer.concat([readFileSync(SHOT), Buffer.from(id)]));
    return { id, path: `/${id}`, score: 100, checks: { "V-judge": { status: "n/a", fails: 0, warns: 0, cut: 0, note: "not judged" } }, shots: [{ theme: "light", viewport: "800x600", file: `shots/${id}.png`, kind: "state" }], errors: [] } as PageResult;
  });
  return { dir, pages };
}

const verdict = (v: RuleVerdict["verdict"]): { verdicts: RuleVerdict[] } => ({
  verdicts: [{ rule: "a11y-color-not-only-cue", verdict: v, reason: `status cue ${v}`, box: v === "pass" ? null : { x: 10, y: 20, w: 30, h: 40 } }],
});

/** Answers by page and model tier, and records every call. */
function stub(answers: Record<string, { cheap: RuleVerdict["verdict"]; strong?: RuleVerdict["verdict"] }>) {
  const calls: ModelRequest[] = [];
  const call: ModelCall = async (req) => {
    calls.push(req);
    const a = answers[req.page!]!;
    return { json: verdict(req.model === "claude-haiku-5-5" ? a.cheap : a.strong!), usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } };
  };
  return { call, calls };
}

describe("V-judge on a run", () => {
  const answers = {
    clean: { cheap: "pass" as const },
    broken: { cheap: "fail" as const, strong: "fail" as const },
    unclear: { cheap: "fail" as const, strong: "unsure" as const },
    overruled: { cheap: "unsure" as const, strong: "pass" as const },
  };

  test("only the strong model's no fails a page, its unsure warns, and a rerun over the same pixels makes no call", async () => {
    const { dir, pages } = run("cascade", Object.keys(answers));
    const first = stub(answers);
    const opts = { call: first.call, cacheDir: join(tmp, "cascade-cache") };
    const a = await runJudge(pages, dir, RULES, opts);
    expect(Object.fromEntries(pages.map((p) => [p.id, p.checks["V-judge"]!.status]))).toEqual({ clean: "pass", broken: "fail", unclear: "warn", overruled: "pass" });
    expect(a.findings.map((f) => [f.page, f.severity, f.rules, f.box])).toEqual([
      ["broken", "fail", ["a11y-color-not-only-cue"], { x: 10, y: 20, w: 30, h: 40 }],
      ["unclear", "warn", ["a11y-color-not-only-cue"], { x: 10, y: 20, w: 30, h: 40 }],
    ]);
    expect(a.summary.review).toEqual([{ shot: "shots/overruled.png", rules: ["a11y-color-not-only-cue"] }]);
    // One cheap call per page, one strong call for each page the cheap model flagged.
    expect(first.calls.length).toBe(7);
    // 4 x (1000 x $0.10 + 100 x $0.50) + 3 x (1000 x $4 + 100 x $20), per million tokens.
    expect(a.summary.costUsd).toBe(0.0186);

    const again = run("cascade-rerun", Object.keys(answers));
    const second = stub(answers);
    const b = await runJudge(again.pages, again.dir, RULES, { ...opts, call: second.call });
    expect(second.calls.length).toBe(0);
    expect(b.summary.cached).toBe(7);
    expect(b.findings).toEqual(a.findings);
  });

  test("the call cap leaves the rest of the shots unjudged and their pages n/a", async () => {
    const { dir, pages } = run("cap", ["one", "two"]);
    const { call, calls } = stub({ one: { cheap: "pass" }, two: { cheap: "pass" } });
    const res = await runJudge(pages, dir, RULES, { call, cacheDir: join(tmp, "cap-cache"), maxCalls: 2 });
    expect(calls.map((c) => c.page)).toEqual(["one"]);
    expect(res.summary.unjudged).toEqual(["shots/two.png"]);
    expect(pages.map((p) => p.checks["V-judge"]!.status)).toEqual(["pass", "n/a"]);
  });

  test("a verdict for a rule outside the still rules is dropped", async () => {
    const { dir, pages } = run("unknown-rule", ["page"]);
    const call: ModelCall = async () => ({ json: { verdicts: [{ rule: "copy-plain-words", verdict: "fail", reason: "text-only rule", box: null }] }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const res = await runJudge(pages, dir, RULES, { call, cacheDir: join(tmp, "unknown-cache") });
    expect(res.findings).toEqual([]);
    expect(pages[0]!.checks["V-judge"]!.status).toBe("pass");
  });
});

describe("V-judge rules", () => {
  test("the still rules are the V-judge rules minus the ones a still cannot show, and every skipped id is a V-judge rule", () => {
    const vjudge = loadRules(DESIGN_SYSTEM_ROOT).rules.filter((r) => [r.check ?? []].flat().includes("V-judge")).map((r) => r.id);
    for (const id of Object.keys(STILL_SKIP)) expect(vjudge).toContain(id);
    expect(RULES.still.map((r) => r.id).sort()).toEqual(vjudge.filter((id) => !(id in STILL_SKIP)).sort());
    expect(RULES.still.length).toBe(16);
  });
});

describe("Messages API call", () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => spy?.mockRestore());

  test("sends the image, the cached rubric and the JSON schema, and returns the parsed reply and its usage", async () => {
    let sent: { url: string; headers: Record<string, string>; body: any } | null = null;
    spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: '{"verdicts":[]}' }], usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 6000 } }));
    }) as any);
    const reply = await anthropicCall("test-key")({ model: "claude-haiku-5-5", effort: "low", system: "RUBRIC", images: [{ label: "Screenshot:", png: new Uint8Array([137, 80, 78, 71]) }], text: "rate it", schema: { type: "object" } });
    expect(reply).toEqual({ json: { verdicts: [] }, usage: { input: 1200, output: 80, cacheRead: 6000, cacheWrite: 0 } });
    expect(sent!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent!.headers["x-api-key"]).toBe("test-key");
    expect(sent!.body.system).toEqual([{ type: "text", text: "RUBRIC", cache_control: { type: "ephemeral" } }]);
    expect(sent!.body.messages[0].content).toEqual([
      { type: "text", text: "Screenshot:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
      { type: "text", text: "rate it" },
    ]);
    expect(sent!.body.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
  });

  test("a client error fails at once, without a retry", async () => {
    let calls = 0;
    spy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls++;
      return new Response('{"error":{"type":"invalid_request_error"}}', { status: 400 });
    }) as any);
    const req = { model: "claude-haiku-5-5", effort: "low" as const, system: "", images: [], text: "", schema: {} };
    await expect(anthropicCall("test-key")(req)).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });
});

describe("judge calibration", () => {
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
    const { items } = loadManifest();
    expect(items.map((i) => i.q).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 26]);
    for (const split of ["tune", "held-out"]) {
      const half = items.filter((i) => i.split === split);
      expect([half.filter((i) => i.kind === "still").length, half.filter((i) => i.kind === "motion").length]).toEqual([5, 7]);
    }
  });
});
