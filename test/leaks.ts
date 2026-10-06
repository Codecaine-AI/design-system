/**
 * Leak guard for test files that start apps: after the file, no process this file started may still
 * listen on a tool-test port (46900-46999). Other worktrees run the same suites on the same ports at the
 * same time, so a listener counts as this file's only when its working directory is inside the file's
 * scratch dir (every stand-in app runs from there).
 *
 * In afterAll, before removing the scratch dir: `await finishScratch(scratch)`. It stops every app this
 * process still has live, runs cleanupRuns on every run-record dir under the scratch dir (what a crashed
 * child tool left), then asserts no listener is left. assertNoLeaks alone is the last step of that.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

import { cleanupRuns, stopAllApps } from "../scripts/lib/app-runner.ts";
import { SYSTEM_BIN } from "../scripts/lib/system-bin.ts";

export interface Leak {
  pid: number;
  port: number;
  cwd: string;
}

/** Listeners on 46900-46999 whose cwd is inside `scratch`. */
export function leakedListeners(scratch: string): Leak[] {
  const out = spawnSync(SYSTEM_BIN.lsof, ["-nP", "-w", "-iTCP:46900-46999", "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
  const leaks: Leak[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      const cwd = (spawnSync(SYSTEM_BIN.lsof, ["-a", "-w", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "")
        .split("\n")
        .find((entry) => entry.startsWith("n"))
        ?.slice(1);
      if (cwd && (cwd === scratch || cwd.startsWith(scratch + sep))) leaks.push({ pid, port, cwd });
    }
  }
  return leaks;
}

/**
 * Fails (throws) when this file left a listener behind, after stopping those processes' groups so the
 * next file starts clean. Only processes whose cwd is inside `scratch` are touched.
 */
export function assertNoLeaks(scratch: string): void {
  const leaks = leakedListeners(scratch);
  const pgidOf = (pid: number) => Number((spawnSync(SYSTEM_BIN.ps, ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim());
  const ownGroup = pgidOf(process.pid);
  for (const { pid } of leaks) {
    const pgid = pgidOf(pid);
    try {
      process.kill(Number.isInteger(pgid) && pgid > 1 && pgid !== ownGroup ? -pgid : pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (leaks.length) throw new Error(`left ${leaks.length} listener(s) behind: ${leaks.map((l) => `pid ${l.pid} on :${l.port} (cwd ${l.cwd})`).join(", ")}`);
}

/** Every out dir under `scratch` (depth <= 4) that holds run records (`<out>/runs/*.json`). */
export function recordDirs(scratch: string, depth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (basename(path) === "runs" && readdirSync(path).some((file) => file.endsWith(".json"))) found.push(dir);
      else if (left > 0) walk(path, left - 1);
    }
  };
  if (existsSync(scratch)) walk(scratch, depth);
  return found;
}

/**
 * The afterAll step before a test file removes its scratch dir: stop this process's live apps, clean up
 * the run records under the scratch dir (crashed child tools), then assertNoLeaks. Returns cleanupRuns'
 * report lines.
 */
export async function finishScratch(scratch: string): Promise<string[]> {
  await stopAllApps();
  const report: string[] = [];
  for (const dir of recordDirs(scratch)) report.push(...(await cleanupRuns(dir)));
  assertNoLeaks(scratch);
  return report;
}
