#!/usr/bin/env bun
/**
 * Before/after sheet for two shot sets of one app.
 *
 *   bun run snapshot:sheet --app <id> --a <set> --b <set> [--only <route|key>,...] [--out-dir <dir>] [--root <dir>]
 *
 * Writes <out-dir>/<app>/sheets/<a>-vs-<b>.html: per route, one row per theme with A, B and the diff
 * (changed pixels magenta inside a red box, masked pixels light blue). The page links the shot PNGs
 * relatively, so keep the run folder's layout. Next to it, <a>-vs-<b>/ holds the diff PNGs and one
 * sheet PNG per route (<route>.png), rendered by Chromium from the same markup.
 *
 * Playwright resolves from --root (default: the folder that holds this design-system checkout).
 * Exit: 2 on bad arguments or a missing set, 1 when the route PNGs could not be rendered.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { encodePng } from "./lib/png";
import { installSignalHandlers } from "./lib/app-runner";
import { loadPlaywright } from "./lib/playwright";
import { DESIGN_SYSTEM_ROOT } from "./lib/registry";
import { safeAppId, safeOutputPath, safeSegment } from "./lib/safe-paths";
import { defaultOutDir, diffSets, readManifest, SET_NAME, setDir, type SetDiff, type ShotDiff } from "./lib/snapshot-set";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const app = flag("--app");
const a = flag("--a");
const b = flag("--b");
if (!app || !a || !b || [a, b].some((set) => !SET_NAME.test(set))) {
  console.error("usage: bun run snapshot:sheet --app <id> --a <set> --b <set> [--only <route|key>,...] [--out-dir <dir>] [--root <dir>]");
  process.exit(2);
}
const root = resolve(flag("--root") ?? resolve(DESIGN_SYSTEM_ROOT, ".."));
let outDir: string;
try {
  // Shared destination check: never the owner's tree (unless --root is that tree); ids stay one path segment.
  outDir = safeOutputPath(flag("--out-dir") ?? defaultOutDir(), { root, label: "--out-dir" });
  safeAppId(app);
  safeSegment(a, "--a");
  safeSegment(b, "--b");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const only = flag("--only")?.split(",").map((value) => value.trim()).filter(Boolean);

const sheetsDir = join(outDir, app, "sheets");
const name = `${a}-vs-${b}`;
const assetsDir = join(sheetsDir, name);
// The old sheet goes first, so a failed run never leaves a stale one behind.
rmSync(assetsDir, { recursive: true, force: true });
rmSync(join(sheetsDir, `${name}.html`), { force: true });

let result: SetDiff;
try {
  result = diffSets(outDir, app, a, b, only);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
mkdirSync(assetsDir, { recursive: true });
for (const [key, diff] of result.images) writeFileSync(join(assetsDir, `${key}.diff.png`), encodePng(diff.image));

// The sheet is a report page, not app UI. Its few colors are literal on purpose: the sheet must not
// depend on the token build it is comparing.
const CSS = `
  html, body { margin: 0; background: #e2e8f0; color: #0f172a; font: 14px/1.4 ui-monospace, Menlo, monospace; }
  body { width: max-content; min-width: 100%; }
  header { padding: 16px; background: #fff; border-bottom: 1px solid #94a3b8; }
  header h1 { margin: 0 0 6px; font-size: 18px; }
  header p { margin: 2px 0; color: #334155; }
  header p.problem { color: #9d174d; font-weight: 600; }
  section { padding: 12px 16px 4px; }
  h2 { margin: 8px 0; font-size: 16px; }
  .row { display: flex; gap: 12px; align-items: flex-start; width: max-content; margin-bottom: 12px; }
  .panel { background: #fff; border: 1px solid #94a3b8; }
  .label { padding: 6px 10px; color: #fff; background: #334155; font-weight: 600; }
  .label.ok { background: #166534; }
  .label.bad { background: #9d174d; }
  .label.soft { background: #92400e; }
  .frame { position: relative; line-height: 0; }
  .frame img { display: block; }
  .box { position: absolute; border: 2px solid #dc2626; box-sizing: border-box; pointer-events: none; }
  .missing { width: 480px; height: 160px; display: flex; align-items: center; justify-content: center; color: #475569; }
`;

const escape = (text: string) => text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function verdict(shot: ShotDiff): { text: string; tone: string } {
  const tone = shot.gating ? "bad" : "soft";
  const gate = shot.gating ? "" : ` (non-gating: ${shot.reason ?? "no reason"})`;
  const problems = shot.problems.length ? `; ${shot.problems.join("; ")}` : "";
  if (shot.status === "identical")
    return {
      text: `diff: identical${shot.maskedPixels ? ` (${shot.maskedPixels.toLocaleString("en-US")} px masked)` : ""}${problems}${problems ? gate : ""}`,
      tone: problems ? tone : "ok",
    };
  if (shot.status === "changed")
    return {
      text: `diff: ${shot.changedPixels.toLocaleString("en-US")} px changed (${shot.percentChanged}%)${shot.sizeMatch ? "" : ", SIZE MISMATCH"}${problems}${gate}`,
      tone,
    };
  return { text: `diff: ${shot.status}${problems}${gate}`, tone };
}

/** Image paths relative to the page that shows them (`fromDir`). */
function rowHtml(shot: ShotDiff, rel: { a: string; b: string; diff: string }): string {
  const { text, tone } = verdict(shot);
  const panel = (label: string, labelTone: string, src: string | null, box?: ShotDiff["bbox"]) =>
    `<div class="panel"><div class="label ${labelTone}">${escape(label)}</div>${
      src
        ? `<div class="frame"><img src="${escape(src)}">${
            box ? `<div class="box" style="left:${box.x - 3}px;top:${box.y - 3}px;width:${box.width + 6}px;height:${box.height + 6}px"></div>` : ""
          }</div>`
        : `<div class="missing">no image</div>`
    }</div>`;
  return `<div class="row">${[
    panel(`A: ${a} / ${shot.key}`, "", shot.status === "missing-in-a" ? null : `${rel.a}/${shot.key}.png`),
    panel(`B: ${b} / ${shot.key}`, "", shot.status === "missing-in-b" ? null : `${rel.b}/${shot.key}.png`),
    panel(text, tone, result.images.has(shot.key) ? `${rel.diff}/${shot.key}.diff.png` : null, shot.bbox),
  ].join("")}</div>`;
}

