#!/usr/bin/env bun
/**
 * Capture an app's registry routes, in every theme the registry requires, under its run profile.
 *
 *   bun run snapshot --app <id> --set <name> [--root <dir>] [--only <route>,...] [--out-dir <dir>] [--force]
 *                    [--registry <apps.json>]
 *
 * Writes <out-dir>/<app>/shots/<set>/<route>-<theme>.png and manifest.json: the design-system commits,
 * the app repo HEAD and `git status`, Playwright and Chromium versions, and per shot the frames until
 * stable, capture attempts, mask boxes, blocked requests and console errors.
 *
 * Starts the app with app-runner (temp HOME, sanitized env, its own ports) and stops it at the end.
 * Refuses an existing set without --force. With --only and --force, only those routes are replaced and
 * the manifest is merged. --registry points at another apps.json (proofs on a local entry).
 * Exit: 2 on bad arguments or an app that cannot be captured, 1 when a shot failed or never settled.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { installSignalHandlers, refreshStartedPorts, startApp, type RunningApp } from "./lib/app-runner";
import { CaptureError, captureRoute, LAUNCH_OPTIONS, routeThemes, shotKey, warmUp } from "./lib/capture";
import { loadPlaywright, playwrightVersion } from "./lib/playwright";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, resolvePath, type RouteSpec } from "./lib/registry";
import { defaultOutDir, readManifest, SET_NAME, setDir, type SetManifest, type ShotEntry, type Theme } from "./lib/snapshot-set";

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
const outDir = resolve(flag("--out-dir") ?? defaultOutDir());
const registryPath = resolve(flag("--registry") ?? REGISTRY_PATH);
const only = flag("--only")?.split(",").map((value) => value.trim()).filter(Boolean);
const force = process.argv.includes("--force");

const app = getApp(loadRegistry(registryPath), appId);
if (app.run?.mode === "none") fail(`${app.id}: run mode none (${app.run.reason ?? "no reason"}): no screenshots`);
if (app.gates?.snapshot && app.gates.snapshot.required === false) fail(`${app.id}: the snapshot gate is n/a (${app.gates.snapshot.reason})`);
const routes: RouteSpec[] = (app.routes ?? []).filter((route) => !only || only.includes(route.id));
if (routes.length === 0) fail(`${app.id}: no routes selected${only ? ` (--only ${only.join(",")})` : ""}`);
if (only) {
  const unknown = only.filter((id) => !(app.routes ?? []).some((route) => route.id === id));
  if (unknown.length) fail(`${app.id}: unknown route(s) ${unknown.join(", ")}`);
}

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
  console.log(`[${app.id}] starting (${app.run.mode}) from ${root}...`);
  running = await startApp(app, { root, outDir });
  console.log(`[${app.id}] ready${running.baseUrl ? ` at ${running.baseUrl}` : ""}; listening on ${running.startedPorts.join(", ")}`);
  if (!running.electron) {
    const { chromium } = loadPlaywright(root);
    browser = await chromium.launch(LAUNCH_OPTIONS);
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
            captureAttempts: attempt,
            ...(problems.length ? { retriedAfter: problems } : {}),
            ...meta,
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
    if (running.violations?.length) {
      console.error(`[${app.id}] ${running.violations.join("; ")}`);
      failures += 1;
    }
    await running.stop().catch((error) => {
      stopError = error instanceof Error ? error.message : String(error);
      console.error(`[${app.id}] stop: ${stopError}`);
    });
  }
}

const dsInRoot = join(root, "design-system");
const manifest: SetManifest = {
  app: app.id,
  set,
  root,
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
        ...(running.violations?.length ? { violations: running.violations } : {}),
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
}
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const expected = routes.reduce((sum, route) => sum + routeThemes(app, route).length, 0);
const good = shots.filter((shot) => !shot.error && shot.stable).length;
console.log(`\n${good}/${expected} shots captured to ${dir}${failures ? ` (${failures} failed or unstable)` : ""}`);
process.exit(failures || stopError ? 1 : 0);
