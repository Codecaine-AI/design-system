/**
 * The viewer-ui trace fixture (apps/fixtures/viewer-ui/serve.ts): the launcher refuses a --tmp inside a
 * git checkout before it opens or starts anything; its API answers 405 to every method but GET and HEAD
 * and leaves the DB byte-identical; and it serves the fixture container, holding every row the
 * registry's viewer-ui routes name. The API tests read the root's agent-kernel sources (they skip
 * without the workspace checkout; set DS_MIRROR in a worktree outside it).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DB_FILE, KERNEL_ID, openFixtureApi, type FixtureApi } from "../apps/fixtures/viewer-ui/serve.ts";
import { getApp, loadRegistry } from "../scripts/lib/registry";
import { PKG, workspaceRoot } from "./support";

const SERVE = join(PKG, "apps/fixtures/viewer-ui/serve.ts");
const FIXTURE_DB = join(PKG, "apps/fixtures/viewer-ui", DB_FILE);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-fixture-viewer-ui-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const app = getApp(loadRegistry(), "viewer-ui");
/** The container every route opens (`/traces?traceId=<id>`). */
const containerId = new URL(app.routes[0]!.path, "http://x").searchParams.get("traceId")!;
/** Every row id (data-span-id, data-span-row) a route step or waitFor names. */
const spanTargets = [...new Set(app.routes.flatMap((r) => [r.waitFor, ...(r.steps ?? []).map((s) => s.target)]).flatMap((s) => [...(s ?? "").matchAll(/data-span-(?:id|row)="([^"]+)"/g)].map((m) => m[1]!)))];

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("the launcher refuses a --tmp inside a git checkout before it starts anything", () => {
  const repo = join(scratch, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const tmp = join(repo, "run");
  const proc = Bun.spawnSync(["bun", "--no-env-file", SERVE, "--root", scratch, "--tmp", tmp, "--api-port", "46991", "--ui-port", "46992"], { stderr: "pipe", stdout: "pipe" });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain("inside the git checkout");
  expect(existsSync(tmp)).toBe(false);
});

const root = workspaceRoot();
const haveKernel = root !== null && existsSync(join(root, "codecaine/core/agent-kernel/packages/kernel/src/read-api.ts"));

describe.skipIf(!haveKernel)("the fixture API (skips without the workspace checkout)", () => {
  const db = join(scratch, "api", DB_FILE);
  let api: FixtureApi;
  let before: string;
  const get = async (path: string, method = "GET") => api.fetch(new Request(`http://127.0.0.1${path}`, { method }));

  beforeAll(async () => {
    mkdirSync(join(scratch, "api"), { recursive: true });
    copyFileSync(FIXTURE_DB, db);
    before = sha(db);
    api = await openFixtureApi(root!, db);
  });
  afterAll(() => api?.close());

  test.each(["POST", "PUT", "PATCH", "DELETE"])("answers 405 to %s on the app's write routes and the read routes", async (method) => {
    for (const path of ["/api/run", `/api/traces/${containerId}`, "/api/backfill", `/kernel/trace-sessions/${containerId}`, "/kernel/agents/x/prompt"]) {
      const response = await get(path, method);
      expect([path, response.status]).toEqual([path, 405]);
    }
  });

  test("lists the fixture container as the one trace session", async () => {
    const list = (await (await get("/kernel/trace-sessions")).json()) as { trace_sessions: Array<{ id: string; kind: string }> };
    expect(list.trace_sessions.map((t) => [t.id, t.kind])).toEqual([[containerId, "session"]]);
  });

  test("serves the container trace, holding every row the routes name", async () => {
    const response = await get(`/kernel/trace-sessions/${containerId}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as {
      session: { id: string };
      pi_sessions: Array<{ id: string }>;
      agent_runs: Array<{ id: string }>;
      events: Array<{ eventId: string }>;
    };
    expect(detail.session.id).toBe(containerId);
    const sessions = new Set(detail.pi_sessions.map((s) => s.id));
    const runs = new Set(detail.agent_runs.map((r) => r.id));
    const events = new Set(detail.events.map((e) => e.eventId));
    const missing = spanTargets.filter((target) => {
      if (target.startsWith("pi:")) return !sessions.has(target.slice(3));
      if (target.startsWith("attempt:")) return !runs.has(target.slice(8));
      return !events.has(target);
    });
    expect(spanTargets.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("answers HEAD without a body, the research stub with no agents or runs, and a clean doctor", async () => {
    const head = await get("/kernel/trace-sessions", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const info = (await (await get("/api/research")).json()) as { kernelId: string; agents: unknown[]; activeRuns: unknown[] };
    expect(info).toMatchObject({ kernelId: KERNEL_ID, agents: [], activeRuns: [] });
    const doctor = (await (await get("/api/doctor")).json()) as { ok: boolean; violations: unknown[] };
    expect(doctor).toMatchObject({ ok: true, violations: [] });
  });

  test("leaves the DB byte-identical, with no journal beside it", async () => {
    await get(`/kernel/trace-sessions/${containerId}`);
    expect(sha(db)).toBe(before);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(db + suffix)).toBe(false);
  });
});
