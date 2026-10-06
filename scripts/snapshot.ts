#!/usr/bin/env bun
/**
 * Capture an app's registry routes, in every theme the registry requires, under its run profile.
 *
 *   bun run snapshot --app <id> --set <name> [--root <dir>] [--only <route>,...] [--out-dir <dir>] [--force]
 *                    [--registry <apps.json>]
 *
 * Writes <out-dir>/<app>/shots/<set>/<route>-<theme>.png and manifest.json: the design-system commits,
 * the app repo HEAD and `git status`, Playwright and Chromium versions, the keys the registry expects
 * (every route × required theme, whatever --only says), the --only list, and per shot its provenance
 * (app HEAD + status, design-system HEAD, tokens.css sha256, capture time), the frames until stable,
 * capture attempts, mask boxes, blocked requests and console errors. A gating dark shot that is
 * byte-identical to its light shot is a manifest warning.
 *
 * Starts the app with app-runner (temp HOME, sanitized env, its own ports) and stops it at the end.
 * Refuses an existing set without --force. With --only and --force, only those routes are replaced and
 * the manifest is merged (shots of two runs then differ in provenance, which snapshot:diff --exact
 * fails). Refuses to run while a propagate journal is unrestored or a build holds the sentinel color.
 * --registry points at another apps.json (proofs on a local entry).
 * Exit: 2 on bad arguments or an app that cannot be captured, 1 when a shot failed or never settled.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanupRuns, installSignalHandlers, launchBrowser, refreshStartedPorts, startApp, type RunningApp } from "./lib/app-runner";
import { CaptureError, captureRoute, routeThemes, shotKey, warmUp } from "./lib/capture";
import { playwrightVersion } from "./lib/playwright";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, resolvePath, type RouteSpec } from "./lib/registry";
import { safeAppId, safeOutputPath, safeSegment } from "./lib/safe-paths";
import { defaultOutDir, type ExpectedShot, readManifest, SET_NAME, setDir, type SetManifest, type ShotEntry, type ShotProvenance, type Theme } from "./lib/snapshot-set";
import { propagateBlocker } from "./lib/verify/propagate";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const appId = flag("--app");
const set = flag("--set");
if (!appId || !set) fail("usage: bun run snapshot --app <id> --set <name> [--root <dir>] [--only <route>,...] [--out-dir <dir>] [--force]");
if (!SET_NAME.test(set)) fail(`--set must be a plain name (letters, digits, . _ -): ${set}`);
const root = resolve(flag("--root") ?? resolve(DESIGN_SYSTEM_ROOT, ".."));
let outDir: string;
try {
  // Shared destination check: never the owner's tree (unless --root is that tree), ids that stay one segment.
  outDir = safeOutputPath(flag("--out-dir") ?? defaultOutDir(), { root, label: "--out-dir" });
  safeAppId(appId);
  safeSegment(set, "--set");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const registryPath = resolve(flag("--registry") ?? REGISTRY_PATH);
const only = flag("--only")?.split(",").map((value) => value.trim()).filter(Boolean);
const force = process.argv.includes("--force");

const app = getApp(loadRegistry(registryPath), appId);
if (app.run?.mode === "none") fail(`${app.id}: run mode none (${app.run.reason ?? "no reason"}): no screenshots`);
if (app.gates?.snapshot && app.gates.snapshot.required === false) fail(`${app.id}: the snapshot gate is n/a (${app.gates.snapshot.reason})`);
if (only) {
  const unknown = only.filter((id) => !(app.routes ?? []).some((route) => route.id === id));
  if (unknown.length) fail(`${app.id}: unknown route(s) ${unknown.join(", ")}`);
}
const routes: RouteSpec[] = (app.routes ?? []).filter((route) => !only || only.includes(route.id));
if (routes.length === 0) fail(`${app.id}: no routes selected${only ? ` (--only ${only.join(",")})` : ""}`);

const blocker = propagateBlocker({ outDirs: [outDir, process.env.DS_RUN], dsDirs: [join(root, "design-system"), DESIGN_SYSTEM_ROOT] });
if (blocker) fail(`refusing to capture: ${blocker}`);

// Every shot the registry asks for, whatever --only selects: snapshot:diff --exact checks a set against it.
const expected: ExpectedShot[] = (app.routes ?? []).flatMap((route) =>
  routeThemes(app, route).map((theme) => ({
    key: shotKey(route, theme),
    route: route.id,
    theme,
    gating: route.gating !== false,
    ...(route.darkDiffers ? { darkDiffers: true } : {}),
  })),
);

const dir = setDir(outDir, app.id, set);
const previous = readManifest(dir);
if (existsSync(dir) && (previous || readdirSync(dir).some((name) => name.endsWith(".png"))) && !force)
  fail(`${dir} already holds a shot set. Use another --set name, or --force to replace it.`);
mkdirSync(dir, { recursive: true });
if (!only) for (const name of readdirSync(dir)) if (name.endsWith(".png") || name === "manifest.json") unlinkSync(join(dir, name));

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trimEnd() : `ERROR: ${result.stderr.trim()}`;
}
function repoState(path: string) {
  return { path, head: git(path, ["rev-parse", "HEAD"]), status: git(path, ["status", "--porcelain"]).split("\n").filter(Boolean) };
}
function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}
const appRepoPath = resolvePath(root, app.repo);
const dsInRoot = join(root, "design-system");
/** The trees a shot was captured from, read right after the shot. */
function provenanceNow(): ShotProvenance {
  const status = git(appRepoPath, ["status", "--porcelain"]);
  return {
    appHead: git(appRepoPath, ["rev-parse", "HEAD"]),
    appStatusSha256: createHash("sha256").update(status).digest("hex"),
    appDirty: status.split("\n").filter(Boolean).length,
    designSystemHead: git(dsInRoot, ["rev-parse", "HEAD"]),
    tokensCssSha256: sha256(join(dsInRoot, "dist/css/tokens.css")),
    capturedAt: new Date().toISOString(),
  };
}

