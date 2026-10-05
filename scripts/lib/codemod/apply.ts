/**
 * Applies the approved rows of a mapping table. A row changes the source only when its `approve`
 * is "yes", it has a replacement, and its line still holds the literal (at the recorded column, or
 * exactly once on the line). Everything else is reported, never guessed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Row, Table } from "./table.ts";

export interface ApplyResult {
  applied: Row[];
  /** Approved rows that were not applied, with the reason. */
  skipped: Array<{ row: Row; reason: string }>;
  /** Rows without approve "yes". */
  unapproved: number;
  /** Files that changed (or would change with dryRun). */
  files: string[];
}

export const isApproved = (r: Row) => String(r.approve ?? "").trim().toLowerCase() === "yes";

export function applyTable(table: Table, root: string, opts: { dryRun?: boolean } = {}): ApplyResult {
  const result: ApplyResult = { applied: [], skipped: [], unapproved: 0, files: [] };
  const byFile = new Map<string, Row[]>();
  for (const row of table.rows) {
    if (!isApproved(row)) {
      result.unapproved++;
      continue;
    }
    if (row.replacement === null || row.replacement === undefined || !row.literal) {
      result.skipped.push({ row, reason: "no replacement: edit by hand, or fill in `replacement`" });
      continue;
    }
    const list = byFile.get(row.file) ?? [];
    list.push(row);
    byFile.set(row.file, list);
  }

  for (const [file, rows] of byFile) {
    const abs = resolve(root, file);
    if (!existsSync(abs)) {
      for (const row of rows) result.skipped.push({ row, reason: `file not found under ${root}` });
      continue;
    }
    const lines = readFileSync(abs, "utf8").split("\n");
    const edits = new Map<number, Array<{ row: Row; pos: number }>>();
    for (const row of rows) {
      const text = lines[row.line - 1];
      if (text === undefined) {
        result.skipped.push({ row, reason: `stale: line ${row.line} no longer exists` });
        continue;
      }
      const pos = findLiteral(text, row);
      if (typeof pos === "string") {
        result.skipped.push({ row, reason: `stale: ${pos}` });
        continue;
      }
      const list = edits.get(row.line) ?? [];
      list.push({ row, pos });
      edits.set(row.line, list);
    }
    let changed = false;
    for (const [line, list] of edits) {
      list.sort((a, b) => a.pos - b.pos);
      const kept: typeof list = [];
      for (const e of list) {
        const prev = kept[kept.length - 1];
        if (prev && e.pos < prev.pos + prev.row.literal.length) {
          result.skipped.push({ row: e.row, reason: `overlaps row ${prev.row.id} on the same characters` });
        } else kept.push(e);
      }
      let text = lines[line - 1];
      for (const e of [...kept].reverse()) {
        text = text.slice(0, e.pos) + e.row.replacement + text.slice(e.pos + e.row.literal.length);
        result.applied.push(e.row);
      }
      if (text !== lines[line - 1]) {
        lines[line - 1] = text;
        changed = true;
      }
    }
    if (changed) {
      result.files.push(file);
      if (!opts.dryRun) writeFileSync(abs, lines.join("\n"));
    }
  }
  result.applied.sort((a, b) => a.id - b.id);
  result.skipped.sort((a, b) => a.row.id - b.row.id);
  return result;
}

/** The literal's offset on the line, or why it cannot be trusted. */
function findLiteral(text: string, row: Row): number | string {
  if (row.column && text.slice(row.column - 1, row.column - 1 + row.literal.length) === row.literal) return row.column - 1;
  const first = text.indexOf(row.literal);
  if (first === -1) return `line ${row.line} no longer holds ${JSON.stringify(row.literal)}`;
  if (text.indexOf(row.literal, first + 1) !== -1) return `line ${row.line} moved and holds ${JSON.stringify(row.literal)} more than once`;
  return first;
}
