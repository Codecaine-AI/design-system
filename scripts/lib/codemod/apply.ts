/**
 * Applies the approved rows of a mapping table. A row changes the source only when its `approve`
 * is "yes", it has a replacement, its file sits inside the root, the whole file is byte-for-byte
 * the file propose read (by hash), and the literal stands at the recorded line and column as a
 * whole token. Everything else is reported, never guessed: any change to a file since propose makes
 * every row of that file stale (an identical line elsewhere is never taken for the row's line).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { targetIn } from "./paths.ts";
import { fileSha, lineSha, type Row, type Table } from "./table.ts";

export interface ApplyResult {
  applied: Row[];
  /** Approved rows that were not applied, with the reason. */
  skipped: Array<{ row: Row; reason: string }>;
  /** Rows without approve "yes". */
  unapproved: number;
  /** Files that changed (or would change with dryRun). */
  files: string[];
  /** Files whose text changed since propose (or that the table has no hash for): all their approved rows were skipped. */
  staleFiles: Array<{ file: string; rows: number; reason: string }>;
}

export const isApproved = (r: Row) => String(r.approve ?? "").trim().toLowerCase() === "yes";

/**
 * `rootReal` must already be vetted (see `applyRoot` in paths.ts): every row's file is resolved
 * inside it, symlinks included, and a row pointing elsewhere is skipped.
 */
export function applyTable(table: Table, rootReal: string, opts: { dryRun?: boolean } = {}): ApplyResult {
  const result: ApplyResult = { applied: [], skipped: [], unapproved: 0, files: [], staleFiles: [] };
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
    const target = targetIn(rootReal, file);
    if ("refused" in target) {
      for (const row of rows) result.skipped.push({ row, reason: `refused: ${target.refused}` });
      continue;
    }
    const text = readFileSync(target.path, "utf8");
    const want = table.files?.[file];
    const stale = !want
      ? "the table has no hash for this file (a table from an older codemod): run propose again"
      : fileSha(text) !== want
        ? "the file changed since propose (whole-file hash): run propose again"
        : null;
    if (stale) {
      for (const row of rows) result.skipped.push({ row, reason: `stale: ${stale}` });
      result.staleFiles.push({ file, rows: rows.length, reason: stale });
      continue;
    }
    const lines = text.split("\n");
    const edits = new Map<number, Array<{ row: Row; pos: number }>>();
    for (const row of rows) {
      const pos = findLiteral(lines, row);
      if (typeof pos === "string") {
        result.skipped.push({ row, reason: pos });
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
      if (!opts.dryRun) writeFileSync(target.path, lines.join("\n"));
    }
  }
  result.applied.sort((a, b) => a.id - b.id);
  result.skipped.sort((a, b) => a.row.id - b.row.id);
  return result;
}

const COLOR_CATEGORIES = new Set(["hex", "rgb", "hsl", "oklch", "otherColorFn", "namedColor"]);
const CLASS_CATEGORIES = new Set(["twArbitrary", "twArbitraryVar", "twPalette"]);

/**
 * The literal's offset on its line, or why the row is stale. The line must hash to what propose
 * read, the literal must stand at the recorded column, and the characters around it must end the
 * token: `#fff` is not the start of `#fff000`, `13` is not the start of `135`.
 */
function findLiteral(lines: string[], row: Row): number | string {
  if (!row.lineSha) return "stale: the row has no line hash (a table from an older codemod): run propose again";
  if (!row.column) return "stale: the row has no column";
  const text = lines[row.line - 1];
  if (text === undefined) return `stale: line ${row.line} no longer exists`;
  if (lineSha(text) !== row.lineSha) return `stale: line ${row.line} changed since propose`;
  const pos = row.column - 1;
  if (text.slice(pos, pos + row.literal.length) !== row.literal) return `stale: line ${row.line} has no ${JSON.stringify(row.literal)} at column ${row.column}`;
  const before = text[pos - 1] ?? "";
  const after = text[pos + row.literal.length] ?? "";
  if (!boundaryOk(row, before, after)) return `stale: ${JSON.stringify(row.literal)} at column ${row.column} is part of a longer token`;
  return pos;
}

function boundaryOk(row: Row, before: string, after: string): boolean {
  const lit = row.literal;
  // A quoted string or a {…} attribute carries its own delimiters.
  if (/^["'`{]/.test(lit)) return true;
  if (CLASS_CATEGORIES.has(row.category)) return !/[\w\-/[\].$#@]/.test(before) && !/[\w\-/[]/.test(after);
  if (COLOR_CATEGORIES.has(row.category)) return !/[\w$#-]/.test(before) && !/[\w-]/.test(after);
  // Sizes, radii, spacing, families: no digit, dot or name character runs on.
  return !/[\w.$#-]/.test(before) && !/[\w.%-]/.test(after);
}
