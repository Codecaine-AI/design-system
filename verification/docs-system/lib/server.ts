/**
 * Start and stop an ISOLATED `docs-cli serve --dev` for one staged corpus.
 *
 * Isolation (nothing reaches the user's live docs state):
 *   --standalone                 never hand off to the installed central service
 *   CODECAINE_DOCS_STATE_DIR     -> <staging>/state (copy; no background.json)
 *   CODECAINE_DOCS_GLOBAL_THEMES -> <staging>/state/themes (copy of the global theme)
 *   CODECAINE_DOCS_CODE_THEMES   -> <staging>/state/code-themes (copy)
 *   --themes-root                -> <staging>/repo-themes (copy of docs-system/themes)
 *   --root                       -> <staging>/corpora/<corpus>/docs (copy; the backlinks
 *                                   index is written into the copy, not the real tree)
 *   --kernel-url                 -> a dead port (the lab UI never reaches the live kernel)
 *   DOCS_SHARED_API_* unset      so the serve can never proxy to a shared authority
 *
 * The serve process spawns `vite dev` as a child; both run in their own
 * process group so stop() can always take down the whole tree.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import { DEAD_KERNEL_URL, DOCS_SYSTEM_REPO } from "./env";

export interface ServeOptions {
  name: string;
  corpusDocsDir: string;
  stagingDir: string;
  apiPort: number;
  uiPort: number;
  logPath: string;
}

export interface ServeHandle {
  name: string;
  apiPort: number;
  uiPort: number;
  uiOrigin: string;
  pid: number;
  logPath: string;
  stop(): Promise<void>;
}

export function isolatedEnv(stagingDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DOCS_SHARED_API_URL",
    "DOCS_SHARED_PROJECT_ID",
    "DOCS_SHARED_API_TOKEN",
    "DOCS_STATIC",
    "DOCS_API",
  ]) {
    delete env[key];
  }
  env.CODECAINE_DOCS_STATE_DIR = join(stagingDir, "state");
  env.CODECAINE_DOCS_GLOBAL_THEMES = join(stagingDir, "state", "themes");
  env.CODECAINE_DOCS_CODE_THEMES = join(stagingDir, "state", "code-themes");
  // Build-time defines in web/vite.config.ts; pinned to their defaults so a
  // shell override can never make two runs compile differently.
  env.CANVAS_STUDIO_URL = "http://localhost:3999";
  env.SEQUENCE_STUDIO_URL = "http://localhost:3998";
  return env;
}

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string, child: ChildProcess, logPath: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what}: serve exited early (code ${child.exitCode}); see ${logPath}`);
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`${what}: not ready after ${timeoutMs} ms; see ${logPath}`);
}

function listenerPids(port: number): number[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function startServe(options: ServeOptions): Promise<ServeHandle> {
  const { name, corpusDocsDir, stagingDir, apiPort, uiPort, logPath } = options;
  for (const port of [apiPort, uiPort]) {
    if (await portInUse(port)) {
      throw new Error(
        `Port ${port} is already in use. A previous harness run may still be up: ` +
          `\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` shows the owner.`,
      );
    }
  }
  const logFd = openSync(logPath, "a");
  const args = [
    "packages/docs-cli/src/index.ts",
    "serve",
    "--standalone",
    "--root",
    corpusDocsDir,
    "--themes-root",
    join(stagingDir, "repo-themes"),
    "--dev",
    "--port",
    String(apiPort),
    "--ui-port",
    String(uiPort),
    "--kernel-url",
    DEAD_KERNEL_URL,
  ];
  const child = spawn("bun", args, {
    cwd: DOCS_SYSTEM_REPO,
    env: isolatedEnv(stagingDir),
    detached: true, // own process group: stop() kills serve + vite together
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  const pid = child.pid;
  if (!pid) throw new Error(`${name}: failed to spawn docs-cli serve`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already gone
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const open = (await portInUse(apiPort)) || (await portInUse(uiPort));
      if (!open && child.exitCode !== null) break;
      if (!open && child.exitCode === null) {
        try {
          process.kill(-pid, 0);
        } catch {
          break; // group is gone
        }
      }
      await sleep(200);
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    // Belt and braces: anything still listening on OUR reserved ports was
    // started by this run (startServe refused to start on a busy port).
    for (const port of [apiPort, uiPort]) {
      for (const leftover of listenerPids(port)) {
        try {
          process.kill(leftover, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  };

  try {
    let config: { themeLocked?: boolean; globalTheme?: boolean } | null = null;
    await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/serve-config`);
        if (!response.ok) return false;
        config = (await response.json()) as { themeLocked?: boolean; globalTheme?: boolean };
        return true;
      },
      60_000,
      `${name} API :${apiPort}`,
      child,
      logPath,
    );
    // The shots assume an unlocked serve rendering the (copied) shared global theme.
    if (config!.themeLocked !== false || config!.globalTheme !== true) {
      throw new Error(`${name}: unexpected /api/serve-config ${JSON.stringify(config)}; expected an unlocked serve with the global theme`);
    }
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${uiPort}/`)).ok,
      60_000,
      `${name} UI :${uiPort}`,
      child,
      logPath,
    );
  } catch (error) {
    await stop();
    throw error;
  }

  return { name, apiPort, uiPort, uiOrigin: `http://127.0.0.1:${uiPort}`, pid, logPath, stop };
}
