/**
 * The OS sandbox every run process starts under. Real children run under the real profile; the owner
 * is a stand-in laid out like the real machine (a temp "home" holding the owner's tree, the mirror with
 * the design-system checkout and the run folder inside it, credential dirs, runtimes), never the real
 * owner. Test ports 46931-46936.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import { realHome, runPolicy, sandboxCommand, sandboxProfile, sandboxUnavailable, SandboxUnavailable, type SandboxPolicy } from "../scripts/lib/sandbox.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-sandbox-")));
const home = join(scratch, "home");
const owner = join(home, "workspace");
const root = join(home, "workspace-ds");
const ds = join(root, "design-system"); // the real layout: the checkout the tool runs from sits inside --root
const out = join(root, "rollout");
const runTmp = join(scratch, "run-tmp");
const sharedTmp = join(scratch, "shared-tmp"); // stands in for the system temp dir every run shares
const usrLocalBin = join(scratch, "usr-local", "bin"); // stands in for /usr/local/bin: owner-writable and on PATH
for (const dir of [owner, join(root, "app"), join(ds, "apps"), join(out, "runs"), runTmp, join(sharedTmp, "other-run"), join(home, ".codex"), join(home, ".bun", "bin"), join(home, "Library", "Caches", "ms-playwright"), join(home, "Documents")])
  mkdirSync(dir, { recursive: true });
writeFileSync(join(owner, "data.json"), "{}");
mkdirSync(usrLocalBin, { recursive: true });
writeFileSync(join(usrLocalBin, "git"), "#!/bin/sh\n", { mode: 0o755 });
for (const name of [".env", ".env.local", ".envrc", ".env-local", ".env_prod"]) writeFileSync(join(root, "app", name), "SECRET=1");
writeFileSync(join(root, "app", "config.json"), "{}");
writeFileSync(join(ds, "apps", "serve.ts"), "// fixture server");
writeFileSync(join(home, ".zsh_history"), "secret history");
writeFileSync(join(home, "Documents", "notes.txt"), "personal");
writeFileSync(join(home, ".codex", "auth.json"), "{}");
writeFileSync(join(home, ".bun", "bin", "tool"), "runtime");
writeFileSync(join(home, "Library", "Caches", "ms-playwright", "browser"), "runtime");

// 46931 the run's own block, 46932 an owner port inside the block, 46933 allowedLocalPorts,
// 46934 a listener the run did not start (an owner service it does not know about), 46936 free in the block.
const OWN = 46931;
const OWNER = 46932;
const ALLOWED = 46933;
const STRAY = 46934;
const OUTSIDE_BLOCK = 46935;
const FREE_IN_BLOCK = 46936;
let servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeAll(() => {
  servers = [OWN, OWNER, ALLOWED, STRAY].map((port) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("up") }));
});
afterAll(() => {
  for (const server of servers) server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const unavailable = sandboxUnavailable();
if (unavailable) console.warn(`skipping the sandbox tests: ${unavailable}`);

function policy(overrides: Partial<Parameters<typeof runPolicy>[0]> = {}): SandboxPolicy {
  const p = runPolicy({
    root,
    tmp: runTmp,
    outDir: out,
    home,
    ownerTree: owner,
    designSystem: ds,
    blockPorts: [OWN, OWNER, FREE_IN_BLOCK],
    allowedLocalPorts: [ALLOWED],
    deniedPorts: [OWNER],
    ...overrides,
  });
  return p;
}

/** Runs `sh -c script` under the policy; returns exit code and combined output. */
function sandboxed(script: string, p: SandboxPolicy = policy()): { code: number; output: string } {
  const result = Bun.spawnSync(sandboxCommand(p, ["/bin/sh", "-c", script]), { cwd: join(root, "app"), stderr: "pipe", stdout: "pipe" });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

/** One "ok <label>" / "denied <label>" line per shell test, in order. */
function verdicts(checks: Array<[label: string, shell: string]>, p?: SandboxPolicy): string[] {
  const script = checks.map(([label, shell]) => `(${shell}) >/dev/null 2>&1 && echo "ok ${label}" || echo "denied ${label}"`).join("; ");
  // Only the verdict lines: a shell may add its own warnings (getcwd outside the readable dirs).
  return sandboxed(script, p)
    .output.trim()
    .split("\n")
    .filter((line) => /^(ok|denied) /.test(line));
}

// --no-env-file: bun exits 1 without a word when the sandbox denies the .env files in its cwd.
const bind = (port: number) => `${process.execPath} --no-env-file -e 'Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("x") }).stop(true)'`;

describe.skipIf(Boolean(unavailable))("sandbox profile", () => {
  test("network: only the run's own block and allowedLocalPorts; never an owner port, another listener or a non-loopback address", () => {
    expect(
      verdicts([
        ["own", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWN}`],
        ["allowedLocalPorts", `/usr/bin/nc -z -G 2 127.0.0.1 ${ALLOWED}`],
        ["owner port in the block", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWNER}`],
        ["a listener the run did not start", `/usr/bin/nc -z -G 2 127.0.0.1 ${STRAY}`],
        ["non-loopback", "/usr/bin/nc -z -G 2 192.0.2.1 9"], // TEST-NET-1: refused before a packet leaves
      ]),
    ).toEqual(["ok own", "ok allowedLocalPorts", "denied owner port in the block", "denied a listener the run did not start", "denied non-loopback"]);
  });

  test("network: listening only on the block, never an owner port", () => {
    expect(
      verdicts([
        ["free port in the block", bind(FREE_IN_BLOCK)],
        ["outside the block", bind(OUTSIDE_BLOCK)],
        ["ephemeral port", bind(0)],
      ]),
    ).toEqual(["ok free port in the block", "denied outside the block", "denied ephemeral port"]);
  });

  test("Unix sockets: only those under the run's temp dir (and the system DNS/syslog sockets)", async () => {
    const outside = join(scratch, "owner.sock");
    const inside = join(runTmp, "run.sock");
    const listeners = [outside, inside].map((unix) => Bun.listen({ unix, socket: { data() {} } }));
    try {
      const connect = (path: string) => `/usr/bin/python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('${path}')"`;
      expect(
        verdicts([
          ["run tmp socket", connect(inside)],
          ["owner socket", connect(outside)],
          ["DNS", `/usr/bin/python3 -c "import socket; socket.getaddrinfo('localhost', ${OWN})"`],
        ]),
      ).toEqual(["ok run tmp socket", "denied owner socket", "ok DNS"]);
    } finally {
      for (const listener of listeners) listener.stop(true);
    }
  });

  test("writes: the root, the run's temp dir and the devices only; never the design-system checkout or the out dir inside the root, nothing on PATH, no other temp dir", () => {
    expect(
      verdicts([
        ["root", `echo x > '${join(root, "app", "out.txt")}'`],
        ["run tmp", `echo x > '${join(runTmp, "state")}'`],
        ["design-system", `echo x > '${join(ds, "apps", "planted")}'`],
        ["out dir log", `echo x > '${join(out, "log.txt")}'`],
        ["forged run record", `echo '{}' > '${join(out, "runs", "forged.json")}'`],
        ["owner tree", `echo x > '${join(owner, "planted")}'`],
        ["home", `echo x > '${join(home, ".zshrc")}'`],
        ["another run's temp dir", `echo x > '${join(sharedTmp, "other-run", "planted")}'`],
        ["shared temp dir", `echo x > '${join(sharedTmp, "planted")}'`],
        ["a tool on PATH", `echo 'echo planted' > '${join(usrLocalBin, "git")}'`],
        ["replacing a tool on PATH", `mv '${join(usrLocalBin, "git")}' '${join(usrLocalBin, "git.old")}'`],
        ["a new tool on PATH", `echo x > '${join(usrLocalBin, "ps")}'`],
        ["the real system temp dir", `echo x > '${join(realpathSync(tmpdir()), `ds-sandbox-planted-${process.pid}`)}'`],
        ["/dev/null", "echo x > /dev/null"],
        ["stderr by path", "echo x > /dev/stderr"],
      ]),
    ).toEqual([
      "ok root",
      "ok run tmp",
      "denied design-system",
      "denied out dir log",
      "denied forged run record",
      "denied owner tree",
      "denied home",
      "denied another run's temp dir",
      "denied shared temp dir",
      "denied a tool on PATH",
      "denied replacing a tool on PATH",
      "denied a new tool on PATH",
      "denied the real system temp dir",
      "ok /dev/null",
      "ok stderr by path",
    ]);
    expect(readFileSync(join(usrLocalBin, "git"), "utf8")).toBe("#!/bin/sh\n");
    expect(existsSync(join(realpathSync(tmpdir()), `ds-sandbox-planted-${process.pid}`))).toBe(false);
    for (const planted of [join(ds, "apps", "planted"), join(out, "runs", "forged.json"), join(owner, "planted"), join(sharedTmp, "planted")]) expect(existsSync(planted)).toBe(false);
  });

  test("reads under home: the root, the design-system checkout and the runtimes only; never personal files, credentials, the owner's tree or a .env file", () => {
    expect(
      verdicts([
        ["root file", `cat '${join(root, "app", "config.json")}'`],
        ["design-system", `cat '${join(ds, "apps", "serve.ts")}'`],
        ["runtime", `cat '${join(home, ".bun", "bin", "tool")}'`],
        ["browser cache", `cat '${join(home, "Library", "Caches", "ms-playwright", "browser")}'`],
        ["home realpath", `cd '${join(root, "app")}' && /bin/pwd -P`],
        ["shell history", `cat '${join(home, ".zsh_history")}'`],
        ["personal file", `cat '${join(home, "Documents", "notes.txt")}'`],
        ["home listing", `ls '${home}'`],
        ["credential store", `cat '${join(home, ".codex", "auth.json")}'`],
        ["owner tree", `cat '${join(owner, "data.json")}'`],
        ...[".env", ".env.local", ".envrc", ".env-local", ".env_prod"].map((name): [string, string] => [name, `cat ${name}`]),
      ]),
    ).toEqual([
      "ok root file",
      "ok design-system",
      "ok runtime",
      "ok browser cache",
      "ok home realpath",
      "denied shell history",
      "denied personal file",
      "denied home listing",
      "denied credential store",
      "denied owner tree",
      "denied .env",
      "denied .env.local",
      "denied .envrc",
      "denied .env-local",
      "denied .env_prod",
    ]);
  });

  test("signals: a run process can stop its own children, never a process outside the sandbox", async () => {
    const outside = Bun.spawn(["sleep", "30"]);
    try {
      expect(verdicts([["outside", `kill -TERM ${outside.pid}`], ["own child", "sleep 30 & kill -TERM $!"]])).toEqual(["denied outside", "ok own child"]);
      expect(outside.exitCode).toBeNull();
    } finally {
      outside.kill("SIGKILL");
    }
  });

  test("the tree's own design-system checkout stays read-only when the tool runs from another checkout (a tooling worktree)", () => {
    const worktree = join(root, ".tooling", "worktree"); // the checkout the tool runs from, inside --root
    mkdirSync(join(worktree, "scripts"), { recursive: true });
    expect(
      verdicts(
        [
          ["tree's design-system", `echo x > '${join(ds, "apps", "planted")}'`],
          ["tree's design-system read", `cat '${join(ds, "apps", "serve.ts")}'`],
          ["tool's checkout", `echo x > '${join(worktree, "scripts", "planted")}'`],
          ["root", `echo x > '${join(root, "app", "out2.txt")}'`],
        ],
        policy({ designSystem: worktree }),
      ),
    ).toEqual(["denied tree's design-system", "ok tree's design-system read", "denied tool's checkout", "ok root"]);
    expect(existsSync(join(ds, "apps", "planted"))).toBe(false);
  });

  test("the design-system checkout stays readable inside a hidden owner tree (a tool run from the owner's checkout), never writable", () => {
    const ownerDs = join(owner, "design-system");
    mkdirSync(join(ownerDs, "apps"), { recursive: true });
    writeFileSync(join(ownerDs, "apps", "serve.ts"), "// fixture server");
    writeFileSync(join(ownerDs, ".env"), "SECRET=3");
    expect(
      verdicts(
        [
          ["read", `cat '${join(ownerDs, "apps", "serve.ts")}'`],
          ["env", `cat '${join(ownerDs, ".env")}'`],
          ["write", `echo x > '${join(ownerDs, "apps", "planted")}'`],
          ["owner", `cat '${join(owner, "data.json")}'`],
        ],
        policy({ designSystem: ownerDs }),
      ),
    ).toEqual(["ok read", "denied env", "denied write", "denied owner"]);
  });

  test("a run whose --root is the owner's tree may read and write it", () => {
    expect(verdicts([["owner", `cat '${join(owner, "data.json")}' && echo x > '${join(owner, "written")}'`]], policy({ root: owner }))).toEqual(["ok owner"]);
  });

  test("a home given by a symlinked spelling (/var for /private/var) is still enforced", () => {
    const spelled = join(tmpdir(), basename(scratch), "home");
    expect(spelled).not.toBe(home); // tmpdir() is the /var/folders spelling on macOS
    const p: SandboxPolicy = { home: spelled, writable: [], hidden: [], deniedPorts: [] };
    expect(sandboxed(`(echo x > '${join(home, "planted")}') 2>/dev/null && echo written || echo denied`, p).output.trim()).toBe("denied");
  });
});

