/**
 * The `## app_ledger` table in the run's STATE.md, parsed by column header.
 */

export type LedgerRow = Record<string, string>;

const PASS_COLUMNS = ["p1", "p2", "p3"] as const;

/** Rows of the first Markdown table under the `## app_ledger` heading, keyed by header. Empty when absent. */
export function readLedger(stateMd: string): LedgerRow[] {
  const lines = stateMd.split("\n");
  const start = lines.findIndex((line) => /^##\s+app_ledger\s*$/.test(line.trim()));
  if (start === -1) return [];
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  let header: string[] | null = null;
  const rows: LedgerRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) {
      if (header) break;
      continue;
    }
    const row = cells(line);
    if (!header) {
      header = row.map((h) => h.toLowerCase());
      continue;
    }
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").replace(/`/g, "")])));
  }
  return rows;
}

/** Every pass is done or n/a, and at least one is done. */
export function passesDone(row: LedgerRow): boolean {
  const states = PASS_COLUMNS.map((column) => (row[column] ?? "").toLowerCase());
  return states.every((s) => s === "done" || s === "n/a") && states.includes("done");
}
