#!/usr/bin/env bun
/**
 * design:judge-calibrate: how often V-judge picks the better version of a known A/B pair.
 *
 *   bun run design:judge-calibrate --media <dir> [--split tune|held-out|all] [--model <id>] [--effort low|medium|high]
 *                                  [--out <file>] [--dry-run]
 *
 * --media is the folder that holds the issue 20 posters and clips (demo-02.png ... demo-27.mp4). They are
 * not in git. The items, their answers and the tune/held-out split are in judge-calibration.json beside
 * this file. Each item is asked twice, with the two options in both orders (A then B, B then A). An item
 * agrees only when both orders pick the known better option, so a judge that always says A or always says
 * B scores zero.
 *
 * Needs ffmpeg. Inputs go to .design-score/judge-calibration/inputs/, the result to --out (default
 * .design-score/judge-calibration/<time>-<split>.json). Replies are cached in .design-score/judge-cache, so a
 * rerun costs nothing. --dry-run builds the inputs and calls no model.
 *
 * Exit: 0 when it finished (whatever the agreement), 2 on bad arguments or a missing file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DESIGN_SYSTEM_ROOT } from "../lib/registry";
import { anthropicCall, apiKey, comparePair, costUsd, JUDGE_MODELS, judgeRules, newMeter, type ModelCall, type PairVerdict } from "./judge";

export interface CalibrationItem {
  q: number;
  kind: "still" | "motion";
  split: "tune" | "held-out";
  good: 1 | 2;
  poster?: string;
  clip?: string;
  /** Poster pixels: the top of the answer bar, and the first row kept. */
  barTop: number;
  top?: number;
  frames?: number;
  windows?: Record<"1" | "2", [number, number]>;
  layout?: "same";
  visible?: boolean;
  rules: string[];
  differs: string;
}

export interface Manifest {
  items: CalibrationItem[];
}

export const MANIFEST_PATH = join(import.meta.dir, "judge-calibration.json");

export function loadManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** The option an order's answer picks: in AB, A is option 1; in BA, A is option 2. */
export function picked(order: "AB" | "BA", better: PairVerdict["better"]): 1 | 2 | null {
  if (better !== "A" && better !== "B") return null;
  return (order === "AB") === (better === "A") ? 1 : 2;
}

export interface ItemResult {
  q: number;
  kind: CalibrationItem["kind"];
  split: CalibrationItem["split"];
  visible: boolean;
  good: 1 | 2;
  rules: string[];
  orders: Record<"AB" | "BA", PairVerdict & { picked: 1 | 2 | null }>;
  agreed: boolean;
  /** The cited rule is one of the item's rules (both orders). */
  ruleMatch: boolean;
}

export interface Tally {
  agreed: number;
  total: number;
}

export function tally(results: ItemResult[], keep: (r: ItemResult) => boolean = () => true): Tally {
  const rows = results.filter(keep);
  return { agreed: rows.filter((r) => r.agreed).length, total: rows.length };
}

