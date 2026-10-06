/**
 * The snapshot CLI end to end on a stand-in server (test/fixtures/verify/serve.ts, not an app), with a
 * --registry that passes the registry checks: the manifest records every expected key, the --only list,
 * the registry it ran from, its runs and each shot's provenance; the page sees the fixed clock; a dark
 * shot identical to light is a manifest warning; an --only --force rerun after a commit, or after a
 * second edit to an already-dirty file, leaves a set of mixed provenance that snapshot:diff --exact
 * rejects; a capture killed mid-run leaves an incomplete set that --exact rejects (and the runner's
 * watchdog takes its app down); an --only merge into an incomplete set, or into one captured with
 * another capture spec, is refused.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXED_TIME } from "../scripts/lib/capture.ts";
import { decodePng } from "../scripts/lib/png.ts";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { finishScratch, leakedListeners } from "./leaks.ts";
import { plantBin } from "./planted-bin.ts";
import { snapshotApp, writeRegistry } from "./snapshot-support.ts";
import { browserSkip, FIXTURES } from "./verify-support.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-snapshot-cli-")));
afterAll(async () => {
  try {
    await finishScratch(scratch); // stop what this file started, clean crashed runs' records, then no listener may be left
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** Green when the page's clock reads FIXED_TIME, red otherwise; the same in light and dark. */
const CLOCK_PAGE = `<!doctype html><html><head><style>html, body { margin: 0; height: 100%; }</style></head><body><script>
  document.body.style.background = new Date().toISOString() === ${JSON.stringify(FIXED_TIME)} ? "#00ff00" : "#ff0000";
</script></body></html>`;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.email=test@example.invalid", "-c", "user.name=test", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A root with the stand-in app at app/ (a git repo with a tracked notes.txt) and a registry naming it on `port`. */
function tree(port = 46976) {
  const root = mkdtempSync(join(scratch, "root-"));
  const app = join(root, "app");
  mkdirSync(app);
  cpSync(join(FIXTURES, "serve.ts"), join(app, "serve.ts"));
  writeFileSync(join(app, "index.html"), CLOCK_PAGE);
  writeFileSync(join(app, "other.html"), CLOCK_PAGE);
  writeFileSync(join(app, "notes.txt"), "committed");
  git(app, "init", "-q");
  git(app, "add", ".");
  git(app, "commit", "-q", "-m", "fixture");
  const entry = snapshotApp({
    routes: [
      { id: "home", path: "/" },
      { id: "other", path: "/other.html", themes: ["light"] },
    ],
    runProfile: { ...snapshotApp().runProfile, ports: { ui: port } },
  });
  const registry = join(root, "apps.json");
  writeRegistry(registry, [entry]);
  return { root, app, registry, out: join(root, "out") };
}
type Tree = ReturnType<typeof tree>;

const argv = (t: Tree, script: string, args: string[]) => [process.execPath, join(DESIGN_SYSTEM_ROOT, "scripts", script), "--app", "demo", "--out-dir", t.out, "--registry", t.registry, ...args];
const env = (t: Tree) => ({ ...process.env, DS_RUN: t.out });
const run = (t: Tree, script: string, args: string[]) => Bun.spawnSync(argv(t, script, args), { env: env(t) });
const snapshot = (t: Tree, set: string, ...extra: string[]) => run(t, "snapshot.ts", ["--set", set, "--root", t.root, ...extra]);
const manifestPath = (t: Tree, set: string) => join(t.out, "demo/shots", set, "manifest.json");
const manifest = (t: Tree, set: string) => JSON.parse(readFileSync(manifestPath(t, set), "utf8"));
const diff = (t: Tree, a: string, b: string) => run(t, "snapshot-diff.ts", ["--a", a, "--b", b, "--exact"]);

