#!/usr/bin/env bun
/**
 * Pixel-diff two shot sets.
 *
 *   bun diff.ts --a before --b after [--no-compare]
 *
 * Writes (folders resolved against this harness folder):
 *   diff-<a>-vs-<b>/report.json   per shot: size match, changed pixel count, % changed,
 *                                 max channel delta, bounding box of the change
 *   diff-<a>-vs-<b>/<key>.png     B faded to light gray; every changed pixel solid magenta
 *   compare-<a>-vs-<b>/<key>.png  A | B | diff side by side, labelled (for people)
 *
 * Pixels compare EXACTLY (any RGBA channel differs => changed). PNGs are
 * decoded by lib/png.ts (zlib + unfiltering), not a canvas, so color
 * management can never hide or invent a difference. Exit code: 0 when every
 * shot is identical, 1 otherwise.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_DIR, loadPlaywright } from "./lib/env";
import { decodePng, encodePng, type RgbaImage } from "./lib/png";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const a = flag("--a");
const b = flag("--b");
if (!a || !b) {
  console.error("usage: bun diff.ts --a <set> --b <set> [--only <id|key>,...] [--no-compare]");
  process.exit(2);
}
// Same selector as snapshot.ts --only: a shot id matches both of its theme keys.
const onlyArg = flag("--only");
const only = onlyArg ? onlyArg.split(",").map((value) => value.trim()).filter(Boolean) : undefined;
const selected = (key: string) => !only || only.some((wanted) => key === wanted || key === `${wanted}-light` || key === `${wanted}-dark`);
const writeCompare = !process.argv.includes("--no-compare");
const dirA = join(HARNESS_DIR, a);
const dirB = join(HARNESS_DIR, b);
for (const dir of [dirA, dirB]) {
  if (!existsSync(dir)) {
    console.error(`No such shot set: ${dir}`);
    process.exit(2);
  }
}
const diffDir = join(HARNESS_DIR, `diff-${a}-vs-${b}`);
const compareDir = join(HARNESS_DIR, `compare-${a}-vs-${b}`);
rmSync(diffDir, { recursive: true, force: true });
mkdirSync(diffDir, { recursive: true });
if (writeCompare) {
  rmSync(compareDir, { recursive: true, force: true });
  mkdirSync(compareDir, { recursive: true });
}

const pngs = (dir: string) =>
  new Set(readdirSync(dir).filter((name) => name.endsWith(".png")).map((name) => name.slice(0, -4)).filter(selected));
const keysA = pngs(dirA);
const keysB = pngs(dirB);
const keys = [...new Set([...keysA, ...keysB])].sort();

interface ShotReport {
  key: string;
  status: "identical" | "changed" | "missing-in-a" | "missing-in-b";
  sizeMatch: boolean;
  sizeA?: [number, number];
  sizeB?: [number, number];
  changedPixels: number;
  totalPixels: number;
  percentChanged: number;
  maxChannelDelta: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

const MAGENTA = [255, 0, 255, 255] as const;

function diffImages(imageA: RgbaImage, imageB: RgbaImage) {
  const width = Math.max(imageA.width, imageB.width);
  const height = Math.max(imageA.height, imageB.height);
  const out = new Uint8Array(width * height * 4);
  let changed = 0;
  let maxDelta = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inA = x < imageA.width && y < imageA.height;
      const inB = x < imageB.width && y < imageB.height;
      let differs = !(inA && inB);
      if (inA && inB) {
        const ia = (y * imageA.width + x) * 4;
        const ib = (y * imageB.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          const delta = Math.abs(imageA.data[ia + c]! - imageB.data[ib + c]!);
          if (delta > 0) {
            differs = true;
            if (delta > maxDelta) maxDelta = delta;
          }
        }
      }
      if (differs) {
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        out.set(MAGENTA, o);
      } else {
        // Unchanged: B in gray, faded toward white so magenta stands out.
        const ib = (y * imageB.width + x) * 4;
        const gray = 0.299 * imageB.data[ib]! + 0.587 * imageB.data[ib + 1]! + 0.114 * imageB.data[ib + 2]!;
        const faded = Math.round(255 - (255 - gray) * 0.25);
        out[o] = out[o + 1] = out[o + 2] = faded;
        out[o + 3] = 255;
      }
    }
  }
  return {
    image: { width, height, data: out } as RgbaImage,
    changed,
    total: width * height,
    maxDelta: maxDelta || (changed > 0 ? 255 : 0),
    bbox: changed > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined,
  };
}

const reports: ShotReport[] = [];
const diffPngs = new Map<string, Uint8Array>();
for (const key of keys) {
  if (!keysA.has(key) || !keysB.has(key)) {
    reports.push({
      key,
      status: keysA.has(key) ? "missing-in-b" : "missing-in-a",
      sizeMatch: false,
      changedPixels: 0,
      totalPixels: 0,
      percentChanged: 100,
      maxChannelDelta: 0,
    });
    continue;
  }
  const imageA = decodePng(readFileSync(join(dirA, `${key}.png`)));
  const imageB = decodePng(readFileSync(join(dirB, `${key}.png`)));
  const result = diffImages(imageA, imageB);
  const png = encodePng(result.image);
  writeFileSync(join(diffDir, `${key}.png`), png);
  diffPngs.set(key, png);
  reports.push({
    key,
    status: result.changed === 0 ? "identical" : "changed",
    sizeMatch: imageA.width === imageB.width && imageA.height === imageB.height,
    sizeA: [imageA.width, imageA.height],
    sizeB: [imageB.width, imageB.height],
    changedPixels: result.changed,
    totalPixels: result.total,
    percentChanged: Number(((result.changed / result.total) * 100).toFixed(4)),
    maxChannelDelta: result.maxDelta,
    ...(result.bbox ? { bbox: result.bbox } : {}),
  });
}

const totals = {
  shots: reports.length,
  identical: reports.filter((report) => report.status === "identical").length,
  changed: reports.filter((report) => report.status === "changed").length,
  missing: reports.filter((report) => report.status.startsWith("missing")).length,
  sizeMismatch: reports.filter((report) => report.status === "changed" && !report.sizeMatch).length,
  changedPixels: reports.reduce((sum, report) => sum + report.changedPixels, 0),
};
writeFileSync(
  join(diffDir, "report.json"),
  `${JSON.stringify({ a, b, generatedAt: new Date().toISOString(), comparison: "exact RGBA", totals, shots: reports }, null, 2)}\n`,
);

// -- side-by-side compare images (rendered by Chromium for the labels) --------
// The compare page is a throwaway report image, not app UI. Its few colors are
// literal on purpose: the verifier must not depend on the token build it is
// verifying.
if (writeCompare) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    const escape = (text: string) => text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    for (const report of reports) {
      const panels: { label: string; tone: string; src: string | null; box?: ShotReport["bbox"] }[] = [
        { label: `A: ${a}`, tone: "#334155", src: keysA.has(report.key) ? dataUrl(readFileSync(join(dirA, `${report.key}.png`))) : null },
        { label: `B: ${b}`, tone: "#334155", src: keysB.has(report.key) ? dataUrl(readFileSync(join(dirB, `${report.key}.png`))) : null },
        {
          label:
            report.status === "identical"
              ? "diff: identical (0 px)"
              : report.status === "changed"
                ? `diff: ${report.changedPixels.toLocaleString("en-US")} px changed (${report.percentChanged}%)${report.sizeMatch ? "" : " SIZE MISMATCH"}`
                : `diff: ${report.status}`,
          tone: report.status === "identical" ? "#166534" : "#9d174d",
          src: diffPngs.has(report.key) ? dataUrl(diffPngs.get(report.key)!) : null,
          box: report.bbox,
        },
      ];
      const html = `<!doctype html><html><head><style>
        html,body{margin:0;background:#e2e8f0;font:600 15px/1.2 ui-monospace,Menlo,monospace}
        .row{display:flex;gap:12px;padding:12px;align-items:flex-start;width:max-content}
        .panel{background:#fff;border:1px solid #94a3b8}
        .label{padding:8px 10px;color:#fff}
        .frame{position:relative;line-height:0}
        .box{position:absolute;border:2px solid #dc2626;box-sizing:border-box;pointer-events:none}
        .missing{width:720px;height:200px;display:flex;align-items:center;justify-content:center;color:#475569;line-height:1.2}
        .title{padding:12px 12px 0;color:#0f172a;font-size:16px}
      </style></head><body>
        <div class="title">${escape(report.key)}</div>
        <div class="row">${panels
          .map(
            (panel) => `<div class="panel"><div class="label" style="background:${panel.tone}">${escape(panel.label)}</div>${
              panel.src
                ? `<div class="frame"><img src="${panel.src}">${
                    panel.box
                      ? `<div class="box" style="left:${panel.box.x - 3}px;top:${panel.box.y - 3}px;width:${panel.box.width + 6}px;height:${panel.box.height + 6}px"></div>`
                      : ""
                  }</div>`
                : `<div class="missing">no image</div>`
            }</div>`,
          )
          .join("")}</div></body></html>`;
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => Promise.all(Array.from(document.images).map((img) => img.decode())));
      await page.screenshot({ path: join(compareDir, `${report.key}.png`), fullPage: true, animations: "disabled" });
    }
  } finally {
    await browser.close();
  }
}

for (const report of reports) {
  const detail =
    report.status === "identical"
      ? "identical"
      : report.status === "changed"
        ? `${report.changedPixels} px (${report.percentChanged}%)${report.sizeMatch ? "" : ", size mismatch"}`
        : report.status;
  console.log(`${report.status === "identical" ? "  ok  " : "  DIFF"}  ${report.key}  ${detail}`);
}
console.log(
  `\n${totals.identical}/${totals.shots} identical, ${totals.changed} changed, ${totals.missing} missing -> ${join(diffDir, "report.json")}`,
);
process.exit(totals.identical === totals.shots ? 0 : 1);
