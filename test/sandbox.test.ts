/**
 * The OS sandbox every run process starts under. Real children run under the real profile; the owner
 * is a stand-in laid out like the real machine (a temp "home" holding the owner's tree, the mirror with
 * the design-system checkout, the run folder, .tooling, .bun-global and Core's node_modules inside it,
 * credential dirs, runtimes), never the real owner. Test ports 46931-46936.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  browserPolicy,
  EPHEMERAL_PORTS,
  packPolicy,
  realHome,
  runPolicy,
  sandboxCommand,
  sandboxProfile,
  sandboxUnavailable,
  SandboxUnavailable,
  type SandboxPolicy,
} from "../scripts/lib/sandbox.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-sandbox-")));
const home = join(scratch, "home");
const owner = join(home, "workspace");
const root = join(home, "workspace-ds");
const ds = join(root, "design-system"); // the real layout: the checkout the tool runs from sits inside --root
const out = join(root, "rollout"); // the run folder, which is also the tool's out dir
const app = join(root, "app"); // the app's own checkout: the only dir under --root a run may write
const vendor = join(app, "vendor"); // another repository's checkout nested in the app's (read-only, appScope)
const sibling = join(root, "other"); // another app's checkout
const tooling = join(root, ".tooling", "wt"); // a tooling worktree
const bunGlobal = join(root, ".bun-global", "bin");
const core = join(root, "codecaine", "core");
const playwrightPkg = join(core, "node_modules", "playwright");
const playwrightCore = join(core, "node_modules", "playwright-core");
const runTmp = join(scratch, "run-tmp");
const sharedTmp = join(scratch, "shared-tmp"); // stands in for the system temp dir every run shares
const usrLocalBin = join(scratch, "usr-local", "bin"); // stands in for /usr/local/bin: owner-writable and on PATH
for (const dir of [
  owner,
  join(app, ".git"),
  vendor,
  sibling,
  join(ds, "apps"),
  join(out, "runs"),
  join(tooling, "scripts"),
  bunGlobal,
  join(core, "docs-system", "packages", "docs-workbench"),
  playwrightPkg,
  playwrightCore,
  runTmp,
  join(sharedTmp, "other-run"),
  join(home, ".codex"),
  join(home, ".bun", "bin"),
  join(home, "Library", "Caches", "ms-playwright"),
  join(home, "Documents"),
])
  mkdirSync(dir, { recursive: true });
writeFileSync(join(owner, "data.json"), "{}");
mkdirSync(usrLocalBin, { recursive: true });
writeFileSync(join(usrLocalBin, "git"), "#!/bin/sh\n", { mode: 0o755 });
for (const name of [".env", ".env.local", ".envrc", ".env-local", ".env_prod"]) writeFileSync(join(app, name), "SECRET=1");
writeFileSync(join(app, "config.json"), "{}");
writeFileSync(join(app, ".git", "config"), "[core]\n");
writeFileSync(join(vendor, ".git"), "gitdir: /nowhere\n");
writeFileSync(join(ds, "apps", "serve.ts"), "// fixture server");
writeFileSync(join(out, "run.env"), "export DS_RUN=x\n");
writeFileSync(join(core, "docs-system", "packages", "docs-workbench", "package.json"), "{}");
for (const [dir, name] of [
  [playwrightPkg, "playwright"],
  [playwrightCore, "playwright-core"],
] as const) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}
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
    writable: [app],
    readOnly: [vendor],
    blockPorts: [OWN, OWNER, FREE_IN_BLOCK],
    allowedLocalPorts: [ALLOWED],
    deniedPorts: [OWNER],
    ...overrides,
  });
  return p;
}

/** Runs `sh -c script` under the policy; returns exit code and combined output. */
function sandboxed(script: string, p: SandboxPolicy = policy(), params: Record<string, string> = {}): { code: number; output: string } {
  const result = Bun.spawnSync(sandboxCommand(p, ["/bin/sh", "-c", script], undefined, params), { cwd: app, stderr: "pipe", stdout: "pipe" });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

/** One "ok <label>" / "denied <label>" line per shell test, in order. */
function verdicts(checks: Array<[label: string, shell: string]>, p?: SandboxPolicy, params?: Record<string, string>): string[] {
  const script = checks.map(([label, shell]) => `(${shell}) >/dev/null 2>&1 && echo "ok ${label}" || echo "denied ${label}"`).join("; ");
  // Only the verdict lines: a shell may add its own warnings (getcwd outside the readable dirs).
  return sandboxed(script, p, params)
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

  test("writes: the app's own checkout, the run's temp dir and the devices only; nothing else under --root, nothing on PATH, no other temp dir", () => {
    expect(
      verdicts([
        ["own checkout", `echo x > '${join(app, "out.txt")}'`],
        ["run tmp", `echo x > '${join(runTmp, "state")}'`],
        ["the root itself", `echo x > '${join(root, "planted")}'`],
        ["another app's checkout", `echo x > '${join(sibling, "planted")}'`],
        ["a checkout nested in the app's", `echo x > '${join(vendor, "planted")}'`],
        ["design-system", `echo x > '${join(ds, "apps", "planted")}'`],
        ["run folder (run.env)", `echo 'echo pwned' >> '${join(out, "run.env")}'`],
        ["forged run record", `echo '{}' > '${join(out, "runs", "forged.json")}'`],
        ["a tooling worktree", `echo x > '${join(tooling, "scripts", "planted")}'`],
        [".bun-global", `echo x > '${join(bunGlobal, "planted")}'`],
        ["Core node_modules", `echo x > '${join(core, "node_modules", "planted")}'`],
        ["Playwright", `echo 'require("/tmp/x")' >> '${join(playwrightPkg, "index.js")}'`],
        ["playwright-core", `echo x > '${join(playwrightCore, "planted.js")}'`],
        ["the checkout's .git config", `echo '[core] fsmonitor = /tmp/x' >> '${join(app, ".git", "config")}'`],
        ["replacing the .git entry", `mv '${join(app, ".git")}' '${join(app, "git-old")}'`],
        ["a new .git in a subfolder", `mkdir -p '${join(app, "sub")}' && echo 'gitdir: /tmp/x' > '${join(app, "sub", ".git")}'`],
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
      "ok own checkout",
      "ok run tmp",
      "denied the root itself",
      "denied another app's checkout",
      "denied a checkout nested in the app's",
      "denied design-system",
      "denied run folder (run.env)",
      "denied forged run record",
      "denied a tooling worktree",
      "denied .bun-global",
      "denied Core node_modules",
      "denied Playwright",
      "denied playwright-core",
      "denied the checkout's .git config",
      "denied replacing the .git entry",
      "denied a new .git in a subfolder",
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
    expect(readFileSync(join(out, "run.env"), "utf8")).toBe("export DS_RUN=x\n");
    expect(readFileSync(join(playwrightPkg, "index.js"), "utf8")).toBe("module.exports = {};\n");
    expect(readFileSync(join(app, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(existsSync(join(realpathSync(tmpdir()), `ds-sandbox-planted-${process.pid}`))).toBe(false);
    for (const planted of [join(root, "planted"), join(ds, "apps", "planted"), join(out, "runs", "forged.json"), join(tooling, "scripts", "planted"), join(owner, "planted"), join(sharedTmp, "planted"), join(app, "sub", ".git")])
      expect(existsSync(planted)).toBe(false);
  });

  test("without `writable` a run writes only its temp dir, not even an app checkout", () => {
    expect(
      verdicts(
        [
          ["app", `echo x > '${join(app, "out3.txt")}'`],
          ["run tmp", `echo x > '${join(runTmp, "state2")}'`],
        ],
        policy({ writable: undefined }),
      ),
    ).toEqual(["denied app", "ok run tmp"]);
  });

  test("reads under home: the root, the design-system checkout and the runtimes only; never personal files, credentials, the owner's tree or a .env file", () => {
    expect(
      verdicts([
        ["root file", `cat '${join(app, "config.json")}'`],
        ["design-system", `cat '${join(ds, "apps", "serve.ts")}'`],
        ["runtime", `cat '${join(home, ".bun", "bin", "tool")}'`],
        ["browser cache", `cat '${join(home, "Library", "Caches", "ms-playwright", "browser")}'`],
        ["home realpath", `cd '${app}' && /bin/pwd -P`],
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
          ["own checkout", `echo x > '${join(app, "out2.txt")}'`],
        ],
        policy({ designSystem: worktree }),
      ),
    ).toEqual(["denied tree's design-system", "ok tree's design-system read", "denied tool's checkout", "ok own checkout"]);
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

  test("a run whose --root is the owner's tree may read it, and write only the app's checkout there", () => {
    const ownerApp = join(owner, "app");
    mkdirSync(ownerApp, { recursive: true });
    expect(
      verdicts(
        [
          ["owner read", `cat '${join(owner, "data.json")}'`],
          ["owner app write", `echo x > '${join(ownerApp, "written")}'`],
          ["owner elsewhere", `echo x > '${join(owner, "written")}'`],
        ],
        policy({ root: owner, writable: [ownerApp] }),
      ),
    ).toEqual(["ok owner read", "ok owner app write", "denied owner elsewhere"]);
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

describe.skipIf(Boolean(unavailable) || !Bun.which("python3"))("suiteNetwork (decision 31: test suites)", () => {
  test("connects only to the block and 49152-65535 minus the listeners found at start; owner ports never; binds anywhere but those", async () => {
    // An ephemeral-range listener present at start (a stand-in for an owner service on a high port).
    const highListener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owner") });
    try {
      const high = highListener.port!;
      expect(high).toBeGreaterThanOrEqual(EPHEMERAL_PORTS.min);
      const p = policy({ suiteNetwork: { listeners: [STRAY, high] } });
      const block = [OWN, OWNER, FREE_IN_BLOCK];
      const probe = Bun.spawnSync(
        sandboxCommand(p, [Bun.which("python3")!, join(import.meta.dir, "fixtures/runner/suiteprobe.py"), [OWN, FREE_IN_BLOCK, `${EPHEMERAL_PORTS.min}-${EPHEMERAL_PORTS.max}`].join(","), [OWNER, STRAY, high, ALLOWED, OUTSIDE_BLOCK, 46937, 3000, 49151].join(",")]),
        { cwd: runTmp, stdout: "pipe", stderr: "pipe" },
      );
      expect(probe.stdout.toString().trim() || probe.stderr.toString().trim()).toBe("all-ok");
      const text = sandboxProfile(p);
      expect(text).toContain(`(allow network-outbound (remote ip "localhost:${EPHEMERAL_PORTS.max}"))`);
      expect(text).not.toContain(`(remote ip "localhost:${high}")`);
      for (const port of [STRAY, high, OWNER]) expect(text).toContain(`(deny network-bind (local ip "localhost:${port}"))`);
      expect(block.every((port) => port !== high)).toBe(true);
    } finally {
      highListener.stop(true);
    }
  }, 120_000);

  test("the suite profile is too long for argv: sandbox-exec reads it from a file the run cannot write", () => {
    const argv = sandboxCommand(policy({ suiteNetwork: { listeners: [] } }), ["/usr/bin/true"]);
    expect(argv[1]).toBe("-f");
    expect(readFileSync(argv[2]!, "utf8")).toContain("(version 1)");
    expect(
      verdicts([["profile file", `echo x >> '${argv[2]}'`]], policy()),
    ).toEqual(["denied profile file"]);
  });
});

describe.skipIf(Boolean(unavailable))("services: LaunchServices, AppleEvents, cfprefsd", () => {
  test("every profile denies lsopen, AppleEvents and the cfprefsd and LaunchServices lookups", () => {
    for (const text of [sandboxProfile(policy()), sandboxProfile(packPolicy({ packageRoot: ds, staging: runTmp, npmHome: runTmp, home, ownerTree: owner })), sandboxProfile(browserPolicy({ browserHome: runTmp, connectPorts: [OWN], home, ownerTree: owner }))]) {
      expect(text).toContain("(deny lsopen)");
      expect(text).toContain("(deny appleevent-send)");
      for (const name of ['(global-name "com.apple.cfprefsd.daemon")', '(global-name "com.apple.cfprefsd.agent")', '(global-name "com.apple.coreservices.launchservicesd")', '(global-name-prefix "com.apple.lsd.")'])
        expect(text).toContain(name);
    }
  });

  test("preferences are out of reach: cfprefsd cannot read them for the run (a read-only probe, `defaults read`)", () => {
    // With the real home, as a real run has it. Without the lookup denial cfprefsd would read
    // ~/Library/Preferences for the run, past the file rules (and write it for `defaults write`).
    // Only a read is probed here: a write that got through would land in the owner's ~/Library.
    const p = runPolicy({ root, tmp: runTmp, outDir: out, home: realHome(), ownerTree: owner, designSystem: ds, writable: [app], blockPorts: [OWN] });
    const result = Bun.spawnSync(sandboxCommand(p, ["/usr/bin/defaults", "read", "-g", "AppleLocale"]), { cwd: runTmp, stdout: "pipe", stderr: "pipe" });
    expect([result.exitCode, result.stdout.toString().trim()]).toEqual([1, ""]);
  });
});

describe.skipIf(Boolean(unavailable))("packPolicy (decision 31: npm pack)", () => {
  const staging = join(scratch, "pack-staging");
  const npmHome = join(scratch, "pack-home");
  mkdirSync(staging, { recursive: true });
  mkdirSync(npmHome, { recursive: true });
  const p = () => packPolicy({ packageRoot: ds, staging, npmHome, home, ownerTree: owner });

  test("writes only the staging dir and npm's HOME; reads the package; no network at all", () => {
    expect(
      verdicts(
        [
          ["staging", `echo x > '${join(staging, "pkg.tgz")}'`],
          ["npm home", `echo x > '${join(npmHome, "cache")}'`],
          ["package read", `cat '${join(ds, "apps", "serve.ts")}'`],
          ["package write", `echo x > '${join(ds, "apps", "planted")}'`],
          ["an app checkout", `echo x > '${join(app, "planted")}'`],
          ["run tmp", `echo x > '${join(runTmp, "planted")}'`],
          ["loopback", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWN}`],
          ["non-loopback", "/usr/bin/nc -z -G 2 192.0.2.1 9"],
          ["DNS", `/usr/bin/python3 -c "import socket; socket.getaddrinfo('localhost', ${OWN})"`],
          ["credential store", `cat '${join(home, ".codex", "auth.json")}'`],
          ["owner tree", `cat '${join(owner, "data.json")}'`],
        ],
        p(),
      ),
    ).toEqual([
      "ok staging",
      "ok npm home",
      "ok package read",
      "denied package write",
      "denied an app checkout",
      "denied run tmp",
      "denied loopback",
      "denied non-loopback",
      "denied DNS",
      "denied credential store",
      "denied owner tree",
    ]);
  });
});

describe.skipIf(Boolean(unavailable))("browserPolicy (decision 29: Chromium)", () => {
  test("connects only to the given ports, listens nowhere, writes only its own dirs, reads under home only the browser cache", () => {
    const browserHome = join(scratch, "browser-home");
    const profileDir = join(scratch, "browser-profile"); // Playwright's --user-data-dir, passed as -D DS_PROFILE_DIR
    mkdirSync(browserHome, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const p = browserPolicy({ browserHome, connectPorts: [OWN], home, ownerTree: owner, deniedPorts: [OWNER] });
    expect(
      verdicts(
        [
          ["run port", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWN}`],
          ["another listener", `/usr/bin/nc -z -G 2 127.0.0.1 ${STRAY}`],
          ["owner port", `/usr/bin/nc -z -G 2 127.0.0.1 ${OWNER}`],
          ["listen", bind(FREE_IN_BLOCK)],
          ["own home", `echo x > '${join(browserHome, "state")}'`],
          ["its profile dir", `echo x > '${join(profileDir, "Local State")}'`],
          ["root", `echo x > '${join(app, "planted-by-browser")}'`],
          ["browser cache", `cat '${join(home, "Library", "Caches", "ms-playwright", "browser")}'`],
          ["root read", `cat '${join(app, "config.json")}'`],
        ],
        p,
        { DS_PROFILE_DIR: profileDir },
      ),
    ).toEqual(["ok run port", "denied another listener", "denied owner port", "denied listen", "ok own home", "ok its profile dir", "denied root", "ok browser cache", "denied root read"]);
    expect(() => sandboxCommand(p, ["/usr/bin/true"])).toThrow(/DS_PROFILE_DIR/);
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
