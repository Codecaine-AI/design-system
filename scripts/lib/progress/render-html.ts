/**
 * progress.html: one self-contained page. The design system's tokens.css is inlined, every style
 * uses `--ds-*` variables, and the page makes no request: no links, no fonts, no scripts from
 * elsewhere. The theme follows `prefers-color-scheme` until the reader picks one with the toggle;
 * either way it lands on `data-theme`, the switch tokens.css reads.
 */

import type { PassId } from "../registry.ts";
import type { LintCheck } from "./lint.ts";
import { formatCount, lintSummary, PASS_IDS, type AppState, type ProgressModel, type ProgressRow } from "./model.ts";

type Tone = "success" | "info" | "warning" | "danger" | "neutral" | "none";

const MAX_VIOLATIONS = 50;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escaped text with `code spans` rendered as <code>. */
function inline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function chip(text: string, tone: Tone, title?: string): string {
  return `<span class="p-chip" data-tone="${tone}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(text)}</span>`;
}

function passTone(status: string | null): Tone {
  switch (status) {
    case "done":
      return "success";
    case "working":
    case "review":
      return "info";
    case "blocked":
      return "danger";
    case "todo":
      return "neutral";
    case "n/a":
    case null:
      return "none";
    default:
      return "warning";
  }
}

const STATE_TONE: Record<AppState, Tone> = { done: "success", "in flight": "info", blocked: "danger", todo: "neutral" };

function checkTone(status: string): Tone {
  return status === "pass" ? "success" : status === "fail" ? "danger" : status === "n/a" ? "none" : "warning";
}

function passCell(row: ProgressRow, p: PassId): string {
  const cell = row.passes[p];
  return `<td>${chip(cell.status ?? "–", passTone(cell.status), cell.reason ? `n/a: ${cell.reason}` : undefined)}</td>`;
}

/**
 * Baseline → now / floor. The meter and "% removed" appear only when both counts come from lint:apps
 * (a lint baseline); an audit baseline and a lint count are different measures, shown side by side.
 */
function literalsCell(row: ProgressRow): string {
  const { baseline, lintBaseline, now, nowFrom, floor, removed } = row.literals;
  const source = nowFrom === "ledger" ? " title=\"From the ledger: lint:apps has no result for this app\"" : "";
  const nowText = `<span${source}>${formatCount(now)}${nowFrom === "ledger" ? "*" : ""}</span>`;
  const floorText = `<span class="p-dim">/ ${formatCount(floor)}</span>`;
  if (removed !== null && lintBaseline !== null) {
    const share = lintBaseline > 0 ? Math.max(0, Math.min(100, Math.round((removed / lintBaseline) * 100))) : 0;
    const meter = `<span class="p-meter" aria-hidden="true"><span style="width: ${share}%"></span></span><span class="p-sub">${share}% removed (lint baseline)</span>`;
    const audit = baseline !== null ? `<span class="p-sub">audit ${formatCount(baseline)}</span>` : "";
    return `<td class="p-num">${formatCount(lintBaseline)} → ${nowText} ${floorText}${meter}${audit}</td>`;
  }
  return `<td class="p-num"><span title="audit baseline">${formatCount(baseline)}</span> · ${nowText} ${floorText}<span class="p-sub">audit · now: different counts, no removal measured</span></td>`;
}

