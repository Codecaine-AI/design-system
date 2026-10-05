/**
 * Merges the three inputs of the progress page into one model the renderers draw:
 *
 * - the registry (apps.json): which passes and checks apply, wave, repo, literal floor
 * - the ledger (STATE.md app_ledger): each pass's status, literal baseline, rounds, blocked reason
 * - the lint report (lint:apps --json): each check's status and the measured literal count
 *
 * The registry is authoritative for what applies; the ledger is authoritative for where the run is.
 * Disagreements become notes on the row instead of being resolved silently.
 */

import type { CheckId, PassId, Registry, Requirement } from "../registry.ts";
import { PASS_STATUSES, type Ledger, type LedgerRow } from "./ledger.ts";
import type { LintCheck, LintSource } from "./lint.ts";

export const PASS_IDS: PassId[] = ["1", "2", "3"];
export const CHECK_IDS: CheckId[] = ["resolution", "wiring", "literals", "names", "shell", "structure"];

export type AppState = "done" | "in flight" | "blocked" | "todo";

export interface PassCell {
  /** Status text as the ledger has it ("n/a" when the registry marks the pass n/a); null when unrecorded. */
  status: string | null;
  applicable: boolean;
  /** The registry's reason when the pass is n/a. */
  reason?: string;
}

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
  literals: { baseline: number | null; now: number | null; nowFrom: "lint" | "ledger" | null; floor: number | null };
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
    /** Sum of every known baseline. */
    baseline: number;
    /** Apps with both a baseline and a current count. */
    measured: number;
    /** Sum of (baseline - now) over the measured apps. */
    removed: number;
  };
}

export interface ProgressModel {
  generatedAt: string;
  root: string;
  sources: {
    registry: { path: string; apps: number };
    ledger: { path: string; rows: number };
    lint: LintSource;
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
  root: string;
  now?: Date;
}

const ACTIVE = new Set(["working", "review", "done"]);
const KNOWN = new Set<string>(PASS_STATUSES);

/** An app's place in the run, from its applicable passes: blocked wins, then all done, then any started. */
export function appState(passes: PassCell[]): AppState {
  const statuses = passes.filter((p) => p.applicable).map((p) => p.status ?? "todo");
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
  if (statuses.some((s) => ACTIVE.has(s) || !KNOWN.has(s))) return "in flight";
  return "todo";
}

function passCell(ledgerStatus: string | null, requirement: Requirement | undefined, pass: PassId, notes: string[]): PassCell {
  if (requirement && !requirement.required) {
    if (ledgerStatus && ledgerStatus !== "n/a") notes.push(`p${pass}: ledger says ${ledgerStatus}, apps.json marks it n/a (${requirement.reason})`);
    return { status: "n/a", applicable: false, reason: requirement.reason };
  }
  if (requirement?.required && ledgerStatus === "n/a") {
    notes.push(`p${pass}: ledger says n/a, apps.json requires it`);
    return { status: ledgerStatus, applicable: true };
  }
  return { status: ledgerStatus, applicable: requirement ? true : ledgerStatus !== "n/a" };
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
  const notes = [...ledger.problems];
  const registryById = new Map(registry.apps.map((a) => [a.id, a]));
  const ledgerById = new Map(ledger.rows.map((r) => [r.id, r]));
  const lintById = new Map(lint.available ? lint.report.apps.map((a) => [a.id, a]) : []);
  const registryEmpty = registry.apps.length === 0;
  if (registryEmpty) notes.push("apps.json has no apps yet: wave and repo come from the ledger, floors and n/a reasons are unknown.");
  if (!lint.available) notes.push(`lint unavailable: ${lint.reason}`);

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

    const passes = Object.fromEntries(
      PASS_IDS.map((p) => [p, passCell(row.passes[p], app?.passes?.[p], p, rowNotes)]),
    ) as Record<PassId, PassCell>;

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
    }

    const now = lintApp?.literals ? lintApp.literals.hard : row.literals.now;
    return {
      id,
      name: app?.name ?? null,
      wave: app?.wave ?? row.wave,
      repo: app?.repo ?? (row.repo || null),
      branch: row.branch || null,
      dependsOn: row.dependsOn,
      passes,
      state: appState(PASS_IDS.map((p) => passes[p])),
      literals: {
        baseline: row.literals.baseline,
        now,
        nowFrom: lintApp?.literals ? "lint" : row.literals.now !== null ? "ledger" : null,
        floor: app?.literalFloor ?? lintApp?.literals?.floor ?? null,
      },
      rounds: row.rounds,
      lint: rowLint,
      blocked: row.blocked,
      notes: rowNotes,
    };
  });

  const count = (state: AppState) => rows.filter((r) => r.state === state).length;
  const measured = rows.filter((r) => r.literals.baseline !== null && r.literals.now !== null);
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    root: input.root,
    sources: {
      registry: { path: input.registryPath, apps: registry.apps.length },
      ledger: { path: input.ledgerPath, rows: ledger.rows.length },
      lint,
    },
    totals: {
      apps: rows.length,
      done: count("done"),
      inFlight: count("in flight"),
      blocked: count("blocked"),
      todo: count("todo"),
      literals: {
        baseline: rows.reduce((sum, r) => sum + (r.literals.baseline ?? 0), 0),
        measured: measured.length,
        removed: measured.reduce((sum, r) => sum + (r.literals.baseline! - r.literals.now!), 0),
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
