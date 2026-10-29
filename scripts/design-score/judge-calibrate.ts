#!/usr/bin/env bun
/**
 * design:judge-calibrate: how often the V-judge agent picks the better version of a known A/B pair.
 *
 *   bun run design:judge-calibrate --media <dir> [--split tune|held-out|all]    write the pack
 *   bun run design:judge-calibrate --verdicts <file> [--out <file>]            score the agent's verdicts
 *
 * --media is the folder that holds the issue 20 posters and clips (demo-02.png ... demo-27.mp4). They are
 * not in git. The items, their answers and the tune/held-out split are in judge-calibration.json beside
 * this file.
 *
 * The pack step writes .design-score/judge-calibration/<split>/: pack.md (the same rubric text as a run's
 * judge/pack.md, the verdicts schema and every pair), images/<pair>-A.png and -B.png, and pairs.json (which
 * question and order each pair is). Each item appears twice, with its two options in both orders, under
 * opaque pair ids in hash order, so neither the order nor the answer shows. The pack holds no answer.
 * An agent writes verdicts.json beside pack.md.
 *
 * The score step reads pairs.json beside the verdicts file and the answers from the manifest. An item
 * agrees only when both orders pick the known better option, so a judge that always says A or always says
 * B scores zero. The result goes to --out (default result.json beside the verdicts).
 *
 * Needs ffmpeg. Exit: 0 when it finished (whatever the agreement), 2 on bad arguments, a missing file or a
 * verdicts file that does not match the schema.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DESIGN_SYSTEM_ROOT } from "../lib/registry";
import { judgeRules, LOOK, ruleLines } from "./judge";

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

export type Order = "AB" | "BA";
export const BETTER = ["A", "B", "same", "unsure"] as const;
export type Better = (typeof BETTER)[number];

export interface PairVerdict {
  better: Better;
  rule: string;
  reason: string;
}

/** The option an order's answer picks: in AB, A is option 1; in BA, A is option 2. */
export function picked(order: Order, better: Better): 1 | 2 | null {
  if (better !== "A" && better !== "B") return null;
  return (order === "AB") === (better === "A") ? 1 : 2;
}

/** An opaque, stable pair id: it shows neither the question nor the order. */
export const pairId = (q: number, order: Order) => "p" + createHash("sha256").update(`issue-20-q${q}-${order}`).digest("hex").slice(0, 6);

export interface Pair {
  id: string;
  q: number;
  order: Order;
}

/** Both orders of each item, in id order (a fixed shuffle). */
export function pairsOf(items: CalibrationItem[]): Pair[] {
  return items.flatMap((i) => (["AB", "BA"] as const).map((order) => ({ id: pairId(i.q, order), q: i.q, order }))).sort((a, b) => a.id.localeCompare(b.id));
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

// ---------------------------------------------------------------------------------------------- pack

/** The A/B question. The rubric around it (LOOK, the rules) is the run pack's. */
export const COMPARE = [
  "Images A and B show two versions of the same interface. A grid of frames is a short clip: read it left to right, top to bottom, and compare the same frame in A and B.",
  "First find the visible difference between A and B. Then say which version follows the design rules better: A, B, same (you see no difference) or unsure (you see a difference but no rule decides it).",
  "When one version visibly breaks a rule and the other never shows that moment, the other version is better.",
  "Cite the one rule id that decides it, and give the reason in one line.",
];

export function verdictsSchema(pairIds: string[], ruleIds: string[]) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["version", "pairs"],
    properties: {
      version: { const: 1 },
      pairs: {
        type: "object",
        propertyNames: { enum: pairIds },
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["better", "rule", "reason"],
          properties: { better: { enum: [...BETTER] }, rule: { enum: ruleIds }, reason: { type: "string", minLength: 1, pattern: "^[^\\n\\r]+$" } },
        },
      },
    },
  };
}

