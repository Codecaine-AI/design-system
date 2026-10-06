/**
 * A registry entry the snapshot tools accept: snapshot, snapshot:diff and snapshot:sheet run every
 * --registry through validateLoadedRegistry, so test registries carry every field validateRegistry and
 * registry:check's profile rules read. The entry starts the stand-in server (test/fixtures/verify/serve.ts)
 * from app/ on its `ui` port; tests override what they exercise.
 */
import { writeFileSync } from "node:fs";

import type { AppEntry, Requirement } from "../scripts/lib/registry.ts";

const req: Requirement = { required: true };
const na = (reason: string): Requirement => ({ required: false, reason });

/** A complete, valid entry for app "demo" on tool-test port 46976 (block 46970-46979). */
export function snapshotApp(over: Partial<AppEntry> = {}): AppEntry {
  return {
    id: "demo",
    name: "Demo",
    wave: 1,
    kind: "app",
    repo: "app",
    root: "app",
    scan: { paths: ["app"], exclude: [] },
    stack: { summary: "stand-in page", tailwind: "none", packageManager: "bun" },
    consume: { via: "relative-import", detail: "app/index.html" },
    entryStylesheet: null,
    theme: { rule: "light-dark" },
    literalFloor: 0,
    allowlist: null,
    shell: false,
    folderStandard: false,
    passes: { "1": req, "2": na("no shell"), "3": na("no folder standard") },
    checks: { resolution: req, wiring: req, literals: req, names: req, shell: na("no shell"), structure: na("a stand-in page") },
    gates: { lint: req, verify: na("a stand-in page with no chrome to probe"), snapshot: req, pixelDiff: req, tests: na("no tests") },
    run: { mode: "browser", cwd: "app", start: "bun serve.ts", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" },
    commands: { cwd: "app" },
    tests: { safe: [] },
    routes: [{ id: "home", path: "/" }],
    runProfile: {
      env: { NO_COLOR: "1", FIXTURE_PORT: "{port:ui}" },
      unsetEnv: [],
      tempHome: true,
      fixtures: [],
      flags: [],
      ports: { ui: 46976 },
      proof: { status: "proven", method: "test stand-in", date: "2026-10-05" },
    },
    exceptions: [],
    ...over,
  };
}

/** Writes `{ version: 1, apps }` to `path`. */
export function writeRegistry(path: string, apps: AppEntry[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, apps }, null, 2));
}
