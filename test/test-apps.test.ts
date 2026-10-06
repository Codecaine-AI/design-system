/**
 * test:apps runs an app's safe tests the one way the rollout allows: profile environment, OS sandbox, a
 * write check around each command, and a comparison with the registry's recorded baseline. A stand-in app
 * in a temp workspace (a Core-like checkout holding the app's checkout and a sibling) prints the output of
 * each runner and makes each kind of write; the CLI is run on it with a stand-in registry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppEntry, TestBaseline } from "../scripts/lib/registry.ts";
import { realHome } from "../scripts/lib/safe-paths.ts";
import { sandboxUnavailable } from "../scripts/lib/sandbox.ts";
import { parseArgs } from "../scripts/test-apps.ts";
import { assertNoLeaks } from "./leaks.ts";
import { PKG } from "./support.ts";

const STANDIN = String.raw`
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
const [mode, arg] = process.argv.slice(2);
const write = (path, text = "x") => (mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, text));
const bunSummary = (pass, fail) => " " + pass + " pass\n " + fail + " fail\nRan " + (pass + fail) + " tests across 1 file. [5.00ms]";
switch (mode) {
  case "pass": console.log("(pass) s > a [0.10ms]\n" + bunSummary(3, 0)); break;
  // A suite that lost a test file: still green, one test fewer.
  case "fewer": console.log(bunSummary(2, 0)); break;
  case "known-fail": console.error("(fail) s > a [0.10ms]\n" + bunSummary(2, 1)); process.exit(1);
  // bun 1.4's own layout for an error outside a test: the file header, a code frame, then the error line.
  case "unhandled":
    console.error("a.test.ts:\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test } from \"bun:test\";\n2 | throw new TypeError(\"boom\");\n              ^\nTypeError: boom in " + process.cwd() + "/a.test.ts\n      at " + process.cwd() + "/a.test.ts:2:11\n-------------------------------\n\n" + bunSummary(0, 1) + "\n 1 error");
    process.exit(1);
  case "new-fail": console.error("(fail) s > a [0.10ms]\n(fail) s > b [0.20ms]\n" + bunSummary(1, 2)); process.exit(1);
  // vitest 3's layout: a file that cannot load is "FAIL  <file> [ <file> ]" and counts only under Test Files.
  case "vitest-new": console.log(" FAIL  src/b.test.ts [ src/b.test.ts ]\nError: Cannot find module './missing.js'\n FAIL  src/a.test.ts > s > old\n FAIL  src/a.test.ts > s > fresh\n\n Test Files  2 failed (2)\n      Tests  2 failed | 5 passed (7)"); process.exit(1);
  case "unittest-known": console.error("FAIL: test_x (m.C.test_x)\n----\nRan 4 tests in 0.010s\n\nFAILED (failures=1)"); process.exit(1);
  case "tsc": console.log("src/a.ts(40,3): error TS2322: Type 'x' is not assignable to type 'y'.\nsrc/b.ts(1,1): error TS2304: Cannot find name 'z'."); process.exit(2);
  case "write-tracked": appendFileSync("tracked.txt", "more\n"); console.log(bunSummary(1, 0)); break;
  case "write-ignored": write("dist/new.txt"); console.log(bunSummary(1, 0)); break;
  case "write-enclosing": write("../../stray.txt"); console.log(bunSummary(1, 0)); break;
  case "delete-ignored": rmSync("dist/old.txt"); console.log(bunSummary(1, 0)); break;
  case "quiet-writes":
    write("../../node_modules/.vite/deps/chunk.js");
    write("tsconfig.tsbuildinfo");
    console.log(bunSummary(1, 0));
    break;
  // Writes the sandbox must refuse: a sibling checkout, the app's own .git, a file outside every checkout.
  case "denied-writes": {
    const allowed = [];
    for (const [path, text] of [["../../sibling/edit.txt", "x"], ["../.git/config", "[core]\n\tfsmonitor = touch " + arg + "\n"], [arg, "x"]]) {
      try { appendFileSync(path, text); allowed.push(path); } catch {}
    }
    console.log((allowed.length ? "wrote " + allowed.join(", ") + "\n" : "") + bunSummary(allowed.length ? 0 : 1, allowed.length ? 1 : 0));
    process.exit(allowed.length ? 1 : 0);
  }
  // A child that leaves the command's process group (setsid) and would outlive it.
  case "stray": {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
    child.unref();
    write("node_modules/.cache/stray.pid", String(child.pid));
    console.log(bunSummary(1, 0));
    break;
  }
  case "env": {
    const problems = [];
    if (process.env.HOME !== arg) problems.push("HOME " + process.env.HOME + " is not the run's temp dir " + arg);
    if (!/--no-env-file/.test(process.env.BUN_OPTIONS ?? "")) problems.push("BUN_OPTIONS " + process.env.BUN_OPTIONS);
    if (process.env.DS_TEST_SECRET !== undefined) problems.push("DS_TEST_SECRET crossed into the run");
    if (process.env.FROM_PROFILE !== "yes") problems.push("runProfile.env missing");
    try { readFileSync(".env", "utf8"); problems.push(".env was readable: no sandbox"); } catch (error) { if (error.code !== "EPERM") problems.push(".env read failed with " + error.code + ", not the sandbox's EPERM"); }
    console.log(problems.join("\n") + "\n" + bunSummary(problems.length ? 0 : 1, problems.length ? 1 : 0));
    process.exit(problems.length ? 1 : 0);
  }
  case "connect": {
    const problems = [];
    // A suite's own server on an ephemeral port is allowed.
    const own = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("own") });
    try { if ((await (await fetch("http://127.0.0.1:" + own.port + "/")).text()) !== "own") problems.push("own server answered wrong"); }
    catch (error) { problems.push("own server on " + own.port + " unreachable: " + error.message); }
    own.stop(true);
    // A listener that was up before the run is not.
    try { await fetch("http://127.0.0.1:" + arg + "/", { signal: AbortSignal.timeout(3000) }); problems.push("reached the listener on " + arg + " that was up before the run"); } catch {}
    console.log(problems.join("\n") + "\n" + bunSummary(problems.length ? 0 : 1, problems.length ? 1 : 0));
    process.exit(problems.length ? 1 : 0);
  }
  case "bind": {
    let bound = false;
    try { Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }).stop(true); bound = true; } catch {}
    console.log(bound ? "a build command could listen on a port" : "no port, as expected");
    process.exit(bound ? 1 : 0);
  }
  case "hang": write(arg, String(process.pid)); await new Promise((r) => setTimeout(r, 120_000)); break;
}
`;

const req = { required: true } as const;
const na = { required: false, reason: "stand-in" } as const;

function app(id: string, cmd: string, extra: { baselines?: Record<string, TestBaseline>; typecheck?: string; build?: string; env?: Record<string, string> } = {}): AppEntry {
  return {
    id,
    name: id,
    wave: 1,
    kind: "app",
    repo: "core/member",
    root: "core/member/app",
    scan: { paths: ["core/member/app"], exclude: [] },
    stack: { summary: "", tailwind: "none", packageManager: "bun" },
    consume: { via: "workspace", detail: "" },
    entryStylesheet: null,
    theme: { rule: "light-dark" },
    literalFloor: 0,
    allowlist: null,
    shell: false,
    folderStandard: false,
    passes: { "1": req, "2": na, "3": na },
    checks: { resolution: req, wiring: req, literals: req, names: req, shell: na, structure: na },
    gates: { lint: req, verify: na, snapshot: na, pixelDiff: na, tests: req },
    run: { mode: "none", reason: "stand-in" },
    commands: { cwd: "core/member/app", ...(extra.typecheck ? { typecheck: extra.typecheck } : {}), ...(extra.build ? { build: extra.build } : {}) },
    tests: { safe: cmd ? [{ cmd, cwd: "core/member/app" }] : [], ...(extra.baselines ? { baselines: extra.baselines } : {}) },
    routes: [],
    runProfile: { env: extra.env ?? {}, unsetEnv: [], tempHome: true, fixtures: [], flags: [], ports: {}, proof: { status: "unproven", method: "" } },
    exceptions: [],
  };
}

const run = (mode: string) => `bun --no-env-file standin.mjs ${mode}`;
/** A listener this test starts before any run (registry tests' range 46940-46959): no run may reach it. */
const PRE_EXISTING_PORT = 46941;
/** A baseline recorded for `cmd` with these failing names. */
const known = (cmd: string, failing: string[], over: Partial<TestBaseline> = {}): TestBaseline => ({ cmd, exit: 1, fail: failing.length, failing, date: "2026-10-05", method: "test", ...over });

