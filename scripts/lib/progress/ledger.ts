/**
 * The run's app ledger: the `## app_ledger` table in `$DS_RUN/STATE.md`, and the one rule for when
 * an app is done. Every tool that reads the ledger (progress, verify:apps --propagate) uses both.
 *
 * The managing agent edits that table by hand, so this parser finds every column by its header
 * text, never by position: reordering, adding or renaming a column to a recognizable header keeps
 * working. A cell that is empty, `-`, `–` or `—` means "no value".
 */

import type { AppEntry, PassId, Requirement } from "../registry.ts";

/** Pass statuses the ledger uses. Any other text is kept as written and shown as is. */
export const PASS_STATUSES = ["todo", "working", "review", "done", "blocked", "n/a"] as const;
export type PassStatus = (typeof PASS_STATUSES)[number];

export interface LedgerRow {
  id: string;
  wave: number | null;
  dependsOn: string;
  repo: string;
  branch: string;
  base: string;
  start: string;
  workers: string;
  /** Lower-cased status text per pass, or null when the cell is empty. */
  passes: Record<PassId, string | null>;
  /** `<baseline> / <now>`; either side may be missing. */
  literals: { baseline: number | null; now: number | null };
  rounds: number | null;
  /** `<reason> → <owner action>`, or null when the cell is empty. */
  blocked: { reason: string; ownerAction: string } | null;
  /** Cells under headers this parser does not know, keyed by header text. */
  extra: Record<string, string>;
}

export interface Ledger {
  rows: LedgerRow[];
  /** Input problems, one message each (missing section, unreadable cells, duplicate ids). */
  problems: string[];
}

type Field =
  | "id"
  | "wave"
  | "dependsOn"
  | "repo"
  | "branch"
  | "base"
  | "start"
  | "workers"
  | "p1"
  | "p2"
  | "p3"
  | "literals"
  | "rounds"
  | "blocked";

/** Which field a header names. Matching is on the normalized header's start, so "repo (mirror path)" is repo. */
function fieldOf(header: string): Field | null {
  const h = header.toLowerCase().replace(/\s+/g, " ").trim();
  const pass = /^(?:p|pass ?)([123])$/.exec(h);
  if (pass) return `p${pass[1]}` as Field;
  if (h === "id" || h === "app" || h === "app id") return "id";
  if (h === "wave") return "wave";
  if (h.startsWith("depends")) return "dependsOn";
  if (h.startsWith("repo")) return "repo";
  if (h === "branch") return "branch";
  if (h === "base") return "base";
  if (h === "start" || h === "started") return "start";
  if (h.startsWith("worker")) return "workers";
  if (h.startsWith("literal")) return "literals";
  if (h.startsWith("round")) return "rounds";
  if (h.startsWith("blocked")) return "blocked";
  return null;
}

const EMPTY = /^[-–—]?$/;

/** The cell's text, or "" for an empty or dash-only cell. */
function value(cell: string | undefined): string {
  const text = (cell ?? "").trim();
  return EMPTY.test(text) ? "" : text;
}

/** Splits a GFM table row at unescaped pipes; `\|` stays in the cell as `|`. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

/** The `## app_ledger` table's lines: header, then rows (the separator dropped). Null when absent. */
function ledgerTable(markdown: string): { header: string; rows: string[] } | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+app_ledger\s*$/i.test(l.trim()));
  if (start === -1) return null;
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith("|")) {
    if (/^#{1,2}\s/.test(lines[i])) return null;
    i++;
  }
  if (i >= lines.length) return null;
  const header = lines[i];
  const rows: string[] = [];
  for (i++; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    if (!SEPARATOR.test(lines[i].trim())) rows.push(lines[i]);
  }
  return { header, rows };
}

function parseCount(text: string, what: string, id: string, problems: string[]): number | null {
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  problems.push(`${id}: ${what} "${text}" is not a whole number`);
  return null;
}

function parseLiterals(text: string, id: string, problems: string[]): LedgerRow["literals"] {
  if (!text) return { baseline: null, now: null };
  const parts = text.split("/").map((p) => value(p));
  if (parts.length > 2) {
    problems.push(`${id}: literals "${text}" is not "<baseline> / <now>"`);
    return { baseline: null, now: null };
  }
  return {
    baseline: parseCount(parts[0], "literal baseline", id, problems),
    now: parseCount(parts[1] ?? "", "literal count", id, problems),
  };
}

