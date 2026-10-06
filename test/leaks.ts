/**
 * Leak guard for test files that start apps: after the file, no process this file started may still
 * listen on a tool-test port (46900-46999). Other worktrees run the same suites on the same ports at the
 * same time, so a listener counts as this file's only when its working directory is inside the file's
 * scratch dir (every stand-in app runs from there). Call before removing the scratch dir.
 */
import { spawnSync } from "node:child_process";
import { sep } from "node:path";

export interface Leak {
  pid: number;
  port: number;
  cwd: string;
}

/** Listeners on 46900-46999 whose cwd is inside `scratch`. */
export function leakedListeners(scratch: string): Leak[] {
  const out = spawnSync("lsof", ["-nP", "-w", "-iTCP:46900-46999", "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8" }).stdout ?? "";
  const leaks: Leak[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      const cwd = (spawnSync("lsof", ["-a", "-w", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout ?? "")
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
  const pgidOf = (pid: number) => Number((spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim());
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
