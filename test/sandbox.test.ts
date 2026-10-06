/**
 * The OS sandbox every run process starts under. Real children run under the real profile; the owner
 * is a stand-in (a temp "home" and "owner tree", test ports 46930-46931), never the real owner.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { runPolicy, sandboxCommand, sandboxUnavailable, SandboxUnavailable, type SandboxPolicy } from "../scripts/lib/sandbox.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-sandbox-")));
const home = join(scratch, "home");
const owner = join(home, "workspace");
const root = join(home, "workspace-ds");
const runTmp = join(scratch, "run-tmp");
const out = join(root, "rollout");
for (const dir of [owner, join(root, "app"), runTmp, out]) mkdirSync(dir, { recursive: true });
writeFileSync(join(owner, "data.json"), "{}");
writeFileSync(join(root, "app", ".env"), "SECRET=1");
writeFileSync(join(root, "app", ".env.local"), "SECRET=2");
writeFileSync(join(root, "app", "config.json"), "{}");

const DENIED = 46930;
const ALLOWED = 46931;
let servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeAll(() => {
  servers = [DENIED, ALLOWED].map((port) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("up") }));
});
afterAll(() => {
  for (const server of servers) server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const unavailable = sandboxUnavailable();
if (unavailable) console.warn(`skipping the sandbox tests: ${unavailable}`);

function policy(): SandboxPolicy {
  return runPolicy({ root, tmp: runTmp, outDir: out, home, ownerTree: owner, deniedPorts: [DENIED] });
}

/** Runs `sh -c script` under the policy; returns exit code and combined output. */
function sandboxed(script: string, p: SandboxPolicy = policy()): { code: number; output: string } {
  const result = Bun.spawnSync(sandboxCommand(p, ["/bin/sh", "-c", script]), { cwd: join(root, "app"), stderr: "pipe", stdout: "pipe" });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe.skipIf(Boolean(unavailable))("sandbox profile", () => {
  test("a run process reaches allowed loopback ports but never a denied port or a non-loopback address", () => {
    const allowed = sandboxed(`/usr/bin/nc -v -z -G 2 127.0.0.1 ${ALLOWED}`);
    expect(allowed).toMatchObject({ code: 0 });
    // Both test ports are listening: the only thing that can stop these connects is the sandbox.
    const denied = sandboxed(`/usr/bin/nc -v -z -G 2 127.0.0.1 ${DENIED}`);
    expect(denied.output).toContain("Operation not permitted");
    const external = sandboxed("/usr/bin/nc -v -z -G 2 192.0.2.1 9"); // TEST-NET-1: denied before a packet leaves
    expect(external.output).toContain("Operation not permitted");
  });

  test("writes under the real home land only in the root, the run folder and the run's temp dir", () => {
    const writes = sandboxed(
      [`${join(owner, "planted")}`, `${join(home, ".zshrc")}`, `${join(root, "app", "out.txt")}`, `${join(out, "log.txt")}`, `${join(runTmp, "state")}`]
        .map((path) => `(echo x > '${path}') 2>/dev/null && echo "ok ${path}" || echo "denied ${path}"`)
        .join("; "),
    );
    expect(writes.output.trim().split("\n")).toEqual([
      `denied ${join(owner, "planted")}`,
      `denied ${join(home, ".zshrc")}`,
      `ok ${join(root, "app", "out.txt")}`,
      `ok ${join(out, "log.txt")}`,
      `ok ${join(runTmp, "state")}`,
    ]);
    expect(existsSync(join(owner, "planted"))).toBe(false);
  });

  test("no run process reads a .env file or the owner's tree; ordinary files stay readable", () => {
    const reads = sandboxed(
      [".env", ".env.local", "config.json", join(owner, "data.json")]
        .map((path) => `cat '${path}' >/dev/null 2>&1 && echo "ok ${path}" || echo "denied ${path}"`)
        .join("; "),
    );
    expect(reads.output.trim().split("\n")).toEqual(["denied .env", "denied .env.local", "ok config.json", `denied ${join(owner, "data.json")}`]);
  });

  test("a run whose --root is the owner's tree may read and write it", () => {
    const ownerRun = runPolicy({ root: owner, tmp: runTmp, outDir: out, home, ownerTree: owner, deniedPorts: [DENIED] });
    expect(sandboxed(`cat '${join(owner, "data.json")}' && echo x > '${join(owner, "written")}' && echo done`, ownerRun).output).toContain("done");
  });

  test("a home given by a symlinked spelling (/var for /private/var) is still enforced", () => {
    const spelled = join(tmpdir(), basename(scratch), "home");
    expect(spelled).not.toBe(home); // tmpdir() is the /var/folders spelling on macOS
    const p: SandboxPolicy = { home: spelled, writable: [], hidden: [], deniedPorts: [] };
    expect(sandboxed(`(echo x > '${join(home, "planted")}') 2>/dev/null && echo written || echo denied`, p).output.trim()).toBe("denied");
  });
});

test("fails closed when sandbox-exec is missing", () => {
  expect(() => sandboxCommand(policy(), ["/usr/bin/true"], join(scratch, "no-sandbox-exec"))).toThrow(SandboxUnavailable);
});
