#!/usr/bin/env bun
/**
 * Capture every shot in shots.json to <out>/<key>.png.
 *
 *   bun snapshot.ts --out before|after|<name> [--only <id|key>,...] [--force] [--keep-staging]
 *
 *   --only   capture just these shot ids (both themes) or keys (one theme);
 *            other PNGs in <out> stay and manifest.json is merged.
 *   --force  required to overwrite an existing before* set (the baseline; its
 *            PNGs are gitignored, so an accidental overwrite cannot be undone).
 *
 * Starts everything it needs and stops it again:
 *   1. extracts fixtures/frozen-inputs.tar.gz into /tmp/ds-verify-docs-system
 *      (fresh every run: corpora, global theme, code theme, repo themes);
 *   2. per server in shots.json, starts an isolated `docs-cli serve --dev`
 *      (lib/server.ts), warms vite up, captures that server's shots, stops it;
 *   3. writes <out>/manifest.json (environment, code-under-test git state,
 *      per-shot stability and any blocked writes).
 * Nothing outside this folder and the staging dir is written (vite keeps its
 * usual dependency cache in Core's node_modules/.vite).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { captureShot, LAUNCH_OPTIONS, warmUp } from "./lib/capture";
import { DOCS_SYSTEM_REPO, FIXTURE_ARCHIVE, FIXTURE_MANIFEST, HARNESS_DIR, loadPlaywright, playwrightVersion, STAGING_DIR } from "./lib/env";
import { startServe, type ServeHandle } from "./lib/server";
import { expandShots, loadShots, type ExpandedShot } from "./lib/shots";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outName = flag("--out");
if (!outName || outName.startsWith("--")) {
  console.error("usage: bun snapshot.ts --out before|after|<name> [--only <id|key>,...] [--force] [--keep-staging]");
  process.exit(2);
}
if (!/^[A-Za-z0-9._-]+$/.test(outName) || outName.startsWith("diff-") || outName.startsWith("compare-") || ["fixtures", "lib"].includes(outName)) {
  console.error(`--out must be a plain folder name (not fixtures, lib, diff-*, compare-*): ${outName}`);
  process.exit(2);
}
const onlyArg = flag("--only");
const only = onlyArg ? new Set(onlyArg.split(",").map((value) => value.trim()).filter(Boolean)) : undefined;
const keepStaging = process.argv.includes("--keep-staging");
const force = process.argv.includes("--force");

const outDir = join(HARNESS_DIR, outName);
if (outName.startsWith("before") && existsSync(join(outDir, "manifest.json")) && !force) {
  console.error(
    `${outDir} already holds a baseline. Capturing again after the migration would replace BEFORE with AFTER.\n` +
      `Use another --out name (e.g. after), or pass --force if you really mean to re-capture the baseline from unmigrated code.`,
  );
  process.exit(2);
}
const shotsFile = loadShots();
const shots = expandShots(shotsFile, only);
if (shots.length === 0) {
  console.error("No shots selected.");
  process.exit(2);
}

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", DOCS_SYSTEM_REPO, ...args], { encoding: "utf8" });
  // trimEnd only: porcelain status lines start with a meaningful space.
  return result.status === 0 ? result.stdout.trimEnd() : `ERROR: ${result.stderr.trim()}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// -- staging -----------------------------------------------------------------
function stage() {
  if (!existsSync(FIXTURE_ARCHIVE)) throw new Error(`Missing ${FIXTURE_ARCHIVE}; run \`bun freeze.ts\` once first.`);
  const expected = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")).archive.sha256 as string;
  const actual = sha256(FIXTURE_ARCHIVE);
  if (expected !== actual) throw new Error(`Fixture checksum mismatch (${actual} != manifest ${expected}).`);
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(join(STAGING_DIR, "logs"), { recursive: true });
  const tar = spawnSync("tar", ["-xzf", FIXTURE_ARCHIVE, "-C", STAGING_DIR], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar -x failed: ${tar.stderr}`);
  return actual;
}

// -- run ---------------------------------------------------------------------
const running = new Set<ServeHandle>();
let shuttingDown = false;
async function stopAll() {
  for (const handle of [...running]) {
    await handle.stop().catch(() => undefined);
    running.delete(handle);
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\n${signal}: stopping servers...`);
    void stopAll().finally(() => process.exit(130));
  });
}

const startedAt = new Date();
const fixtureSha = stage();
mkdirSync(outDir, { recursive: true });
if (!only) {
  for (const name of readdirSync(outDir)) {
    if (name.endsWith(".png") || name === "manifest.json") unlinkSync(join(outDir, name));
  }
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch(LAUNCH_OPTIONS);
const chromiumVersion: string = browser.version();

const results: Record<string, unknown>[] = [];
let failures = 0;
try {
  const byServer = new Map<string, ExpandedShot[]>();
  for (const shot of shots) {
    const list = byServer.get(shot.spec.server) ?? [];
    list.push(shot);
    byServer.set(shot.spec.server, list);
  }
  for (const [serverName, serverShots] of byServer) {
    const server = shotsFile.servers[serverName]!;
    console.log(`\n[${serverName}] starting isolated serve (api :${server.apiPort}, ui :${server.uiPort})...`);
    const handle = await startServe({
      name: serverName,
      corpusDocsDir: join(STAGING_DIR, "corpora", server.corpus, "docs"),
      stagingDir: STAGING_DIR,
      apiPort: server.apiPort,
      uiPort: server.uiPort,
      logPath: join(STAGING_DIR, "logs", `${serverName}.log`),
    });
    running.add(handle);
    try {
      const warmUrls = [...new Set(serverShots.map((shot) => (shot.spec.app === "playground" ? shot.spec.url : "/")))];
      console.log(`[${serverName}] warming up vite: ${warmUrls.join(" ")}`);
      await warmUp(browser, handle.uiOrigin, warmUrls);
      for (const shot of serverShots) {
        if (shuttingDown) break;
        // One retry for a step that timed out or a vite reload mid-capture. Retries
        // are recorded in the manifest (captureAttempts) so flakiness stays visible.
        const problems: string[] = [];
        for (let attempt = 1; ; attempt++) {
          try {
            const result = await captureShot(browser, handle.uiOrigin, shot.spec, shot.theme);
            if (result.reloads > 0 && attempt < 3) {
              problems.push("page reloaded during capture (vite)");
              console.log(`  ${shot.key}: page reloaded during capture (vite), retrying`);
              continue;
            }
            writeFileSync(join(outDir, `${shot.key}.png`), result.png);
            const { png: _png, ...meta } = result;
            results.push({
              key: shot.key,
              id: shot.spec.id,
              theme: shot.theme,
              url: shot.spec.url,
              server: serverName,
              captureAttempts: attempt,
              ...(problems.length ? { retriedAfter: problems } : {}),
              ...meta,
            });
            const flags = [
              result.stable ? "" : "UNSTABLE",
              attempt > 1 ? `retried=${attempt - 1}` : "",
              result.blockedWrites.length ? `blocked-writes=${result.blockedWrites.length}` : "",
              result.blockedExternal.length ? `blocked-external=${result.blockedExternal.length}` : "",
            ].filter(Boolean);
            console.log(`  ${shot.key}  (${result.durationMs} ms, ${result.attempts} frames)${flags.length ? `  ${flags.join(" ")}` : ""}`);
            if (!result.stable) failures += 1;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            problems.push(message.split("\n")[0]!);
            if (attempt < 2) {
              console.log(`  ${shot.key}: ${message.split("\n")[0]} -- retrying once`);
              continue;
            }
            console.error(`  ${shot.key}: FAILED: ${message}`);
            results.push({ key: shot.key, id: shot.spec.id, theme: shot.theme, url: shot.spec.url, server: serverName, error: message, retriedAfter: problems });
            failures += 1;
            break;
          }
        }
      }
    } finally {
      console.log(`[${serverName}] stopping serve`);
      await handle.stop();
      running.delete(handle);
    }
  }
} finally {
  await browser.close().catch(() => undefined);
  await stopAll();
  if (!keepStaging) rmSync(STAGING_DIR, { recursive: true, force: true });
}

const manifest = {
  out: outName,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  environment: {
    playwright: playwrightVersion(),
    chromium: chromiumVersion,
    platform: `${process.platform} ${process.arch}`,
    bun: process.versions.bun,
  },
  codeUnderTest: {
    repo: DOCS_SYSTEM_REPO,
    head: git(["rev-parse", "HEAD"]),
    // Uncommitted changes in the checkout at capture time (the AFTER run lists the migration here).
    status: git(["status", "--porcelain"]).split("\n").filter(Boolean),
  },
  fixtureSha256: fixtureSha,
  shots: results,
};
if (only && existsSync(join(outDir, "manifest.json"))) {
  // Partial run: keep the other shots' entries, replace the recaptured ones.
  const previous = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as { shots?: { key: string }[] };
  const recaptured = new Set(results.map((entry) => entry.key));
  manifest.shots = [...(previous.shots ?? []).filter((entry) => !recaptured.has(entry.key)), ...results];
  (manifest as Record<string, unknown>).partialRuns = [
    ...(((previous as Record<string, unknown>).partialRuns as unknown[]) ?? []),
    { at: manifest.finishedAt, keys: [...recaptured] },
  ];
}
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n${results.length - failures}/${shots.length} shots captured to ${outDir}${failures ? ` (${failures} failed or unstable)` : ""}`);
process.exit(failures ? 1 : 0);