let running: RunningApp | undefined;
let browser: any;
let interrupted = false;
// On a signal: stop capturing, close the browser, stop the app (app-runner), exit 130.
installSignalHandlers(() => {
  interrupted = true;
  return browser?.close();
});

const startedAt = new Date();
const shots: ShotEntry[] = [];
let failures = 0;
let chromiumVersion = "";
let stopError: string | undefined;
let startError: string | undefined;
let warmUpBlocked = { blocked: [] as string[], expectedBlocked: [] as string[] };

try {
  // Processes a crashed earlier run left behind (the runner's records in <out-dir>/runs).
  for (const line of await cleanupRuns(outDir)) console.error(`[${app.id}] cleanup: ${line}`);
  console.log(`[${app.id}] starting (${app.run.mode}) from ${root}...`);
  running = await startApp(app, { root, outDir });
  console.log(`[${app.id}] ready${running.baseUrl ? ` at ${running.baseUrl}` : ""}; listening on ${running.startedPorts.join(", ")}`);
  if (!running.electron) {
    // A sanitized env over a temp HOME, never the tool's own.
    browser = await launchBrowser(root);
    chromiumVersion = browser.version();
    console.log(`[${app.id}] warming up: ${[...new Set(routes.map((route) => route.path || "/"))].join(" ")}`);
    warmUpBlocked = await warmUp(browser, running, routes);
  } else {
    chromiumVersion = `electron ${await running.electron.app.evaluate(() => process.versions.electron).catch(() => "?")}`;
  }

  for (const route of routes) {
    for (const theme of routeThemes(app, route) as Theme[]) {
      if (interrupted) break;
      const key = shotKey(route, theme);
      // A stale PNG must never stand in for a capture that fails now.
      rmSync(join(dir, `${key}.png`), { force: true });
      const problems: string[] = [];
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await captureRoute(browser, running, route, theme);
          if (result.reloads > 0 && attempt < 3) {
            problems.push("page reloaded during capture");
            console.log(`  ${key}: page reloaded during capture, retrying`);
            continue;
          }
          writeFileSync(join(dir, `${key}.png`), result.png);
          const { png: _png, ...meta } = result;
          shots.push({
            key,
            route: route.id,
            theme,
            gating: route.gating !== false,
            ...(route.reason ? { reason: route.reason } : {}),
            ...(route.darkDiffers ? { darkDiffers: true } : {}),
            captureAttempts: attempt,
            ...(problems.length ? { retriedAfter: problems } : {}),
            ...meta,
            provenance: provenanceNow(),
          });
          const flags = [
            result.stable ? "" : "UNSTABLE",
            attempt > 1 ? `retried=${attempt - 1}` : "",
            result.blocked.length ? `BLOCKED=${result.blocked.length}` : "",
            result.expectedBlocked.length ? `expected-blocked=${result.expectedBlocked.length}` : "",
            result.consoleErrors.length ? `console-errors=${result.consoleErrors.length}` : "",
          ].filter(Boolean);
          console.log(`  ${key}  (${result.durationMs} ms, ${result.frames} frames, theme ${result.themeMethod})${flags.length ? `  ${flags.join(" ")}` : ""}`);
          if (!result.stable) failures += 1;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          problems.push(message.split("\n")[0]!);
          if (attempt < 2) {
            console.log(`  ${key}: ${message.split("\n")[0]} -- retrying once`);
            continue;
          }
          console.error(`  ${key}: FAILED: ${message}`);
          shots.push({
            key,
            route: route.id,
            theme,
            gating: route.gating !== false,
            ...(route.darkDiffers ? { darkDiffers: true } : {}),
            masks: [],
            error: message,
            retriedAfter: problems,
            blocked: error instanceof CaptureError ? error.blocked : [],
            expectedBlocked: error instanceof CaptureError ? error.expectedBlocked : [],
          });
          failures += 1;
          break;
        }
      }
    }
  }
} catch (error) {
  startError = error instanceof Error ? error.message : String(error);
  console.error(`[${app.id}] ${startError}`);
  failures += 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (running) {
    refreshStartedPorts(running);
    await running.stop().catch((error) => {
      stopError = error instanceof Error ? error.message : String(error);
      console.error(`[${app.id}] stop: ${stopError}`);
    });
    // stop() takes the last egress sample: the violations are complete only now. A run without the
    // sandbox or with an unproven profile never makes a set that counts.
    const isolation = [
      ...(running.violations ?? []),
      ...(running.unproven ? ["the run profile is unproven"] : []),
      ...(running.unsandboxed ? ["the run had no OS sandbox"] : []),
    ];
    if (isolation.length) {
      console.error(`[${app.id}] isolation: ${isolation.join("; ")}`);
      failures += 1;
    }
  }
}

