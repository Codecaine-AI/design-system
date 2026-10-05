/**
 * The mapping table: one row per literal, written as JSON (what `apply` reads) and Markdown (what a
 * reviewer reads). A reviewer sets `approve` to "yes" in the JSON, and may edit `replacement`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "./tokens.ts";

export interface Row {
  id: number;
  /** Root-relative path of the source file. */
  file: string;
  line: number;
  /** 1-based column of the literal; null when the literal was not found as written. */
  column: number | null;
  /** scan-literals category (hex, rgb, twArbitrary, pxFontSize ...). */
  category: string;
  /** Color literals: definition (--x: #fff), fallback (var(--x, #fff)) or inline. */
  kind: "definition" | "fallback" | "inline" | null;
  /** The exact source text `apply` replaces. */
  literal: string;
  context: { property: string | null; selector: string | null; component: string | null; theme: Theme };
  /** Token path(s), or null when nothing maps. */
  proposed: string | null;
  /** Text that replaces `literal`, or null when the row needs a hand edit. */
  replacement: string | null;
  method: "role" | "nearest" | null;
  /** Color rows: ΔE (OKLab × 100) between the literal and the proposed token, both over the page surface. */
  deltaE: number | null;
  why: string;
  /** Set to "yes" to apply the row. */
  approve: string;
}

export interface Table {
  tool: "codemod-literals";
  version: 1;
  app: string;
  root: string;
  createdAt: string;
  designSystem: { root: string; commit: string | null };
  scan: { paths: string[]; exclude: string[]; ext?: string; categories: string[] };
  /** role + nearest + unmapped = rows; handEdit counts mapped rows without a replacement (canvas, data objects, triplets). */
  summary: { rows: number; role: number; nearest: number; unmapped: number; handEdit: number };
  rows: Row[];
}

export function summarize(rows: Row[]): Table["summary"] {
  return {
    rows: rows.length,
    role: rows.filter((r) => r.method === "role").length,
    nearest: rows.filter((r) => r.method === "nearest").length,
    unmapped: rows.filter((r) => r.method === null).length,
    handEdit: rows.filter((r) => r.method !== null && r.replacement === null).length,
  };
}

/** `<dir>/mapping-<n>` with n one past the highest existing table. */
export function nextTableBase(dir: string): string {
  let n = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = f.match(/^mapping-(\d+)\.(?:json|md)$/);
      if (m) n = Math.max(n, Number(m[1]));
    }
  }
  return join(dir, `mapping-${n + 1}`);
}

const cell = (s: string | number | null) => (s === null || s === "" ? "" : String(s).replace(/\|/g, "\\|").replace(/\n/g, " "));
const code = (s: string | null) => (s ? `\`${s.replace(/`/g, "ˋ")}\`` : "");

export function toMarkdown(t: Table, jsonPath: string): string {
  const s = t.summary;
  const out: string[] = [];
  out.push(`# Literal mapping: ${t.app}`);
  out.push("");
  out.push(`- Root: \`${t.root}\`. Scan: ${t.scan.paths.map((p) => `\`${p}\``).join(", ")}${t.scan.exclude.length ? `, excluding ${t.scan.exclude.map((p) => `\`${p}\``).join(", ")}` : ""}.`);
  out.push(`- ${s.rows} rows: ${s.role} by role, ${s.nearest} by nearest color, ${s.unmapped} unmapped, ${s.handEdit} mapped but need a hand edit.`);
  out.push(`- To apply: set \`"approve": "yes"\` on rows in \`${jsonPath}\` (edit \`replacement\` to change a proposal), then run \`bun run codemod:literals --app ${t.app} --root ${t.root} apply --table ${jsonPath}\`.`);
  out.push("- ΔE is OKLab × 100 between the literal and the token, both drawn over the page surface; about 2 is the smallest visible step.");
  out.push("");
  out.push("| # | file:line | literal | context | proposed | replacement | how | ΔE | why | approve |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of t.rows) {
    const ctx = [r.context.property, r.context.selector, r.context.component ? `<${r.context.component}>` : null, r.context.theme === "dark" ? "dark" : null]
      .filter(Boolean)
      .join(" · ");
    out.push(
      `| ${r.id} | ${cell(`${r.file}:${r.line}`)} | ${cell(code(r.literal))} | ${cell(ctx)} | ${cell(r.proposed ?? "none")} | ${cell(code(r.replacement))} | ${cell(r.method)} | ${cell(r.deltaE)} | ${cell(r.why)} | ${cell(r.approve)} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

export function writeTable(dir: string, t: Table): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const base = nextTableBase(dir);
  const json = `${base}.json`;
  const md = `${base}.md`;
  writeFileSync(json, JSON.stringify(t, null, 2) + "\n");
  writeFileSync(md, toMarkdown(t, json));
  return { json, md };
}

export function readTable(path: string): Table {
  const t = JSON.parse(readFileSync(path, "utf8")) as Table;
  if (t.tool !== "codemod-literals" || !Array.isArray(t.rows)) throw new Error(`${path}: not a codemod-literals table`);
  return t;
}
