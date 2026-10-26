#!/usr/bin/env bun
/**
 * Exact pixel diff of two shot sets of one app, judged against the current registry entry.
 *
 *   bun run snapshot:diff --app <id> --a <set> --b <set> [--exact] [--only <route|key>,...] [--out-dir <dir>]
 *                         [--registry <apps.json>] [--root <dir>]
 *
 * The expected shots, gating, reasons, darkDiffers and mask selectors come from apps.json (default the
 * checkout's own; --registry another, which must pass the registry checks), never from a manifest.
 * B must show the tree being gated: its shots' app HEAD, uncommitted app content and design-system
 * dist/css/fonts are compared with the tree at --root now (default: the root B was captured from), and a
 * shot the tree no longer matches fails --exact ("recapture B"). A is a historical baseline: not checked.
 *
 * Writes <out-dir>/<app>/diffs/<a>-vs-<b>/ (the old folder is removed first, so a failed run never
 * leaves a stale report behind):
 *   report.json          per shot: status, gating, size match, changed pixels outside masks, masked
 *                        pixels, % changed, max channel delta, bounding box of the change, problems;
 *                        per set: problems and warnings; the registry it was judged against
 *   <key>.png            B faded to gray; changed pixels magenta, masked pixels light blue
 *   compare/<key>.png    A | B | diff side by side
 * --out-dir is never the owner's tree or a git checkout, and no write under it goes through a symlink.
 *
 * Without --exact the summary counts changed gating shots as "changed (expected without --exact)" and names
 * only the other gating problems; report.json is the same either way.
 *
 * Exit: 2 on bad arguments (same set twice, an --only id that names no registry route or shot, a missing
 * set, an invalid registry, an unsafe output path). With --exact, 1 when the gate fails
 * (scripts/lib/snapshot-set.ts: a gating shot changed, missing, failed, unstable or unlisted; mask boxes
 * differ or were never recorded; a partial set without --only; mixed provenance; an incomplete set, a
 * set captured with another capture spec, a run that broke isolation; no shot compared); otherwise 0.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateLoadedRegistry } from "./lib/app-runner";
import { toolOutputDir } from "./lib/output-dir";
import { decodePng, encodePng } from "./lib/png";
import { changedGitEntries, treeState } from "./lib/provenance";
import { getApp, loadRegistry, REGISTRY_PATH, type AppEntry, workspaceRoot } from "./lib/registry";
import { safeAppId, safeSegment } from "./lib/safe-paths";
import { defaultOutDir, diffPath, diffSets, readManifest, SET_NAME, setPath, sha256Hex, sideBySide } from "./lib/snapshot-set";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The value, or exit 2 with the error's message. */
function orFail<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

const app = flag("--app");
const a = flag("--a");
const b = flag("--b");
const exact = process.argv.includes("--exact");
if (!app || !a || !b || [a, b].some((set) => !SET_NAME.test(set))) {
  console.error("usage: bun run snapshot:diff --app <id> --a <set> --b <set> [--exact] [--only <route|key>,...] [--out-dir <dir>] [--registry <apps.json>] [--root <dir>]");
  process.exit(2);
}
// Shared destination check: never the owner's tree or a git checkout; app id and set names stay one path segment.
const outDir = orFail(() => {
  safeAppId(app);
  safeSegment(a, "--a");
  safeSegment(b, "--b");
  return toolOutputDir(flag("--out-dir") ?? defaultOutDir(), { label: "--out-dir" });
});
const registryPath = resolve(flag("--registry") ?? REGISTRY_PATH);
const entry: AppEntry = orFail(() => getApp(validateLoadedRegistry(loadRegistry(registryPath), registryPath), app));
const registry = { path: registryPath, sha256: sha256Hex(readFileSync(registryPath)) };
const only = flag("--only")?.split(",").map((value) => value.trim()).filter(Boolean);

const out = (...file: string[]) => diffPath(outDir, app, a, b, ...file);
const diffDir = orFail(() => out());
rmSync(diffDir, { recursive: true, force: true });

// The tree being gated: --root, else the root B was captured from, else the folder that holds this checkout.
const bManifest = orFail(() => readManifest(setPath(outDir, app, b)));
const bRoot = bManifest?.root;
const root = resolve(flag("--root") ?? (typeof bRoot === "string" ? bRoot : workspaceRoot()));
// git reads the tree through pins (git.ts): never a repository whose `.git` entry changed since B's capture.
const changedRepos = changedGitEntries(bManifest?.git);
if (changedRepos.length) {
  console.error(`snapshot:diff: ${changedRepos.join("; ")}`);
  process.exit(2);
}
const tree = { root, state: orFail(() => treeState(root, entry)) };
const result = orFail(() => diffSets(outDir, entry, a, b, only, registry, tree));

orFail(() => {
  mkdirSync(out("compare"), { recursive: true });
  for (const shot of result.shots) {
    const diff = result.images.get(shot.key);
    if (!diff) continue;
    writeFileSync(out(`${shot.key}.png`), encodePng(diff.image));
    const imageA = decodePng(readFileSync(setPath(outDir, app, a, `${shot.key}.png`)));
    const imageB = decodePng(readFileSync(setPath(outDir, app, b, `${shot.key}.png`)));
    writeFileSync(out("compare", `${shot.key}.png`), encodePng(sideBySide([imageA, imageB, diff.image])));
  }
  const { images: _images, ...report } = result;
  writeFileSync(out("report.json"), `${JSON.stringify({ ...report, exact }, null, 2)}\n`);
});

for (const shot of result.shots) {
  const detail =
    shot.status === "identical"
      ? `identical${shot.maskedPixels ? ` (${shot.maskedPixels} px masked)` : ""}`
      : shot.status === "changed"
        ? `${shot.changedPixels} px (${shot.percentChanged}%)${shot.sizeMatch ? "" : ", size mismatch"}`
        : `${shot.status}${shot.error ? `: ${shot.error.split("\n")[0]}` : ""}`;
  const mark = shot.status === "identical" ? "  ok  " : shot.gating ? "  DIFF" : "  diff";
  const bad = shot.status === "identical" && shot.problems.length ? (shot.gating ? "  FAIL" : "  warn") : mark;
  console.log(`${bad}  ${shot.key}  ${detail}${shot.gating ? "" : `  (non-gating: ${shot.reason ?? "no reason"})`}`);
  for (const problem of shot.problems) console.log(`          problem: ${problem}`);
}
for (const problem of result.problems) console.log(`  FAIL  set: ${problem}`);
for (const warning of result.warnings) console.log(`  warn  ${warning}`);
if (!result.registry.canonical) console.log(`  warn  judged against ${result.registry.path}, not the checkout's apps.json (${REGISTRY_PATH})`);
const { totals } = result;
// Without --exact a changed pixel is what a migration pass expects: count it as changed, and call only what
// --exact would fail on besides the changes (missing, failed, unstable, mask problems) a gating problem.
const changedOnly = result.shots.filter((shot) => shot.gating && shot.status === "changed" && shot.problems.length === 0).length;
const verdict = exact
  ? `${totals.changed} changed, ${totals.missing} missing, ${totals.gatingFailures} gating failure(s)`
  : `${totals.changed} changed (expected without --exact), ${totals.missing} missing, ${totals.gatingFailures - changedOnly} gating problem(s)`;
console.log(`\n${totals.identical}/${totals.shots} identical, ${verdict}, ${result.problems.length} set problem(s) -> ${out("report.json")}`);
if (exact && !result.ok) {
  if (totals.shots === 0) console.error("--exact: no shots compared");
  process.exit(1);
}
