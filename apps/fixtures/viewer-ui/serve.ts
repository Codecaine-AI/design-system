#!/usr/bin/env bun
/**
 * Read-only trace fixture for viewer-ui: the library's host (the simple-research-kernel UI) over the
 * model-nodes demo trace, with no agent-kernel API of the app's own.
 *
 *   bun --no-env-file apps/fixtures/viewer-ui/serve.ts --root <workspace> --tmp <dir> --api-port <n> --ui-port <n>
 *
 * The research app's own API cannot run in a profile: its server.ts creates .agent-kernel/ in the
 * example folder, opens the trace DB read-write in WAL mode, bootstraps the schema and serves write
 * routes (POST /api/run calls an LLM). So this:
 *
 * 1. Opens <tmp>/model-nodes-demo.db, which the run profile copies there (registry fixture
 *    apps/fixtures/viewer-ui/model-nodes-demo.db, written by agent-kernel's
 *    examples/simple-research-kernel/scripts/model-nodes-demo/generate-fixture.ts with
 *    --journal-mode delete, so a read-only open needs no -wal or -shm file), with
 *    openKernelDatabaseReadOnly from the root's agent-kernel db package.
 * 2. Serves the kernel's own trace read API over it on --api-port: createContainerReadService and
 *    createKernelTraceReadApi, the routes the research API mounts (container trace, trace sessions,
 *    blobs, turn context). Besides those, GET /api/research answers an empty harness (no agents, no
 *    active runs) and GET /api/doctor the trace doctor over the read-only DB. Every method but GET and
 *    HEAD answers 405, so no request can reach a write.
 * 3. Runs the research app's Vite dev server on --ui-port with API_TARGET at that API, so the app's
 *    /kernel and /api proxy reaches this server only. Vite's "Local:" line is the run's ready line; the
 *    API's own log line never matches it. Vite stays in this process group, so stopping the group stops it.
 *
 * Reads only the root's repo content and the copied DB; writes nothing (Vite writes its usual
 * dependency cache to the example's node_modules/.vite).
 */
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

import { canonicalPath } from "../../../scripts/lib/safe-paths";
import { parseFixtureArgs, runFixture } from "../lib/fixture-server";

const AGENT_KERNEL = "codecaine/core/agent-kernel";
const EXAMPLE = `${AGENT_KERNEL}/examples/simple-research-kernel`;

/** The fixture DB's name in --tmp (the profile copies apps/fixtures/viewer-ui/<DB_FILE> there). */
export const DB_FILE = "model-nodes-demo.db";
/** The kernel id the generator writes; the trace-sessions list is scoped to it. */
export const KERNEL_ID = "model-nodes-demo";

const READ_METHODS = new Set(["GET", "HEAD"]);

export interface FixtureApi {
  /** Answers one request: 405 unless GET or HEAD, then the stubs, then the kernel's read API. */
  fetch(request: Request): Promise<Response>;
  close(): void;
}

interface SessionSummary {
  label?: string;
  piSessionCount?: number;
  eventCount?: number;
  latestEventAt?: string | null;
}

/** The research app's ResearchHarnessInfo for a harness that runs nothing: the first trace's counts, no agents. */
export function researchInfo(sessions: SessionSummary[]) {
  const trace = sessions[0];
  return {
    kernelId: KERNEL_ID,
    concurrency: { maxBackgroundAgents: 0 },
    memoryDir: "",
    agents: [],
    activeRuns: [],
    trace: {
      label: trace?.label ?? "model-nodes demo",
      piSessionCount: trace?.piSessionCount ?? 0,
      eventCount: trace?.eventCount ?? 0,
      latestEventAt: trace?.latestEventAt ?? null,
    },
    artifacts: { scoutReports: [], reports: [] },
    latestReport: "",
  };
}

/** The read-only API over the trace DB at `dbPath`, built from the root's agent-kernel sources. */
export async function openFixtureApi(root: string, dbPath: string): Promise<FixtureApi> {
  const ak = join(root, AGENT_KERNEL);
  const { openKernelDatabaseReadOnly } = await import(join(ak, "packages/db/src/index.ts"));
  const { createContainerReadService, runTraceDoctor } = await import(join(ak, "packages/kernel/src/index.ts"));
  // Not re-exported by the kernel's index.
  const { createKernelTraceReadApi } = await import(join(ak, "packages/kernel/src/read-api.ts"));
  const handle = openKernelDatabaseReadOnly(dbPath);
  const service = createContainerReadService({ db: handle.db, kernelId: KERNEL_ID });
  const readApi = createKernelTraceReadApi(service);

  const json = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/research") return json(researchInfo((await service.listSessionContainers()).trace_sessions));
    if (pathname === "/api/doctor") return json(await runTraceDoctor(handle.db));
    return readApi.handle(request);
  };
  return {
    async fetch(request) {
      if (!READ_METHODS.has(request.method)) return new Response("read-only", { status: 405, headers: { allow: "GET, HEAD" } });
      if (request.method === "GET") return route(request);
      const response = await route(new Request(request.url, { headers: request.headers }));
      return new Response(null, { status: response.status, headers: response.headers });
    },
    close: () => handle.close(),
  };
}

async function main() {
  const args = parseFixtureArgs(process.argv.slice(2));
  const { api, ui } = args.ports;
  if (!api || !ui) throw new Error("--api-port and --ui-port are required");
  const example = join(args.root, EXAMPLE);
  if (!existsSync(join(example, "vite.config.ts"))) throw new Error(`no simple-research-kernel example at ${example}`);
  const db = join(args.tmp, DB_FILE);
  if (!existsSync(db)) throw new Error(`no ${DB_FILE} in --tmp ${args.tmp} (the run profile copies apps/fixtures/viewer-ui/${DB_FILE} there)`);
  const realDb = canonicalPath(db);
  if (!realDb.startsWith(args.tmp + sep)) throw new Error(`${db} resolves to ${realDb}, outside --tmp ${args.tmp}`);

  const fixture = await openFixtureApi(args.root, realDb);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: api,
    fetch: (request) => fixture.fetch(request),
    error: (error) => {
      console.error(`viewer-ui fixture: ${error.message}`);
      return new Response("fixture error", { status: 500 });
    },
  });
  console.log(`viewer-ui fixture: read-only trace API on http://127.0.0.1:${server.port} over ${realDb} (kernel ${KERNEL_ID})`);

  const cmd = ["bun", "x", "--no-env-file", "vite", "--host", "127.0.0.1", "--port", String(ui), "--strictPort"];
  console.log(`viewer-ui fixture: ${cmd.join(" ")} (cwd ${example})`);
  const env = { ...process.env, API_TARGET: `http://127.0.0.1:${api}`, FRONTEND_PORT: String(ui) };
  const child = Bun.spawn(cmd, { cwd: example, env, stdio: ["ignore", "inherit", "inherit"] });
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    server.stop(true);
    fixture.close();
  };
  const forward = (signal: NodeJS.Signals) => () => {
    child.kill(signal);
    shutdown();
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  const code = await child.exited;
  shutdown();
  process.exit(code);
}

if (import.meta.main) await runFixture("viewer-ui fixture", main);
