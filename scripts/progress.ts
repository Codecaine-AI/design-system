#!/usr/bin/env bun
/**
 * progress: one page with every app's pass status and literal count.
 *
 *   bun run progress [--root <dir>] [--out-dir <dir>] [--lint-json <file>] [--baseline-lint <file>] [--state <file>] [--registry <file>]
 *
 * Inputs:
 *   registry   apps.json of this design-system checkout (--registry overrides; the linter reads the same file)
 *   ledger     the `## app_ledger` table of $DS_RUN/STATE.md, else <root>/rollout/STATE.md (--state overrides)
 *   lint       `bun run lint:apps --json --root <root> --registry <file>` in this checkout (the report it
 *              writes to its --out-dir), or the report in --lint-json. A report for another root counts as
 *              unavailable; one from another design-system commit gets a note. When the linter is missing
 *              or writes no report, every app shows "lint: unavailable".
 *   baseline   --baseline-lint: a lint:apps --json report from before the apps moved. "Literals removed"
 *              is measured only against it (the ledger's baseline is the audit's count, another measure).
 *
 * Writes <out-dir>/progress.html (self-contained, tokens.css inlined, light and dark) and
 * <out-dir>/progress.md. --out-dir defaults to $DS_RUN, else <os tmpdir>/ds-rollout; it is never the
 * owner's tree or a dir inside a git checkout, and neither file may be a symlink.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLedger } from "./lib/progress/ledger.ts";
import { checkLintReport, fileSha256, type LintSource, readLintFile, runLinter } from "./lib/progress/lint.ts";
import { buildProgress, type ProgressModel } from "./lib/progress/model.ts";
import { renderHtml } from "./lib/progress/render-html.ts";
import { renderMarkdown } from "./lib/progress/render-md.ts";
import { DESIGN_SYSTEM_ROOT, loadRegistry, REGISTRY_PATH } from "./lib/registry.ts";
import { toolOutputDir } from "./lib/output-dir.ts";
import { safeChildPath } from "./lib/safe-paths.ts";

const USAGE =
  "usage: bun run progress [--root <dir>] [--out-dir <dir>] [--lint-json <file>] [--baseline-lint <file>] [--state <file>] [--registry <file>]";

export interface ProgressOptions {
  root: string;
  outDir: string;
  lintJson: string | null;
  baselineLint: string | null;
  state: string;
  registry: string;
}

const FLAGS = {
  "--root": "root",
  "--out-dir": "outDir",
  "--lint-json": "lintJson",
  "--baseline-lint": "baselineLint",
  "--state": "state",
  "--registry": "registry",
} as const;

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): ProgressOptions {
  const given: Partial<Record<(typeof FLAGS)[keyof typeof FLAGS], string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as keyof typeof FLAGS;
    const key = FLAGS[flag];
    if (!key) throw new Error(`unknown argument "${argv[i]}"\n${USAGE}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
    given[key] = resolve(value);
  }
  const root = given.root ?? resolve(DESIGN_SYSTEM_ROOT, "..");
  return {
    root,
    outDir: given.outDir ?? (env.DS_RUN ? resolve(env.DS_RUN) : join(tmpdir(), "ds-rollout")),
    lintJson: given.lintJson ?? null,
    baselineLint: given.baselineLint ?? null,
    state: given.state ?? (env.DS_RUN ? join(resolve(env.DS_RUN), "STATE.md") : join(root, "rollout", "STATE.md")),
    registry: given.registry ?? REGISTRY_PATH,
  };
}

/** Reads every input, writes progress.html and progress.md, and returns the model and the written paths. */
export function runProgress(opts: ProgressOptions): { model: ProgressModel; html: string; md: string } {
  if (!existsSync(opts.state)) throw new Error(`no ledger: ${opts.state} does not exist (pass --state <file>)`);
  const outDir = toolOutputDir(opts.outDir, { root: opts.root, label: "--out-dir" });
  const head = spawnSync("git", ["-C", DESIGN_SYSTEM_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const build = { root: opts.root, commit: head.status === 0 ? head.stdout.trim() : null, tokensCssSha256: fileSha256(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css")) };
  const lintRead = checkLintReport(opts.lintJson ? readLintFile(opts.lintJson) : runLinter(DESIGN_SYSTEM_ROOT, opts.root, { registry: opts.registry }), build);
  // The baseline was taken before the apps moved, so only its root must match.
  const baselineRead = opts.baselineLint ? checkLintReport(readLintFile(opts.baselineLint), { ...build, commit: null, tokensCssSha256: null, label: "the lint baseline" }) : null;
  const model = buildProgress({
    registry: loadRegistry(opts.registry),
    registryPath: opts.registry,
    ledger: parseLedger(readFileSync(opts.state, "utf8")),
    ledgerPath: opts.state,
    lint: lintRead.source,
    lintBaseline: baselineRead?.source ?? null,
    root: opts.root,
  });
  model.notes.push(...lintRead.notes, ...(baselineRead?.notes ?? []));
  const tokensCss = readFileSync(join(DESIGN_SYSTEM_ROOT, "dist", "css", "tokens.css"), "utf8");
  mkdirSync(outDir, { recursive: true });
  const base = { base: outDir, root: opts.root, label: "--out-dir" };
  const html = safeChildPath(base, "progress.html");
  const md = safeChildPath(base, "progress.md");
  writeFileSync(html, renderHtml(model, tokensCss));
  writeFileSync(md, renderMarkdown(model));
  return { model, html, md };
}

if (import.meta.main) {
  try {
    const { model, html, md } = runProgress(parseArgs(process.argv.slice(2)));
    const t = model.totals;
    for (const note of model.notes) console.error(`note: ${note}`);
    const literals =
      t.literals.removed === null
        ? `no lint baseline: audit ${t.literals.baseline} literals, ${t.literals.now} now`
        : `${t.literals.removed} literals removed (${t.literals.measured} measured against the lint baseline)`;
    console.log(`${t.apps} apps: ${t.done} done, ${t.inFlight} in flight, ${t.blocked} blocked, ${t.todo} todo; ${literals}`);
    console.log(`wrote ${html}`);
    console.log(`wrote ${md}`);
  } catch (error) {
    console.error(`progress: ${(error as Error).message}`);
    process.exit(2);
  }
}