function checkTitle(c: LintCheck): string {
  const parts = [`${c.id}: ${c.status}`];
  if (c.reason) parts.push(c.reason);
  if (c.violations.length) parts.push(`${c.violations.length} violation${c.violations.length === 1 ? "" : "s"}`);
  if (c.warnings.length) parts.push(`${c.warnings.length} warning${c.warnings.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function lintCell(row: ProgressRow): string {
  const { lint } = row;
  if (lint.kind === "unavailable") return `<td>${chip("unavailable", "none", "lint:apps did not produce a report")}</td>`;
  if (lint.kind === "missing") return `<td>${chip("no result", "warning", "lint:apps reported no result for this app")}</td>`;
  const title = lint.checks.map(checkTitle).join("\n");
  const flagged = lint.checks.filter((c) => c.status === "fail" || c.status === "warn" || c.warnings.length);
  if (flagged.length === 0) return `<td>${chip(lint.ok ? "pass" : "fail", lint.ok ? "success" : "danger", title)}</td>`;
  const chips = flagged.map((c) => {
    const count = c.status === "fail" ? c.violations.length : c.warnings.length;
    return chip(`${c.id}${count ? ` ${count}` : ""}`, c.status === "fail" ? "danger" : "warning", checkTitle(c));
  });
  return `<td><span class="p-chips" title="${escapeHtml(title)}">${chips.join(" ")}</span></td>`;
}

function blockedCell(row: ProgressRow): string {
  if (!row.blocked) return `<td class="p-dim">–</td>`;
  const action = row.blocked.ownerAction ? `<span class="p-action"><strong>Owner:</strong> ${inline(row.blocked.ownerAction)}</span>` : "";
  return `<td class="p-blocked">${inline(row.blocked.reason)}${action}</td>`;
}

function appRow(row: ProgressRow): string {
  const sub = [row.repo, row.branch].filter(Boolean).map((t) => `<span class="p-sub">${escapeHtml(t!)}</span>`).join("");
  const notes = row.notes.map((n) => `<span class="p-rownote">${escapeHtml(n)}</span>`).join("");
  return [
    `<tr id="app-${escapeHtml(row.id)}">`,
    `<td class="p-app"><strong>${escapeHtml(row.id)}</strong>${sub}${notes}</td>`,
    `<td>${chip(row.state, STATE_TONE[row.state])}</td>`,
    `<td class="p-num">${row.wave ?? "–"}</td>`,
    ...PASS_IDS.map((p) => passCell(row, p)),
    literalsCell(row),
    `<td class="p-num">${formatCount(row.rounds)}</td>`,
    lintCell(row),
    blockedCell(row),
    "</tr>",
  ].join("");
}

function tile(label: string, value: string, tone: Tone, sub = ""): string {
  return `<div class="p-tile" data-tone="${tone}"><span class="p-tile-label">${escapeHtml(label)}</span><span class="p-tile-value">${escapeHtml(value)}</span>${sub ? `<span class="p-sub">${escapeHtml(sub)}</span>` : ""}</div>`;
}

function lintDetails(model: ProgressModel): string {
  const rows = model.rows.filter((r) => r.lint.kind === "result" && r.lint.checks.some((c) => c.violations.length || c.warnings.length));
  if (!rows.length) return "";
  const blocks = rows.map((r) => {
    const checks = r.lint.kind === "result" ? r.lint.checks : [];
    const body = checks
      .filter((c) => c.violations.length || c.warnings.length)
      .map((c) => {
        const items = [
          ...c.violations.slice(0, MAX_VIOLATIONS).map((v) => `<li>${escapeHtml(`${v.file}:${v.line}`)} ${escapeHtml(v.message)}</li>`),
          ...(c.violations.length > MAX_VIOLATIONS ? [`<li class="p-dim">and ${c.violations.length - MAX_VIOLATIONS} more</li>`] : []),
          ...c.warnings.slice(0, MAX_VIOLATIONS).map((w) => `<li class="p-warn">warning: ${escapeHtml(w)}</li>`),
        ];
        return `<div class="p-check">${chip(`${c.id} ${c.status}`, checkTone(c.status))}<ul class="p-violations">${items.join("")}</ul></div>`;
      })
      .join("");
    return `<details><summary>${escapeHtml(r.id)} <span class="p-dim">lint: ${escapeHtml(lintSummary(r.lint))}</span></summary>${body}</details>`;
  });
  return `<h2>Lint details</h2><div class="p-panel">${blocks.join("")}</div>`;
}

function sources(model: ProgressModel): string {
  const { registry, ledger, lint, lintBaseline } = model.sources;
  const lintText = lint.available
    ? `<code>${escapeHtml(lint.origin)}</code> (pass ${escapeHtml(lint.report.pass ?? "all required")}${lint.report.designSystem ? `, design-system ${escapeHtml(lint.report.designSystem.commit.slice(0, 12))}` : ""})`
    : `unavailable: ${escapeHtml(lint.reason)}`;
  return [
    '<dl class="p-sources">',
    `<dt>Registry</dt><dd><code>${escapeHtml(registry.path)}</code> (${registry.apps} apps)</dd>`,
    `<dt>Ledger</dt><dd><code>${escapeHtml(ledger.path)}</code> (${ledger.rows} rows)</dd>`,
    `<dt>Lint</dt><dd>${lintText}</dd>`,
    `<dt>Lint baseline</dt><dd>${lintBaseline ? (lintBaseline.available ? `<code>${escapeHtml(lintBaseline.origin)}</code>` : `unavailable: ${escapeHtml(lintBaseline.reason)}`) : "none: literals removed is not measured"}</dd>`,
    "</dl>",
  ].join("");
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
body { margin: 0; background: var(--ds-color-surface-page); color: var(--ds-color-text-body); font-family: var(--ds-font-family-sans); font-size: var(--ds-font-size-ui-lg); line-height: var(--ds-line-height-ui); }
::selection { background: var(--ds-color-selection); }
:focus-visible { outline: var(--ds-border-width-focus) solid var(--ds-color-focus-ring); outline-offset: var(--ds-focus-ring-offset); }
main { padding: var(--ds-layout-content-padding-top) var(--ds-layout-content-padding-x) var(--ds-layout-content-padding-bottom); }
.p-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--ds-space-4); margin-bottom: var(--ds-space-6); }
h1 { margin: 0; color: var(--ds-color-text-ink); font-size: var(--ds-font-size-title); font-weight: var(--ds-font-weight-bold); letter-spacing: var(--ds-letter-spacing-title); line-height: var(--ds-line-height-tight); }
h2 { margin: var(--ds-space-10) 0 var(--ds-space-3); color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-2xs); font-weight: var(--ds-font-weight-semibold); letter-spacing: var(--ds-letter-spacing-micro-wide); text-transform: uppercase; }
code { padding: 0 var(--ds-space-0-5); border-radius: var(--ds-radius-base); background: var(--ds-color-fill-chip); font-family: var(--ds-font-family-mono); font-size: var(--ds-font-size-ui-xs); }
.p-meta { margin: var(--ds-space-1) 0 0; color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-sm); }
.p-toggle { padding: var(--ds-space-1) var(--ds-space-3); border: var(--ds-border-width-hairline) solid var(--ds-color-border-default); border-radius: var(--ds-radius-base); background: var(--ds-color-surface-panel); color: var(--ds-color-text-body); font: inherit; font-size: var(--ds-font-size-ui-sm); cursor: pointer; }
.p-toggle:hover { background: var(--ds-color-fill-hover); }
.p-tiles { display: flex; flex-wrap: wrap; gap: var(--ds-space-3); }
.p-tile { display: flex; flex: 1 1 0; flex-direction: column; gap: var(--ds-space-0-5); min-width: max-content; padding: var(--ds-space-3) var(--ds-space-4); border: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); border-left-width: var(--ds-border-width-rail); border-radius: var(--ds-radius-base); background: var(--ds-color-surface-panel); }
.p-tile[data-tone="success"] { border-left-color: var(--ds-color-status-success-solid); }
.p-tile[data-tone="info"] { border-left-color: var(--ds-color-status-info-solid); }
.p-tile[data-tone="danger"] { border-left-color: var(--ds-color-status-danger-solid); }
.p-tile[data-tone="neutral"] { border-left-color: var(--ds-color-status-neutral-solid); }
.p-tile[data-tone="none"] { border-left-color: var(--ds-color-border-strong); }
.p-tile-label { color: var(--ds-color-text-muted); font-size: var(--ds-font-size-micro); font-weight: var(--ds-font-weight-semibold); letter-spacing: var(--ds-letter-spacing-micro-wide); text-transform: uppercase; }
.p-tile-value { color: var(--ds-color-text-ink); font-size: var(--ds-font-size-title); font-weight: var(--ds-font-weight-semibold); font-variant-numeric: tabular-nums; line-height: var(--ds-line-height-tight); }
.p-notes { margin: var(--ds-space-6) 0 0; padding: var(--ds-space-3) var(--ds-space-4) var(--ds-space-3) var(--ds-space-8); border-left: var(--ds-border-width-rail) solid var(--ds-color-status-warning-solid); border-radius: var(--ds-radius-base); background: var(--ds-color-status-warning-soft); color: var(--ds-color-text-body); font-size: var(--ds-font-size-ui-sm); }
.p-panel { overflow-x: auto; border: var(--ds-border-width-hairline) solid var(--ds-color-border-default); border-radius: var(--ds-radius-base); background: var(--ds-color-surface-panel); }
table { width: 100%; border-collapse: collapse; font-size: var(--ds-font-size-ui-md); }
th { position: sticky; top: 0; z-index: var(--ds-z-raised); padding: var(--ds-space-2) var(--ds-space-3); border-bottom: var(--ds-border-width-hairline) solid var(--ds-color-border-default); background: var(--ds-color-surface-panel); color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-2xs); font-weight: var(--ds-font-weight-semibold); letter-spacing: var(--ds-letter-spacing-micro); text-align: left; text-transform: uppercase; white-space: nowrap; }
td { padding: var(--ds-space-2) var(--ds-space-3); border-bottom: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); vertical-align: top; }
tbody tr:last-child td { border-bottom-width: var(--ds-border-width-none); }
tbody tr:hover { background: var(--ds-color-fill-hover); }
.p-app strong { color: var(--ds-color-text-ink); font-weight: var(--ds-font-weight-semibold); }
.p-sub { display: block; color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-xs); }
.p-app .p-sub { font-family: var(--ds-font-family-mono); overflow-wrap: anywhere; }
.p-rownote { display: block; color: var(--ds-color-status-warning-text); font-size: var(--ds-font-size-ui-xs); }
.p-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.p-dim { color: var(--ds-color-text-faint); }
.p-chips { display: flex; flex-wrap: wrap; gap: var(--ds-space-1); }
.p-chip { display: inline-block; padding: 0 var(--ds-space-1-5); border: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); border-radius: var(--ds-radius-base); color: var(--ds-color-text-faint); font-size: var(--ds-font-size-ui-xs); font-weight: var(--ds-font-weight-medium); white-space: nowrap; }
.p-chip[data-tone="success"] { border-color: var(--ds-color-status-success-line); background: var(--ds-color-status-success-soft); color: var(--ds-color-status-success-text); }
.p-chip[data-tone="info"] { border-color: var(--ds-color-status-info-line); background: var(--ds-color-status-info-soft); color: var(--ds-color-status-info-text); }
.p-chip[data-tone="warning"] { border-color: var(--ds-color-status-warning-line); background: var(--ds-color-status-warning-soft); color: var(--ds-color-status-warning-text); }
.p-chip[data-tone="danger"] { border-color: var(--ds-color-status-danger-line); background: var(--ds-color-status-danger-soft); color: var(--ds-color-status-danger-text); }
.p-chip[data-tone="neutral"] { border-color: var(--ds-color-status-neutral-line); background: var(--ds-color-status-neutral-soft); color: var(--ds-color-status-neutral-text); }
.p-meter { display: block; overflow: hidden; height: var(--ds-space-1); margin-top: var(--ds-space-1); border-radius: var(--ds-radius-pill); background: var(--ds-color-fill-chip); }
.p-meter > span { display: block; height: 100%; background: var(--ds-color-status-success-solid); }
.p-blocked { min-width: var(--ds-layout-inspector-width); font-size: var(--ds-font-size-ui-sm); overflow-wrap: anywhere; }
.p-action { display: block; margin-top: var(--ds-space-1); color: var(--ds-color-text-ink); }
.p-sources { display: grid; grid-template-columns: max-content 1fr; gap: var(--ds-space-1) var(--ds-space-4); margin: 0; font-size: var(--ds-font-size-ui-sm); }
.p-sources dt { color: var(--ds-color-text-muted); }
.p-sources dd { margin: 0; }
details { padding: var(--ds-space-2) var(--ds-space-3); border-bottom: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); }
details:last-child { border-bottom-width: var(--ds-border-width-none); }
summary { color: var(--ds-color-text-ink); font-weight: var(--ds-font-weight-medium); cursor: pointer; }
.p-check { margin-top: var(--ds-space-2); }
.p-violations { margin: var(--ds-space-1) 0 0; padding-left: var(--ds-space-5); font-family: var(--ds-font-family-mono); font-size: var(--ds-font-size-ui-xs); }
.p-warn { color: var(--ds-color-status-warning-text); }
`;

/** Picks the theme before first paint: the saved choice, else the OS preference. */
const THEME_BOOT = `(function () {
  var root = document.documentElement, saved = null;
  try { saved = localStorage.getItem("ds-progress-theme"); } catch (e) {}
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", saved === "light" || saved === "dark" ? saved : dark ? "dark" : "light");
})();`;

const THEME_TOGGLE = `(function () {
  var root = document.documentElement, button = document.getElementById("p-theme-toggle");
  function label() { button.textContent = root.getAttribute("data-theme") === "dark" ? "Switch to light" : "Switch to dark"; }
  label();
  button.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("ds-progress-theme", next); } catch (e) {}
    label();
  });
})();`;

/** The page. `tokensCss` is the design system's dist/css/tokens.css, inlined as the first stylesheet. */
export function renderHtml(model: ProgressModel, tokensCss: string): string {
  const { totals } = model;
  const { literals } = totals;
  const literalSub =
    literals.removed === null
      ? `no lint baseline · audit ${formatCount(literals.baseline)} · now ${formatCount(literals.now)}`
      : `${literals.measured} of ${totals.apps} apps measured against a lint baseline`;
  const tiles = [
    tile("Apps", String(totals.apps), "none"),
    tile("Done", String(totals.done), "success"),
    tile("In flight", String(totals.inFlight), "info"),
    tile("Blocked", String(totals.blocked), "danger"),
    tile("Todo", String(totals.todo), "neutral"),
    tile("Literals removed", formatCount(literals.removed), literals.removed === null ? "none" : "success", literalSub),
  ].join("");
  const notes = model.notes.length ? `<ul class="p-notes">${model.notes.map((n) => `<li>${inline(n)}</li>`).join("")}</ul>` : "";
  const ledgerNow = model.rows.some((r) => r.literals.nowFrom === "ledger")
    ? '<p class="p-meta">* The current count comes from the ledger; lint:apps has no result for the app.</p>'
    : "";
  const headers = ["App", "State", "Wave", "P1", "P2", "P3", "Literals (baseline, now / floor)", "Rounds", "Lint", "Blocked reason → owner action"];
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rollout progress · @codecaine-ai/design-system</title>
<!-- Generated by scripts/progress.ts (bun run progress). Self-contained: tokens.css is inlined below. -->
<script>${THEME_BOOT}</script>
<style>
${tokensCss.trim()}
</style>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="p-head">
<div><h1>Rollout progress</h1><p class="p-meta">Generated ${escapeHtml(model.generatedAt)} · root <code>${escapeHtml(model.root)}</code></p></div>
<button type="button" class="p-toggle" id="p-theme-toggle">Switch theme</button>
</header>
<section class="p-tiles" aria-label="Totals">${tiles}</section>
${notes}
<h2>Apps</h2>
<div class="p-panel"><table>
<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>${model.rows.map(appRow).join("\n")}</tbody>
</table></div>
${ledgerNow}
${lintDetails(model)}
<h2>Sources</h2>
${sources(model)}
</main>
<script>${THEME_TOGGLE}</script>
</body>
</html>
`;
}