const manifest: SetManifest = {
  app: app.id,
  set,
  root,
  expectedKeys: expected.map((shot) => shot.key),
  expected,
  only: only ?? null,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  designSystem: {
    // The copy the app renders with (inside --root), and the checkout this tool ran from.
    rendered: { ...repoState(dsInRoot), tokensCssSha256: sha256(join(dsInRoot, "dist/css/tokens.css")) },
    tooling: { path: DESIGN_SYSTEM_ROOT, head: git(DESIGN_SYSTEM_ROOT, ["rev-parse", "HEAD"]), registry: registryPath },
  },
  appRepo: repoState(resolvePath(root, app.repo)),
  environment: {
    playwright: (() => {
      try {
        return playwrightVersion(root);
      } catch {
        return "unresolved";
      }
    })(),
    chromium: chromiumVersion,
    platform: `${process.platform} ${process.arch}`,
    bun: process.versions.bun,
  },
  run: running
    ? {
        mode: app.run.mode,
        baseUrl: running.baseUrl,
        ports: running.ports,
        startedPorts: running.startedPorts,
        logPath: running.logPath,
        profileProof: app.runProfile.proof,
        ...(running.unproven ? { unproven: true } : {}),
        ...(running.unsandboxed ? { unsandboxed: true } : {}),
        ...(running.violations?.length ? { violations: running.violations } : {}),
        ...(running.egress ? { egress: running.egress } : {}),
        ...(stopError ? { stopError } : {}),
      }
    : { mode: app.run.mode, startError },
  // Requests the guard blocked: unexpected ones, and expected ones (the app's own named ports the run never bound).
  blockedRequests: [...new Set([...warmUpBlocked.blocked, ...shots.flatMap((shot) => (shot.blocked as string[] | undefined) ?? [])])],
  expectedBlocked: [...new Set([...warmUpBlocked.expectedBlocked, ...shots.flatMap((shot) => (shot.expectedBlocked as string[] | undefined) ?? [])])],
  warmUpBlocked,
  shots,
};
if (only && previous) {
  const recaptured = new Set(shots.map((shot) => shot.key));
  manifest.shots = [...previous.shots.filter((shot) => !recaptured.has(shot.key)), ...shots];
  manifest.partialRuns = [...((previous.partialRuns as unknown[]) ?? []), { at: manifest.finishedAt, keys: [...recaptured] }];
  // A full set stays full (its shots now differ in provenance); a partial one covers both runs' routes.
  manifest.only = previous.only == null ? null : [...new Set([...previous.only, ...only])];
}
// Dark identical to light: expected before a migration, a sign that the dark switch did nothing after it.
const warnings: string[] = [];
for (const shot of manifest.shots) {
  if (shot.theme !== "dark" || shot.error || shot.gating === false) continue;
  const light = manifest.shots.find((other) => other.route === shot.route && other.theme === "light" && !other.error);
  const [darkPng, lightPng] = [shot, light].map((entry) => (entry ? join(dir, `${entry.key}.png`) : ""));
  if (!light || !existsSync(darkPng!) || !existsSync(lightPng!)) continue;
  if (!readFileSync(darkPng!).equals(readFileSync(lightPng!))) continue;
  shot.sameAsLight = true;
  warnings.push(`${shot.key} is byte-identical to ${light.key}${shot.darkDiffers ? " (the route sets darkDiffers: snapshot:diff --exact fails it)" : ""}`);
}
if (warnings.length) manifest.warnings = warnings;
for (const warning of warnings) console.log(`  warning: ${warning}`);
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const selectedCount = routes.reduce((sum, route) => sum + routeThemes(app, route).length, 0);
const good = shots.filter((shot) => !shot.error && shot.stable).length;
console.log(`\n${good}/${selectedCount} shots captured to ${dir}${failures ? ` (${failures} failed or unstable)` : ""}`);
process.exit(failures || stopError ? 1 : 0);
