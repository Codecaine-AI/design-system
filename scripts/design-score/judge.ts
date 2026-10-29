/**
 * V-judge: a vision model that scores the taste rules no code check can decide, from the state
 * screenshots every run already takes (shots/<page>__<theme>__<viewport>.png). Opt-in (it costs money):
 * `design:score --judge`. Design and calibration: docs/10-design-score/85-screenshot-judge.
 *
 *   rate a screenshot   the cheap model answers pass, fail, unsure or n/a for each still rule (STILL_SKIP
 *                       lists the V-judge rules a still cannot show). On any fail or unsure, the strong
 *                       model answers again and its answer is final.
 *   finding             strong fail -> fail finding; strong unsure -> warn finding (for Ford). Each cites
 *                       one rule id and a short reason, with a box when the model gives one.
 *   compare a pair      the calibration (judge-calibrate.ts): which of two versions follows the rules
 *                       better, and the rule that decides it. The same rubric and the same model call.
 *   cache               every model reply is kept under the screenshot's hash, the model and the prompt,
 *                       so a rerun over the same pixels costs nothing.
 *   cost cap            at most `maxCalls` uncached calls per run; shots past the cap are listed unjudged.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadRules } from "./rules";
import type { Box, Finding, PageResult } from "./types";

export const JUDGE_MODELS = { cheap: "claude-haiku-5-5", strong: "claude-opus-5-5" } as const;
/** USD per million tokens. Cache reads are billed at a tenth of input, cache writes at 1.25x. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
export const DEFAULT_MAX_CALLS = 100;

/** V-judge rules a still screenshot cannot decide, and why. */
export const STILL_SKIP: Record<string, string> = {
  "a11y-alt-by-purpose": "text-only: reads alt strings, not pixels",
  "copy-consistent-terms": "text-only: reads extracted strings",
  "copy-tone-by-stakes": "text-only: reads extracted strings",
  "copy-plain-words": "text-only: reads extracted strings",
  "copy-status-parallel": "text-only: reads extracted strings",
  "08-focus-motion-subtle": "motion: a still shows no motion",
  "13-subtle-not-over-animated": "motion: a still shows no motion",
  "layout-rtl-mirror": "needs a dir=rtl run",
  "bd-fidelity-compare": "needs the design frame",
  "bd-rounding-threshold": "needs the design frame",
};

export interface JudgeRule {
  id: string;
  area: string;
  title: string;
  rule: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelRequest {
  model: string;
  effort: "low" | "medium" | "high";
  system: string;
  /** PNG bytes, in order, each after its label. */
  images: Array<{ label: string; png: Uint8Array }>;
  text: string;
  schema: Record<string, unknown>;
  /** The page id the image comes from (stubs key replies on it; the API never sees it). */
  page?: string;
}

export interface ModelReply {
  json: unknown;
  usage: Usage;
}

export type ModelCall = (req: ModelRequest) => Promise<ModelReply>;

export type Verdict = "pass" | "fail" | "unsure" | "n/a";

export interface RuleVerdict {
  rule: string;
  verdict: Verdict;
  reason: string;
  box: Box | null;
}

export interface JudgeOptions {
  call: ModelCall;
  cacheDir: string;
  maxCalls?: number;
  models?: { cheap: string; strong: string };
}

/** Every rule in design-score/rules/, and the still rules: V-judge rules a screenshot can show. */
export function judgeRules(designSystem: string): { all: JudgeRule[]; still: JudgeRule[] } {
  const all = loadRules(designSystem).rules.map((r) => {
    const raw = r as typeof r & { rule?: string };
    return { id: r.id, area: r.area ?? "", title: r.title ?? r.id, rule: raw.rule ?? "", check: r.check };
  });
  const still = all.filter((r) => [r.check ?? []].flat().includes("V-judge") && !(r.id in STILL_SKIP));
  return { all: all.map(({ check: _, ...r }) => r), still: still.map(({ check: _, ...r }) => r) };
}

/** The rubric: every rule, grouped by area. Stable text, so the API caches it. */
export function systemPrompt(rules: JudgeRule[]): string {
  const areas = [...new Set(rules.map((r) => r.area))];
  return [
    "You are a design reviewer. You judge interface screenshots against the design rules below and nothing else.",
    "Judge only what the pixels show. When the image cannot show whether a rule holds, say so instead of guessing.",
    "Each reason is one short sentence that names what you see.",
    "",
    ...areas.flatMap((a) => [`## ${a}`, ...rules.filter((r) => r.area === a).map((r) => `- ${r.id}: ${r.rule}`), ""]),
  ].join("\n");
}

const BOX_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "w", "h"],
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
    },
  ],
};

