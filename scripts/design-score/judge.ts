/**
 * V-judge: a vision-model judge over the state screenshots. Not run in this version.
 *
 * What it will need is already captured per run: shots/<page>__<theme>__<viewport>.png (the page state
 * after its actions), plus the motion shots and every finding's crop. A later version reads those, asks a
 * model to rate hierarchy, grouping, rhythm and polish against the rules mapped to V-judge in
 * design-score/rules.json, and returns findings in the same shape as every other check
 * ({ check: "V-judge", severity, page, theme, viewport, box, measured, expected }).
 */
import type { PageResult, Scorecard } from "./types";

export function judgeStub(pages: PageResult[]): Scorecard["judge"] {
  return {
    status: "not-run",
    shots: pages.flatMap((p) => p.shots.filter((s) => s.kind === "state").map((s) => s.file)),
    note: "V-judge is a stub: the listed state screenshots are its input. V-judge is n/a in every page score.",
  };
}
