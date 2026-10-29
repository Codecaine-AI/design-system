#!/usr/bin/env bun
/**
 * design:score: score every page of an app against the design principles.
 *
 *   bun run design:score --app <id> [--base-url <url>] [--label <name>] [--pages a,b,docs-*] [--quick]
 *                        [--themes light,dark] [--viewports 1440x900,1024x768] [--jobs 2] [--no-motion] [--no-focus]
 *                        [--no-static] [--config <file>] [--out <dir>] [--root <dir>] [--json]
 *                        [--judge [--judge-max-calls 100] [--judge-cache <dir>]]
 *   bun run design:score --app <id> --list-pages
 *   bun run design:score --fixture <check-id>[,<check-id>...] [--root <dir>]
 *
 * --pages takes page ids or globs (`*`); an unknown id is an error. --quick scores one theme (the first)
 * at one viewport (the first): about a third of the time, for hill-climbing; a full run is what counts.
 *   bun run design:score --compare <runA> <runB> [--out <file>]
 *
 * The app config is design-score/apps/<id>.json. The app is visited at --base-url, else the config's
 * baseUrl (an app that is already running), else its apps.json entry (`registryApp`) is started with
 * app-runner and stopped afterwards. Browsing is read-only: every non-GET request is aborted unless the
 * config allows it.
 *
 * Writes .design-score/<app>/<timestamp>[-<label>]/ (scorecard.json, report.html, shots/, crops/) in this
 * checkout (git-ignored). --compare takes two run folders (or <app>/<run> under .design-score, or
 * "<app>/latest" and "<app>/previous") and writes an HTML page with both runs' screenshots side by side
 * per page and the score delta per check.
 *
 * --judge runs V-judge, the screenshot judge (scripts/design-score/judge.ts): a vision model rates each state
 * screenshot against the taste rules. It costs money, so it is opt-in. It reads ANTHROPIC_API_KEY from the
 * environment or <workspace>/.env, stops after --judge-max-calls uncached calls, and caches every reply by
 * screenshot hash in --judge-cache (default .design-score/judge-cache), so a rerun over the same pixels is free.
 * Calibration: bun run design:judge-calibrate --media <issue-20 media folder>.
 *
 * --fixture runs one check against design-score/fixtures/<check-id>/good.html and bad.html (scripts/design-score/fixture.ts),
 * prints each page's status, and writes shots/good.png and shots/bad.png there with the findings boxed.
 * It exits 1 unless the bad page fails (warns, for a warn-only check) and the good page passes.
 *
 * Exit: 0 when the run finished (whatever the score), 1 when a page errored, 2 on bad arguments.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { cleanupRuns, installSignalHandlers, startApp, validateLoadedRegistry, type RunningApp } from "../lib/app-runner";
import { pinPlaywright } from "../lib/playwright";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, workspaceRoot } from "../lib/registry";
import { CHECKS } from "./checks";
import { judgeFixture, runFixture } from "./fixture";
import { anthropicCall, apiKey, DEFAULT_MAX_CALLS, type JudgeOptions } from "./judge";
import { writeCompare } from "./report";
import { AREAS } from "./score";
import { runScore, selectPages } from "./run";
import type { AppConfig } from "./types";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const fail = (message: string, code = 2): never => {
  console.error(`design:score: ${message}`);
  process.exit(code);
};
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

const OUT_ROOT = join(DESIGN_SYSTEM_ROOT, ".design-score");

/** --judge: the real model, its cache and its call cap. Null without --judge. */
function judgeOptions(): JudgeOptions | null {
  if (!has("--judge")) return null;
  const key = apiKey() ?? fail("--judge needs ANTHROPIC_API_KEY (environment or ~/workspace/.env)");
  const max = flag("--judge-max-calls") ?? String(DEFAULT_MAX_CALLS);
  if (!/^[1-9]\d*$/.test(max)) fail(`--judge-max-calls: "${max}" is not a positive integer`);
  return { call: anthropicCall(key!), cacheDir: resolve(flag("--judge-cache") ?? join(OUT_ROOT, "judge-cache")), maxCalls: Number(max) };
}