const ffmpeg = (args: string[]) => {
  const res = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args]);
  if (res.exitCode !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${res.stderr.toString().trim()}`);
};

/** Writes one option's input image (a poster half or a strip of clip frames) and returns its path. */
export function buildInput(item: CalibrationItem, option: 1 | 2, media: string, outDir: string): string {
  const out = join(outDir, `q${String(item.q).padStart(2, "0")}-${option}.png`);
  const top = item.top ?? 0;
  // The number badge sits in the top-left corner of each half, unless the crop starts below it.
  const mask = (s: number) => (top < 84 && item.layout !== "same" ? `,drawbox=x=0:y=0:w=${96 * s}:h=${96 * s}:color=white:t=fill` : "");
  if (item.poster) {
    const src = join(media, item.poster);
    if (!existsSync(src)) throw new Error(`missing ${src}`);
    const crop = item.layout === "same" ? `crop=1344:${item.barTop - top}:0:${top}` : `crop=672:${item.barTop - top}:${option === 1 ? 0 : 672}:${top}`;
    ffmpeg(["-i", src, "-vf", crop + mask(1), "-frames:v", "1", out]);
    return out;
  }
  const src = join(media, item.clip!);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  const [t0, t1] = item.windows![String(option) as "1" | "2"];
  const n = item.frames ?? 6;
  const cols = Math.min(n, 4);
  const rows = Math.ceil(n / cols);
  // Clips are half the poster's size.
  const crop = `crop=336:${Math.round((item.barTop - top) / 2)}:${option === 1 ? 0 : 336}:${Math.round(top / 2)}`;
  const vf = `fps=${n / (t1 - t0)},${crop}${top < 84 ? ",drawbox=x=0:y=0:w=48:h=48:color=white:t=fill" : ""},tile=${cols}x${rows}:padding=8:color=0x9a9a9a`;
  ffmpeg(["-ss", String(t0), "-t", String(t1 - t0), "-i", src, "-vf", vf, "-frames:v", "1", out]);
  return out;
}

export interface CalibrateOptions {
  media: string;
  split: "tune" | "held-out" | "all";
  model: string;
  effort: "low" | "medium" | "high";
  call: ModelCall | null;
  workDir: string;
  cacheDir: string;
  log?: (s: string) => void;
}

export async function calibrate(manifest: Manifest, opts: CalibrateOptions) {
  const items = manifest.items.filter((i) => opts.split === "all" || i.split === opts.split);
  const inputs = join(opts.workDir, "inputs");
  mkdirSync(inputs, { recursive: true });
  const rules = judgeRules(DESIGN_SYSTEM_ROOT).all;
  const meter = newMeter();
  const results: ItemResult[] = [];
  const log = opts.log ?? (() => undefined);
  for (const item of items) {
    const one = new Uint8Array(readFileSync(buildInput(item, 1, opts.media, inputs)));
    const two = new Uint8Array(readFileSync(buildInput(item, 2, opts.media, inputs)));
    if (!opts.call) continue;
    const ctx = { call: opts.call, cacheDir: opts.cacheDir, model: opts.model, effort: opts.effort, rules, meter };
    const ab = await comparePair(one, two, ctx);
    const ba = await comparePair(two, one, ctx);
    const orders = { AB: { ...ab, picked: picked("AB", ab.better) }, BA: { ...ba, picked: picked("BA", ba.better) } };
    const agreed = orders.AB.picked === item.good && orders.BA.picked === item.good;
    const row: ItemResult = { q: item.q, kind: item.kind, split: item.split, visible: item.visible !== false, good: item.good, rules: item.rules, orders, agreed, ruleMatch: item.rules.includes(ab.rule) && item.rules.includes(ba.rule) };
    results.push(row);
    log(`q${String(item.q).padEnd(3)} ${item.split.padEnd(8)} ${item.kind.padEnd(6)} good ${item.good}  AB→${orders.AB.picked ?? ab.better}  BA→${orders.BA.picked ?? ba.better}  ${agreed ? "agree" : "MISS "}  ${ab.rule}${row.visible ? "" : "  (not in media)"}`);
  }
  return {
    model: opts.model,
    effort: opts.effort,
    split: opts.split,
    items: results,
    summary: {
      all: tally(results),
      tune: tally(results, (r) => r.split === "tune"),
      heldOut: tally(results, (r) => r.split === "held-out"),
      still: tally(results, (r) => r.kind === "still"),
      motion: tally(results, (r) => r.kind === "motion"),
      visible: tally(results, (r) => r.visible),
      ruleMatch: results.filter((r) => r.ruleMatch).length,
      misses: results.filter((r) => !r.agreed).map((r) => r.q),
    },
    calls: meter.calls,
    cached: meter.cached,
    usage: meter.usage,
    costUsd: costUsd(meter.usage),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const fail = (message: string): never => {
    console.error(`design:judge-calibrate: ${message}`);
    process.exit(2);
  };
  if (argv.includes("--help") || !argv.length) {
    console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]!.replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
    process.exit(argv.length ? 0 : 2);
  }
  const media = resolve(flag("--media") ?? fail("--media <dir> is required (the issue 20 posters and clips)"));
  if (!existsSync(media)) fail(`no folder ${media}`);
  const split = (flag("--split") ?? "all") as CalibrateOptions["split"];
  if (!["tune", "held-out", "all"].includes(split)) fail(`--split: "${split}" is not tune, held-out or all`);
  const effort = (flag("--effort") ?? "medium") as CalibrateOptions["effort"];
  if (!["low", "medium", "high"].includes(effort)) fail(`--effort: "${effort}" is not low, medium or high`);
  const dry = argv.includes("--dry-run");
  const key = dry ? null : apiKey() ?? fail("needs ANTHROPIC_API_KEY (environment or ~/workspace/.env)");
  const root = join(DESIGN_SYSTEM_ROOT, ".design-score");
  const workDir = join(root, "judge-calibration");
  const startedAt = new Date();
  const res = await calibrate(loadManifest(), {
    media,
    split,
    model: flag("--model") ?? JUDGE_MODELS.strong,
    effort,
    call: key ? anthropicCall(key) : null,
    workDir,
    cacheDir: join(root, "judge-cache"),
    log: (s) => console.log(s),
  });
  if (dry) {
    console.log(`inputs: ${join(workDir, "inputs")}`);
    process.exit(0);
  }
  const s = res.summary;
  console.log(`\nagreement ${s.all.agreed}/${s.all.total} · tune ${s.tune.agreed}/${s.tune.total} · held-out ${s.heldOut.agreed}/${s.heldOut.total} · still ${s.still.agreed}/${s.still.total} · motion ${s.motion.agreed}/${s.motion.total} · visible in media ${s.visible.agreed}/${s.visible.total}`);
  console.log(`cited the item's rule in both orders: ${s.ruleMatch}/${s.all.total} · ${res.calls} calls, ${res.cached} cached, about $${res.costUsd}`);
  const out = resolve(flag("--out") ?? join(workDir, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${split}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ tool: "design-score-judge-calibration", startedAt: startedAt.toISOString(), source: "Interfaces Magazine issue 20", ...res }, null, 2) + "\n");
  console.log(out);
}
