/**
 * snapshot:diff --exact is the pixel gate: it must fail on any changed pixel outside the route's masks,
 * a missing shot, or a shot whose capture failed (in either set) on a gating route, and pass when the
 * change is masked or the route is non-gating. It must also refuse comparisons that prove nothing:
 * the same set twice, an --only id that names nothing, a shot the registry expects but neither set
 * holds, a partial set compared without --only, shots of one set captured from different trees, a
 * shot that never settled, a PNG the manifest does not list, a size change hidden under a mask, mask
 * boxes that differ between the sets, and a dark shot equal to light on a route that must differ.
 * Runs the CLI on synthetic sets in a temp out-dir.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "../scripts/lib/png.ts";
import type { ShotProvenance } from "../scripts/lib/snapshot-set.ts";

const scratch = mkdtempSync(join(tmpdir(), "ds-diff-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const W = 40;
const H = 30;
/** Mask over the top-left 10x10 corner in every shot. */
const MASK = { selector: ".clock", boxes: [{ x: 0, y: 0, width: 10, height: 10 }] };

function png(changes: Array<[number, number]> = [], width = W, height = H, fill = 255): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(fill);
  for (const [x, y] of changes) data.set([255, 0, 0, 255], (y * width + x) * 4);
  return encodePng({ width, height, data });
}

const PROVENANCE: ShotProvenance = {
  appHead: "a".repeat(40),
  appStatusSha256: "0".repeat(64),
  appDirty: 0,
  designSystemHead: "d".repeat(40),
  tokensCssSha256: "t".repeat(64),
  capturedAt: "2026-10-05T12:00:00.000Z",
};

interface Shot {
  key: string;
  gating?: boolean;
  png: Uint8Array | null;
  /** The capture failed: the manifest records this error (and the set has no PNG for the shot). */
  error?: string;
  /** The capture failed in set A instead. */
  errorInA?: string;
  stable?: boolean;
  masks?: typeof MASK[];
  provenance?: Partial<ShotProvenance>;
  /** The PNG is on disk, but the manifest does not list the shot. */
  unlisted?: boolean;
  darkDiffers?: boolean;
}

interface SetOptions {
  /** expectedKeys; default every shot's key. null leaves the field out (an older manifest). */
  expected?: string[] | null;
  only?: string[] | null;
}

