/**
 * Merges the three inputs of the progress page into one model the renderers draw:
 *
 * - the registry (apps.json): which passes and checks apply, wave, repo, literal floor
 * - the ledger (STATE.md app_ledger): each pass's status, literal baseline, rounds, blocked reason
 * - the lint report (lint:apps --json): each check's status and the measured literal count
 * - optionally a lint baseline (a lint:apps --json report from before the apps moved)
 *
 * The registry is authoritative for what applies; the ledger is authoritative for where the run is.
 * Disagreements become notes on the row instead of being resolved silently.
 *
 * "Literals removed" subtracts counts of one linter only: the lint baseline minus lint:apps now. The
 * ledger's baseline is the audit's count (another scanner, other rules), so without a lint baseline
 * the page shows both numbers and claims no removal.
 */

import type { CheckId, PassId, Registry } from "../registry.ts";
import { type AppState, appState, type Ledger, type LedgerRow, PASS_IDS, type PassCell, passCells } from "./ledger.ts";
import type { LintCheck, LintSource } from "./lint.ts";

export { type AppState, appState, PASS_IDS, type PassCell };
export const CHECK_IDS: CheckId[] = ["resolution", "wiring", "literals", "names", "shell", "structure"];

export type RowLint =
  | { kind: "unavailable" }
  | { kind: "missing" }
  | { kind: "result"; ok: boolean; checks: LintCheck[] };

export interface ProgressRow {
  id: string;
  name: string | null;
  wave: number | null;
  repo: string | null;
  branch: string | null;
  dependsOn: string;
  passes: Record<PassId, PassCell>;
  state: AppState;
  literals: {
    /** The ledger's baseline: the audit's count. */
    baseline: number | null;
    /** lint:apps' count before the app moved (--baseline-lint), or null. */
    lintBaseline: number | null;
    now: number | null;
    nowFrom: "lint" | "ledger" | null;
    floor: number | null;
    /** lintBaseline - now when both are lint:apps counts; null otherwise (never audit minus lint). */
    removed: number | null;
  };
  rounds: number | null;
  lint: RowLint;
  blocked: { reason: string; ownerAction: string } | null;
  notes: string[];
}

export interface ProgressTotals {
  apps: number;
  done: number;
  inFlight: number;
  blocked: number;
  todo: number;
  literals: {
    /** Sum of every known audit baseline (the ledger's). */
    baseline: number;
    /** Sum of every known current count. */
    now: number;
    /** Apps whose removal is measured: a lint baseline and a lint count now. */
    measured: number;
    /** Sum of removed over the measured apps; null when no app is measured. */
    removed: number | null;
  };
}

export interface ProgressModel {
  generatedAt: string;
  root: string;
  sources: {
    registry: { path: string; apps: number };
    ledger: { path: string; rows: number };
    lint: LintSource;
    lintBaseline: LintSource | null;
  };
  totals: ProgressTotals;
  rows: ProgressRow[];
  /** Input problems and page-wide notes. */
  notes: string[];
}

export interface ProgressInput {
  registry: Registry;
  registryPath: string;
  ledger: Ledger;
  ledgerPath: string;
  lint: LintSource;
  /** A lint:apps --json report from before the apps moved: the only baseline "removed" is measured against. */
  lintBaseline?: LintSource | null;
  root: string;
  now?: Date;
}

const EMPTY_LEDGER_ROW = (id: string): LedgerRow => ({
  id,
  wave: null,
  dependsOn: "",
  repo: "",
  branch: "",
  base: "",
  start: "",
  workers: "",
  passes: { "1": null, "2": null, "3": null },
  literals: { baseline: null, now: null },
  rounds: null,
  blocked: null,
  extra: {},
});

