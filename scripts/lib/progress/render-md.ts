/** progress.md: the same model as progress.html, as GitHub-flavored Markdown tables. */

import type { PassId } from "../registry.ts";
import { CHECK_IDS, formatCount, lintSummary, PASS_IDS, type ProgressModel, type ProgressRow } from "./model.ts";

/** A table cell: pipes escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

function pass(row: ProgressRow, p: PassId): string {
  return row.passes[p].status ?? "–";
}

function literals(row: ProgressRow): string {
  const { baseline, lintBaseline, now, nowFrom, floor, removed } = row.literals;
  const lint = lintBaseline !== null ? ` (lint ${formatCount(lintBaseline)})` : "";
  const gone = removed !== null ? `, ${formatCount(removed)} removed` : "";
  return `${formatCount(baseline)}${lint} / ${formatCount(now)}${nowFrom === "ledger" ? "*" : ""} / ${formatCount(floor)}${gone}`;
}

export function renderMarkdown(model: ProgressModel): string {
  const { totals, sources } = model;
  const out: string[] = [];
  out.push("# Design-system rollout progress", "");
  out.push(`Generated ${model.generatedAt} for root \`${model.root}\`.`, "");
  out.push(
    table(
      ["Apps", "Done", "In flight", "Blocked", "Todo", "Literals removed"],
      [
        [
          String(totals.apps),
          String(totals.done),
          String(totals.inFlight),
          String(totals.blocked),
          String(totals.todo),
          totals.literals.removed === null
            ? `– (no lint baseline; audit ${formatCount(totals.literals.baseline)}, now ${formatCount(totals.literals.now)})`
            : `${formatCount(totals.literals.removed)} (${totals.literals.measured} of ${totals.apps} apps measured against a lint baseline)`,
        ],
      ],
    ),
    "",
  );

  out.push("## Sources", "");
  out.push(`- Registry: \`${sources.registry.path}\` (${sources.registry.apps} apps)`);
  out.push(`- Ledger: \`${sources.ledger.path}\` (${sources.ledger.rows} rows)`);
  if (sources.lint.available) {
    const { report } = sources.lint;
    const ds = report.designSystem ? `, design-system ${report.designSystem.commit.slice(0, 12)}` : "";
    out.push(`- Lint: \`${sources.lint.origin}\` (pass ${report.pass ?? "all required"}${ds})`);
  } else {
    out.push(`- Lint: unavailable (${sources.lint.reason})`);
  }
  const base = sources.lintBaseline;
  out.push(`- Lint baseline: ${base ? (base.available ? `\`${base.origin}\`` : `unavailable (${base.reason})`) : "none (literals removed is not measured)"}`);
  out.push("");

  if (model.notes.length) out.push("## Notes", "", ...model.notes.map((n) => `- ${n}`), "");

  out.push("## Apps", "");
  out.push(
    table(
      ["App", "State", "Wave", "Repo", "Branch", "P1", "P2", "P3", "Literals (audit baseline / now / floor)", "Rounds", "Lint"],
      model.rows.map((r) => [
        r.id,
        r.state,
        r.wave === null ? "–" : String(r.wave),
        r.repo ? `\`${r.repo}\`` : "–",
        r.branch ? `\`${r.branch}\`` : "–",
        ...PASS_IDS.map((p) => pass(r, p)),
        literals(r),
        formatCount(r.rounds),
        `lint: ${lintSummary(r.lint)}`,
      ]),
    ),
    "",
  );
  if (model.rows.some((r) => r.literals.nowFrom === "ledger"))
    out.push("\\* The current count comes from the ledger; lint:apps has no result for the app.", "");

  if (sources.lint.available) {
    out.push("## Lint checks", "");
    const withResult = model.rows.filter((r) => r.lint.kind === "result");
    out.push(
      table(
        ["App", ...CHECK_IDS],
        withResult.map((r) => {
          const checks = r.lint.kind === "result" ? r.lint.checks : [];
          return [
            r.id,
            ...CHECK_IDS.map((id) => {
              const c = checks.find((x) => x.id === id);
              if (!c) return "–";
              return c.violations.length ? `${c.status} (${c.violations.length})` : c.status;
            }),
          ];
        }),
      ),
      "",
    );
  }

  const blocked = model.rows.filter((r) => r.blocked);
  if (blocked.length) {
    out.push("## Blocked", "");
    out.push(table(["App", "Reason", "Owner action"], blocked.map((r) => [r.id, r.blocked!.reason, r.blocked!.ownerAction || "–"])), "");
  }

  const noted = model.rows.filter((r) => r.notes.length);
  if (noted.length) out.push("## Row notes", "", ...noted.flatMap((r) => r.notes.map((n) => `- ${r.id}: ${n}`)), "");

  return `${out.join("\n").trimEnd()}\n`;
}