const APPS: AppEntry[] = [
  app("pass", run("pass")),
  app("known-fail", run("known-fail"), { baselines: { "tests.safe[0]": known(run("known-fail"), ["s > a"]) } }),
  app("new-fail", run("new-fail"), { baselines: { "tests.safe[0]": known(run("new-fail"), ["s > a"]) } }),
  app("no-baseline", run("known-fail")),
  // The baseline names the file under {root}: recorded on one tree, it matches a run on another.
  app("unhandled", run("unhandled"), { baselines: { "tests.safe[0]": known(run("unhandled"), ["unhandled: a.test.ts: TypeError: boom in {root}/core/member/app/a.test.ts"], { errors: 1 }) } }),
  // Recorded for another command: the entry's command changed since, so the baseline is stale.
  app("stale-baseline", run("known-fail"), { baselines: { "tests.safe[0]": known(run("an-older-command"), ["s > a"]) } }),
  // Recorded without its command: a stale baseline could not be told apart, so it compares with nothing.
  app("no-cmd-baseline", run("known-fail"), { baselines: { "tests.safe[0]": { exit: 1, fail: 1, failing: ["s > a"], date: "2026-10-05", method: "test" } } }),
  app("baseline-green", run("known-fail"), { baselines: { "tests.safe[0]": { cmd: run("known-fail"), exit: 0, pass: 3, fail: 0, date: "2026-10-05", method: "test" } } }),
  // Green, but one test fewer than the baseline ran.
  app("fewer-tests", run("fewer"), { baselines: { "tests.safe[0]": { cmd: run("fewer"), exit: 0, pass: 3, fail: 0, date: "2026-10-05", method: "test" } } }),
  app("vitest-new", run("vitest-new"), { baselines: { "tests.safe[0]": known(run("vitest-new"), ["src/a.test.ts > s > old"]) } }),
  app("unittest-known", run("unittest-known"), { baselines: { "tests.safe[0]": known(run("unittest-known"), ["m.C.test_x"]) } }),
  // The baseline's tsc error sits on another line now (line numbers are not compared); the second error is new.
  app("tsc", "", { typecheck: run("tsc"), build: run("bind"), baselines: { "commands.typecheck": known(run("tsc"), ["src/a.ts: TS2322: Type 'x' is not assignable to type 'y'."], { exit: 2 }) } }),
  // No safe test and only a typecheck: a run without --commands has nothing to do.
  app("typecheck-only", "", { typecheck: run("pass") }),
  app("write-tracked", run("write-tracked")),
  app("write-ignored", run("write-ignored")),
  app("delete-ignored", run("delete-ignored")),
  app("write-enclosing", run("write-enclosing")),
  app("quiet-writes", run("quiet-writes")),
  app("denied-writes", `${run("denied-writes")} {root}/outside.txt`),
  app("stray", run("stray")),
  app("env", `${run("env")} {tmp}`, { env: { FROM_PROFILE: "yes" } }),
  app("connect", `${run("connect")} ${PRE_EXISTING_PORT}`),
  app("hang", `${run("hang")} node_modules/.cache/hang.pid`),
  { ...app("not-a-checkout", run("pass")), repo: "plain", root: "plain/app", commands: { cwd: "plain/app" }, tests: { safe: [{ cmd: run("pass"), cwd: "plain/app" }] } },
];

