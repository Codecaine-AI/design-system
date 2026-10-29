/**
 * R-axe: axe-core injected into the page. color-contrast and target-size are off (R-contrast and
 * R-hit-target own them, with Ford's thresholds); `incomplete` results are not findings.
 */
import type { AxeSource } from "./browser";
import type { RawFinding } from "./types";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface AxeNodeOut {
  rule: string;
  impact: string;
  help: string;
  target: string;
  summary: string;
  box: { x: number; y: number; w: number; h: number } | null;
}

export async function runAxe(page: any, axe: AxeSource, exclude: string[]): Promise<RawFinding[]> {
  const has = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== "undefined");
  if (!has) await page.addScriptTag({ content: axe.source });
  const nodes: AxeNodeOut[] = await page.evaluate(
    async (arg: { tags: string[]; exclude: string[] }) => {
      const ax = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }> }> } }).axe;
      const context = arg.exclude.length ? { include: [document], exclude: arg.exclude.map((s) => [s]) } : document;
      const res = await ax.run(context, {
        runOnly: { type: "tag", values: arg.tags },
        rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
        resultTypes: ["violations"],
      });
      const out: AxeNodeOut[] = [];
      for (const v of res.violations) {
        for (const n of v.nodes.slice(0, 8)) {
          const target = n.target.map(String).join(" ");
          let box: AxeNodeOut["box"] = null;
          try {
            const el = document.querySelector(String(n.target[n.target.length - 1]));
            const r = el?.getBoundingClientRect();
            if (r && r.width > 0) box = { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
          } catch {
            // shadow-DOM or iframe target
          }
          out.push({ rule: v.id, impact: v.impact, help: v.help, target, summary: (n.failureSummary ?? "").split("\n").slice(0, 3).join(" ").trim(), box });
        }
      }
      return out;
    },
    { tags: TAGS, exclude },
  );
  return nodes.map((n) => ({
    check: "R-axe",
    severity: "fail" as const,
    selector: n.target,
    box: n.box,
    measured: `${n.rule} (${n.impact}): ${n.summary}`.slice(0, 300),
    expected: n.help,
  }));
}