export function rateSchema(ids: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "verdict", "reason", "box"],
          properties: {
            rule: { type: "string", enum: ids },
            verdict: { type: "string", enum: ["pass", "fail", "unsure", "n/a"] },
            reason: { type: "string" },
            box: BOX_SCHEMA,
          },
        },
      },
    },
  };
}

export function rateText(still: JudgeRule[], width: number, height: number): string {
  return [
    `The image is one screen of an app, ${width}x${height} pixels.`,
    "Code checks already measure contrast, sizes, spacing, alignment and motion. Judge only these taste rules:",
    ...still.map((r) => `- ${r.id} (${r.title})`),
    "Give one verdict per rule: pass when the screen follows it, fail when it breaks it, unsure when you cannot tell, n/a when nothing on the screen is about it.",
    "For a fail or unsure, give the box (image pixels) of the region your answer is about; else box is null.",
  ].join("\n");
}

export function compareSchema(ids: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["difference", "better", "rule", "reason"],
    properties: {
      difference: { type: "string" },
      better: { type: "string", enum: ["A", "B", "same", "unsure"] },
      rule: { type: "string", enum: ids },
      reason: { type: "string" },
    },
  };
}

export const COMPARE_TEXT = [
  "Images A and B show two versions of the same interface. A strip of frames is a short clip, read left to right, top to bottom.",
  "First describe the visible difference between A and B. Then say which version follows the design rules better: A, B, same (no difference you can see) or unsure.",
  "Cite the one rule id that decides it, and give the reason in one short sentence.",
].join("\n");

// ---------------------------------------------------------------------------------------------- model

/** ANTHROPIC_API_KEY from the environment, else from ~/workspace/.env (where envsync writes the keys). Never printed. */
export function apiKey(envFile = join(homedir(), "workspace", ".env")): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => /^\s*(export\s+)?ANTHROPIC_API_KEY=/.test(l));
  const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return value || null;
}

/** The Messages API over fetch (this package has no dependencies, so no SDK). Retries 429, 5xx and network errors. */
export function anthropicCall(key: string, opts: { retries?: number } = {}): ModelCall {
  return async (req) => {
    const content: unknown[] = [];
    for (const img of req.images) {
      content.push({ type: "text", text: img.label });
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(img.png).toString("base64") } });
    }
    content.push({ type: "text", text: req.text });
    const body = JSON.stringify({
      model: req.model,
      max_tokens: 16000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
    });
    let last = "";
    for (let attempt = 0; attempt <= (opts.retries ?? 3); attempt++) {
      if (attempt) await Bun.sleep(1000 * 2 ** attempt);
      let res: Response;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2026-10-21" },
          body,
        });
      } catch (error) {
        last = `network: ${error instanceof Error ? error.message : error}`;
        continue;
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        last = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) throw new Error(`Messages API HTTP ${res.status}: ${text.slice(0, 300)}`);
      const msg = JSON.parse(text) as { stop_reason: string; content: Array<{ type: string; text?: string }>; usage: Record<string, number> };
      if (msg.stop_reason === "refusal") throw new Error("the model refused the request");
      if (msg.stop_reason === "max_tokens") throw new Error("the reply hit max_tokens");
      const out = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      return {
        json: JSON.parse(out),
        usage: {
          input: msg.usage.input_tokens ?? 0,
          output: msg.usage.output_tokens ?? 0,
          cacheRead: msg.usage.cache_read_input_tokens ?? 0,
          cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
        },
      };
    }
    throw new Error(`Messages API failed after retries (${last})`);
  };
}

/** The cache key: every byte the model sees, plus the model and its settings. */
export function cacheKey(req: ModelRequest): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ model: req.model, effort: req.effort, system: req.system, text: req.text, schema: req.schema, labels: req.images.map((i) => i.label) }));
  for (const img of req.images) h.update(createHash("sha256").update(img.png).digest("hex"));
  return h.digest("hex");
}

export interface Meter {
  calls: number;
  cached: number;
  usage: Record<string, Usage>;
}

export const newMeter = (): Meter => ({ calls: 0, cached: 0, usage: {} });

/** Calls the model unless the cache holds this exact request. */
export async function cachedCall(call: ModelCall, cacheDir: string, req: ModelRequest, meter: Meter): Promise<unknown> {
  const file = join(cacheDir, `${cacheKey(req)}.json`);
  if (existsSync(file)) {
    meter.cached++;
    return (JSON.parse(readFileSync(file, "utf8")) as { json: unknown }).json;
  }
  const reply = await call(req);
  meter.calls++;
  const u = (meter.usage[req.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  u.input += reply.usage.input;
  u.output += reply.usage.output;
  u.cacheRead += reply.usage.cacheRead;
  u.cacheWrite += reply.usage.cacheWrite;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ model: req.model, json: reply.json, usage: reply.usage }) + "\n");
  return reply.json;
}