function sh(cwd: string, ...argv: string[]) {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr}`);
}

function gitRepo(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  sh(dir, "git", "init", "-q");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
}

/** Runs the CLI against the stand-in workspace; `--json` reports by app id. */
function testApps(args: string[]) {
  const result = spawnSync(process.execPath, ["scripts/test-apps.ts", "--root", root, "--registry", registry, "--out-dir", out, ...args], {
    cwd: PKG,
    encoding: "utf8",
    env: { ...process.env, DS_TEST_SECRET: "must-not-cross" },
    timeout: 120_000,
  });
  let reports: Record<string, any> = {};
  if (args.includes("--json") && result.stdout.trim().startsWith("["))
    reports = Object.fromEntries((JSON.parse(result.stdout) as any[]).map((report) => [report.app, report]));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, reports };
}

let scratch: string;
let root: string;
/** The listener that is up before every run: its own process (the test process blocks in spawnSync), counting hits in a file. */
let preExisting: ReturnType<typeof Bun.spawn> | undefined;
const preExistingHits = () => (existsSync(join(scratch, "hits.txt")) ? readFileSync(join(scratch, "hits.txt"), "utf8").length : 0);
let registry: string;
let out: string;
const noSandbox = sandboxUnavailable();

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-test-apps-")));
  writeFileSync(
    join(scratch, "listener.mjs"),
    `import { appendFileSync } from "node:fs";\nBun.serve({ hostname: "127.0.0.1", port: ${PRE_EXISTING_PORT}, fetch: () => (appendFileSync("hits.txt", "x"), new Response("not the run's")) });\n`,
  );
  preExisting = Bun.spawn([process.execPath, "--no-env-file", "listener.mjs"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${PRE_EXISTING_PORT}/`).then(() => true, () => false)); i++) await Bun.sleep(50);
  rmSync(join(scratch, "hits.txt"), { force: true }); // the readiness probe's own hit
  root = join(scratch, "workspace");
  out = join(scratch, "out");
  registry = join(scratch, "apps.json");
  // core/ is the enclosing checkout (a bun workspace root that ignores its member checkouts), core/member the
  // app's own checkout, core/sibling a checkout the app does not touch.
  gitRepo(join(root, "core"), { ".gitignore": "node_modules/\nmember/\nsibling/\n", "package.json": "{}\n" });
  gitRepo(join(root, "core/member"), {
    ".gitignore": "dist/\n.env\n",
    "app/standin.mjs": STANDIN,
    "app/tracked.txt": "tracked\n",
    "app/dist/old.txt": "ignored output from an earlier build\n",
    "app/dist/keep.txt": "more ignored output\n",
    "app/.env": "SECRET=from-dotenv\n",
  });
  gitRepo(join(root, "core/sibling"), { "README.md": "sibling\n" });
  mkdirSync(join(root, "plain/app"), { recursive: true });
  writeFileSync(join(root, "plain/app/standin.mjs"), STANDIN);
  writeFileSync(registry, `${JSON.stringify({ version: 1, apps: APPS }, null, 2)}\n`);
});

