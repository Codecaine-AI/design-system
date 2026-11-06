import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadRules, type RuleArea } from "../scripts/design-score/rules";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry";

/** Each rule area's page under docs/10-design-score/. `judge` rules are listed on the screenshot judge page. */
const AREA_PAGE: Record<RuleArea, string> = {
  layout: "20-layout",
  typography: "30-typography",
  color: "40-color",
  motion: "50-motion",
  interaction: "60-interaction",
  accessibility: "70-accessibility",
  writing: "80-writing",
  judge: "85-screenshot-judge",
};

/** Every text span on a page: block text and structured-table cells. */
function pageText(page: string): string {
  const doc = JSON.parse(readFileSync(join(DESIGN_SYSTEM_ROOT, "docs/10-design-score", page, "doc.json"), "utf8"));
  const spans = (x: unknown): string[] =>
    typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(spans) : x && typeof x === "object" && typeof (x as any).insert === "string" ? [(x as any).insert] : [];
  return Object.values<any>(doc.blocks)
    .flatMap((b) => [...spans(b.text ?? []), ...(b.type === "structured-table" ? spans(b.props.rows) : [])])
    .join("\n");
}

/** Rule ids from rules/<area>.json that its area page never names. */
function missingFromPages(rules: { id: string; area?: string }[], text: (page: string) => string = pageText): string[] {
  const pages = new Map<string, string>();
  return rules
    .filter((r) => {
      const page = AREA_PAGE[r.area as RuleArea];
      if (!page) return true;
      if (!pages.has(page)) pages.set(page, text(page));
      const id = r.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(pages.get(page)!);
    })
    .map((r) => `${r.area}: ${r.id}`);
}

describe("design-score rule pages", () => {
  test("every rule id appears on its area's page", () => {
    const { rules } = loadRules(DESIGN_SYSTEM_ROOT);
    expect(rules.length).toBeGreaterThan(0);
    expect(missingFromPages(rules)).toEqual([]);
  });

  test("a rule its page does not name is reported", () => {
    const text = (page: string) => (page === "20-layout" ? "layout-wrap-hang-extra and layout-shared-edges" : "");
    expect(missingFromPages([{ id: "layout-wrap-hang", area: "layout" }, { id: "layout-shared-edges", area: "layout" }], text)).toEqual(["layout: layout-wrap-hang"]);
  });
});
