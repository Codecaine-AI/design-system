/**
 * V-judge: an agent judges the taste rules no code check can decide, from the state screenshots every run
 * already takes (shots/<page>__<theme>__<viewport>.png). design:score calls no model. Design and
 * calibration: docs/10-design-score/85-screenshot-judge.
 *
 *   pack      --judge-pack writes judge/pack.md in the run folder: the still rules (STILL_SKIP lists the
 *             V-judge rules a still cannot show), what each verdict means, the verdicts.json schema, and
 *             each state screenshot still to judge, keyed by the sha256 of its PNG bytes.
 *   verdicts  the agent writes judge/verdicts.json: per screenshot hash and rule id, pass, warn, fail or
 *             unsure, with a one-line reason. --judge-verdicts <path> validates it and folds it into the run.
 *   fold      per page: fail on any fail, warn on any warn or unsure, else pass; n/a when none of its shots
 *             has a verdict. Each fail, warn or unsure is a finding that cites its rule. A verdict whose hash
 *             is not in the run is ignored and listed in judge.stale.
 *   carry     the verdicts of earlier runs of the app (their judge/applied.json) apply by hash, so an
 *             unchanged screenshot needs no new judging. The run's own verdicts.json wins.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeReport } from "./report";
import { loadRules } from "./rules";
import { appAreas, appScore, checkTotals, pageAreas, pageScore } from "./score";
import type { Finding, PageResult, Scorecard } from "./types";

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

/** Every rule in design-score/rules/, and the still rules: V-judge rules a screenshot can show. */
export function judgeRules(designSystem: string): { all: JudgeRule[]; still: JudgeRule[] } {
  const all = loadRules(designSystem).rules.map((r) => {
    const raw = r as typeof r & { rule?: string };
    return { id: r.id, area: r.area ?? "", title: r.title ?? r.id, rule: raw.rule ?? "", check: r.check };
  });
  const still = all.filter((r) => [r.check ?? []].flat().includes("V-judge") && !(r.id in STILL_SKIP));
  return { all: all.map(({ check: _, ...r }) => r), still: still.map(({ check: _, ...r }) => r) };
}

// ---------------------------------------------------------------------------------------------- pack text

/** How to look. The run pack and the calibration pack share it; calibration tunes this text. */
export const LOOK = [
  "Judge only what the pixels show. Code checks already measure contrast, sizes, spacing, alignment and motion timing, so judge taste, not numbers.",
  "Before you give a verdict, name the exact element the rule is about and what you see in it: the words of a heading and where its lines break, the quote and dash characters, the corners, the edges of a card on what is behind it, the space around an icon.",
  "Look at the detail at full size. A difference of one character, one line break or a few pixels is often the whole answer.",
  "When the image cannot show whether a rule holds (it needs motion, hover, a second state or the source), say unsure. Never guess from what is typical.",
  "Each reason is one line that names what you see.",
];

export const VERDICT_MEANING: Record<Verdict, string> = {
  pass: "the screen follows the rule, or nothing on it is about the rule.",
  warn: "the screen mostly follows the rule but one detail is weak (a near miss). Counts half.",
  fail: "the screen clearly breaks the rule in a place you can name.",
  unsure: "the image cannot show whether the rule holds. Counts as warn, so use it only when you looked and cannot tell.",
};

/** The rules as pack lines, grouped by area. */
export function ruleLines(rules: JudgeRule[]): string[] {
  const areas = [...new Set(rules.map((r) => r.area))];
  return areas.flatMap((a) => [`### ${a}`, "", ...rules.filter((r) => r.area === a).map((r) => `- \`${r.id}\` (${r.title}): ${r.rule}`), ""]);
}

// ---------------------------------------------------------------------------------------------- verdicts

