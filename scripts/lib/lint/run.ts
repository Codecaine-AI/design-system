/**
 * Runs the checks for each app and builds the lint report.
 *
 * Which checks run: `--pass n` selects the checks whose pass is at most n (1: resolution,
 * wiring, literals, names; 2: + shell; 3: + structure); without `--pass`, all six.
 * The registry's `checks` decides each one: n/a reports the registry's reason, required
 * runs. A check can also report n/a from app data (resolution for host-css apps, shell
 * for `shell: false`). A check that throws becomes one violation, so one broken app does
 * not stop the others.
 */

import { dirname, relative, resolve } from "node:path";
import type { AppEntry, CheckId, Registry } from "../registry";
import { resolvePath } from "../registry";
import type { DesignSystemBuild } from "./design-system";
import { buildLoadGraph, type LoadGraph } from "./loads";
import { checkLiterals, hardTotal } from "./literals";
import { checkNames } from "./names";
import { checkResolution } from "./resolution";
import { checkShell } from "./shell";
import { checkStructure } from "./structure";
import type { AppContext, AppResult, Check, CheckResult, LintReport, PassNumber } from "./types";
import { CHECK_ORDER, PASS_OF } from "./types";
import { checkWiring } from "./wiring";
import { collectSources, isInside, realpathOrNull, runLiteralScan, scanSetup, toPosix, type LiteralScan, type SourceFile } from "./workspace";

export const CHECKS: Record<CheckId, Check> = {
  resolution: checkResolution,
  wiring: checkWiring,
  literals: checkLiterals,
  names: checkNames,
  shell: checkShell,
  structure: checkStructure,
};

export interface LintOptions {
  /** The workspace tree to check. */
  root: string;
  registry: Registry;
  /** Directory of apps.json (allowlist paths resolve against it). */
  registryDir: string;
  ds: DesignSystemBuild;
  pass: PassNumber | null;
  /** App ids; empty means every app in the registry. */
  apps: string[];
}

function lazy<T>(make: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = make();
      done = true;
    }
    return value;
  };
}

export function makeContext(app: AppEntry, opts: { root: string; registryDir: string; ds: DesignSystemBuild }): AppContext {
  const root = opts.root;
  const rel = (abs: string) => {
    const p = isInside(abs, root) ? abs : realpathOrNull(abs);
    return p && isInside(p, root) ? toPosix(relative(root, p)) || "." : abs;
  };
  const setup = lazy(() => scanSetup(app, root));
  const sources = lazy<SourceFile[]>(() => collectSources(setup(), rel));
  const loads = lazy<LoadGraph>(() => buildLoadGraph(app.entryStylesheet ? resolvePath(root, app.entryStylesheet) : null));
  const literalScan = lazy<LiteralScan>(() => runLiteralScan(setup()));
  return {
    app,
    root,
    appRoot: resolvePath(root, app.root),
    registryDir: opts.registryDir,
    ds: opts.ds,
    rel,
    sources,
    loads,
    literalScan,
  };
}

export function lintApp(app: AppEntry, opts: Omit<LintOptions, "registry" | "apps">): AppResult {
  const ctx = makeContext(app, opts);
  const selected = CHECK_ORDER.filter((c) => opts.pass === null || PASS_OF[c] <= opts.pass);
  const checks: CheckResult[] = selected.map((id) => {
    const req = app.checks?.[id];
    if (req && !req.required) return { id, status: "n/a", reason: req.reason, violations: [], warnings: [] };
    try {
      const out = CHECKS[id](ctx);
      if (out.na) return { id, status: "n/a", reason: out.na, violations: [], warnings: out.warnings };
      const status = out.violations.length ? "fail" : out.warnings.length ? "warn" : "pass";
      return { id, status, violations: out.violations, warnings: out.warnings };
    } catch (err) {
      const e = err as Error;
      return { id, status: "fail", violations: [{ file: app.root, line: 0, message: `check crashed: ${e.stack ?? e.message}` }], warnings: [] };
    }
  });
  let hard: number | null = null;
  try {
    hard = hardTotal(ctx);
  } catch {
    hard = null;
  }
  return { id: app.id, ok: checks.every((c) => c.status !== "fail"), checks, literals: { hard, floor: app.literalFloor } };
}

export function lintApps(opts: LintOptions): LintReport {
  const ids = opts.apps.length ? opts.apps : opts.registry.apps.map((a) => a.id);
  const apps = ids.map((id) => {
    const app = opts.registry.apps.find((a) => a.id === id);
    if (!app) throw new Error(`apps.json: no app "${id}"`);
    return lintApp(app, opts);
  });
  return {
    root: opts.root,
    pass: opts.pass,
    designSystem: { commit: opts.ds.commit, dirty: opts.ds.dirty, tokensCssSha256: opts.ds.tokensCssSha256 },
    apps,
  };
}

/** Text output: one line per violation (`<app> <check> <file>:<line> <message>`), warnings marked, then one summary line per app. */
export function formatText(report: LintReport): string {
  const lines: string[] = [];
  for (const a of report.apps) {
    for (const c of a.checks) {
      for (const v of c.violations) lines.push(`${a.id} ${c.id} ${v.file}:${v.line} ${v.message}`);
      for (const w of c.warnings) lines.push(`${a.id} ${c.id} ${w.file}:${w.line} warning: ${w.message}`);
    }
  }
  for (const a of report.apps) {
    const parts = a.checks.map((c) => {
      if (c.status === "n/a") return `${c.id} n/a (${c.reason})`;
      if (c.status === "fail") return `${c.id} FAIL ${c.violations.length}`;
      if (c.status === "warn") return `${c.id} warn ${c.warnings.length}`;
      return `${c.id} pass`;
    });
    const lit = a.literals.hard === null ? "literals ?" : `hard literals ${a.literals.hard}/${a.literals.floor}`;
    lines.push(`${a.id}: ${a.ok ? "ok" : "FAIL"}${report.pass ? ` (pass ${report.pass})` : ""}; ${parts.join("; ")}; ${lit}`);
  }
  return lines.join("\n");
}

export const exitCode = (report: LintReport) => (report.apps.every((a) => a.ok) ? 0 : 1);

export const registryDirOf = (registryPath: string) => dirname(resolve(registryPath));