export function buildProgress(input: ProgressInput): ProgressModel {
  const { registry, ledger, lint } = input;
  const lintBaseline = input.lintBaseline ?? null;
  const notes = [...ledger.problems];
  const registryById = new Map(registry.apps.map((a) => [a.id, a]));
  const ledgerById = new Map(ledger.rows.map((r) => [r.id, r]));
  const lintById = new Map(lint.available ? lint.report.apps.map((a) => [a.id, a]) : []);
  const baselineById = new Map(lintBaseline?.available ? lintBaseline.report.apps.map((a) => [a.id, a]) : []);
  const registryEmpty = registry.apps.length === 0;
  if (registryEmpty) notes.push("apps.json has no apps yet: wave and repo come from the ledger, floors and n/a reasons are unknown.");
  if (!lint.available) notes.push(`lint unavailable: ${lint.reason}`);
  if (lintBaseline && !lintBaseline.available) notes.push(`lint baseline unavailable: ${lintBaseline.reason}`);
  const partial = lint.available && lint.report.pass !== null ? lint.report.pass : null;

  // Ledger order first (it follows the waves and repo stacks), then apps only the registry or the linter knows.
  const ids = [...ledger.rows.map((r) => r.id)];
  for (const id of [...registryById.keys(), ...lintById.keys()]) if (!ids.includes(id)) ids.push(id);

  const rows = ids.map((id): ProgressRow => {
    const app = registryById.get(id);
    const row = ledgerById.get(id) ?? EMPTY_LEDGER_ROW(id);
    const lintApp = lintById.get(id);
    const rowNotes: string[] = [];
    if (!ledgerById.has(id)) rowNotes.push(app ? "not in the STATE.md ledger" : "only in the lint output");
    if (!app && !registryEmpty && ledgerById.has(id)) rowNotes.push("not in apps.json");

    const passes = passCells(row, app, rowNotes);

    let rowLint: RowLint;
    if (!lint.available) rowLint = { kind: "unavailable" };
    else if (!lintApp) rowLint = { kind: "missing" };
    else {
      const order = (c: LintCheck) => {
        const i = CHECK_IDS.indexOf(c.id as CheckId);
        return i === -1 ? CHECK_IDS.length : i;
      };
      const checks = [...lintApp.checks]
        .sort((a, b) => order(a) - order(b))
        .map((c) => {
          const requirement = app?.checks?.[c.id as CheckId];
          const reason = c.reason ?? (requirement && !requirement.required ? requirement.reason : undefined);
          return reason && c.status === "n/a" ? { ...c, reason } : c;
        });
      rowLint = { kind: "result", ok: lintApp.ok, checks };
      // A report of fewer checks than apps.json requires (--pass 1, say) cannot show the app is clean.
      const missing = CHECK_IDS.filter((id) => app?.checks?.[id]?.required && !lintApp.checks.some((c) => c.id === id));
      if (missing.length) rowNotes.push(`the lint report has no ${missing.join(", ")} result${partial ? ` (it ran --pass ${partial})` : ""}, which apps.json requires`);
    }

    const state = appState(PASS_IDS.map((p) => passes[p]));
    if (state === "done" && rowLint.kind === "result" && !rowLint.ok) {
      const failing = rowLint.checks.filter((c) => c.status === "fail").map((c) => c.id);
      rowNotes.push(`done in the ledger, but lint:apps fails${failing.length ? `: ${failing.join(", ")}` : ""}`);
    }

    const now = lintApp?.literals ? lintApp.literals.hard : row.literals.now;
    const nowFrom = lintApp?.literals ? "lint" : row.literals.now !== null ? "ledger" : null;
    const lintBaselineCount = baselineById.get(id)?.literals?.hard ?? null;
    return {
      id,
      name: app?.name ?? null,
      wave: app?.wave ?? row.wave,
      repo: app?.repo ?? (row.repo || null),
      branch: row.branch || null,
      dependsOn: row.dependsOn,
      passes,
      state,
      literals: {
        baseline: row.literals.baseline,
        lintBaseline: lintBaselineCount,
        now,
        nowFrom,
        floor: app?.literalFloor ?? lintApp?.literals?.floor ?? null,
        removed: lintBaselineCount !== null && nowFrom === "lint" && now !== null ? lintBaselineCount - now : null,
      },
      rounds: row.rounds,
      lint: rowLint,
      blocked: row.blocked,
      notes: rowNotes,
    };
  });

  const count = (state: AppState) => rows.filter((r) => r.state === state).length;
  const measured = rows.filter((r) => r.literals.removed !== null);
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    root: input.root,
    sources: {
      registry: { path: input.registryPath, apps: registry.apps.length },
      ledger: { path: input.ledgerPath, rows: ledger.rows.length },
      lint,
      lintBaseline,
    },
    totals: {
      apps: rows.length,
      done: count("done"),
      inFlight: count("in flight"),
      blocked: count("blocked"),
      todo: count("todo"),
      literals: {
        baseline: rows.reduce((sum, r) => sum + (r.literals.baseline ?? 0), 0),
        now: rows.reduce((sum, r) => sum + (r.literals.now ?? 0), 0),
        measured: measured.length,
        removed: measured.length ? measured.reduce((sum, r) => sum + r.literals.removed!, 0) : null,
      },
    },
    rows,
    notes,
  };
}

/** One-line lint summary of a row: "unavailable", "no result", "pass", or the failing checks with counts. */
export function lintSummary(lint: RowLint): string {
  if (lint.kind === "unavailable") return "unavailable";
  if (lint.kind === "missing") return "no result";
  const failing = lint.checks.filter((c) => c.status === "fail");
  const warnings = lint.checks.reduce((n, c) => n + (c.warnings.length || (c.status === "warn" ? 1 : 0)), 0);
  const warnText = warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  if (failing.length === 0) return lint.ok ? ["pass", warnText].filter(Boolean).join(", ") : ["fail", warnText].filter(Boolean).join(", ");
  return `fail: ${failing.map((c) => `${c.id} (${c.violations.length})`).join(", ")}`;
}

/** A count for display: thousands separated, "–" when unknown. */
export function formatCount(n: number | null): string {
  return n === null ? "–" : n.toLocaleString("en-US");
}
