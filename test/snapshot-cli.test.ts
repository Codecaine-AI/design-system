/**
 * The snapshot CLI end to end on a stand-in server (test/fixtures/verify/serve.ts, not an app): the
 * manifest records every expected key, the --only list and each shot's provenance; the page sees the
 * fixed clock; a dark shot identical to light is a manifest warning; and an --only --force rerun after
 * a commit leaves a set of mixed provenance that snapshot:diff --exact rejects.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXED_TIME } from "../scripts/lib/capture.ts";
import { decodePng } from "../scripts/lib/png.ts";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { assertNoLeaks } from "./leaks.ts";
import { browserSkip, FIXTURES, runnableFixtureApp } from "./verify-support.ts";

const PORT = 46976;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-snapshot-cli-")));
afterAll(() => {
  try {
    assertNoLeaks(scratch); // no app this file started may still listen
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

function tree() {
  const root = mkdtempSync(join(scratch, "root-"));
  const app = join(root, "app");
  mkdirSync(app);
  cpSync(join(FIXTURES, "serve.ts"), join(app, "serve.ts"));
  writeFileSync(join(app, "index.html"), CLOCK_PAGE);
  writeFileSync(join(app, "other.html"), CLOCK_PAGE);
  git(app, "init", "-q");
  git(app, "add", ".");
  git(app, "commit", "-q", "-m", "fixture");
  const entry = {
    ...runnableFixtureApp({ ui: PORT }),
    id: "snap",
    repo: "app",
    verify: undefined,
    gates: { snapshot: { required: true } },
    routes: [
      { id: "home", path: "/" },
      { id: "other", path: "/other.html", themes: ["light"] },
    ],
  };
  const registry = join(root, "apps.json");
  writeFileSync(registry, JSON.stringify({ version: 1, apps: [entry] }));
  return { root, app, registry, out: join(root, "out") };
}

const run = (t: ReturnType<typeof tree>, script: string, args: string[]) =>
  Bun.spawnSync([process.execPath, join(DESIGN_SYSTEM_ROOT, "scripts", script), "--app", "snap", "--out-dir", t.out, ...args], {
    env: { ...process.env, DS_RUN: t.out },
  });

test.skipIf(Boolean(browserSkip))(
  "manifest fields, the fixed clock, dark-equals-light warnings, and a mixed-provenance merge that --exact rejects",
  () => {
    const t = tree();
    const snapshot = (set: string, ...extra: string[]) => run(t, "snapshot.ts", ["--set", set, "--root", t.root, "--registry", t.registry, ...extra]);
    const manifest = (set: string) => JSON.parse(readFileSync(join(t.out, "snap/shots", set, "manifest.json"), "utf8"));

    const first = snapshot("base");
    expect([first.exitCode, first.stderr.toString()]).toEqual([0, ""]);
    const base = manifest("base");
    expect(base.expectedKeys).toEqual(["home-light", "home-dark", "other-light"]);
    expect(base.only).toBeNull();
    for (const shot of base.shots) {
      expect(shot.provenance).toMatchObject({ appHead: expect.stringMatching(/^[0-9a-f]{40}$/), appDirty: 0, capturedAt: expect.any(String) });
      expect(shot.clock).toBe("fixed");
    }
    // The page read FIXED_TIME: green, not red.
    expect([...decodePng(readFileSync(join(t.out, "snap/shots/base/home-light.png"))).data.subarray(0, 3)]).toEqual([0, 255, 0]);
    expect(base.warnings).toEqual(["home-dark is byte-identical to home-light"]);

    // A second full set of the same tree compares clean.
    expect(snapshot("again").exitCode).toBe(0);
    expect(run(t, "snapshot-diff.ts", ["--a", "base", "--b", "again", "--exact"]).exitCode).toBe(0);

    // A commit, then only `home` recaptured into `again`: its shots now come from two trees.
    writeFileSync(join(t.app, "notes.txt"), "a change");
    git(t.app, "add", ".");
    git(t.app, "commit", "-q", "-m", "change");
    expect(snapshot("again", "--only", "home", "--force").exitCode).toBe(0);
    const merged = manifest("again");
    expect(merged.only).toBeNull();
    expect(new Set(merged.shots.map((shot: any) => shot.provenance.appHead)).size).toBe(2);
    const diff = run(t, "snapshot-diff.ts", ["--a", "base", "--b", "again", "--exact"]);
    expect(diff.exitCode).toBe(1);
    expect(diff.stdout.toString()).toContain("FAIL  set: B (again) mixes captures of different trees");
  },
  120_000,
);