export const VERDICTS = ["pass", "warn", "fail", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface RuleVerdict {
  verdict: Verdict;
  reason: string;
}

/** Screenshot sha256 -> rule id -> verdict. */
export type VerdictMap = Record<string, Record<string, RuleVerdict>>;

const HASH = /^[0-9a-f]{64}$/;
const MAX_REASON = 300;

/** The verdicts.json schema (JSON Schema 2020-12), as the pack prints it. validateVerdicts enforces it. */
export function verdictsSchema(ruleIds: string[]) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["version", "shots"],
    properties: {
      version: { const: 1 },
      shots: {
        type: "object",
        description: "Keyed by the screenshot's sha256 (64 lowercase hex characters).",
        propertyNames: { pattern: HASH.source },
        additionalProperties: {
          type: "object",
          description: "Keyed by rule id. Give every rule.",
          propertyNames: { enum: ruleIds },
          required: ruleIds,
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["verdict", "reason"],
            properties: {
              verdict: { enum: [...VERDICTS] },
              reason: { type: "string", minLength: 1, maxLength: MAX_REASON, pattern: "^[^\\n\\r]+$" },
            },
          },
        },
      },
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a parsed verdicts.json against verdictsSchema. Returns the verdicts, or every error found. */
export function validateVerdicts(json: unknown, ruleIds: string[]): { shots: VerdictMap; errors: string[] } {
  const errors: string[] = [];
  const shots: VerdictMap = {};
  if (!isObject(json)) return { shots, errors: ["the file is not a JSON object"] };
  for (const key of Object.keys(json)) if (key !== "version" && key !== "shots") errors.push(`unknown top-level key "${key}"`);
  if (json.version !== 1) errors.push(`version must be 1, not ${JSON.stringify(json.version)}`);
  if (!isObject(json.shots)) return { shots, errors: [...errors, "shots must be an object keyed by screenshot hash"] };
  const ids = new Set(ruleIds);
  for (const [hash, rules] of Object.entries(json.shots)) {
    if (!HASH.test(hash)) errors.push(`shots: "${hash}" is not a sha256 (64 lowercase hex characters)`);
    if (!isObject(rules)) {
      errors.push(`shots.${hash}: must be an object keyed by rule id`);
      continue;
    }
    const missing = ruleIds.filter((id) => !(id in rules));
    if (missing.length) errors.push(`shots.${hash.slice(0, 12)}: no verdict for ${missing.length} rules (${missing.join(", ")})`);
    for (const [rule, v] of Object.entries(rules)) {
      const at = `shots.${hash.slice(0, 12)}.${rule}`;
      if (!ids.has(rule)) errors.push(`${at}: "${rule}" is not one of the ${ruleIds.length} rules in the pack`);
      if (!isObject(v)) {
        errors.push(`${at}: must be { "verdict", "reason" }`);
        continue;
      }
      for (const key of Object.keys(v)) if (key !== "verdict" && key !== "reason") errors.push(`${at}: unknown key "${key}"`);
      if (!VERDICTS.includes(v.verdict as Verdict)) errors.push(`${at}: verdict ${JSON.stringify(v.verdict)} is not ${VERDICTS.join(", ")}`);
      if (typeof v.reason !== "string" || !v.reason.trim()) errors.push(`${at}: reason must be a non-empty string`);
      else if (/[\n\r]/.test(v.reason)) errors.push(`${at}: reason must be one line`);
      else if (v.reason.length > MAX_REASON) errors.push(`${at}: reason is over ${MAX_REASON} characters`);
      (shots[hash] ??= {})[rule] = { verdict: v.verdict as Verdict, reason: v.reason as string };
    }
  }
  return { shots: errors.length ? {} : shots, errors };
}

/** Reads and validates a verdicts.json file. Throws with every error. */
export function readVerdicts(path: string, ruleIds: string[]): VerdictMap {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not JSON (${error instanceof Error ? error.message : error})`);
  }
  const { shots, errors } = validateVerdicts(json, ruleIds);
  if (errors.length) throw new Error(`${path} does not match the verdicts schema:\n  ${errors.join("\n  ")}`);
  return shots;
}

/**
 * Verdicts carried from the app's other runs (siblings of runDir): each run's judge/applied.json, oldest
 * run first, so a later run's verdict wins. A file that fails the schema (an older rule set) is skipped.
 */
export function carriedVerdicts(runDir: string, ruleIds: string[]): VerdictMap {
  const appDir = dirname(runDir);
  const self = runDir.slice(appDir.length + 1);
  const out: VerdictMap = {};
  const runs = existsSync(appDir) ? readdirSync(appDir).filter((d) => d !== self && existsSync(join(appDir, d, "judge", "applied.json"))).sort() : [];
  for (const run of runs) {
    let shots: VerdictMap;
    try {
      shots = readVerdicts(join(appDir, run, "judge", "applied.json"), ruleIds);
    } catch {
      continue;
    }
    for (const [hash, rules] of Object.entries(shots)) out[hash] = { ...out[hash], ...rules };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- run

export interface JudgedShot {
  file: string;
  hash: string;
  page: string;
  theme: string;
  viewport: string;
  /** Where its verdicts came from: this run's verdicts.json, an earlier run, or none yet. */
  from: "run" | "carried" | "none";
}

export interface JudgeSummary {
  shots: JudgedShot[];
  rules: number;
  /** Hashes in this run's verdicts.json that match no screenshot in the run (ignored). */
  stale: string[];
  /** judge/pack.md, relative to the run folder, when --judge-pack wrote it. */
  pack: string | null;
  note: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A page V-judge leaves alone: skipped, or its config skips V-judge. */
const unjudged = (p: PageResult) => !!p.skipped || !!p.checks["V-judge"]?.skipped;

/** Every state screenshot of the pages V-judge scores, with its hash. */
export function stateShots(pages: PageResult[], runDir: string): Omit<JudgedShot, "from">[] {
  return pages.filter((p) => !unjudged(p)).flatMap((p) =>
    p.shots.filter((s) => s.kind === "state" && existsSync(join(runDir, s.file))).map((s) => ({ file: s.file, hash: sha256(readFileSync(join(runDir, s.file))), page: p.id, theme: s.theme, viewport: s.viewport })),
  );
}

const MESSAGE: Record<Exclude<Verdict, "pass">, string> = { fail: "Breaks", warn: "Near miss on", unsure: "Unsure about" };

/**
 * Folds verdicts into the pages: sets each page's V-judge status and returns the findings. `own` is this
 * run's verdicts.json, `carried` the earlier runs'. Per rule, own wins.
 */
export function foldVerdicts(pages: PageResult[], runDir: string, still: JudgeRule[], own: VerdictMap, carried: VerdictMap): { findings: Finding[]; shots: JudgedShot[]; applied: VerdictMap; stale: string[] } {
  const rules = new Map(still.map((r) => [r.id, r]));
  const shots = stateShots(pages, runDir);
  const findings: Finding[] = [];
  const applied: VerdictMap = {};
  const judged: JudgedShot[] = [];
  for (const page of pages) {
    if (unjudged(page)) continue;
    let fails = 0;
    let warns = 0;
    let count = 0;
    for (const shot of shots.filter((s) => s.page === page.id)) {
      const verdicts = { ...carried[shot.hash], ...own[shot.hash] };
      const from = own[shot.hash] ? "run" : carried[shot.hash] ? "carried" : "none";
      judged.push({ ...shot, from });
      if (from === "none") continue;
      count++;
      applied[shot.hash] = verdicts;
      for (const [id, v] of Object.entries(verdicts)) {
        if (v.verdict === "pass") continue;
        const severity = v.verdict === "fail" ? "fail" : "warn";
        if (severity === "fail") fails++;
        else warns++;
        const rule = rules.get(id)!;
        findings.push({ check: "V-judge", severity, page: page.id, theme: shot.theme, viewport: shot.viewport, selector: null, box: null, measured: v.reason, expected: rule.rule, message: `${MESSAGE[v.verdict]} ${rule.title}`, rules: [id], group: `${id}|${v.reason}` });
      }
    }
    const total = shots.filter((s) => s.page === page.id).length;
    page.checks["V-judge"] = count
      ? { status: fails ? "fail" : warns ? "warn" : "pass", fails, warns, cut: 0, note: `${count} of ${total} screenshots judged` }
      : { status: "n/a", fails: 0, warns: 0, cut: 0, note: "no screenshot has a verdict (design:score --judge-pack writes the pack)" };
  }
  const known = new Set(shots.map((s) => s.hash));
  return { findings, shots: judged, applied, stale: Object.keys(own).filter((h) => !known.has(h)) };
}

/** judge/pack.md: what an agent reads to judge this run. Lists only the screenshots with no verdict yet. */
export function packText(card: Pick<Scorecard, "app" | "runId">, runDir: string, still: JudgeRule[], shots: JudgedShot[], cli: string): string {
  const todo = new Map<string, JudgedShot[]>();
  for (const s of shots.filter((s) => s.from === "none")) todo.set(s.hash, [...(todo.get(s.hash) ?? []), s]);
  const carried = new Set(shots.filter((s) => s.from !== "none").map((s) => s.hash)).size;
  const example = { version: 1, shots: { [todo.keys().next().value ?? "0".repeat(64)]: { [still[0]!.id]: { verdict: "pass", reason: "One line that names what you see." } } } };
  const verdictsPath = join(runDir, "judge", "verdicts.json");
  return [
    `# V-judge pack: ${card.app}, run ${card.runId}`,
    "",
    `You are the design judge. Open each screenshot below, judge it against each of the ${still.length} rules, and write ${verdictsPath}.`,
    "",
    "## How to look",
    "",
    ...LOOK.map((l) => `- ${l}`),
    "",
    "## Verdicts",
    "",
    ...VERDICTS.map((v) => `- \`${v}\`: ${VERDICT_MEANING[v]}`),
    "",
    "## Rules",
    "",
    ...ruleLines(still),
    "## verdicts.json",
    "",
    "One entry per screenshot hash and rule id. Give every rule for every screenshot.",
    "",
    "```json",
    JSON.stringify(verdictsSchema(still.map((r) => r.id)), null, 2),
    "```",
    "",
    "Example:",
    "",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "",
    `Then fold it into the run: \`${cli} --judge-verdicts ${verdictsPath}\``,
    "",
    `## Screenshots (${todo.size} to judge${carried ? `, ${carried} carried from earlier runs` : ""})`,
    "",
    ...(todo.size ? [...todo].flatMap(([hash, places]) => [`### \`${hash}\``, "", `- file: ${join(runDir, places[0]!.file)}`, ...places.map((p) => `- ${p.page} · ${p.theme} · ${p.viewport}`), ""]) : ["Every screenshot already has a verdict from an earlier run.", ""]),
  ].join("\n");
}

