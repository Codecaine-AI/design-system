#!/usr/bin/env bun
/**
 * Capture an app's registry routes, in every theme the registry requires, under its run profile.
 *
 *   bun run snapshot --app <id> --set <name> [--root <dir>] [--only <route>,...] [--out-dir <dir>] [--force]
 *                    [--registry <apps.json>]
 *
 * Writes <out-dir>/<app>/shots/<set>/<route>-<theme>.png and manifest.json: the design-system commits,
 * the app repo HEAD and `git status`, Playwright and Chromium versions, the keys the registry expects
 * (every route × required theme, whatever --only says), the --only list, the apps.json it ran from
 * (path, file sha256, the app's capture spec sha256), every run whose shots the set holds, and per shot
 * its provenance (app HEAD + status + uncommitted content, design-system HEAD + dist/css/fonts content,
 * tokens.css sha256, capture time), the frames until stable, capture attempts, mask boxes, blocked
 * requests and console errors. A gating dark shot that is byte-identical to its light shot is a
 * manifest warning.
 *
 * Before the app starts, manifest.json is written with `incomplete: true`; only the final manifest
 * drops it, so a capture that dies leaves a set snapshot:diff --exact rejects. Manifests are written
 * through a temp file and a rename.
 *
 * Starts the app with app-runner (temp HOME, sanitized env, its own ports) and stops it at the end.
 * Refuses an existing set without --force. With --only and --force, only those routes are replaced and
 * the manifest is merged (shots of two runs then differ in provenance when the trees changed, which
 * snapshot:diff --exact fails); a merge into an incomplete set, or into one captured with another capture
 * spec of the app, is refused. Refuses to run while a
 * propagate journal is unrestored or a build holds the sentinel color. --registry points at another
 * apps.json (proofs on a local entry); it must pass the registry checks. --out-dir is never the owner's
 * tree or a git checkout, and no write under it goes through a symlink.
 * Exit: 2 on bad arguments or an app that cannot be captured, 1 when a shot failed or never settled.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanupRuns, installSignalHandlers, launchBrowser, refreshStartedPorts, startApp, validateLoadedRegistry, type RunningApp } from "./lib/app-runner";
import { CaptureError, captureRoute, routeThemes, shotKey, warmUp } from "./lib/capture";
import { toolOutputDir } from "./lib/output-dir";
import { playwrightVersion } from "./lib/playwright";
import { DESIGN_SYSTEM_ROOT, getApp, loadRegistry, REGISTRY_PATH, resolvePath, type AppEntry, type Registry, type RouteSpec, workspaceRoot, designSystemIn } from "./lib/registry";
import { safeAppId, safeSegment } from "./lib/safe-paths";
import {
  captureSha256,
  defaultOutDir,
  type ExpectedShot,
  readManifest,
  type RegistryRecord,
  type RunRecord,
  SET_NAME,
  setPath,
  type SetManifest,
  sha256Hex,
  type ShotEntry,
  type ShotProvenance,
  type Theme,
  writeManifest,
} from "./lib/snapshot-set";
import { GitPinError, pinFor, pinnedGit, pinRepos } from "./lib/git";
import { treeState } from "./lib/provenance";
import { propagateBlocker } from "./lib/verify/propagate";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

/** The value, or exit 2 with the error's message. */
function orFail<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const appId = flag("--app");
const set = flag("--set");
if (!appId || !set) fail("usage: bun run snapshot --app <id> --set <name> [--root <dir>] [--only <route>,...] [--out-dir <dir>] [--force] [--registry <apps.json>]");
if (!SET_NAME.test(set)) fail(`--set must be a plain name (letters, digits, . _ -): ${set}`);
const root = resolve(flag("--root") ?? workspaceRoot());
// Shared destination check: never the owner's tree or a git checkout; ids that stay one segment.
const outDir = orFail(() => {
  safeAppId(appId);
  safeSegment(set, "--set");
  return toolOutputDir(flag("--out-dir") ?? defaultOutDir(), { label: "--out-dir" });
});
const registryPath = resolve(flag("--registry") ?? REGISTRY_PATH);
const only = flag("--only")?.split(",").map((value) => value.trim()).filter(Boolean);
const force = process.argv.includes("--force");

