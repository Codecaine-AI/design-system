/**
 * snapshot:diff --exact is the pixel gate, judged against the current registry entry (--registry): it
 * must fail on any changed pixel outside the registry route's masks, a missing shot, or a shot whose
 * capture failed (in either set) on a gating route, and pass when the change is masked or the registry
 * route is non-gating. It must also refuse comparisons that prove nothing: the same set twice, an --only
 * id the registry does not name, an invalid registry, a shot the registry expects but neither set holds,
 * a partial set compared without --only, shots of one set captured from different trees (including
 * uncommitted content), a shot without content provenance, a shot that never settled, a PNG the manifest
 * does not list, a size change hidden under a mask, mask boxes that differ between the sets or were never
 * recorded, a dark shot equal to light on a route that must differ, an incomplete set, a set captured
 * with another capture spec, and a set whose runs broke isolation or contacted an owner port. Output
 * never lands in a git checkout or through a symlink. Runs the CLIs on synthetic sets in a temp dir.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "../scripts/lib/png.ts";
import type { AppEntry, RouteSpec } from "../scripts/lib/registry.ts";
import { captureSha256, type RunRecord, type ShotProvenance } from "../scripts/lib/snapshot-set.ts";
import { snapshotApp, writeRegistry } from "./snapshot-support.ts";

const PKG = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "ds-diff-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const W = 40;
const H = 30;
/** Mask over the top-left 10x10 corner; every registry route lists `.clock` unless a test says otherwise. */
const MASK = { selector: ".clock", boxes: [{ x: 0, y: 0, width: 10, height: 10 }] };
type MaskRecord = typeof MASK;

function png(changes: Array<[number, number]> = [], width = W, height = H, fill = 255): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(fill);
  for (const [x, y] of changes) data.set([255, 0, 0, 255], (y * width + x) * 4);
  return encodePng({ width, height, data });
}

const PROVENANCE: ShotProvenance = {
  appHead: "a".repeat(40),
  appStatusSha256: "0".repeat(64),
  appDirty: 0,
  appContentSha256: "c".repeat(64),
  designSystemHead: "d".repeat(40),
  tokensCssSha256: "t".repeat(64),
  designSystemFilesSha256: "f".repeat(64),
  capturedAt: "2026-10-05T12:00:00.000Z",
};

const RUN: RunRecord = { mode: "browser", startedAt: "2026-10-05T11:59:00.000Z", finishedAt: "2026-10-05T12:01:00.000Z", blockedRequests: [], expectedBlocked: [] };

interface Shot {
  key: string;
  png: Uint8Array | null;
  /** The capture failed: the manifest records this error (and the set has no PNG for the shot). */
  error?: string;
  /** The capture failed in set A instead. */
  errorInA?: string;
  stable?: boolean;
  /** Mask records in the manifest (default [MASK]). */
  masks?: MaskRecord[];
  provenance?: Partial<ShotProvenance>;
  /** The PNG is on disk, but the manifest does not list the shot. */
  unlisted?: boolean;
  /** What the manifest records about gating (the registry decides). */
  gating?: boolean;
  blocked?: string[];
}

interface SetOptions {
  /** expectedKeys; default every shot's key. null leaves the field out (an older manifest). */
  expected?: string[] | null;
  only?: string[] | null;
  /** The entry the set was captured with (its manifest's registry.captureSha256); default the judging entry. */
  capturedWith?: AppEntry;
  /** Manifest fields to set or override (undefined removes one). */
  manifest?: Record<string, unknown>;
}

const routeOf = (key: string) => key.replace(/-(light|dark)$/, "");
const themeOf = (key: string) => (key.endsWith("-dark") ? "dark" : "light");

/** The judging entry: one route per route id in `keys`, with the themes those keys name, masking `.clock`. */
function registryApp(keys: string[], routes: Record<string, Partial<RouteSpec>> = {}): AppEntry {
  const ids = [...new Set(keys.map(routeOf))];
  return snapshotApp({
    routes: ids.map((id) => ({
      id,
      path: `/${id}`,
      themes: (["light", "dark"] as const).filter((theme) => keys.includes(`${id}-${theme}`)),
      masks: [".clock"],
      ...routes[id],
    })),
  });
}

