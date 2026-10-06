/**
 * Shared types of the conformance linter (`bun run lint:apps`).
 *
 * One module per check lives next to this file. Each check is a function from an
 * `AppContext` to a `CheckOutput`; `run.ts` decides which checks run for an app,
 * turns outputs into `CheckResult`s and builds the report the CLI prints.
 */

import type { AppEntry, CheckId } from "../registry";
import type { DesignSystemBuild } from "./design-system";
import type { LoadGraph } from "./loads";
import type { LiteralScan, SourceFile } from "./workspace";

export type PassNumber = 1 | 2 | 3;
export type CheckStatus = "pass" | "fail" | "n/a" | "warn";

/** One violation or warning. `file` is workspace-relative (absolute when outside the root); `line` is 1-based, 0 when the finding is about a file or the app as a whole. */
export interface Finding {
  file: string;
  line: number;
  message: string;
}

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** Why the check is n/a. */
  reason?: string;
  violations: Finding[];
  warnings: Finding[];
}

export interface AppResult {
  id: string;
  ok: boolean;
  checks: CheckResult[];
  /** Hard literals in the scan dirs (allowlisted ones included) and the registry floor. `hard` is null when the scan could not run. */
  literals: { hard: number | null; floor: number };
}

export interface LintReport {
  root: string;
  pass: PassNumber | null;
  designSystem: { commit: string; dirty: boolean; tokensCssSha256: string };
  apps: AppResult[];
}

/** What a check returns. `na` says the app data leaves nothing to check (a non-shell app has no shell); for a check the registry requires, that is a violation. */
export interface CheckOutput {
  violations: Finding[];
  warnings: Finding[];
  na?: string;
}

/** Everything a check needs about one app. Expensive parts are computed once, on first use. */
export interface AppContext {
  app: AppEntry;
  /** Real path of --root. */
  root: string;
  /** Absolute app package root. */
  appRoot: string;
  /** Directory of apps.json: allowlist paths resolve against it. */
  registryDir: string;
  ds: DesignSystemBuild;
  /** Workspace-relative posix path, or the absolute path when outside the root. */
  rel(abs: string): string;
  /** Source files of the scan spec (scan-literals' file selection, tests and generated files skipped). */
  sources(): SourceFile[];
  /** Stylesheet loads reached from the entry stylesheet. */
  loads(): LoadGraph;
  /** scan-literals over the scan spec, with hits. */
  literalScan(): LiteralScan;
}

export type Check = (ctx: AppContext) => CheckOutput;

export const CHECK_ORDER: CheckId[] = ["resolution", "wiring", "literals", "names", "shell", "structure"];

/** The pass that introduces each check: `--pass n` runs every check whose pass is at most n. */
export const PASS_OF: Record<CheckId, PassNumber> = {
  resolution: 1,
  wiring: 1,
  literals: 1,
  names: 1,
  shell: 2,
  structure: 3,
};

export const PACKAGE_NAME = "@codecaine-ai/design-system";
export const MAX_LINES = 400;