export function costUsd(usage: Record<string, Usage>): number {
  let usd = 0;
  for (const [model, u] of Object.entries(usage)) {
    const p = PRICES[model];
    if (!p) continue;
    usd += (u.input * p.input + u.cacheRead * p.input * 0.1 + u.cacheWrite * p.input * 1.25 + u.output * p.output) / 1e6;
  }
  return Math.round(usd * 10000) / 10000;
}

// ---------------------------------------------------------------------------------------------- rate

/** Keeps the verdicts for known rules, one per rule (the first). An unknown rule id is dropped. */
export function parseVerdicts(json: unknown, ids: string[]): RuleVerdict[] {
  const list = (json as { verdicts?: unknown[] } | null)?.verdicts;
  if (!Array.isArray(list)) throw new Error("judge reply has no verdicts list");
  const seen = new Set<string>();
  const out: RuleVerdict[] = [];
  for (const v of list as Array<Partial<RuleVerdict>>) {
    if (!v || typeof v.rule !== "string" || !ids.includes(v.rule) || seen.has(v.rule)) continue;
    if (!["pass", "fail", "unsure", "n/a"].includes(v.verdict as string)) continue;
    seen.add(v.rule);
    const b = v.box;
    const box = b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    out.push({ rule: v.rule, verdict: v.verdict as Verdict, reason: String(v.reason ?? "").slice(0, 300), box });
  }
  return out;
}

export interface ShotRating {
  /** The final verdicts: the strong model's when it was asked, else the cheap model's. */
  verdicts: RuleVerdict[];
  /** Rules where the cheap model said fail or unsure and the strong model said pass (for Ford). */
  disagreed: string[];
  strong: boolean;
}

/** Rates one screenshot: the cheap model first, the strong model again on any fail or unsure. */
export async function rateShot(png: Uint8Array, size: { width: number; height: number }, ctx: { opts: JudgeOptions; rules: { all: JudgeRule[]; still: JudgeRule[] }; meter: Meter; page?: string }): Promise<ShotRating> {
  const models = ctx.opts.models ?? JUDGE_MODELS;
  const ids = ctx.rules.still.map((r) => r.id);
  const base = { system: systemPrompt(ctx.rules.all), images: [{ label: "Screenshot:", png }], text: rateText(ctx.rules.still, size.width, size.height), schema: rateSchema(ids), page: ctx.page };
  const cheap = parseVerdicts(await cachedCall(ctx.opts.call, ctx.opts.cacheDir, { ...base, model: models.cheap, effort: "low" }, ctx.meter), ids);
  if (!cheap.some((v) => v.verdict === "fail" || v.verdict === "unsure")) return { verdicts: cheap, disagreed: [], strong: false };
  const strong = parseVerdicts(await cachedCall(ctx.opts.call, ctx.opts.cacheDir, { ...base, model: models.strong, effort: "medium" }, ctx.meter), ids);
  const flagged = cheap.filter((v) => v.verdict === "fail" || v.verdict === "unsure").map((v) => v.rule);
  const disagreed = flagged.filter((id) => strong.find((v) => v.rule === id)?.verdict === "pass");
  return { verdicts: strong, disagreed, strong: true };
}

export interface PairVerdict {
  difference: string;
  better: "A" | "B" | "same" | "unsure";
  rule: string;
  reason: string;
}

/** Which of two versions follows the rules better. Each side is one image (a still or a frame strip). */
export async function comparePair(a: Uint8Array, b: Uint8Array, ctx: { call: ModelCall; cacheDir: string; model: string; effort: "low" | "medium" | "high"; rules: JudgeRule[]; meter: Meter }): Promise<PairVerdict> {
  const ids = ctx.rules.map((r) => r.id);
  const json = (await cachedCall(ctx.call, ctx.cacheDir, {
    model: ctx.model,
    effort: ctx.effort,
    system: systemPrompt(ctx.rules),
    images: [{ label: "Image A:", png: a }, { label: "Image B:", png: b }],
    text: COMPARE_TEXT,
    schema: compareSchema(ids),
  }, ctx.meter)) as Partial<PairVerdict> | null;
  const better = json?.better;
  if (better !== "A" && better !== "B" && better !== "same" && better !== "unsure") throw new Error("judge reply has no better field");
  return { difference: String(json?.difference ?? ""), better, rule: ids.includes(String(json?.rule)) ? String(json!.rule) : "", reason: String(json?.reason ?? "") };
}

