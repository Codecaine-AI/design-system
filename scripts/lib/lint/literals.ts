/**
 * Check 3, literals: no hard-coded style values outside the allowlist.
 *
 * - scan-literals runs over the registry scan spec (paths, excludes, ext). Every
 *   hard hit the allowlist does not match is a violation (file:line, literal,
 *   category), and the hard total, allowlisted hits included, must be at or under
 *   `literalFloor`.
 * - On Tailwind apps, every Tailwind default-scale class (tailwind-scale.ts) that
 *   the allowlist does not match is a violation.
 * - A scan path that does not exist is a violation: the floor would pass on nothing.
 */

import { HARD, type HardCategory } from "../../scan-literals";
import { allowsLiteral, allowsTwClass, loadAllowlist, unusedEntries, type LiteralKind } from "./allowlist";
import { findDefaultScaleClasses } from "./tailwind-scale";
import type { AppContext, CheckOutput, Finding } from "./types";
import { lineFinder } from "./workspace";

const HARD_SET = new Set<string>(HARD);
const COLOR = new Set(["hex", "rgb", "hsl", "oklch", "otherColorFn"]);

/** Hard literal count of the scan spec (allowlisted hits included); null when the scan cannot run. */
export function hardTotal(ctx: AppContext): number | null {
  const s = ctx.literalScan();
  return s.report ? s.report.totals.hard : null;
}

export function checkLiterals(ctx: AppContext): CheckOutput {
  const { app } = ctx;
  const violations: Finding[] = [];
  const warnings: Finding[] = [];
  const al = loadAllowlist(app, ctx.registryDir, ctx.rel);
  violations.push(...al.problems);

  const scanRun = ctx.literalScan();
  for (const m of scanRun.setup.missing) violations.push({ file: m, line: 0, message: "scan path from apps.json not found" });
  if (scanRun.setup.error) violations.push({ file: app.root, line: 0, message: scanRun.setup.error });
  const report = scanRun.report;
  const scanLabel = app.scan?.paths?.[0] ?? app.root;

  if (report) {
    report.fileReports.forEach((fr, i) => {
      const file = ctx.rel(scanRun.absPaths[i]);
      for (const h of fr.hits ?? []) {
        if (!HARD_SET.has(h.category)) continue;
        const kind: LiteralKind = COLOR.has(h.category) && h.def ? "definition" : h.fallback ? "fallback" : "inline";
        if (allowsLiteral(al, { file, value: h.value, category: h.category, kind })) continue;
        const split = COLOR.has(h.category) ? `, ${kind}` : "";
        violations.push({ file, line: h.line, message: `hard literal ${h.value} (${h.category as HardCategory}${split})` });
      }
    });
    const hard = report.totals.hard;
    if (hard > app.literalFloor) {
      violations.push({ file: scanLabel, line: 0, message: `${hard} hard literals in the scan dirs, over the floor of ${app.literalFloor}` });
    }
  }

  if ((app.stack?.tailwind ?? "none") !== "none") {
    for (const f of ctx.sources()) {
      const hits = findDefaultScaleClasses(f.text, f.kind);
      const lineOf = hits.length ? lineFinder(f.text) : () => 0;
      for (const hit of hits) {
        if (allowsTwClass(al, f.rel, hit.className)) continue;
        violations.push({ file: f.rel, line: lineOf(hit.index), message: `Tailwind default-scale class ${hit.className} (${hit.scale}); use a design-system utility` });
      }
    }
    warnings.push(...unusedEntries(al, "twClasses"));
  }
  if (report) warnings.push(...unusedEntries(al, "literals"));

  return { violations, warnings };
}
