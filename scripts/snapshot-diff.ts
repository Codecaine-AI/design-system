#!/usr/bin/env bun
/**
 * Exact pixel diff of two shot sets of one app.
 *
 *   bun run snapshot:diff --app <id> --a <set> --b <set> [--exact] [--only <route|key>,...] [--out-dir <dir>]
 *
 * Writes <out-dir>/<app>/diffs/<a>-vs-<b>/:
 *   report.json          per shot: status, gating, size match, changed pixels outside masks, masked
 *                        pixels, % changed, max channel delta, bounding box of the change
 *   <key>.png            B faded to gray; changed pixels magenta, masked pixels light blue
 *   compare/<key>.png    A | B | diff side by side
 *
 * Exit: 2 on bad arguments or a missing set. With --exact, 1 when any gating shot has a changed pixel
 * outside its masks, is missing from either set, or no shot compared; otherwise 0.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodePng, encodePng } from "./lib/png";
import { defaultOutDir, diffSets, SET_NAME, setDir, sideBySide } from "./lib/snapshot-set";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const app = flag("--app");
const a = flag("--a");
const b = flag("--b");
const exact = process.argv.includes("--exact");
if (!app || !a || !b || [a, b].some((set) => !SET_NAME.test(set))) {
  console.error("usage: bun run snapshot:diff --app <id> --a <set> --b <set> [--exact] [--only <route|key>,...] [--out-dir <dir>]");
  process.exit(2);
}
const outDir = resolve(flag("--out-dir") ?? defaultOutDir());
const only = flag("--only")?.split(",").map((value) => value.trim()).filter(Boolean);

let result: ReturnType<typeof diffSets>;
try {
  result = diffSets(outDir, app, a, b, only);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const diffDir = join(outDir, app, "diffs", `${a}-vs-${b}`);
rmSync(diffDir, { recursive: true, force: true });
mkdirSync(join(diffDir, "compare"), { recursive: true });
for (const shot of result.shots) {
  const diff = result.images.get(shot.key);
  if (!diff) continue;
  writeFileSync(join(diffDir, `${shot.key}.png`), encodePng(diff.image));
  const imageA = decodePng(readFileSync(join(setDir(outDir, app, a), `${shot.key}.png`)));
  const imageB = decodePng(readFileSync(join(setDir(outDir, app, b), `${shot.key}.png`)));
  writeFileSync(join(diffDir, "compare", `${shot.key}.png`), encodePng(sideBySide([imageA, imageB, diff.image])));
}
const { images: _images, ...report } = result;
writeFileSync(join(diffDir, "report.json"), `${JSON.stringify({ ...report, exact }, null, 2)}\n`);

for (const shot of result.shots) {
  const detail =
    shot.status === "identical"
      ? `identical${shot.maskedPixels ? ` (${shot.maskedPixels} px masked)` : ""}`
      : shot.status === "changed"
        ? `${shot.changedPixels} px (${shot.percentChanged}%)${shot.sizeMatch ? "" : ", size mismatch"}`
        : `${shot.status}${shot.error ? `: ${shot.error.split("\n")[0]}` : ""}`;
  const mark = shot.status === "identical" ? "  ok  " : shot.gating ? "  DIFF" : "  diff";
  console.log(`${mark}  ${shot.key}  ${detail}${shot.gating ? "" : `  (non-gating: ${shot.reason ?? "no reason"})`}`);
}
const { totals } = result;
console.log(
  `\n${totals.identical}/${totals.shots} identical, ${totals.changed} changed, ${totals.missing} missing, ` +
    `${totals.gatingFailures} gating failure(s) -> ${join(diffDir, "report.json")}`,
);
if (exact && !result.ok) {
  if (totals.shots === 0) console.error("--exact: no shots compared");
  process.exit(1);
}