function writeSet(outDir: string, set: string, shots: Shot[], opts: SetOptions = {}) {
  const dir = join(outDir, "demo", "shots", set);
  mkdirSync(dir, { recursive: true });
  for (const shot of shots) if (shot.png) writeFileSync(join(dir, `${shot.key}.png`), shot.png);
  const expected = opts.expected === undefined ? shots.map((shot) => shot.key) : opts.expected;
  const manifest = {
    app: "demo",
    set,
    ...(expected ? { expectedKeys: expected } : {}),
    only: opts.only ?? null,
    shots: shots
      .filter((shot) => !shot.unlisted)
      .map((shot) => ({
        key: shot.key,
        route: shot.key.replace(/-(light|dark)$/, ""),
        theme: shot.key.endsWith("-dark") ? "dark" : "light",
        gating: shot.gating ?? true,
        ...(shot.gating === false ? { reason: "live clock" } : {}),
        ...(shot.darkDiffers ? { darkDiffers: true } : {}),
        ...(shot.error ? { error: shot.error } : { stable: shot.stable ?? true, provenance: { ...PROVENANCE, ...shot.provenance } }),
        masks: shot.masks ?? [MASK],
      })),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

function cli(outDir: string, args: string[]) {
  const result = Bun.spawnSync(["bun", "scripts/snapshot-diff.ts", "--app", "demo", "--exact", "--out-dir", outDir, ...args], { cwd: join(import.meta.dir, "..") });
  const reportPath = join(outDir, "demo", "diffs", `${args[args.indexOf("--a") + 1]}-vs-${args[args.indexOf("--b") + 1]}`, "report.json");
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null };
}

/** A: a clean capture of every key of `b` (or `a` when given); B: `b`. */
function runDiff(b: Shot[], opts: { a?: Shot[]; setA?: SetOptions; setB?: SetOptions; args?: string[] } = {}) {
  const outDir = mkdtempSync(join(scratch, "out-"));
  const a = opts.a ?? b.map((shot) => (shot.errorInA ? { ...shot, png: null, error: shot.errorInA } : { key: shot.key, gating: shot.gating, png: png(), darkDiffers: shot.darkDiffers }));
  writeSet(outDir, "a", a, opts.setA);
  writeSet(outDir, "b", b, opts.setB);
  return cli(outDir, ["--a", "a", "--b", "b", ...(opts.args ?? [])]);
}

test.each([
  ["identical sets pass", [{ key: "home-light", png: png() }], 0],
  ["a change inside a mask passes", [{ key: "home-light", png: png([[3, 4]]) }], 0],
  ["a change outside the masks fails", [{ key: "home-light", png: png([[20, 15]]) }], 1],
  ["a change on a non-gating route passes", [{ key: "clock-light", gating: false, png: png([[20, 15]]) }], 0],
  ["a shot missing from B fails", [{ key: "home-light", png: png() }, { key: "home-dark", png: null }], 1],
  ["a shot whose capture failed in B fails", [{ key: "home-light", png: png() }, { key: "home-dark", png: null, error: "waitFor: Timeout" }], 1],
  [
    "a shot whose capture failed in both sets fails",
    [{ key: "home-light", png: png() }, { key: "home-dark", png: null, error: "Timeout", errorInA: "Timeout" }],
    1,
  ],
  ["a gating shot that never settled fails, even with identical pixels", [{ key: "home-light", png: png(), stable: false }], 1],
  ["an unsettled shot on a non-gating route passes", [{ key: "clock-light", gating: false, png: png(), stable: false }], 0],
  ["a PNG the manifest does not list fails", [{ key: "home-light", png: png() }, { key: "stray-light", png: png(), unlisted: true }], 1],
  ["a size change fails even where a mask covers it", [{ key: "home-light", png: png([], W, H + 5), masks: [{ selector: ".page", boxes: [{ x: 0, y: 0, width: W, height: H + 5 }] }] }], 1],
  ["mask boxes that differ between A and B fail", [{ key: "home-light", png: png([[25, 20]]), masks: [MASK, { selector: ".toast", boxes: [{ x: 20, y: 15, width: 10, height: 10 }] }] }], 1],
] as Array<[string, Shot[], number]>)("--exact: %s", (_, shots, exitCode) => {
  expect(runDiff(shots).exitCode).toBe(exitCode);
});

test("the report counts changed pixels outside masks and boxes them", () => {
  const { report } = runDiff([{ key: "home-light", png: png([[3, 4], [20, 15], [25, 18]]) }]);
  expect(report.shots[0]).toMatchObject({
    status: "changed",
    changedPixels: 2,
    maskedPixels: 100,
    bbox: { x: 20, y: 15, width: 6, height: 4 },
  });
});

test("a size change counts every pixel outside the smaller image, masked or not", () => {
  const masks = [{ selector: ".page", boxes: [{ x: 0, y: 0, width: W, height: H + 5 }] }];
  const { report } = runDiff([{ key: "home-light", png: png([], W, H + 5), masks }], { a: [{ key: "home-light", png: png(), masks }] });
  expect(report.shots[0]).toMatchObject({ status: "changed", sizeMatch: false, changedPixels: W * 5, maskedPixels: W * H });
});

test("the same set twice and an --only id that names nothing exit 2", () => {
  const outDir = mkdtempSync(join(scratch, "out-"));
  writeSet(outDir, "a", [{ key: "home-light", png: png() }]);
  writeSet(outDir, "b", [{ key: "home-light", png: png() }]);
  expect(cli(outDir, ["--a", "a", "--b", "a"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("the same set") });
  expect(cli(outDir, ["--a", "a", "--b", "b", "--only", "home,hom"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("--only names no route or shot of demo in a or b: hom") });
});

test("a failed diff removes the old report first, so no stale result stays behind", () => {
  const outDir = mkdtempSync(join(scratch, "out-"));
  writeSet(outDir, "a", [{ key: "home-light", png: png() }]);
  writeSet(outDir, "b", [{ key: "home-light", png: png() }]);
  expect(cli(outDir, ["--a", "a", "--b", "b"]).report.ok).toBe(true);
  rmSync(join(outDir, "demo", "shots", "b"), { recursive: true });
  expect(cli(outDir, ["--a", "a", "--b", "b"])).toMatchObject({ exitCode: 2, report: null });
});

test("a shot the registry expects but neither set holds fails, and so does a manifest without expectedKeys", () => {
  const shots = [{ key: "home-light", png: png() }];
  const expected = { expected: ["home-light", "home-dark"] };
  const missing = runDiff(shots, { setA: expected, setB: expected });
  expect(missing.exitCode).toBe(1);
  expect(missing.report.shots.find((s: any) => s.key === "home-dark")).toMatchObject({ status: "missing-in-b", problems: ["missing in both sets"] });
  const old = runDiff(shots, { setB: { expected: null } });
  expect([old.exitCode, old.report.problems]).toEqual([1, [expect.stringContaining("the manifest has no expectedKeys")]]);
});

test("a partial set passes only with a matching --only", () => {
  const shots = [{ key: "home-light", png: png() }];
  const opts = { setA: { expected: ["home-light", "edit-light"] }, setB: { expected: ["home-light", "edit-light"], only: ["home"] } };
  const whole = runDiff(shots, opts);
  expect([whole.exitCode, whole.report.problems]).toEqual([1, [expect.stringContaining("is a partial set (captured with --only home)")]]);
  expect(runDiff(shots, { ...opts, args: ["--only", "home"] }).exitCode).toBe(0);
  // --only edit selects a shot the partial set does not hold.
  expect(runDiff(shots, { ...opts, args: ["--only", "edit"] }).exitCode).toBe(1);
});

test("shots of one set captured from different trees fail (an --only --force merge)", () => {
  const result = runDiff([
    { key: "home-light", png: png() },
    { key: "edit-light", png: png(), provenance: { appHead: "b".repeat(40), capturedAt: "2026-10-06T08:00:00.000Z" } },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.report.problems).toEqual([expect.stringMatching(/^B \(b\) mixes captures of different trees: app bbbbbbbbbbbb.*: edit-light \| app aaaaaaaaaaaa.*: home-light$/)]);
  // Only the time differs: one tree.
  expect(runDiff([{ key: "home-light", png: png() }, { key: "edit-light", png: png(), provenance: { capturedAt: "2026-10-06T08:00:00.000Z" } }]).exitCode).toBe(0);
});

test("a dark shot identical to light fails in B when the route sets darkDiffers, and is a warning otherwise", () => {
  const same = (darkDiffers: boolean): Shot[] => [
    { key: "home-light", png: png(), darkDiffers },
    { key: "home-dark", png: png(), darkDiffers },
  ];
  const strict = runDiff(same(true));
  expect(strict.exitCode).toBe(1);
  expect(strict.report.shots.find((s: any) => s.key === "home-dark").problems).toEqual(["B (b): home-dark is byte-identical to home-light, but the route sets darkDiffers"]);
  const loose = runDiff(same(false));
  expect(loose.exitCode).toBe(0);
  expect(loose.report.warnings).toEqual(["home-dark: A (a): home-dark is byte-identical to home-light", "home-dark: B (b): home-dark is byte-identical to home-light"]);
});