/** A run folder from a path, "<app>/<run>", "<app>/latest" or "<app>/previous". */
function runDir(ref: string): string {
  const direct = isAbsolute(ref) ? ref : resolve(process.cwd(), ref);
  if (existsSync(join(direct, "scorecard.json"))) return direct;
  const [app, run] = ref.split("/");
  const appDir = join(OUT_ROOT, app ?? "");
  if (app && run && existsSync(appDir)) {
    const runs = readdirSync(appDir)
      .filter((d) => existsSync(join(appDir, d, "scorecard.json")))
      .sort((a, b) => statSync(join(appDir, a)).mtimeMs - statSync(join(appDir, b)).mtimeMs);
    if (run === "latest" && runs.length) return join(appDir, runs[runs.length - 1]!);
    if (run === "previous" && runs.length > 1) return join(appDir, runs[runs.length - 2]!);
    const match = runs.find((d) => d === run || d.endsWith(`-${run}`));
    if (match) return join(appDir, match);
  }
  return fail(`no run at ${ref} (a run folder with scorecard.json, or <app>/<run>, <app>/latest, <app>/previous)`);
}

if (has("--help") || has("-h") || !argv.length) {
  console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]!.replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
  console.log("Checks: " + CHECKS.map((c) => c.id).join(", "));
  process.exit(argv.length ? 0 : 2);
}

if (has("--compare")) {
  const i = argv.indexOf("--compare");
  const a = argv[i + 1];
  const b = argv[i + 2];
  if (!a || !b || a.startsWith("--") || b.startsWith("--")) fail("--compare needs two runs");
  const dirA = runDir(a!);
  const dirB = runDir(b!);
  const app = basename(join(dirB, ".."));
  const out = flag("--out") ?? join(OUT_ROOT, app, "compare", `${basename(dirA)}__vs__${basename(dirB)}.html`);
  const path = writeCompare(dirA, dirB, resolve(out), DESIGN_SYSTEM_ROOT);
  const ca = JSON.parse(readFileSync(join(dirA, "scorecard.json"), "utf8"));
  const cb = JSON.parse(readFileSync(join(dirB, "scorecard.json"), "utf8"));
  const scoreText = (score: number | null) => (score === null ? "n/a" : String(score));
  const delta = ca.score === null || cb.score === null ? "" : ` (${cb.score - ca.score >= 0 ? "+" : ""}${Math.round((cb.score - ca.score) * 10) / 10})`;
  console.log(`${ca.app}: ${scoreText(ca.score)} → ${scoreText(cb.score)}${delta}`);
  console.log(path);
  process.exit(0);
}