afterAll(async () => {
  preExisting?.kill("SIGKILL");
  await preExisting?.exited;
  assertNoLeaks(scratch);
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!!noSandbox)("bun run test:apps", () => {
  let main: ReturnType<typeof testApps>;
  let typecheck: ReturnType<typeof testApps>;
  const ids = APPS.map((a) => a.id).filter((id) => !["hang", "tsc", "not-a-checkout", "typecheck-only"].includes(id));
  beforeAll(() => {
    main = testApps(["--json", ...ids]);
    typecheck = testApps(["--json", "--no-tests", "--commands", "typecheck,build", "tsc"]);
  }, 180_000);
  const result = (id: string) => (id === "tsc" ? typecheck : main).reports[id]?.commands?.[0];

  test("exits 1 when any command fails its baseline or writes unexpectedly", () => {
    expect(main.stderr).toBe("");
    expect(main.status).toBe(1);
    expect(Object.keys(main.reports).sort()).toEqual([...ids].sort());
  });

  test.each<[string, boolean]>([
    ["pass", true],
    ["known-fail", true],
    ["unittest-known", true],
    ["unhandled", true],
    ["new-fail", false],
    ["no-baseline", false],
    ["baseline-green", false],
    ["stale-baseline", false],
    ["no-cmd-baseline", false],
    ["fewer-tests", false],
  ])("%s: ok %p against its baseline", (id, ok) => {
    expect(result(id)?.ok).toBe(ok);
  });

  test("a baseline that records no cmd fails the run: a stale one could not be told apart", () => {
    expect(result("no-cmd-baseline").verdict.reasons).toEqual([
      "the baseline records no cmd (the command it was recorded for), so a stale one cannot be told apart; the managing agent re-records it",
    ]);
  });

  test("a run that executes fewer tests than its baseline fails, even when it exits 0", () => {
    expect(result("fewer-tests").exit).toBe(0);
    expect(result("fewer-tests").verdict.reasons).toEqual(["ran 2 test(s) (pass + fail), the baseline ran 3"]);
  });

  test("--commands typecheck,build skips a named command the entry does not set and runs the rest", () => {
    const run = testApps(["--commands", "typecheck,build", "pass"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("pass: commands.typecheck: not set in apps.json (skipped)\npass: commands.build: not set in apps.json (skipped)\n");
    expect(run.stdout).toContain("pass: ok");
  }, 60_000);

  test("an entry with nothing to run says which --commands it does set", () => {
    const refused = testApps(["--json", "typecheck-only"]);
    expect(refused.status).toBe(1);
    expect(refused.reports["typecheck-only"].refused).toBe("nothing to run: typecheck-only has no tests.safe command; the entry sets commands.typecheck: run it with --commands typecheck");
  });

  test("a failure the baseline does not list is named, for bun test, vitest and tsc output", () => {
    expect(result("new-fail").verdict.newFailures).toEqual(["s > b"]);
    expect(result("vitest-new").verdict.newFailures).toEqual(["file: src/b.test.ts", "src/a.test.ts > s > fresh"]);
    // The known tsc error moved lines and still counts as known; only the new one fails the run.
    expect(result("tsc").label).toBe("commands.typecheck");
    expect(result("tsc").verdict.newFailures).toEqual(["src/b.ts: TS2304: Cannot find name 'z'."]);
  });

  test("writes in the app's checkouts fail the run: a tracked file, a new file in or a deletion from an existing ignored folder, a file in the enclosing checkout", () => {
    expect(result("write-tracked").writes.unexpected).toEqual(["core/member/app/tracked.txt", "core/member/app/tracked.txt (git status: M new)"]);
    expect(result("write-ignored").writes.unexpected).toEqual(["core/member/app/dist/new.txt"]);
    expect(result("delete-ignored").writes.unexpected).toEqual(["core/member/app/dist/ (an entry was removed or renamed)"]);
    expect(result("write-enclosing").writes.unexpected).toEqual(["core/stray.txt", "core/stray.txt (git status: ?? new)"]);
    for (const id of ["write-tracked", "write-ignored", "delete-ignored", "write-enclosing"]) expect(result(id).ok).toBe(false);
  });

  test("the sandbox refuses writes the check does not watch: a sibling checkout, the checkout's .git, anything outside the checkouts", () => {
    expect({ ok: result("denied-writes").ok, log: readFileSync(result("denied-writes").log, "utf8") }).toMatchObject({ ok: true });
    expect(readFileSync(join(root, "core/member/.git/config"), "utf8")).not.toContain("fsmonitor");
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
  });

  test("a process that leaves the command's group is killed and fails the run", () => {
    const pid = Number(readFileSync(join(root, "core/member/app/node_modules/.cache/stray.pid"), "utf8"));
    expect(result("stray").strays).toContain(pid);
    expect(result("stray").ok).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("an app outside every git checkout is refused: the write check needs one", () => {
    const refused = testApps(["--json", "not-a-checkout"]);
    expect(refused.status).toBe(1);
    expect(refused.reports["not-a-checkout"].refused).toContain("is in no git checkout");
    expect(refused.reports["not-a-checkout"].commands).toEqual([]);
  });

  test("build caches are listed but pass", () => {
    expect(result("quiet-writes").writes.unexpected).toEqual([]);
    expect(result("quiet-writes").ok).toBe(true);
    expect(result("quiet-writes").writes.caches).toEqual([
      "core/member/app/tsconfig.tsbuildinfo",
      "core/member/app/tsconfig.tsbuildinfo (git status: ?? new)",
      "core/node_modules/ (git status: !! new)",
      "core/node_modules/.vite/deps/chunk.js",
    ]);
  });

  test("the command runs with the profile env (temp HOME, BUN_OPTIONS=--no-env-file, nothing else inherited) inside the sandbox (.env unreadable)", () => {
    // The stand-in checks each and prints what is wrong; the log shows it when this fails.
    expect({ ok: result("env").ok, log: readFileSync(result("env").log, "utf8") }).toMatchObject({ ok: true });
  });

  test("a test command reaches its own ephemeral servers but no port that was listening before it started", () => {
    expect({ ok: result("connect").ok, log: readFileSync(result("connect").log, "utf8") }).toMatchObject({ ok: true });
    expect(preExistingHits()).toBe(0);
  });

  test("a named command (build, typecheck) gets no network port at all", () => {
    const build = typecheck.reports["tsc"].commands[1];
    expect(build.label).toBe("commands.build");
    expect({ ok: build.ok, log: readFileSync(build.log, "utf8") }).toMatchObject({ ok: true });
  });

  test("each report proposes the baseline the managing agent records", () => {
    expect(result("known-fail").proposedBaseline).toMatchObject({ exit: 1, pass: 2, fail: 1, errors: 0, failing: ["s > a"] });
    expect(existsSync(main.reports["pass"].reportPath)).toBe(true);
  });

  test("a command that outlives --timeout fails and its whole process group is killed", () => {
    const hung = testApps(["--json", "--timeout", "3", "hang"]);
    expect(hung.status).toBe(1);
    expect(hung.reports["hang"].commands[0].timedOut).toBe(true);
    const pid = Number(readFileSync(join(root, "core/member/app/node_modules/.cache/hang.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);

  test("when the tool dies, its watchdog kills the command", async () => {
    const pidFile = join(root, "core/member/app/node_modules/.cache/hang.pid");
    rmSync(pidFile, { force: true });
    const cli = Bun.spawn([process.execPath, "scripts/test-apps.ts", "--root", root, "--registry", registry, "--out-dir", out, "hang"], { cwd: PKG, stdio: ["ignore", "ignore", "ignore"] });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(50);
    const pid = Number(readFileSync(pidFile, "utf8"));
    cli.kill("SIGKILL");
    await cli.exited;
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 60_000);

  test("exits 0 when every command passes", () => {
    const green = testApps(["pass", "known-fail"]);
    expect(green.status).toBe(0);
    expect(green.stdout).toContain("pass: ok");
  }, 60_000);
});

test("the default out dir ($DS_RUN, else under the temp base) refuses a TMPDIR that is the home itself", () => {
  expect(parseArgs(["x"], { DS_RUN: "/run/folder" }).outDir).toBe("/run/folder");
  expect(() => parseArgs(["x"], { TMPDIR: realHome() })).toThrow("is the home directory itself");
  expect(parseArgs(["--out-dir", "/elsewhere", "x"], { TMPDIR: realHome() }).outDir).toBe("/elsewhere");
});

test("refuses install and unknown commands before running anything", () => {
  const elsewhere = join(scratch, "out-refused");
  const refused = testApps(["--out-dir", elsewhere, "--commands", "install", "pass"]);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain(`"install" is not one of typecheck, build`);
  expect(existsSync(elsewhere)).toBe(false);
});