// The registry must pass the same checks registry:check runs before anything starts from it.
const registry: Registry = orFail(() => validateLoadedRegistry(loadRegistry(registryPath), registryPath));
const app: AppEntry = orFail(() => getApp(registry, appId));
if (app.run?.mode === "none") fail(`${app.id}: run mode none (${app.run.reason ?? "no reason"}): no screenshots`);
if (app.gates?.snapshot && app.gates.snapshot.required === false) fail(`${app.id}: the snapshot gate is n/a (${app.gates.snapshot.reason})`);
if (only) {
  const unknown = only.filter((id) => !(app.routes ?? []).some((route) => route.id === id));
  if (unknown.length) fail(`${app.id}: unknown route(s) ${unknown.join(", ")}`);
}
const routes: RouteSpec[] = (app.routes ?? []).filter((route) => !only || only.includes(route.id));
if (routes.length === 0) fail(`${app.id}: no routes selected${only ? ` (--only ${only.join(",")})` : ""}`);

const blocker = propagateBlocker({ outDirs: [outDir, process.env.DS_RUN], dsDirs: [designSystemIn(root), DESIGN_SYSTEM_ROOT] });
if (blocker) fail(`refusing to capture: ${blocker}`);

// Every shot the registry asks for, whatever --only selects. snapshot:diff --exact judges against the
// registry it runs with; these record what this capture was asked for.
const expected: ExpectedShot[] = orFail(() =>
  (app.routes ?? []).flatMap((route) =>
    routeThemes(app, route).map((theme) => ({
      key: shotKey(route, theme),
      route: route.id,
      theme,
      gating: route.gating !== false,
      ...(route.darkDiffers ? { darkDiffers: true } : {}),
    })),
  ),
);
const registryRecord: RegistryRecord = { path: registryPath, sha256: sha256Hex(readFileSync(registryPath)), captureSha256: captureSha256(app) };

/** `<set>/<file>`: no component on the way may be a symlink (exit 2 otherwise; only while no app runs). */
const shotFile = (file: string) => orFail(() => setPath(outDir, app.id, set, file));

const dir = orFail(() => setPath(outDir, app.id, set));
const previous = readManifest(dir);
if (existsSync(dir) && (previous || readdirSync(dir).some((name) => name.endsWith(".png"))) && !force)
  fail(`${dir} already holds a shot set. Use another --set name, or --force to replace it.`);
// An --only merge keeps the other shots: they must come from a finished capture with today's capture spec.
if (only && previous?.incomplete)
  fail(`${dir} is incomplete (a capture started ${previous.startedAt ?? "at an unknown time"} never finished); capture the whole set again with --force, without --only`);
if (only && previous && previous.registry?.captureSha256 !== registryRecord.captureSha256)
  fail(`${dir} was captured with another apps.json entry for ${app.id} (or records none); capture the whole set again with --force, without --only`);
mkdirSync(dir, { recursive: true });
const isSetFile = (name: string) => name.endsWith(".png") || name === "manifest.json" || (name.startsWith("manifest.json.") && name.endsWith(".tmp"));
if (!only) for (const name of readdirSync(dir)) if (isSetFile(name)) unlinkSync(shotFile(name));

const startedAt = new Date();
// From here until the final manifest, the set says it is incomplete: a capture that dies leaves it so.
orFail(() =>
  writeManifest(
    outDir,
    app.id,
    set,
    only && previous
      ? { ...previous, incomplete: true, startedAt: startedAt.toISOString() }
      : { app: app.id, set, incomplete: true, startedAt: startedAt.toISOString(), expectedKeys: expected.map((shot) => shot.key), expected, only: only ?? null, registry: registryRecord, shots: [] },
  ),
);

/**
 * git through git.ts: the system git, pinned to the repositories recorded below before the app starts,
 * hook-free, no fsmonitor, no system or global config. A repository whose `.git` entry changed since then
 * is refused (GitPinChanged): its output never reaches the manifest, and the capture fails.
 */