/** Splits at the last arrow: a reason may itself hold one ("version 0.1.0 → 0.0.1"), the owner action does not. */
function parseBlocked(text: string): LedgerRow["blocked"] {
  if (!text) return null;
  const arrows = [...text.matchAll(/\s*(?:→|->)\s*/g)];
  const arrow = arrows.at(-1);
  if (!arrow) return { reason: text, ownerAction: "" };
  return { reason: text.slice(0, arrow.index).trim(), ownerAction: text.slice(arrow.index! + arrow[0].length).trim() };
}

/** Parses the `## app_ledger` table of a STATE.md. Never throws: problems are reported, rows kept where possible. */
export function parseLedger(markdown: string): Ledger {
  const problems: string[] = [];
  const table = ledgerTable(markdown);
  if (!table) return { rows: [], problems: ['STATE.md has no "## app_ledger" table'] };

  const headers = splitRow(table.header);
  const columns = new Map<Field, number>();
  const extraColumns: Array<[string, number]> = [];
  headers.forEach((header, index) => {
    const field = fieldOf(header);
    if (field && !columns.has(field)) columns.set(field, index);
    else extraColumns.push([header, index]);
  });
  if (!columns.has("id")) return { rows: [], problems: ['the app_ledger table has no "id" column'] };

  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const line of table.rows) {
    const cells = splitRow(line);
    const cell = (field: Field) => {
      const index = columns.get(field);
      return index === undefined ? "" : value(cells[index]);
    };
    const id = cell("id");
    if (!id) continue;
    if (seen.has(id)) {
      problems.push(`${id}: duplicate ledger row (the first one is used)`);
      continue;
    }
    seen.add(id);
    const status = (field: Field) => cell(field).toLowerCase() || null;
    rows.push({
      id,
      wave: parseCount(cell("wave"), "wave", id, problems),
      dependsOn: cell("dependsOn"),
      repo: cell("repo"),
      branch: cell("branch"),
      base: cell("base"),
      start: cell("start"),
      workers: cell("workers"),
      passes: { "1": status("p1"), "2": status("p2"), "3": status("p3") },
      literals: parseLiterals(cell("literals"), id, problems),
      rounds: parseCount(cell("rounds"), "rounds", id, problems),
      blocked: parseBlocked(cell("blocked")),
      extra: Object.fromEntries(extraColumns.map(([header, index]) => [header, value(cells[index])])),
    });
  }
  return { rows, problems };
}

// -- the done rule ------------------------------------------------------------------

export const PASS_IDS: PassId[] = ["1", "2", "3"];

export type AppState = "done" | "in flight" | "blocked" | "todo";

export interface PassCell {
  /** Status text as the ledger has it ("n/a" when the registry marks the pass n/a); null when unrecorded. */
  status: string | null;
  applicable: boolean;
  /** The registry's reason when the pass is n/a. */
  reason?: string;
}

const ACTIVE = new Set(["working", "review", "done"]);
const KNOWN = new Set<string>(PASS_STATUSES);

/**
 * One pass of one app: the registry decides whether it applies (a pass it marks n/a never counts,
 * whatever the ledger says; one it requires always counts), the ledger says where it is. Without a
 * registry entry, a ledger "n/a" is taken as written. Disagreements are pushed to `notes`.
 */
export function passCell(ledgerStatus: string | null, requirement: Requirement | undefined, pass: PassId, notes: string[] = []): PassCell {
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

/** Every pass of a ledger row, judged against the app's registry entry (when there is one). */
export function passCells(row: Pick<LedgerRow, "passes">, app: Pick<AppEntry, "passes"> | undefined, notes: string[] = []): Record<PassId, PassCell> {
  return Object.fromEntries(PASS_IDS.map((p) => [p, passCell(row.passes[p], app?.passes?.[p], p, notes)])) as Record<PassId, PassCell>;
}

/** An app's place in the run, from its applicable passes: blocked wins, then all done, then any started. */
export function appState(passes: PassCell[]): AppState {
  const statuses = passes.filter((p) => p.applicable).map((p) => p.status ?? "todo");
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
  if (statuses.some((s) => ACTIVE.has(s) || !KNOWN.has(s))) return "in flight";
  return "todo";
}

/** The passes of a row as one line: "p1 done, p2 working, p3 n/a". */
export function describePasses(cells: Record<PassId, PassCell>): string {
  return PASS_IDS.map((p) => `p${p} ${cells[p].status ?? "–"}`).join(", ");
}
