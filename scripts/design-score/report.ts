/**
 * report.html for one run, and the compare page for two runs. Plain HTML styled only with the design
 * system's own tokens (linked from this checkout's dist/, never copied).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { CHECKS } from "./checks";
import { loadRules } from "./rules";
import { AREAS, appAreas, pageAreas } from "./score";
import type { AllowedFinding, CheckStatus, Finding, Scorecard } from "./types";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const STYLE = `
  body { margin: 0; background: var(--ds-color-surface-page); color: var(--ds-color-text-body); font-family: var(--ds-font-family-sans); font-size: var(--ds-font-size-ui-md); line-height: var(--ds-line-height-ui); }
  main { max-width: var(--ds-layout-lane-wide); margin: 0 auto; padding: var(--ds-space-10) var(--ds-space-8) var(--ds-space-16); }
  h1 { font-size: var(--ds-font-size-title); letter-spacing: var(--ds-letter-spacing-title); line-height: var(--ds-line-height-tight); color: var(--ds-color-text-ink); margin: 0 0 var(--ds-space-2); }
  h2 { font-size: var(--ds-font-size-ui-lg); color: var(--ds-color-text-ink); margin: var(--ds-space-10) 0 var(--ds-space-3); }
  h3 { font-size: var(--ds-font-size-ui-md); color: var(--ds-color-text-ink); margin: var(--ds-space-6) 0 var(--ds-space-2); }
  .muted { color: var(--ds-color-text-muted); }
  .score { display: flex; align-items: baseline; gap: var(--ds-space-4); margin: var(--ds-space-4) 0; }
  .score strong { font-size: var(--ds-font-size-title); color: var(--ds-color-text-ink); font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: var(--ds-space-1-5) var(--ds-space-2); border-bottom: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); vertical-align: top; }
  th { color: var(--ds-color-text-muted); font-weight: var(--ds-font-weight-medium); font-size: var(--ds-font-size-ui-xs); }
  td.num, th.num { text-align: right; }
  .grid td.st { text-align: center; padding: var(--ds-space-1); font-size: var(--ds-font-size-ui-xs); }
  .pass { background: var(--ds-color-status-success-soft); color: var(--ds-color-status-success-text); }
  .warn { background: var(--ds-color-status-warning-soft); color: var(--ds-color-status-warning-text); }
  .fail { background: var(--ds-color-status-danger-soft); color: var(--ds-color-status-danger-text); }
  .na { color: var(--ds-color-text-faint); }
  .badge { display: inline-block; padding: 0 var(--ds-space-1-5); border-radius: var(--ds-radius-base); font-size: var(--ds-font-size-ui-xs); font-weight: var(--ds-font-weight-medium); }
  .finding { border: var(--ds-border-width-hairline) solid var(--ds-color-border-default); border-radius: var(--ds-radius-base); padding: var(--ds-space-3); margin: var(--ds-space-2) 0; background: var(--ds-color-surface-panel); }
  .finding header { display: flex; gap: var(--ds-space-2); align-items: center; flex-wrap: wrap; }
  .finding code, td code { font-family: var(--ds-font-family-mono); font-size: var(--ds-font-size-code); word-break: break-all; }
  .finding dl { display: grid; grid-template-columns: auto 1fr; gap: var(--ds-space-1) var(--ds-space-3); margin: var(--ds-space-2) 0; }
  .finding dt { color: var(--ds-color-text-muted); }
  .finding dd { margin: 0; }
  .finding img { display: block; max-width: 100%; margin-top: var(--ds-space-2); border: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); image-rendering: pixelated; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(var(--ds-space-16) * 4), 1fr)); gap: var(--ds-space-3); }
  .shots figure, .pair figure { margin: 0; }
  .shots img, .pair img { width: 100%; border: var(--ds-border-width-hairline) solid var(--ds-color-border-subtle); }
  figcaption { font-size: var(--ds-font-size-ui-xs); color: var(--ds-color-text-muted); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--ds-space-4); margin: var(--ds-space-3) 0; }
  .up { color: var(--ds-color-status-success-text); }
  .down { color: var(--ds-color-status-danger-text); }
  details summary { cursor: pointer; color: var(--ds-color-link); }
  .scroll { overflow-x: auto; }
  .areas { display: flex; flex-wrap: wrap; gap: var(--ds-space-2) var(--ds-space-6); margin: 0 0 var(--ds-space-4); }
  .areas span { font-variant-numeric: tabular-nums; }
  .areas strong { color: var(--ds-color-text-ink); }
  .rules { color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-xs); }
`;

function head(title: string, dir: string, designSystem: string): string {
  const rel = (p: string) => relative(dir, join(designSystem, p));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="${esc(rel("css/fonts.css"))}"><link rel="stylesheet" href="${esc(rel("dist/css/tokens.css"))}">
<style>${STYLE}</style></head><body><main>`;
}

const CELL: Record<CheckStatus, string> = { pass: "pass", warn: "warn", fail: "fail", "n/a": "na" };
const LABEL: Record<CheckStatus, string> = { pass: "pass", warn: "warn", fail: "fail", "n/a": "n/a" };

/** Findings that repeat across themes/viewports collapse into one entry (grouped findings by their group key). */
function grouped(findings: Finding[]): Array<{ f: Finding; also: string[] }> {
  const groups = new Map<string, { f: Finding; also: string[] }>();
  for (const f of findings) {
    const key = `${f.page}|${f.check}|${f.severity}|${f.group ?? f.selector}|${f.file}:${f.line}`;
    const g = groups.get(key);
    if (g) g.also.push(`${f.theme} ${f.viewport}`);
    else groups.set(key, { f, also: [] });
  }
  return [...groups.values()];
}