const python = Bun.which("python3");

describe.skipIf(Boolean(unavailable) || !python)("network rule shapes (Seatbelt workarounds)", () => {
  test("every tool-test port block: its own ports bind and connect, other ports, port 0 and foreign Unix sockets do not", () => {
    // Per-port allow rules in other shapes made the kernel deny some allowed ports (see sandbox.ts).
    // Only 46900-46939 (this suite's own range) are touched; the scan over 47000-47259 is in the report.
    const outsideSocket = join(scratch, "foreign.sock");
    const listener = Bun.listen({ unix: outsideSocket, socket: { data() {} } });
    const failures: string[] = [];
    try {
      for (const start of [46900, 46910, 46920, 46930]) {
        const block = Array.from({ length: 10 }, (_, i) => start + i);
        const outside = [start === 46930 ? 46929 : start + 10, start === 46900 ? 46939 : start - 1];
        const p = policy({ blockPorts: block, allowedLocalPorts: [], deniedPorts: [] });
        const probe = Bun.spawnSync(sandboxCommand(p, [python!, join(import.meta.dir, "fixtures/runner/portprobe.py"), block.join(","), outside.join(","), runTmp, outsideSocket]), {
          cwd: runTmp,
          stdout: "pipe",
          stderr: "pipe",
        });
        const verdict = probe.stdout.toString().trim() || probe.stderr.toString().trim();
        if (verdict !== "all-ok") failures.push(`${start}: ${verdict}`);
      }
    } finally {
      listener.stop(true);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test("Unix-socket rules come before the IP rules; binding is one negated deny rule", () => {
    const lines = sandboxProfile(policy()).split("\n");
    const lastUnix = lines.findLastIndex((line) => line.includes("(remote unix-socket"));
    const firstIp = lines.findIndex((line) => line.includes("(remote ip "));
    expect(lastUnix).toBeGreaterThan(-1);
    expect(lastUnix).toBeLessThan(firstIp);
    const bind = lines.filter((line) => line.includes("network-bind"));
    expect(bind).toEqual([expect.stringMatching(/^\(deny network-bind \(require-not \(require-any \(local ip "localhost:46931"\)/)]);
  });
});

test("the profile lists the block's ports and never an owner port among them", () => {
  const text = sandboxProfile(policy());
  expect(text).toContain(`(allow network-outbound (remote ip "localhost:${OWN}"))`);
  expect(text).toContain(`(allow network-outbound (remote ip "localhost:${ALLOWED}"))`);
  expect(text).not.toContain(`localhost:${OWNER}"))`);
  expect(text).toContain(`(local ip "localhost:${FREE_IN_BLOCK}")`);
  expect(text).not.toContain(`(local ip "localhost:${ALLOWED}")`);
});

describe.skipIf(Boolean(unavailable) || !Bun.which("python3"))("anyLoopback (test suites that start their own servers)", () => {
  test("a suite binds and reaches its own ephemeral port; owner ports and the listeners it found at start stay denied", () => {
    // STRAY stands in for a listener test:apps saw before the run started: it passes it as extraDeniedPorts.
    const p = policy({ anyLoopback: true, extraDeniedPorts: [STRAY] });
    const selfServe = `python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(); c = socket.socket(); c.connect(s.getsockname())"`;
    expect(
      verdicts(
        [
          ["own ephemeral server", selfServe],
          ["block port", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWN}`],
          ["listener found at start", `/usr/bin/nc -z -G 2 127.0.0.1 ${STRAY}`],
          ["owner port", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWNER}`],
          ["non-loopback", "/usr/bin/nc -z -G 2 192.0.2.1 9"],
        ],
        p,
      ),
    ).toEqual(["ok own ephemeral server", "ok block port", "denied listener found at start", "denied owner port", "denied non-loopback"]);
    expect(sandboxProfile(p)).toContain(`(deny network-bind (local ip "localhost:${STRAY}"))`);
  });
});

test("realHome reads the user database, not $HOME", () => {
  const fake = join(scratch, "fake-home");
  mkdirSync(fake, { recursive: true });
  const probe = spawnSync(process.execPath, ["-e", `import("${join(import.meta.dir, "../scripts/lib/sandbox.ts")}").then((m) => console.log(m.realHome()))`], {
    encoding: "utf8",
    env: { ...process.env, HOME: fake },
  });
  expect(probe.stdout.trim()).toBe(realHome());
  expect(probe.stdout.trim()).not.toBe(fake);
  expect(realHome()).toMatch(/^\/Users\/[^/]+$/);
});

test("fails closed when sandbox-exec is missing", () => {
  expect(() => sandboxCommand(policy(), ["/usr/bin/true"], join(scratch, "no-sandbox-exec"))).toThrow(SandboxUnavailable);
});
