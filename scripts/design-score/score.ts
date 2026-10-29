/**
 * Scoring.
 *
 *   check status per page   fail if any fail finding (in any theme or viewport), else warn if any warn
 *                           finding, else pass; n/a when the check could not run or the page skips it
 *   page score              mean over its applicable checks of pass 1, warn 0.5, fail 0, times 100
 *   app score               mean of the page scores
 *
 * Static checks have no page: their status counts once in every page (the source renders every page).
 * Counts come from all findings, before the per-check cap, so the cap never changes a score.
 */
import { CHECKS } from "./checks";
import type { Area, CheckStatus, PageCheck, PageResult } from "./types";

export const AREAS: Area[] = ["layout", "typography", "color", "motion", "interaction", "accessibility"];

export const SCORING = "Per page, each check is pass (1), warn (0.5) or fail (0): fail if any finding is a fail in any theme or viewport, warn if any is a warn. n/a checks are left out. Page score = mean x 100. App score = mean of page scores. Area sub-scores apply the same formula to each area's checks. Static checks count once in every page. Counts are taken before the per-check cap. Skipped pages and allowed findings are not counted.";

const VALUE: Record<Exclude<CheckStatus, "n/a">, number> = { pass: 1, warn: 0.5, fail: 0 };

export function statusOf(fails: number, warns: number): Exclude<CheckStatus, "n/a"> {
  return fails > 0 ? "fail" : warns > 0 ? "warn" : "pass";
}

/** Adds counts into a page's check entry. */
export function tally(checks: Record<string, PageCheck>, id: string, fails: number, warns: number, cut: number): void {
  const entry = (checks[id] ??= { status: "pass", fails: 0, warns: 0, cut: 0 });
  if (entry.status === "n/a" && entry.note) {
    // a check skipped for one variant but run in another keeps its counts
    entry.status = "pass";
  }
  entry.fails += fails;
  entry.warns += warns;
  entry.cut += cut;
  entry.status = statusOf(entry.fails, entry.warns);
}

export function markNa(checks: Record<string, PageCheck>, id: string, note: string): void {
  if (checks[id] && checks[id]!.status !== "n/a") return;
  checks[id] = { status: "n/a", fails: 0, warns: 0, cut: 0, note };
}

export function pageScore(checks: Record<string, PageCheck>): number | null {
  const values = Object.values(checks)
    .filter((c) => c.status !== "n/a")
    .map((c) => VALUE[c.status as Exclude<CheckStatus, "n/a">]);
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 10 : null;
}

export function appScore(pages: PageResult[]): number | null {
  const scores = pages.map((p) => p.score).filter((s): s is number => s !== null);
  return scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
}

export function checkTotals(pages: PageResult[]): Record<string, Record<CheckStatus, number>> {
  const out: Record<string, Record<CheckStatus, number>> = {};
  for (const check of CHECKS) out[check.id] = { pass: 0, warn: 0, fail: 0, "n/a": 0 };
  for (const page of pages) for (const check of CHECKS) out[check.id]![page.checks[check.id]?.status ?? "n/a"]++;
  return out;
}

/** Per-area page scores: the page score formula over the area's checks only. */
export function pageAreas(checks: Record<string, PageCheck>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const area of AREAS) {
    const ids = CHECKS.filter((c) => c.area === area).map((c) => c.id);
    out[area] = pageScore(Object.fromEntries(Object.entries(checks).filter(([id]) => ids.includes(id))));
  }
  return out;
}

/** Per-area app sub-scores: mean of the page area scores (pages where the area applies). */
export function appAreas(pages: PageResult[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const area of AREAS) {
    const vals = pages.map((p) => (p.areas ?? pageAreas(p.checks))[area]).filter((v): v is number => typeof v === "number");
    out[area] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  }
  return out;
}