function findingHtml({ f, also }: { f: Finding; also: string[] }): string {
  const where = f.file ? `<code>${esc(f.file)}:${f.line}</code>` : `${esc(f.theme)} · ${esc(f.viewport)}${also.length ? ` <span class="muted">(also ${esc(also.join(", "))})</span>` : ""}`;
  const allowed = (f as AllowedFinding).allowed;
  const badge = allowed ? `<span class="badge na">allowed: ${esc(allowed)}</span>` : `<span class="badge ${f.severity}">${f.severity}</span>`;
  const band = f.check === "R-hit-target" && f.group ? ` <span class="muted">${esc(f.group.split("|")[0])}</span>` : "";
  return `<article class="finding"><header>${badge}<strong>${esc(f.check)}</strong>${band}${f.count && f.count > 1 ? ` <span class="badge na">×${f.count}</span>` : ""}<span class="muted">${where}</span></header>
<dl>${f.selector ? `<dt>element</dt><dd><code>${esc(f.selector)}</code>${f.box ? ` <span class="muted">at ${f.box.x},${f.box.y} ${f.box.w}x${f.box.h}</span>` : ""}</dd>` : ""}
${f.other ? `<dt>other</dt><dd><code>${esc(f.other.selector)}</code> <span class="muted">at ${f.other.box.x},${f.other.box.y} ${f.other.box.w}x${f.other.box.h}</span></dd>` : ""}
<dt>measured</dt><dd>${esc(f.measured)}</dd><dt>expected</dt><dd>${esc(f.expected)}</dd>${f.message ? `<dt>note</dt><dd>${esc(f.message)}</dd>` : ""}${allowed ? `<dt>why allowed</dt><dd>${esc((f as AllowedFinding).reason)}</dd>` : ""}${f.rules?.length ? `<dt>rules</dt><dd class="rules">${f.rules.map((r) => `<code>${esc(r)}</code>`).join(" ")}</dd>` : ""}</dl>
${f.crop ? `<a href="${esc(f.crop)}"><img src="${esc(f.crop)}" alt="${esc(f.check)} crop" loading="lazy"></a>` : ""}</article>`;
}