function git(repo: string, args: string[]): string {
  try {
    const pin = pinFor(repo, { optional: true });
    if (!pin) return "ERROR: not a git checkout";
    const result = pinnedGit(pin, args);
    return result.status === 0 ? result.stdout.trimEnd() : `ERROR: ${(result.error?.message ?? result.stderr).trim()}`;
  } catch (error) {
    if (!(error instanceof GitPinError)) throw error;
    pinChanged ??= error.message;
    return `ERROR: ${error.message}`;
  }
}
function repoState(path: string) {
  return { path, head: git(path, ["rev-parse", "HEAD"]), status: git(path, ["status", "--porcelain"]).split("\n").filter(Boolean) };
}
function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}
const dsInRoot = designSystemIn(root);
// Every repository this capture reads, pinned before the app starts (startApp pins the app's checkouts too).
const gitPins = orFail(() => pinRepos([resolvePath(root, app.repo), resolvePath(root, app.root), dsInRoot, DESIGN_SYSTEM_ROOT]));
/** Problems reading the trees for provenance (a git failure): manifest warnings, never a crash. */
const provenanceWarnings = new Set<string>();
/** Set when a pinned repository's `.git` entry changed during the capture: the set fails. */
let pinChanged: string | undefined;

/** The trees a shot was captured from, read right after the shot (scripts/lib/provenance.ts). */
function provenanceNow(): ShotProvenance {
  try {
    return { ...treeState(root, app, provenanceWarnings), capturedAt: new Date().toISOString() };
  } catch (error) {
    if (!(error instanceof GitPinError)) throw error;
    pinChanged ??= error.message;
    throw error;
  }
}