test.skipIf(Boolean(browserSkip))(
  "manifest fields, the fixed clock, dark-equals-light warnings, and a mixed-provenance merge that --exact rejects",
  () => {
    const t = tree();
    // git, ps and lsof planted in PATH: the capture must run the system binaries (provenance included).
    const planted = plantBin(t.root);
    const first = Bun.spawnSync(argv(t, "snapshot.ts", ["--set", "base", "--root", t.root]), { env: { ...env(t), PATH: planted.path } });
    expect([first.exitCode, first.stderr.toString(), planted.calls()]).toEqual([0, "", []]);
    const base = manifest(t, "base");
    expect(base.expectedKeys).toEqual(["home-light", "home-dark", "other-light"]);
    expect(base.only).toBeNull();
    expect(base.incomplete).toBeUndefined();
    expect(base.registry).toEqual({ path: t.registry, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), captureSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(base.runs).toEqual([expect.objectContaining({ mode: "browser", startedAt: base.startedAt, finishedAt: base.finishedAt, blockedRequests: [], expectedBlocked: [] })]);
    for (const shot of base.shots) {
      expect(shot.provenance).toMatchObject({
        appHead: expect.stringMatching(/^[0-9a-f]{40}$/),
        appDirty: 0,
        appContentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        designSystemFilesSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        capturedAt: expect.any(String),
      });
      expect(shot.clock).toBe("fixed");
    }
    // The page read FIXED_TIME: green, not red.
    expect([...decodePng(readFileSync(join(t.out, "demo/shots/base/home-light.png"))).data.subarray(0, 3)]).toEqual([0, 255, 0]);
    expect(base.warnings).toEqual(["home-dark is byte-identical to home-light"]);

    // A second full set of the same tree compares clean.
    expect(snapshot(t, "again").exitCode).toBe(0);
    expect(diff(t, "base", "again").exitCode).toBe(0);

    // A commit, then only `home` recaptured into `again`: its shots now come from two trees.
    writeFileSync(join(t.app, "notes.txt"), "a change");
    git(t.app, "commit", "-q", "-am", "change");
    expect(snapshot(t, "again", "--only", "home", "--force").exitCode).toBe(0);
    const merged = manifest(t, "again");
    expect(merged.only).toBeNull();
    expect(merged.runs).toHaveLength(2);
    expect(new Set(merged.shots.map((shot: any) => shot.provenance.appHead)).size).toBe(2);
    const result = diff(t, "base", "again");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("FAIL  set: B (again) mixes captures of different trees");
  },
  120_000,
);

test.skipIf(Boolean(browserSkip))(
  "a second edit to an already-dirty file between two --only runs gives mixed provenance",
  () => {
    const t = tree();
    writeFileSync(join(t.app, "notes.txt"), "first edit");
    expect(snapshot(t, "base").exitCode).toBe(0);
    expect(snapshot(t, "dirty").exitCode).toBe(0);
    // `git status --porcelain` reads " M notes.txt" before and after: only the content changes.
    writeFileSync(join(t.app, "notes.txt"), "second edit");
    expect(snapshot(t, "dirty", "--only", "home", "--force").exitCode).toBe(0);
    const shots = manifest(t, "dirty").shots;
    expect(new Set(shots.map((shot: any) => shot.provenance.appStatusSha256)).size).toBe(1);
    expect(new Set(shots.map((shot: any) => shot.provenance.appContentSha256)).size).toBe(2);
    const result = diff(t, "base", "dirty");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("FAIL  set: B (dirty) mixes captures of different trees");
  },
  120_000,
);

test.skipIf(Boolean(browserSkip))(
  "a capture killed mid-run leaves an incomplete set that --exact rejects, and no app behind",
  async () => {
    const t = tree(46977);
    expect(snapshot(t, "base").exitCode).toBe(0);
    const proc = Bun.spawn(argv(t, "snapshot.ts", ["--set", "killed", "--root", t.root]), { env: env(t), stdout: "ignore", stderr: "ignore" });
    // Wait until the set says it is incomplete and the app listens, then kill the tool without a chance to clean up.
    let marked = false;
    let listening = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && proc.exitCode === null && !(marked && listening)) {
      marked ||= existsSync(manifestPath(t, "killed")) && manifest(t, "killed").incomplete === true;
      listening = marked && leakedListeners(scratch).some((leak) => leak.port === 46977);
      await Bun.sleep(100);
    }
    proc.kill("SIGKILL");
    await proc.exited;
    expect([marked, listening]).toEqual([true, true]);
    // The runner's watchdog stops the app once its tool is gone.
    const gone = Date.now() + 15_000;
    while (Date.now() < gone && leakedListeners(scratch).some((leak) => leak.port === 46977)) await Bun.sleep(200);
    expect(leakedListeners(scratch).filter((leak) => leak.port === 46977)).toEqual([]);
    const result = diff(t, "base", "killed");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("FAIL  set: B (killed) is incomplete: its capture started");
  },
  120_000,
);

test.each([
  ["an incomplete set", { incomplete: true, startedAt: "2026-10-05T12:00:00.000Z" }, "is incomplete (a capture started 2026-10-05T12:00:00.000Z never finished)"],
  ["a set captured with another capture spec", { registry: { path: "/elsewhere/apps.json", sha256: "0".repeat(64), captureSha256: "1".repeat(64) } }, "was captured with another apps.json entry for demo"],
])("an --only merge into %s is refused before anything starts", (_, fields, message) => {
  const t = tree();
  const dir = join(t.out, "demo/shots/half");
  mkdirSync(dir, { recursive: true });
  const previous = { app: "demo", set: "half", only: null, shots: [], ...fields };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(previous));
  const result = snapshot(t, "half", "--only", "home", "--force");
  expect([result.exitCode, result.stderr.toString()]).toEqual([2, expect.stringContaining(message)]);
  expect(manifest(t, "half")).toEqual(previous);
});