export interface JudgeRunOptions {
  /** Write judge/pack.md. */
  pack?: boolean;
  /** The command the pack tells the agent to run next. */
  cli?: string;
}

/**
 * Folds the run's judge/verdicts.json (if any) and the carried verdicts into the scorecard: page statuses,
 * V-judge findings, scores, judge summary. Writes judge/applied.json, and judge/pack.md with opts.pack.
 * Throws when verdicts.json does not match the schema.
 */
export function judgeRun(card: Scorecard, runDir: string, designSystem: string, opts: JudgeRunOptions = {}): Scorecard {
  const still = judgeRules(designSystem).still;
  const ids = still.map((r) => r.id);
  const ownPath = join(runDir, "judge", "verdicts.json");
  const own = existsSync(ownPath) ? readVerdicts(ownPath, ids) : {};
  const folded = foldVerdicts(card.pages, runDir, still, own, carriedVerdicts(runDir, ids));
  mkdirSync(join(runDir, "judge"), { recursive: true });
  writeFileSync(join(runDir, "judge", "applied.json"), JSON.stringify({ version: 1, shots: folded.applied }, null, 2) + "\n");
  let pack: string | null = null;
  if (opts.pack) {
    pack = "judge/pack.md";
    writeFileSync(join(runDir, pack), packText(card, runDir, still, folded.shots, opts.cli ?? `bun run design:score --app ${card.app}`));
  }
  for (const p of card.pages) {
    // A page whose browser checks all failed keeps no score (see run.ts).
    if (p.score !== null || (!unjudged(p) && p.checks["V-judge"]?.status !== "n/a")) p.score = pageScore(p.checks);
    p.areas = pageAreas(p.checks);
  }
  const hashes = (from: JudgedShot["from"]) => new Set(folded.shots.filter((s) => s.from === from).map((s) => s.hash)).size;
  const total = new Set(folded.shots.map((s) => s.hash)).size;
  const left = hashes("none");
  card.findings = [...card.findings.filter((f) => f.check !== "V-judge"), ...folded.findings];
  card.score = appScore(card.pages);
  card.areas = appAreas(card.pages);
  card.checkTotals = checkTotals(card.pages);
  card.judge = {
    shots: folded.shots,
    rules: still.length,
    stale: folded.stale,
    pack,
    note: [
      `V-judge: ${total - left} of ${total} distinct state screenshots have verdicts (${hashes("run")} from this run, ${hashes("carried")} carried from earlier runs), against ${still.length} rules.`,
      left ? `${left} have none, so their pages stay n/a${pack ? `: an agent judges them from ${pack}` : " (--judge-pack writes the pack)"}.` : "",
      folded.stale.length ? `${folded.stale.length} verdicts.json entries match no screenshot in this run and were ignored: ${folded.stale.map((h) => h.slice(0, 12)).join(", ")}.` : "",
    ].filter(Boolean).join(" "),
  };
  return card;
}

/**
 * --judge-verdicts: validates a verdicts.json, puts it at <run>/judge/verdicts.json, and refolds the run's
 * scorecard.json and report.html. No browser, no capture.
 */
export function refoldRun(runDir: string, verdictsPath: string, designSystem: string): Scorecard {
  const ids = judgeRules(designSystem).still.map((r) => r.id);
  const own = readVerdicts(verdictsPath, ids);
  const target = join(runDir, "judge", "verdicts.json");
  mkdirSync(dirname(target), { recursive: true });
  if (verdictsPath !== target) writeFileSync(target, JSON.stringify({ version: 1, shots: own }, null, 2) + "\n");
  const card = JSON.parse(readFileSync(join(runDir, "scorecard.json"), "utf8")) as Scorecard;
  judgeRun(card, runDir, designSystem);
  writeFileSync(join(runDir, "scorecard.json"), JSON.stringify(card, null, 2) + "\n");
  writeReport(runDir, card, designSystem);
  return card;
}