interface Work {
  out: string;
  registry: string;
  app: AppEntry;
}

function work(app: AppEntry, outDir?: string): Work {
  const dir = mkdtempSync(join(scratch, "work-"));
  const registry = join(dir, "apps.json");
  writeRegistry(registry, [app]);
  return { out: outDir ?? join(dir, "out"), registry, app };
}

function writeSet(w: Work, set: string, shots: Shot[], opts: SetOptions = {}) {
  const dir = join(w.out, "demo", "shots", set);
  mkdirSync(dir, { recursive: true });
  for (const shot of shots) if (shot.png) writeFileSync(join(dir, `${shot.key}.png`), shot.png);
  const expected = opts.expected === undefined ? shots.map((shot) => shot.key) : opts.expected;
  const manifest = {
    app: "demo",
    set,
    ...(expected ? { expectedKeys: expected } : {}),
    only: opts.only ?? null,
    registry: { path: w.registry, sha256: createHash("sha256").update(readFileSync(w.registry)).digest("hex"), captureSha256: captureSha256(opts.capturedWith ?? w.app) },
    runs: [RUN],
    shots: shots
      .filter((shot) => !shot.unlisted)
      .map((shot) => ({
        key: shot.key,
        route: routeOf(shot.key),
        theme: themeOf(shot.key),
        gating: shot.gating ?? true,
        ...(shot.error ? { error: shot.error } : { stable: shot.stable ?? true, provenance: { ...PROVENANCE, ...shot.provenance } }),
        masks: shot.masks ?? [MASK],
        blocked: shot.blocked ?? [],
        expectedBlocked: [],
      })),
    ...opts.manifest,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

function cli(w: Work, args: string[], script = "snapshot-diff.ts") {
  const result = Bun.spawnSync(["bun", `scripts/${script}`, "--app", "demo", "--exact", "--out-dir", w.out, "--registry", w.registry, ...args], { cwd: PKG });
  const reportPath = join(w.out, "demo", "diffs", `${args[args.indexOf("--a") + 1]}-vs-${args[args.indexOf("--b") + 1]}`, "report.json");
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null,
  };
}

interface DiffOptions {
  a?: Shot[];
  setA?: SetOptions;
  setB?: SetOptions;
  /** Registry route overrides by route id. */
  routes?: Record<string, Partial<RouteSpec>>;
  /** Keys the registry expects; default every key of A and B. */
  keys?: string[];
  args?: string[];
}

/** A: a clean capture of every key of `b` with the same mask records (or `a` when given); B: `b`. */
function runDiff(b: Shot[], opts: DiffOptions = {}) {
  const a = opts.a ?? b.map((shot) => (shot.errorInA ? { ...shot, png: null, error: shot.errorInA } : { key: shot.key, png: png(), masks: shot.masks }));
  const w = work(registryApp(opts.keys ?? [...new Set([...a, ...b].map((shot) => shot.key))], opts.routes));
  writeSet(w, "a", a, opts.setA);
  writeSet(w, "b", b, opts.setB);
  return cli(w, ["--a", "a", "--b", "b", ...(opts.args ?? [])]);
}

/** Every problem the report names: the sets' and each shot's. */
const allProblems = (report: any): string[] => [...report.problems, ...report.shots.flatMap((shot: any) => shot.problems)];

// Registry route overrides per case: by default each route masks `.clock` only.
const PAGE_MASK = { home: { masks: [".clock", ".page"] } };
test.each<[string, Shot[], number, Record<string, Partial<RouteSpec>>]>([
  ["identical sets pass", [{ key: "home-light", png: png() }], 0, {}],
  ["a change inside a mask passes", [{ key: "home-light", png: png([[3, 4]]) }], 0, {}],
  ["a change outside the masks fails", [{ key: "home-light", png: png([[20, 15]]) }], 1, {}],
  ["a shot missing from B fails", [{ key: "home-light", png: png() }, { key: "home-dark", png: null }], 1, {}],
  ["a shot whose capture failed in B fails", [{ key: "home-light", png: png() }, { key: "home-dark", png: null, error: "waitFor: Timeout" }], 1, {}],
  [
    "a shot whose capture failed in both sets fails",
    [{ key: "home-light", png: png() }, { key: "home-dark", png: null, error: "Timeout", errorInA: "Timeout" }],
    1,
    {},
  ],
  ["a gating shot that never settled fails, even with identical pixels", [{ key: "home-light", png: png(), stable: false }], 1, {}],
  ["a PNG the manifest does not list fails", [{ key: "home-light", png: png() }, { key: "stray-light", png: png(), unlisted: true }], 1, {}],
  [
    "a size change fails even where a mask covers it",
    [{ key: "home-light", png: png([], W, H + 5), masks: [MASK, { selector: ".page", boxes: [{ x: 0, y: 0, width: W, height: H + 5 }] }] }],
    1,
    PAGE_MASK,
  ],
])("--exact: %s", (_, shots, exitCode, routes) => {
  expect(runDiff(shots, { routes }).exitCode).toBe(exitCode);
});

test("the registry route decides gating: non-gating passes a change; a manifest's gating: false never does", () => {
  const nonGating = { routes: { clock: { gating: false, reason: "live clock" } } };
  expect(runDiff([{ key: "clock-light", png: png([[20, 15]]) }], nonGating).exitCode).toBe(0);
  expect(runDiff([{ key: "clock-light", png: png(), stable: false }], nonGating).exitCode).toBe(0);
  // Set B's manifest marks the shot non-gating; apps.json gates the route.
  const result = runDiff([{ key: "home-light", png: png([[20, 15]]), gating: false }]);
  expect([result.exitCode, result.report.shots[0]]).toEqual([1, expect.objectContaining({ status: "changed", gating: true })]);
});

test("only the registry's mask selectors count: a recorded selector apps.json dropped masks nothing", () => {
  const ad = { selector: ".ad", boxes: [{ x: 15, y: 10, width: 15, height: 15 }] };
  const result = runDiff([{ key: "home-light", png: png([[20, 15]]), masks: [MASK, ad] }]);
  expect([result.exitCode, result.report.shots[0].status, result.report.shots[0].changedPixels]).toEqual([1, "changed", 1]);
  expect(result.report.warnings).toContain("home-light: A recorded mask .ad, which apps.json no longer lists; ignored");
});

test("a registry mask with no boxes recorded in a set fails, and so do boxes that differ between A and B", () => {
  const missing = runDiff([{ key: "home-light", png: png() }], { routes: { home: { masks: [".clock", ".toast"] } } });
  expect(missing.exitCode).toBe(1);
  expect(missing.report.shots[0].problems).toEqual([
    "mask .toast from apps.json has no boxes recorded in A; capture again",
    "mask .toast from apps.json has no boxes recorded in B; capture again",
  ]);
  const toast = (x: number) => ({ selector: ".toast", boxes: [{ x, y: 15, width: 10, height: 10 }] });
  const differ = runDiff([{ key: "home-light", png: png([[25, 20]]), masks: [MASK, toast(20)] }], {
    a: [{ key: "home-light", png: png(), masks: [MASK, toast(0)] }],
    routes: { home: { masks: [".clock", ".toast"] } },
  });
  expect([differ.exitCode, differ.report.shots[0].problems]).toEqual([1, ["mask .toast covers different boxes in A (1 box(es)) and B (1 box(es))"]]);
});

test("the report counts changed pixels outside masks, boxes them, and names the registry it judged against", () => {
  const { report, stdout } = runDiff([{ key: "home-light", png: png([[3, 4], [20, 15], [25, 18]]) }]);
  expect(report.shots[0]).toMatchObject({
    status: "changed",
    changedPixels: 2,
    maskedPixels: 100,
    bbox: { x: 20, y: 15, width: 6, height: 4 },
  });
  expect(report.registry).toEqual({ path: expect.stringMatching(/apps\.json$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), captureSha256: expect.stringMatching(/^[0-9a-f]{64}$/), canonical: false });
  expect(stdout).toContain(`warn  judged against ${report.registry.path}, not the checkout's apps.json`);
});

test("a size change counts every pixel outside the smaller image, masked or not", () => {
  const masks = [{ selector: ".page", boxes: [{ x: 0, y: 0, width: W, height: H + 5 }] }];
  const { report } = runDiff([{ key: "home-light", png: png([], W, H + 5), masks }], { a: [{ key: "home-light", png: png(), masks }], routes: { home: { masks: [".page"] } } });
  expect(report.shots[0]).toMatchObject({ status: "changed", sizeMatch: false, changedPixels: W * 5, maskedPixels: W * H });
});

test("the same set twice, an --only id the registry does not name, and an invalid registry exit 2", () => {
  const w = work(registryApp(["home-light"]));
  writeSet(w, "a", [{ key: "home-light", png: png() }]);
  writeSet(w, "b", [{ key: "home-light", png: png() }]);
  expect(cli(w, ["--a", "a", "--b", "a"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("the same set") });
  expect(cli(w, ["--a", "a", "--b", "b", "--only", "home,hom"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining(`--only names no route or shot of demo in ${w.registry}: hom`) });
  // A shot a set holds that the registry does not name is no --only target either.
  writeSet(w, "b", [{ key: "home-light", png: png() }, { key: "old-light", png: png() }]);
  expect(cli(w, ["--a", "a", "--b", "b", "--only", "old"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("names no route or shot of demo") });
  writeRegistry(w.registry, [snapshotApp({ runProfile: { ...snapshotApp().runProfile, proof: { status: "unproven", method: "" } } })]);
  expect(cli(w, ["--a", "a", "--b", "b"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("registry problem(s)"), report: null });
});

test("a failed diff removes the old report first, so no stale result stays behind", () => {
  const w = work(registryApp(["home-light"]));
  writeSet(w, "a", [{ key: "home-light", png: png() }]);
  writeSet(w, "b", [{ key: "home-light", png: png() }]);
  expect(cli(w, ["--a", "a", "--b", "b"]).report.ok).toBe(true);
  rmSync(join(w.out, "demo", "shots", "b"), { recursive: true });
  expect(cli(w, ["--a", "a", "--b", "b"])).toMatchObject({ exitCode: 2, report: null });
});

test("a registry shot neither set holds fails; a shot the registry no longer names is not compared", () => {
  const shots = [{ key: "home-light", png: png() }];
  const missing = runDiff(shots, { keys: ["home-light", "home-dark"] });
  expect(missing.exitCode).toBe(1);
  expect(missing.report.shots.find((s: any) => s.key === "home-dark")).toMatchObject({ status: "missing-in-b", problems: ["missing in both sets"] });
  // B still holds old-light (its manifest lists it); apps.json dropped the route.
  const dropped = runDiff([...shots, { key: "old-light", png: png([[20, 15]]) }], { keys: ["home-light"] });
  expect([dropped.exitCode, dropped.report.shots.map((s: any) => s.key)]).toEqual([0, ["home-light"]]);
  expect(dropped.report.warnings).toContain(`old-light: not a shot of demo in ${dropped.report.registry.path}; not compared`);
  const old = runDiff(shots, { setB: { expected: null } });
  expect([old.exitCode, old.report.problems]).toEqual([1, [expect.stringContaining("the manifest has no expectedKeys")]]);
});

test("a partial set passes only with a matching --only", () => {
  const shots = [{ key: "home-light", png: png() }];
  const opts = { keys: ["home-light", "edit-light"], setA: { expected: ["home-light", "edit-light"] }, setB: { expected: ["home-light", "edit-light"], only: ["home"] } };
  const whole = runDiff(shots, opts);
  expect([whole.exitCode, whole.report.problems]).toEqual([1, [expect.stringContaining("is a partial set (captured with --only home)")]]);
  expect(runDiff(shots, { ...opts, args: ["--only", "home"] }).exitCode).toBe(0);
  // --only edit selects a shot the partial set does not hold.
  expect(runDiff(shots, { ...opts, args: ["--only", "edit"] }).exitCode).toBe(1);
});

test("shots of one set captured from different trees fail, uncommitted content included", () => {
  const result = runDiff([
    { key: "home-light", png: png() },
    { key: "edit-light", png: png(), provenance: { appHead: "b".repeat(40), capturedAt: "2026-10-06T08:00:00.000Z" } },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.report.problems).toEqual([expect.stringMatching(/^B \(b\) mixes captures of different trees: app bbbbbbbbbbbb.*: edit-light \| app aaaaaaaaaaaa.*: home-light$/)]);
  // The same HEAD and the same porcelain status, but a second edit to an already-dirty file.
  const content = runDiff([
    { key: "home-light", png: png(), provenance: { appDirty: 1 } },
    { key: "edit-light", png: png(), provenance: { appDirty: 1, appContentSha256: "e".repeat(64) } },
  ]);
  expect([content.exitCode, content.report.problems]).toEqual([1, [expect.stringMatching(/^B \(b\) mixes captures of different trees: .*content eeeeeeee.*: edit-light \| .*content cccccccc.*: home-light$/)]]);
  // Only the time differs: one tree.
  expect(runDiff([{ key: "home-light", png: png() }, { key: "edit-light", png: png(), provenance: { capturedAt: "2026-10-06T08:00:00.000Z" } }]).exitCode).toBe(0);
});

test("a dark shot identical to light fails in B when the registry route sets darkDiffers, and is a warning otherwise", () => {
  const same: Shot[] = [
    { key: "home-light", png: png() },
    { key: "home-dark", png: png() },
  ];
  const strict = runDiff(same, { routes: { home: { darkDiffers: true } } });
  expect(strict.exitCode).toBe(1);
  expect(strict.report.shots.find((s: any) => s.key === "home-dark").problems).toEqual(["B (b): home-dark is byte-identical to home-light, but the route sets darkDiffers"]);
  const loose = runDiff(same);
  expect(loose.exitCode).toBe(0);
  expect(loose.report.warnings).toEqual(["home-dark: A (a): home-dark is byte-identical to home-light", "home-dark: B (b): home-dark is byte-identical to home-light"]);
});

const shot = (extra: Partial<Shot> = {}): Shot[] => [{ key: "home-light", png: png(), ...extra }];
const runWith = (run: Partial<RunRecord>) => ({ setB: { manifest: { runs: [RUN, { ...RUN, ...run }] } } });
test.each<[string, Shot[], DiffOptions, string]>([
  ["an incomplete set", shot(), { setB: { manifest: { incomplete: true, startedAt: "2026-10-05T12:00:00.000Z" } } }, "B (b) is incomplete: its capture started 2026-10-05T12:00:00.000Z and never finished"],
  ["a run with an isolation violation", shot(), runWith({ violations: ["connected to 10.0.0.1:443"] }), "B (b): run 2 of 2 (2026-10-05T11:59:00.000Z) broke isolation: connected to 10.0.0.1:443"],
  ["a run that failed to start", shot(), runWith({ startError: "port ui=46976 is in use" }), "failed: port ui=46976 is in use"],
  ["a run that did not stop", shot(), runWith({ stopError: "port 46976 still listening" }), "did not stop cleanly: port 46976 still listening"],
  ["an unproven run", shot(), runWith({ unproven: true }), "used an unproven run profile"],
  ["an unsandboxed run", shot(), runWith({ unsandboxed: true }), "had no OS sandbox"],
  ["a shot's request to an owner port", shot({ blocked: ["GET http://127.0.0.1:4820/api"] }), {}, "B (b) made request(s) to owner ports: GET http://127.0.0.1:4820/api"],
  ["a run's expected-blocked request to an owner port", shot(), runWith({ expectedBlocked: ["WS ws://localhost:4840/kernel"] }), "made request(s) to owner ports: WS ws://localhost:4840/kernel"],
  ["a manifest with no run (an older snapshot)", shot(), { setB: { manifest: { runs: undefined } } }, "B (b) records no capture run (an older snapshot); capture again"],
  ["a manifest with no registry (an older snapshot)", shot(), { setB: { manifest: { registry: undefined } } }, "B (b) records no registry (an older snapshot); capture again"],
  [
    "a set captured with another capture spec of the app",
    shot(),
    { setB: { capturedWith: snapshotApp({ routes: [{ id: "home", path: "/v2", themes: ["light"] }] }) } },
    "B (b) was captured with a different apps.json entry for demo",
  ],
  [
    "shots without content provenance (an older snapshot)",
    shot({ provenance: { appContentSha256: undefined, designSystemFilesSha256: undefined } }),
    {},
    "B (b): 1 shot(s) record no content provenance (an older snapshot: home-light); capture again",
  ],
])("--exact fails %s, with identical pixels", (_, shots, opts, problem) => {
  const result = runDiff(shots, opts);
  expect(result.exitCode).toBe(1);
  expect(allProblems(result.report)).toEqual([expect.stringContaining(problem)]);
});

test("a registry edit to judged fields only keeps a set comparable; another apps.json file is a warning", () => {
  const keys = ["home-light"];
  // Captured before masks, gating, darkDiffers, literalFloor and the proof changed: the capture spec is the same.
  const before = snapshotApp({ literalFloor: 9, routes: [{ id: "home", path: "/home", themes: ["light"], masks: [".old"], gating: false, reason: "was live", darkDiffers: true }] });
  const result = runDiff(shot(), { keys, setB: { capturedWith: before, manifest: { registry: { path: "/elsewhere/apps.json", sha256: "0".repeat(64), captureSha256: captureSha256(before) } } } });
  expect([result.exitCode, result.report.problems]).toEqual([0, []]);
  expect(result.report.warnings).toEqual([expect.stringContaining("B (b) was captured from /elsewhere/apps.json (sha256 000000000000)")]);
});

test("--out-dir inside a git checkout is refused, and nothing is written", () => {
  const repo = mkdtempSync(join(scratch, "repo-"));
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  const w = work(registryApp(["home-light"]), join(repo, "out"));
  writeSet(w, "a", [{ key: "home-light", png: png() }]);
  writeSet(w, "b", [{ key: "home-light", png: png() }]);
  const result = cli(w, ["--a", "a", "--b", "b"]);
  expect([result.exitCode, result.stderr]).toEqual([2, expect.stringContaining("is inside the git checkout")]);
  expect(existsSync(join(w.out, "demo", "diffs"))).toBe(false);
});

test.each([
  ["snapshot:diff", "snapshot-diff.ts", "diffs"],
  ["snapshot:sheet", "snapshot-sheet.ts", "sheets"],
])("%s refuses a symlinked folder under the out dir and touches nothing behind it", (_, script, folder) => {
  const w = work(registryApp(["home-light"]));
  writeSet(w, "a", [{ key: "home-light", png: png() }]);
  writeSet(w, "b", [{ key: "home-light", png: png() }]);
  const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
  mkdirSync(join(elsewhere, "a-vs-b"));
  writeFileSync(join(elsewhere, "a-vs-b", "keep.txt"), "not the tool's");
  symlinkSync(elsewhere, join(w.out, "demo", folder));
  const result = cli(w, ["--a", "a", "--b", "b"], script);
  expect([result.exitCode, result.stderr]).toEqual([2, expect.stringContaining("is a symlink")]);
  expect([readdirSync(elsewhere), readdirSync(join(elsewhere, "a-vs-b"))]).toEqual([["a-vs-b"], ["keep.txt"]]);
});