export function packText(pairs: Pair[], imagesDir: string, verdictsPath: string): string {
  const rules = judgeRules(DESIGN_SYSTEM_ROOT).all;
  const example = { version: 1, pairs: { [pairs[0]!.id]: { better: "A", rule: rules[0]!.id, reason: "One line that names the difference you see." } } };
  return [
    "# V-judge calibration pack",
    "",
    `You are the design judge. For each pair below, open both images, decide which version follows the design rules better, and write ${verdictsPath}.`,
    "",
    "## How to look",
    "",
    ...[...LOOK, ...COMPARE].map((l) => `- ${l}`),
    "",
    "## Rules",
    "",
    ...ruleLines(rules),
    "## verdicts.json",
    "",
    "One entry per pair.",
    "",
    "```json",
    JSON.stringify(verdictsSchema(pairs.map((p) => p.id), ["<any rule id above>"]), null, 2),
    "```",
    "",
    "Example:",
    "",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "",
    `## Pairs (${pairs.length})`,
    "",
    ...pairs.flatMap((p) => [`### ${p.id}`, "", `- A: ${join(imagesDir, `${p.id}-A.png`)}`, `- B: ${join(imagesDir, `${p.id}-B.png`)}`, ""]),
  ].join("\n");
}

/** Writes <workDir>/pack.md, images/ and pairs.json for the items. Returns the pack path. */
export function writePack(items: CalibrationItem[], media: string, workDir: string): string {
  const images = join(workDir, "images");
  rmSync(images, { recursive: true, force: true });
  mkdirSync(images, { recursive: true });
  // The q-named inputs stay in a temp folder: the work folder shows only pair ids.
  const tmp = mkdtempSync(join(tmpdir(), "ds-judge-calibrate-"));
  try {
    const pairs = pairsOf(items);
    for (const item of items) {
      const one = buildInput(item, 1, media, tmp);
      const two = buildInput(item, 2, media, tmp);
      for (const p of pairs.filter((p) => p.q === item.q)) {
        copyFileSync(p.order === "AB" ? one : two, join(images, `${p.id}-A.png`));
        copyFileSync(p.order === "AB" ? two : one, join(images, `${p.id}-B.png`));
      }
    }
    writeFileSync(join(workDir, "pairs.json"), JSON.stringify({ version: 1, pairs }, null, 2) + "\n");
    const pack = join(workDir, "pack.md");
    writeFileSync(pack, packText(pairs, images, join(workDir, "verdicts.json")));
    return pack;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------- score

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a parsed calibration verdicts.json against verdictsSchema. */
export function validatePairVerdicts(json: unknown, pairIds: string[], ruleIds: string[]): { pairs: Record<string, PairVerdict>; errors: string[] } {
  const errors: string[] = [];
  const pairs: Record<string, PairVerdict> = {};
  if (!isObject(json)) return { pairs, errors: ["the file is not a JSON object"] };
  for (const key of Object.keys(json)) if (key !== "version" && key !== "pairs") errors.push(`unknown top-level key "${key}"`);
  if (json.version !== 1) errors.push(`version must be 1, not ${JSON.stringify(json.version)}`);
  if (!isObject(json.pairs)) return { pairs, errors: [...errors, "pairs must be an object keyed by pair id"] };
  const ids = new Set(pairIds);
  const rules = new Set(ruleIds);
  for (const [id, v] of Object.entries(json.pairs)) {
    if (!ids.has(id)) errors.push(`pairs: "${id}" is not a pair in the pack`);
    if (!isObject(v)) {
      errors.push(`pairs.${id}: must be { "better", "rule", "reason" }`);
      continue;
    }
    for (const key of Object.keys(v)) if (!["better", "rule", "reason"].includes(key)) errors.push(`pairs.${id}: unknown key "${key}"`);
    if (!BETTER.includes(v.better as Better)) errors.push(`pairs.${id}: better ${JSON.stringify(v.better)} is not ${BETTER.join(", ")}`);
    if (typeof v.rule !== "string" || !rules.has(v.rule)) errors.push(`pairs.${id}: rule ${JSON.stringify(v.rule)} is not a rule id`);
    if (typeof v.reason !== "string" || !v.reason.trim() || /[\n\r]/.test(v.reason)) errors.push(`pairs.${id}: reason must be one non-empty line`);
    pairs[id] = { better: v.better as Better, rule: String(v.rule), reason: String(v.reason) };
  }
  return { pairs: errors.length ? {} : pairs, errors };
}

export interface ItemResult {
  q: number;
  kind: CalibrationItem["kind"];
  split: CalibrationItem["split"];
  visible: boolean;
  good: 1 | 2;
  rules: string[];
  orders: Record<Order, (PairVerdict & { pair: string; picked: 1 | 2 | null }) | null>;
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

/** Scores verdicts against the answers. Items whose pairs are not in `pairs` are left out; a pair with no verdict is a miss. */
export function score(manifest: Manifest, pairs: Pair[], verdicts: Record<string, PairVerdict>) {
  const results: ItemResult[] = [];
  for (const item of manifest.items) {
    const mine = pairs.filter((p) => p.q === item.q);
    if (!mine.length) continue;
    const order = (o: Order) => {
      const p = mine.find((m) => m.order === o)!;
      const v = verdicts[p.id];
      return v ? { ...v, pair: p.id, picked: picked(o, v.better) } : null;
    };
    const orders = { AB: order("AB"), BA: order("BA") };
    results.push({
      q: item.q,
      kind: item.kind,
      split: item.split,
      visible: item.visible !== false,
      good: item.good,
      rules: item.rules,
      orders,
      agreed: orders.AB?.picked === item.good && orders.BA?.picked === item.good,
      ruleMatch: !!orders.AB && !!orders.BA && item.rules.includes(orders.AB.rule) && item.rules.includes(orders.BA.rule),
    });
  }
  const split = (s: string) => (r: ItemResult) => r.split === s;
  return {
    items: results,
    summary: {
      all: tally(results),
      judgeable: tally(results, (r) => r.visible),
      tune: tally(results, split("tune")),
      heldOut: tally(results, split("held-out")),
      heldOutJudgeable: tally(results, (r) => r.split === "held-out" && r.visible),
      still: tally(results, (r) => r.kind === "still"),
      motion: tally(results, (r) => r.kind === "motion"),
      ruleMatch: results.filter((r) => r.ruleMatch).length,
      misses: results.filter((r) => !r.agreed).map((r) => r.q),
    },
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
  const manifest = loadManifest();
  const verdictsArg = flag("--verdicts");
  if (verdictsArg) {
    const file = resolve(verdictsArg);
    const pairsFile = join(dirname(file), "pairs.json");
    if (!existsSync(file)) fail(`no file ${file}`);
    if (!existsSync(pairsFile)) fail(`no pairs.json beside ${file} (write the pack first)`);
    const pairs = (JSON.parse(readFileSync(pairsFile, "utf8")) as { pairs: Pair[] }).pairs;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      fail(`${file}: not JSON (${error instanceof Error ? error.message : error})`);
    }
    const { pairs: verdicts, errors } = validatePairVerdicts(json, pairs.map((p) => p.id), judgeRules(DESIGN_SYSTEM_ROOT).all.map((r) => r.id));
    if (errors.length) fail(`${file} does not match the verdicts schema:\n  ${errors.join("\n  ")}`);
    const res = score(manifest, pairs, verdicts);
    for (const r of res.items) {
      const show = (o: Order) => r.orders[o]?.picked ?? r.orders[o]?.better ?? "-";
      console.log(`q${String(r.q).padEnd(3)} ${r.split.padEnd(8)} ${r.kind.padEnd(6)} good ${r.good}  AB→${show("AB")}  BA→${show("BA")}  ${r.agreed ? "agree" : "MISS "}  ${r.orders.AB?.rule ?? ""}${r.visible ? "" : "  (not in media)"}`);
    }
    const s = res.summary;
    const t = (x: Tally) => `${x.agreed}/${x.total}`;
    console.log(`\nagreement ${t(s.all)} · judgeable ${t(s.judgeable)} · tune ${t(s.tune)} · held-out ${t(s.heldOut)} (judgeable ${t(s.heldOutJudgeable)}) · still ${t(s.still)} · motion ${t(s.motion)}`);
    console.log(`cited the item's rule in both orders: ${s.ruleMatch}/${s.all.total} · misses: ${s.misses.join(", ") || "none"}`);
    const out = resolve(flag("--out") ?? join(dirname(file), "result.json"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ tool: "design-score-judge-calibration", scoredAt: new Date().toISOString(), source: "Interfaces Magazine issue 20", verdicts: file, ...res }, null, 2) + "\n");
    console.log(out);
    process.exit(0);
  }
  const media = resolve(flag("--media") ?? fail("--media <dir> is required (the issue 20 posters and clips), or --verdicts <file> to score"));
  if (!existsSync(media)) fail(`no folder ${media}`);
  const split = flag("--split") ?? "all";
  if (!["tune", "held-out", "all"].includes(split)) fail(`--split: "${split}" is not tune, held-out or all`);
  const items = manifest.items.filter((i) => split === "all" || i.split === split);
  const workDir = join(DESIGN_SYSTEM_ROOT, ".design-score", "judge-calibration", split);
  mkdirSync(workDir, { recursive: true });
  console.log(writePack(items, media, workDir));
}