let running: RunningApp | undefined;
let browser: any;
let interrupted = false;
// On a signal: stop capturing, close the browser, stop the app (app-runner), exit 130. The manifest
// stays incomplete.
installSignalHandlers(() => {
  interrupted = true;
  return browser?.close();
});

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
  running = await startApp(app, { root, outDir, registry });
  console.log(`[${app.id}] ready${running.baseUrl ? ` at ${running.baseUrl}` : ""}; listening on ${running.startedPorts.join(", ")}`);
  if (!running.electron) {
    // Sandboxed to the run's ports (decision 29); a sanitized env over a temp HOME, never the tool's own.
    browser = await launchBrowser(root, { running });
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
      // A stale PNG must never stand in for a capture that fails now. (A symlinked path throws: the
      // capture stops and the app is stopped below.)
      rmSync(setPath(outDir, app.id, set, `${key}.png`), { force: true });
      const problems: string[] = [];
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await captureRoute(browser, running, route, theme);
          if (result.reloads > 0 && attempt < 3) {
            problems.push("page reloaded during capture");
            console.log(`  ${key}: page reloaded during capture, retrying`);
            continue;
          }
          writeFileSync(setPath(outDir, app.id, set, `${key}.png`), result.png);
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

const finishedAt = new Date().toISOString();
// Requests the guard blocked: unexpected ones, and expected ones (the app's own named ports the run never bound).
const blockedRequests = [...new Set([...warmUpBlocked.blocked, ...shots.flatMap((shot) => (shot.blocked as string[] | undefined) ?? [])])];
const expectedBlocked = [...new Set([...warmUpBlocked.expectedBlocked, ...shots.flatMap((shot) => (shot.expectedBlocked as string[] | undefined) ?? [])])];
const run: RunRecord = running
  ? {
      mode: app.run.mode,
      startedAt: startedAt.toISOString(),
      finishedAt,
      baseUrl: running.baseUrl,
      ports: running.ports,
      startedPorts: running.startedPorts,
      logPath: running.logPath,
      profileProof: app.runProfile.proof,
      ...(running.unproven ? { unproven: true } : {}),
      ...(running.unsandboxed ? { unsandboxed: true } : {}),
      ...(running.violations?.length ? { violations: running.violations } : {}),
      ...(running.egress ? { egress: running.egress } : {}),
      ...(startError ? { startError } : {}),
      ...(stopError ? { stopError } : {}),
      blockedRequests,
      expectedBlocked,
    }
  : { mode: app.run.mode, startedAt: startedAt.toISOString(), finishedAt, startError, blockedRequests, expectedBlocked };

const manifest: SetManifest = {
  app: app.id,
  set,
  root,
  expectedKeys: expected.map((shot) => shot.key),
  expected,
  only: only ?? null,
  startedAt: startedAt.toISOString(),
  finishedAt,
  registry: registryRecord,
  designSystem: {
    // The copy the app renders with (inside --root), and the checkout this tool ran from.
    rendered: { ...repoState(dsInRoot), tokensCssSha256: sha256(join(dsInRoot, "dist/css/tokens.css")) },
    tooling: { path: DESIGN_SYSTEM_ROOT, head: git(DESIGN_SYSTEM_ROOT, ["rev-parse", "HEAD"]), registry: registryPath },
  },
  appRepo: repoState(resolvePath(root, app.repo)),
  // The repositories git read, as pinned before the app started; snapshot:diff refuses a B set whose
  // repositories' `.git` entries changed since (git.ts).
  git: gitPins.map(({ workTree, gitDir, commonDir, entry }) => ({ workTree, gitDir, commonDir, entry })),
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
  runs: [run],
  run,
  blockedRequests,
  expectedBlocked,
  warmUpBlocked,
  shots,
};
if (only && previous) {
  const recaptured = new Set(shots.map((shot) => shot.key));
  manifest.shots = [...previous.shots.filter((shot) => !recaptured.has(shot.key)), ...shots];
  manifest.partialRuns = [...((previous.partialRuns as unknown[]) ?? []), { at: manifest.finishedAt, keys: [...recaptured] }];
  // Every run whose shots the set still holds; snapshot:diff --exact judges each.
  manifest.runs = [...(previous.runs ?? (previous.run ? [previous.run] : [])), run];
  // A full set stays full (its shots now differ in provenance); a partial one covers both runs' routes.
  manifest.only = previous.only == null ? null : [...new Set([...previous.only, ...only])];
}
// Dark identical to light: expected before a migration, a sign that the dark switch did nothing after it.
const warnings: string[] = [...provenanceWarnings];
if (pinChanged) {
  // A repository's `.git` entry changed while the app ran: nothing git said about it can be trusted, so the
  // set stays incomplete (snapshot:diff --exact rejects it, and an --only merge into it is refused).
  warnings.push(`git: ${pinChanged}`);
  manifest.incomplete = true;
  manifest.invalid = `git: ${pinChanged}`;
  console.error(`[${app.id}] ${pinChanged}`);
  failures += 1;
}
for (const shot of manifest.shots) {
  if (shot.theme !== "dark" || shot.error || shot.gating === false) continue;
  const light = manifest.shots.find((other) => other.route === shot.route && other.theme === "light" && !other.error);
  const [darkPng, lightPng] = [shot, light].map((entry) => (entry ? shotFile(`${entry.key}.png`) : ""));
  if (!light || !existsSync(darkPng!) || !existsSync(lightPng!)) continue;
  if (!readFileSync(darkPng!).equals(readFileSync(lightPng!))) continue;
  shot.sameAsLight = true;
  warnings.push(`${shot.key} is byte-identical to ${light.key}${shot.darkDiffers ? " (the route sets darkDiffers: snapshot:diff --exact fails it)" : ""}`);
}
if (warnings.length) manifest.warnings = warnings;
for (const warning of warnings) console.log(`  warning: ${warning}`);
orFail(() => writeManifest(outDir, app.id, set, manifest));
const selectedCount = routes.reduce((sum, route) => sum + routeThemes(app, route).length, 0);
const good = shots.filter((shot) => !shot.error && shot.stable).length;
console.log(`\n${good}/${selectedCount} shots captured to ${dir}${failures ? ` (${failures} failed or unstable)` : ""}`);
process.exit(failures || stopError ? 1 : 0);