export function writeReport(dir: string, card: Scorecard, designSystem: string): string {
  const parts: string[] = [head(`design:score ${card.app} ${card.runId}`, dir, designSystem)];
  parts.push(`<h1>${esc(card.app)}</h1><p class="muted">Run ${esc(card.runId)}${card.label ? ` · ${esc(card.label)}` : ""} · ${esc(card.baseUrl)} · ${esc(card.startedAt)}</p>`);
  parts.push(`<div class="score"><strong>${card.score ?? "–"}</strong><span class="muted">app score (mean of ${card.pages.length} page scores)</span></div>`);
  const areas = card.areas ?? appAreas(card.pages);
  parts.push(`<div class="areas">${AREAS.map((a) => `<span>${esc(a)} <strong>${areas[a] ?? "–"}</strong></span>`).join("")}</div>`);
  parts.push(`<p class="muted">${esc(card.scoring)}</p>`);
  const prov = card.provenance as Record<string, any>;
  parts.push(`<p class="muted">App ${esc(prov.app?.branch ?? "")} ${esc(String(prov.app?.head ?? "").slice(0, 10))}${prov.app?.dirtyFiles ? ` (+${prov.app.dirtyFiles} changed files)` : ""} · design system ${esc(String(prov.designSystem?.head ?? "").slice(0, 10))} · Chromium ${esc(prov.browser?.version)} · axe ${esc(prov.axe?.version ?? "not found")}${prov.browser?.fallback ? ` · ${esc(prov.browser.fallback)}` : ""}</p>`);

  // Pages x checks.
  parts.push(`<h2>Pages</h2><div class="scroll"><table class="grid"><thead><tr><th>page</th><th class="num">score</th>${AREAS.map((a) => `<th class="num" title="${esc(a)} sub-score">${esc(a.slice(0, 5))}</th>`).join("")}${CHECKS.map((c) => `<th title="${esc(c.title)}">${esc(c.id.replace(/^[A-Z]-/, ""))}</th>`).join("")}</tr></thead><tbody>`);
  for (const p of card.pages) {
    const pa = p.areas ?? pageAreas(p.checks);
    parts.push(`<tr><td><a href="#page-${esc(p.id)}">${esc(p.id)}</a><br><span class="muted">${esc(p.path)}${p.skipped ? " · skipped" : ""}</span></td><td class="num">${p.score ?? "–"}</td>${AREAS.map((a) => `<td class="num">${pa[a] ?? "–"}</td>`).join("")}${CHECKS.map((c) => {
      const pc = p.checks[c.id];
      const st = pc?.status ?? "n/a";
      const n = pc ? pc.fails + pc.warns : 0;
      return `<td class="st ${CELL[st]}" title="${esc(`${c.id}: ${LABEL[st]}${pc?.note ? ` (${pc.note})` : ""}${n ? `, ${pc!.fails} fail / ${pc!.warns} warn` : ""}${pc?.cut ? `, ${pc.cut} cut` : ""}`)}">${st === "n/a" ? "–" : n || "✓"}</td>`;
    }).join("")}</tr>`);
  }
  parts.push(`</tbody></table></div>`);

  // Checks, with the design rules design-score/rules/ maps to each (when that folder exists).
  const mapped = new Map<string, string[]>();
  try {
    for (const r of loadRules(designSystem).rules) for (const c of [r.check ?? []].flat()) mapped.set(c, [...(mapped.get(c) ?? []), `${r.id} (${r.title ?? r.id})`]);
  } catch {
    // a rules file that does not parse: the table shows no rules
  }
  parts.push(`<h2>Checks</h2><table><thead><tr><th>check</th><th>area</th><th>rule</th><th class="num">pass</th><th class="num">warn</th><th class="num">fail</th><th class="num">n/a</th></tr></thead><tbody>`);
  for (const c of CHECKS) {
    const t = card.checkTotals[c.id] ?? { pass: 0, warn: 0, fail: 0, "n/a": card.pages.length };
    parts.push(`<tr><td><strong>${esc(c.id)}</strong><br><span class="muted">${esc(c.title)}</span></td><td class="muted">${esc(c.area ?? "–")}</td><td class="muted">${esc(c.rule)}${mapped.get(c.id)?.length ? `<details><summary>${mapped.get(c.id)!.length} design rules</summary>${esc(mapped.get(c.id)!.join(" · "))}</details>` : ""}</td><td class="num">${t.pass}</td><td class="num">${t.warn}</td><td class="num">${t.fail}</td><td class="num">${t["n/a"]}</td></tr>`);
  }
  parts.push(`</tbody></table>`);

  // Hit targets by component, fails apart from the warn band.
  const hits = card.findings.filter((f) => f.check === "R-hit-target");
  if (hits.length) {
    const byComp = new Map<string, { band: string; component: string; pages: Set<string>; count: number; f: Finding }>();
    for (const f of hits) {
      const [band, component] = (f.group ?? `${f.severity}|${f.selector}`).split("|");
      const k = `${band}|${component}`;
      const e = byComp.get(k) ?? { band: band!, component: component ?? "", pages: new Set<string>(), count: 0, f };
      e.pages.add(f.page);
      e.count = Math.max(e.count, f.count ?? 1);
      byComp.set(k, e);
    }
    const order = ["fail", "spaced", "warn-band"];
    const rows = [...byComp.values()].sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band) || b.pages.size - a.pages.size);
    parts.push(`<h2>Hit targets by component</h2><p class="muted">fail: under 24px with a target within 12px. spaced: under 24px, no target near (warns). warn-band: 24-32px (warns). Kept findings only (the cap applies per page variant).</p><table><thead><tr><th>band</th><th>component</th><th>example</th><th class="num">most per page</th><th class="num">pages</th></tr></thead><tbody>`);
    for (const r of rows) parts.push(`<tr><td><span class="badge ${r.band === "fail" ? "fail" : "warn"}">${esc(r.band)}</span></td><td><code>${esc(r.component)}</code></td><td class="muted">${esc(r.f.measured)}</td><td class="num">${r.count}</td><td class="num">${r.pages.size}</td></tr>`);
    parts.push(`</tbody></table>`);
  }

  // Allowed findings (config motionAllow): shown, not counted.
  const allowed = card.allowed ?? [];
  if (allowed.length) {
    parts.push(`<h2>Allowed</h2><p class="muted">Matched an allowlist entry in the app config: not counted in any score.</p>`);
    const seen = new Set<string>();
    for (const a of allowed) {
      const k = `${a.check}|${a.allowed}|${a.severity}|${a.measured}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const pagesWith = [...new Set(allowed.filter((x) => `${x.check}|${x.allowed}|${x.severity}|${x.measured}` === k).map((x) => x.page))];
      parts.push(findingHtml({ f: a, also: [] }).replace("</header>", ` <span class="muted">${pagesWith.length} pages</span></header>`));
    }
  }

  // Static findings.
  const statics = card.findings.filter((f) => f.page === "*");
  if (statics.length) {
    parts.push(`<h2>Static findings</h2><p class="muted">Source checks count once in every page. Showing up to 25 per check; the scorecard counts all.</p>`);
    for (const g of grouped(statics)) parts.push(findingHtml(g));
  }

  // Per page.
  for (const p of card.pages) {
    parts.push(`<h2 id="page-${esc(p.id)}">${esc(p.id)} <span class="muted">${p.score ?? "–"}</span></h2><p class="muted"><code>${esc(p.path)}</code></p>`);
    if (p.skipped) parts.push(`<p class="muted">Skipped: ${esc(p.skipped)}</p>`);
    const notes = Object.entries(p.checks).filter(([id, c]) => c.note && ["R-hit-target", "R-state-shift", "M-layout-props"].includes(id));
    if (notes.length && !p.skipped) parts.push(`<p class="muted">${notes.map(([id, c]) => `${esc(id)}: ${esc(c.note)}`).join("<br>")}</p>`);
    if (p.errors.length) parts.push(`<p class="fail badge">errors</p><ul>${p.errors.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`);
    const cuts = Object.entries(p.checks).filter(([, c]) => c.cut > 0);
    if (cuts.length) parts.push(`<p class="muted">Cut by the cap: ${cuts.map(([id, c]) => `${esc(id)} ${c.cut}`).join(", ")}.</p>`);
    const mine = card.findings.filter((f) => f.page === p.id);
    const order = (f: Finding) => (f.severity === "fail" ? 0 : 1) * 100 + CHECKS.findIndex((c) => c.id === f.check);
    for (const g of grouped(mine).sort((a, b) => order(a.f) - order(b.f))) parts.push(findingHtml(g));
    if (!mine.length) parts.push(`<p class="muted">No runtime findings.</p>`);
    parts.push(`<details><summary>Screenshots (${p.shots.length})</summary><div class="shots">${p.shots.map((s) => `<figure><a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="" loading="lazy"></a><figcaption>${esc(s.kind)} · ${esc(s.theme)} · ${esc(s.viewport)}</figcaption></figure>`).join("")}</div></details>`);
  }
  const review = card.judge.review?.length ? `<p class="muted">For Ford (the cheap model flagged, the strong model passed): ${card.judge.review.map((r) => `${esc(r.shot)} ${esc(r.rules.join(", "))}`).join("; ")}</p>` : "";
  parts.push(`<h2>V-judge</h2><p class="muted">${esc(card.judge.note)}</p>${review}</main></body></html>`);
  const path = join(dir, "report.html");
  writeFileSync(path, parts.join("\n"));
  return path;
}

// ---------------------------------------------------------------------------

const VALUE: Record<string, number> = { pass: 1, warn: 0.5, fail: 0 };

/** A check's score across pages: mean of pass 1, warn 0.5, fail 0 over pages where it applies. */
function checkScore(card: Scorecard, id: string): number | null {
  const vals = card.pages.map((p) => p.checks[id]?.status).filter((s): s is "pass" | "warn" | "fail" => !!s && s !== "n/a").map((s) => VALUE[s]!);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 10 : null;
}

const delta = (a: number | null, b: number | null) => {
  if (a === null || b === null) return `<span class="muted">–</span>`;
  const d = Math.round((b - a) * 10) / 10;
  return d > 0 ? `<span class="up">+${d}</span>` : d < 0 ? `<span class="down">${d}</span>` : `<span class="muted">0</span>`;
};

export function writeCompare(dirA: string, dirB: string, out: string, designSystem: string): string {
  const a = JSON.parse(readFileSync(join(dirA, "scorecard.json"), "utf8")) as Scorecard;
  const b = JSON.parse(readFileSync(join(dirB, "scorecard.json"), "utf8")) as Scorecard;
  mkdirSync(dirname(out), { recursive: true });
  const base = dirname(out);
  const img = (dir: string, file: string) => relative(base, join(dir, file));
  const name = (c: Scorecard) => `${c.label ?? c.runId}`;
  const parts: string[] = [head(`design:score compare ${name(a)} vs ${name(b)}`, base, designSystem)];
  parts.push(`<h1>${esc(a.app)}: ${esc(name(a))} → ${esc(name(b))}</h1>`);
  parts.push(`<p class="muted">A: ${esc(a.runId)} (${esc(a.baseUrl)}) · B: ${esc(b.runId)} (${esc(b.baseUrl)})</p>`);
  parts.push(`<div class="score"><strong>${a.score ?? "–"} → ${b.score ?? "–"}</strong><span>${delta(a.score, b.score)}</span></div>`);

  const aa = appAreas(a.pages);
  const ba = appAreas(b.pages);
  parts.push(`<h2>Areas</h2><table><thead><tr><th>area</th><th class="num">A</th><th class="num">B</th><th class="num">delta</th></tr></thead><tbody>${AREAS.map((ar) => `<tr><td>${esc(ar)}</td><td class="num">${aa[ar] ?? "–"}</td><td class="num">${ba[ar] ?? "–"}</td><td class="num">${delta(aa[ar] ?? null, ba[ar] ?? null)}</td></tr>`).join("")}</tbody></table>`);
  parts.push(`<h2>Checks</h2><table><thead><tr><th>check</th><th class="num">A</th><th class="num">B</th><th class="num">delta</th><th class="num">A fail/warn findings</th><th class="num">B fail/warn findings</th></tr></thead><tbody>`);
  for (const c of CHECKS) {
    const sa = checkScore(a, c.id);
    const sb = checkScore(b, c.id);
    const count = (card: Scorecard) => {
      let f = 0;
      let w = 0;
      for (const p of card.pages) {
        f += p.checks[c.id]?.fails ?? 0;
        w += p.checks[c.id]?.warns ?? 0;
      }
      return `${f} / ${w}`;
    };
    parts.push(`<tr><td><strong>${esc(c.id)}</strong> <span class="muted">${esc(c.title)}</span></td><td class="num">${sa ?? "–"}</td><td class="num">${sb ?? "–"}</td><td class="num">${delta(sa, sb)}</td><td class="num">${count(a)}</td><td class="num">${count(b)}</td></tr>`);
  }
  parts.push(`</tbody></table>`);

  const ids = [...new Set([...a.pages.map((p) => p.id), ...b.pages.map((p) => p.id)])];
  parts.push(`<h2>Pages</h2><table><thead><tr><th>page</th><th class="num">A</th><th class="num">B</th><th class="num">delta</th><th>checks that changed</th></tr></thead><tbody>`);
  for (const id of ids) {
    const pa = a.pages.find((p) => p.id === id);
    const pb = b.pages.find((p) => p.id === id);
    const changed = CHECKS.filter((c) => (pa?.checks[c.id]?.status ?? "n/a") !== (pb?.checks[c.id]?.status ?? "n/a")).map((c) => `${c.id} ${pa?.checks[c.id]?.status ?? "n/a"}→${pb?.checks[c.id]?.status ?? "n/a"}`);
    parts.push(`<tr><td><a href="#cmp-${esc(id)}">${esc(id)}</a></td><td class="num">${pa?.score ?? "–"}</td><td class="num">${pb?.score ?? "–"}</td><td class="num">${delta(pa?.score ?? null, pb?.score ?? null)}</td><td class="muted">${esc(changed.join(", ") || "none")}</td></tr>`);
  }
  parts.push(`</tbody></table>`);

  for (const id of ids) {
    const pa = a.pages.find((p) => p.id === id);
    const pb = b.pages.find((p) => p.id === id);
    parts.push(`<h2 id="cmp-${esc(id)}">${esc(id)} <span class="muted">${pa?.score ?? "–"} → ${pb?.score ?? "–"}</span> ${delta(pa?.score ?? null, pb?.score ?? null)}</h2>`);
    const keys = [...new Set([...(pa?.shots ?? []), ...(pb?.shots ?? [])].filter((s) => s.kind === "state").map((s) => `${s.theme}|${s.viewport}`))];
    for (const k of keys) {
      const [theme, vp] = k.split("|");
      const sa = pa?.shots.find((s) => s.kind === "state" && s.theme === theme && s.viewport === vp);
      const sb = pb?.shots.find((s) => s.kind === "state" && s.theme === theme && s.viewport === vp);
      const fig = (dir: string, s: typeof sa, label: string) =>
        s && existsSync(join(dir, s.file)) ? `<figure><a href="${esc(img(dir, s.file))}"><img src="${esc(img(dir, s.file))}" alt="" loading="lazy"></a><figcaption>${esc(label)} · ${esc(theme)} · ${esc(vp)}</figcaption></figure>` : `<figure><figcaption>${esc(label)}: no shot</figcaption></figure>`;
      parts.push(`<div class="pair">${fig(dirA, sa, `A ${name(a)}`)}${fig(dirB, sb, `B ${name(b)}`)}</div>`);
    }
  }
  parts.push(`</main></body></html>`);
  writeFileSync(out, parts.join("\n"));
  return out;
}