function describeSet(set: string): string {
  const manifest = readManifest(setDir(outDir, app!, set)) as Record<string, any> | null;
  if (!manifest) return `${escape(set)}: no manifest`;
  const ds = manifest.designSystem?.rendered;
  return `${escape(set)}: captured ${escape(String(manifest.finishedAt ?? "?"))}, design-system ${escape(String(ds?.head ?? "?").slice(0, 10))} (tokens.css ${escape(String(ds?.tokensCssSha256 ?? "?").slice(0, 12))}), app ${escape(String(manifest.appRepo?.head ?? "?").slice(0, 10))}${manifest.appRepo?.status?.length ? ` + ${manifest.appRepo.status.length} uncommitted` : ""}`;
}

const routes = [...new Set(result.shots.map((shot) => shot.route))];
function page(title: string, sections: string[]): string {
  const { totals } = result;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>${CSS}</style></head><body>
<header><h1>${escape(title)}</h1>
<p>${describeSet(a!)}</p><p>${describeSet(b!)}</p>
<p>${totals.identical}/${totals.shots} identical, ${totals.changed} changed, ${totals.missing} missing, ${totals.gatingFailures} gating failure(s). Exact RGBA outside masks.</p>
${result.problems.map((problem) => `<p class="problem">set problem: ${escape(problem)}</p>`).join("")}${result.warnings.map((warning) => `<p>warning: ${escape(warning)}</p>`).join("")}</header>
${sections.join("\n")}
</body></html>`;
}
const section = (route: string, rel: { a: string; b: string; diff: string }) =>
  `<section><h2>${escape(route)}</h2>${result.shots
    .filter((shot) => shot.route === route)
    .map((shot) => rowHtml(shot, rel))
    .join("")}</section>`;

// The overview page lives in sheets/; the per-route pages in sheets/<name>/.
const htmlPath = join(sheetsDir, `${name}.html`);
writeFileSync(htmlPath, page(`${app}: ${a} vs ${b}`, routes.map((route) => section(route, { a: `../shots/${a}`, b: `../shots/${b}`, diff: name }))));
console.log(`sheet: ${htmlPath}`);

let renderError: string | undefined;
try {
  const { chromium } = loadPlaywright(root);
  const browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  installSignalHandlers(() => browser.close());
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
    const tab = await context.newPage();
    for (const route of routes) {
      const routeHtml = join(assetsDir, `${route}.html`);
      writeFileSync(routeHtml, page(`${app} / ${route}: ${a} vs ${b}`, [section(route, { a: `../../shots/${a}`, b: `../../shots/${b}`, diff: "." })]));
      await tab.goto(pathToFileURL(routeHtml).href, { waitUntil: "load" });
      await tab.evaluate(() => Promise.all(Array.from((globalThis as any).document.images as any[]).map((img: any) => img.decode().catch(() => undefined))));
      await tab.screenshot({ path: join(assetsDir, `${route}.png`), fullPage: true, animations: "disabled" });
      rmSync(routeHtml);
      console.log(`  ${join(assetsDir, `${route}.png`)}`);
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  renderError = error instanceof Error ? error.message.split("\n")[0] : String(error);
  console.error(`route PNGs not rendered: ${renderError}`);
}
process.exit(renderError ? 1 : 0);
