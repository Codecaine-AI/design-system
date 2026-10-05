/**
 * snapshot:diff --exact is the pixel gate: it must fail on any changed pixel outside the route's masks
 * (or a missing shot) on a gating route, and pass when the change is masked or the route is non-gating.
 * Runs the CLI on synthetic sets in a temp out-dir.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "../scripts/lib/png.ts";

const scratch = mkdtempSync(join(tmpdir(), "ds-diff-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const W = 40;
const H = 30;
/** Mask over the top-left 10x10 corner in every shot. */
const MASK = { selector: ".clock", boxes: [{ x: 0, y: 0, width: 10, height: 10 }] };

function png(changes: Array<[number, number]> = []): Uint8Array {
  const data = new Uint8Array(W * H * 4).fill(255);
  for (const [x, y] of changes) data.set([255, 0, 0, 255], (y * W + x) * 4);
  return encodePng({ width: W, height: H, data });
}

interface Shot {
  key: string;
  gating?: boolean;
  png: Uint8Array | null;
}

function writeSet(outDir: string, set: string, shots: Shot[]) {
  const dir = join(outDir, "demo", "shots", set);
  mkdirSync(dir, { recursive: true });
  for (const shot of shots) if (shot.png) writeFileSync(join(dir, `${shot.key}.png`), shot.png);
  const manifest = {
    app: "demo",
    set,
    shots: shots.map((shot) => ({
      key: shot.key,
      route: shot.key.replace(/-(light|dark)$/, ""),
      theme: shot.key.endsWith("-dark") ? "dark" : "light",
      gating: shot.gating ?? true,
      ...(shot.gating === false ? { reason: "live clock" } : {}),
      masks: [MASK],
    })),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

function runDiff(b: Shot[]) {
  const outDir = mkdtempSync(join(scratch, "out-"));
  writeSet(outDir, "a", b.map((shot) => ({ ...shot, png: png() })));
  writeSet(outDir, "b", b);
  const result = Bun.spawnSync(["bun", "scripts/snapshot-diff.ts", "--app", "demo", "--a", "a", "--b", "b", "--exact", "--out-dir", outDir], {
    cwd: join(import.meta.dir, ".."),
  });
  const report = JSON.parse(readFileSync(join(outDir, "demo", "diffs", "a-vs-b", "report.json"), "utf8"));
  return { exitCode: result.exitCode, report };
}

test.each([
  ["identical sets pass", [{ key: "home-light", png: png() }], 0],
  ["a change inside a mask passes", [{ key: "home-light", png: png([[3, 4]]) }], 0],
  ["a change outside the masks fails", [{ key: "home-light", png: png([[20, 15]]) }], 1],
  ["a change on a non-gating route passes", [{ key: "clock-light", gating: false, png: png([[20, 15]]) }], 0],
  ["a shot missing from B fails", [{ key: "home-light", png: png() }, { key: "home-dark", png: null }], 1],
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