// ---------------------------------------------------------------------------------------------- run

export interface JudgeSummary {
  status: "not-run" | "ran";
  shots: string[];
  note: string;
  models?: { cheap: string; strong: string };
  calls?: number;
  cached?: number;
  usage?: Record<string, Usage>;
  costUsd?: number;
  /** State shots the call cap left unjudged. */
  unjudged?: string[];
  /** Cheap and strong model disagreed: for Ford, never counted. */
  review?: Array<{ shot: string; rules: string[] }>;
}

const stateShots = (pages: PageResult[]) => pages.flatMap((p) => p.shots.filter((s) => s.kind === "state").map((s) => s.file));

/** The judge field when --judge is off: the state screenshots it would read. */
export function judgeOff(pages: PageResult[]): JudgeSummary {
  return { status: "not-run", shots: stateShots(pages), note: "V-judge did not run (opt-in: --judge). V-judge is n/a in every page score." };
}

/** PNG width and height from its IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/**
 * Rates every state screenshot of the scored pages and sets each page's V-judge status: fail on a strong
 * fail, warn on a strong unsure, else pass; n/a when none of its shots was judged. Returns the findings.
 */
export async function runJudge(pages: PageResult[], runDir: string, rules: { all: JudgeRule[]; still: JudgeRule[] }, opts: JudgeOptions, log: (s: string) => void = () => undefined): Promise<{ findings: Finding[]; summary: JudgeSummary }> {
  const meter = newMeter();
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const titles = new Map(rules.still.map((r) => [r.id, r]));
  const findings: Finding[] = [];
  const unjudged: string[] = [];
  const review: JudgeSummary["review"] = [];
  for (const page of pages) {
    if (page.skipped) continue;
    let judged = 0;
    let fails = 0;
    let warns = 0;
    for (const shot of page.shots.filter((s) => s.kind === "state")) {
      // A shot needs up to two calls; stop before the cap, unless both replies are cached.
      if (meter.calls + 2 > maxCalls) {
        unjudged.push(shot.file);
        continue;
      }
      const png = new Uint8Array(readFileSync(join(runDir, shot.file)));
      let rating: ShotRating;
      try {
        rating = await rateShot(png, pngSize(png), { opts, rules, meter, page: page.id });
      } catch (error) {
        page.errors.push(`V-judge ${shot.theme} ${shot.viewport}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      judged++;
      if (rating.disagreed.length) review.push({ shot: shot.file, rules: rating.disagreed });
      for (const v of rating.verdicts) {
        if (v.verdict !== "fail" && v.verdict !== "unsure") continue;
        // Only the strong model's no counts as a fail; its unsure goes to Ford as a warn.
        const severity = v.verdict === "fail" && rating.strong ? "fail" : "warn";
        if (severity === "fail") fails++;
        else warns++;
        const rule = titles.get(v.rule)!;
        findings.push({
          check: "V-judge",
          severity,
          page: page.id,
          theme: shot.theme,
          viewport: shot.viewport,
          selector: null,
          box: v.box,
          measured: v.reason,
          expected: rule.rule,
          message: `${v.verdict === "fail" ? "Breaks" : "Unsure about"} ${rule.title}`,
          rules: [v.rule],
        });
      }
    }
    if (!judged) page.checks["V-judge"] = { status: "n/a", fails: 0, warns: 0, cut: 0, note: unjudged.length ? "not judged: the call cap was reached" : "no state screenshot was judged" };
    else page.checks["V-judge"] = { status: fails ? "fail" : warns ? "warn" : "pass", fails, warns, cut: 0, note: `${judged} screenshots judged` };
    log(`V-judge ${page.id}: ${page.checks["V-judge"]!.status}`);
  }
  const models = opts.models ?? JUDGE_MODELS;
  const usd = costUsd(meter.usage);
  return {
    findings,
    summary: {
      status: "ran",
      shots: stateShots(pages),
      note: `V-judge rated ${stateShots(pages).length - unjudged.length} state screenshots against ${rules.still.length} rules: ${meter.calls} model calls, ${meter.cached} from the cache, about $${usd}.${unjudged.length ? ` ${unjudged.length} screenshots were left unjudged at the call cap of ${maxCalls}.` : ""}`,
      models,
      calls: meter.calls,
      cached: meter.cached,
      usage: meter.usage,
      costUsd: usd,
      unjudged,
      review,
    },
  };
}