if (has("--fixture")) {
  const ids = list(flag("--fixture")) ?? fail("--fixture <check-id> is required");
  const root = resolve(flag("--root") ?? workspaceRoot());
  pinPlaywright(root);
  let ok = true;
  for (const id of ids!) {
    try {
      const res = await runFixture(id, { designSystem: DESIGN_SYSTEM_ROOT, root, judge: judgeOptions() ?? undefined });
      const judged = judgeFixture(id, res);
      ok &&= judged.ok;
      console.log(judged.lines.join("\n"));
      console.log(`  run: ${res.bad?.runDir ?? res.good?.runDir}`);
    } catch (error) {
      ok = false;
      console.log(`${id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  process.exit(ok ? 0 : 1);
}

const appId = flag("--app") ?? fail("--app <id> is required (a design-score/apps/<id>.json)");
// --pages a,b: validated against the config before anything starts.
const configPath = resolve(flag("--config") ?? join(DESIGN_SYSTEM_ROOT, "design-score/apps", `${appId}.json`));
if (!existsSync(configPath)) fail(`no config at ${configPath}`);
const config = JSON.parse(readFileSync(configPath, "utf8")) as AppConfig;
if (config.app !== appId) fail(`${configPath} is for app "${config.app}", not "${appId}"`);
if (!config.pages?.length) fail(`${configPath} lists no pages`);
if (!config.themes || !Object.keys(config.themes).length) fail(`${configPath} lists no themes`);
if (has("--list-pages")) {
  for (const p of config.pages) console.log(`${p.id.padEnd(28)} ${p.path}${p.optional ? "  (optional)" : ""}`);
  process.exit(0);
}
try {
  selectPages(config.pages, list(flag("--pages")));
} catch (error) {
  fail(`--pages: ${error instanceof Error ? error.message : error}`);
}

const root = resolve(flag("--root") ?? workspaceRoot());
const viewports = list(flag("--viewports"))?.map((v) => {
  const m = /^(\d+)x(\d+)$/.exec(v);
  if (!m) fail(`--viewports: "${v}" is not <width>x<height>`);
  return { width: Number(m![1]), height: Number(m![2]) };
}) ?? null;
const jobsArg = flag("--jobs") ?? "2";
if (!/^[1-9]\d*$/.test(jobsArg)) fail(`--jobs: "${jobsArg}" is not a positive integer`);
const jobs = Number(jobsArg);

let running: RunningApp | null = null;
let baseUrl = flag("--base-url") ?? config.baseUrl;
const cleanup = async () => {
  if (running) await running.stop().catch(() => undefined);
};
installSignalHandlers(cleanup);

try {
  // Pinned before any app starts (app-runner refuses a later first load).
  pinPlaywright(root);
  if (!baseUrl) {
    if (!config.registryApp) fail("give --base-url, or set baseUrl or registryApp in the config");
    const registry = validateLoadedRegistry(loadRegistry(REGISTRY_PATH), REGISTRY_PATH);
    // app-runner's records and logs stay outside any checkout (TOOLING_CONTRACT "Places").
    const outDir = join(process.env.DS_RUN || join(tmpdir(), "ds-rollout"), "design-score", appId);
    await cleanupRuns(outDir).catch(() => undefined);
    console.error(`[design:score] starting ${config.registryApp} with app-runner`);
    running = await startApp(getApp(registry, config.registryApp!), { root, outDir, registry });
    baseUrl = running.baseUrl ?? fail(`${config.registryApp} has no browser URL`);
  }
  const probe = await fetch(baseUrl!).catch((error) => error as Error);
  if (probe instanceof Error || !probe.ok) fail(`${baseUrl} is not answering (${probe instanceof Error ? probe.message : probe.status}); start the app first`, 2);

  const { dir, scorecard } = await runScore({
    root,
    designSystem: DESIGN_SYSTEM_ROOT,
    configPath,
    config,
    baseUrl: baseUrl!,
    label: flag("--label") ?? null,
    outRoot: resolve(flag("--out") ?? OUT_ROOT),
    pages: list(flag("--pages")),
    themes: list(flag("--themes")),
    viewports,
    jobs,
    motion: !has("--no-motion"),
    focus: !has("--no-focus"),
    static: !has("--no-static"),
    quiet: has("--json"),
    quick: has("--quick"),
    judge: judgeOptions(),
  });
  if (has("--json")) {
    console.log(JSON.stringify({ dir, score: scorecard.score, areas: scorecard.areas, pages: scorecard.pages.map((p) => ({ id: p.id, score: p.score, errors: p.errors.length, ...(p.skipped ? { skipped: p.skipped } : {}), areas: p.areas })), checkTotals: scorecard.checkTotals }, null, 2));
  } else {
    console.log(`\n${scorecard.app}: ${scorecard.score}${has("--quick") ? " (quick: one theme, one viewport)" : ""}`);
    console.log("  " + AREAS.map((a) => `${a} ${scorecard.areas?.[a] ?? "-"}`).join(" · "));
    for (const p of scorecard.pages) console.log(`  ${p.id.padEnd(26)} ${String(p.score ?? "-").padStart(5)}${p.skipped ? `  skipped: ${p.skipped}` : ""}${p.errors.length ? `  (${p.errors.length} errors)` : ""}`);
    console.log("\n  check                 pass  warn  fail   n/a");
    for (const c of CHECKS) {
      const t = scorecard.checkTotals[c.id]!;
      console.log(`  ${c.id.padEnd(20)} ${String(t.pass).padStart(5)} ${String(t.warn).padStart(5)} ${String(t.fail).padStart(5)} ${String(t["n/a"]).padStart(5)}`);
    }
    console.log(`\n${join(dir, "report.html")}`);
  }
  await cleanup();
  process.exit(scorecard.pages.some((p) => p.errors.length) ? 1 : 0);
} catch (error) {
  await cleanup();
  fail(error instanceof Error ? error.stack ?? error.message : String(error), 2);
}
