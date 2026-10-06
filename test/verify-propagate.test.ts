/**
 * verify:apps --propagate and --restore, always on a scratch copy of the design-system (never a real
 * checkout): the theme files are journaled before the sentinel goes in, the copy is restored and
 * rebuilt byte-for-byte even when the check throws, a crashed run blocks the next until --restore,
 * the owner's tree is refused, nothing is written through a link out of the design-system, a build a
 * crashed run left behind is stopped before the restore, and eligibility follows the ledger.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CONTEXT_OPTIONS, LAUNCH_OPTIONS } from "../scripts/lib/capture.ts";
import { loadPlaywright } from "../scripts/lib/playwright.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT, type Registry } from "../scripts/lib/registry.ts";
import { sentinelAssertions } from "../scripts/lib/verify/page-checks.ts";
import {
  buildHashes,
  eligibleApps,
  hashChanges,
  OWNER_TREE,
  propagateBlocker,
  Refusal,
  readJournal,
  restoreFromJournal,
  runPackageScript,
  SENTINEL_COMPUTED,
  SENTINEL_TOKEN,
  setSentinel,
  withSentinel,
  writeJournal,
} from "../scripts/lib/verify/propagate.ts";
import { browserSkip, MIRROR, makeFixtureRoot, runnableFixtureApp } from "./verify-support.ts";
import { finishScratch } from "./leaks.ts";
import { plantBin } from "./planted-bin.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-propagate-")));
afterAll(async () => {
  try {
    await finishScratch(scratch); // stop what this file started, clean crashed runs' records, then no listener may be left
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** A scratch workspace root (or `root`) whose design-system is a freshly built copy of this package. */
function scratchRoot(root = mkdtempSync(join(scratch, "root-"))) {
  const ds = join(root, "design-system");
  for (const path of ["package.json", "tokens", "scripts", "dist"]) cpSync(join(DESIGN_SYSTEM_ROOT, path), join(ds, path), { recursive: true });
  mkdirSync(join(ds, "guide"));
  cpSync(join(DESIGN_SYSTEM_ROOT, "guide/tokens.md"), join(ds, "guide/tokens.md"));
  const build = runPackageScript(ds, "build");
  if (!build.ok) throw new Error(build.output);
  const out = join(root, "out");
  return { root, ds, out, journal: join(out, "propagate-journal") };
}

/** Every file under `dir`, by path relative to `base`. */
function contents(dir: string, base = dir, files: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) contents(full, base, files);
    else files[relative(base, full)] = readFileSync(full, "utf8");
  }
  return files;
}

/** Theme sources and every build output, by path. */
function snapshot(ds: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of ["tokens/themes", "dist"]) contents(join(ds, dir), ds, files);
  files["guide/tokens.md"] = readFileSync(join(ds, "guide/tokens.md"), "utf8");
  return files;
}

const THEME = `${JSON.stringify({ color: { surface: { page: { $value: "#ffffff" } } } }, null, 2)}\n`;

/**
 * A minimal design-system (one theme, a built dist/ and guide/tokens.md) whose toy build copies the theme
 * into dist/light.json and whose check compares the two. No real build, so a test costs milliseconds.
 */
function miniDs(build = "cp tokens/themes/light.tokens.json dist/light.json") {
  const root = mkdtempSync(join(scratch, "mini-"));
  const ds = join(root, "design-system");
  for (const dir of ["tokens/themes", "dist", "guide"]) mkdirSync(join(ds, dir), { recursive: true });
  writeFileSync(join(ds, "tokens/themes/light.tokens.json"), THEME);
  writeFileSync(join(ds, "dist/light.json"), THEME);
  writeFileSync(join(ds, "guide/tokens.md"), "tokens\n");
  writeFileSync(join(ds, "package.json"), JSON.stringify({ scripts: { build, check: "cmp tokens/themes/light.tokens.json dist/light.json" } }));
  return { ds, journal: join(root, "out/propagate-journal") };
}

const readOrNull = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** Live (not zombie) processes in a process group. */
function liveGroupMembers(pgid: number): number[] {
  return spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, group, stat]) => Number(group) === pgid && stat !== undefined && !stat.startsWith("Z"))
    .map(([pid]) => Number(pid));
}

const groupOf = (pid: number) => Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());

const pageValue = (ds: string, theme: string) => JSON.parse(readFileSync(join(ds, `dist/json/${theme}.json`), "utf8"))[SENTINEL_TOKEN];

function cli(args: string[], out: string) {
  const result = spawnSync(process.execPath, [join(DESIGN_SYSTEM_ROOT, "scripts/verify-apps.ts"), ...args, "--out-dir", out], {
    encoding: "utf8",
    env: { ...process.env, DS_RUN: out },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("withSentinel", () => {
  test("builds with the sentinel for the check, then restores and rebuilds byte-for-byte even when the check throws", async () => {
    const { ds, journal } = scratchRoot();
    const before = snapshot(ds);
    let during: unknown;
    await expect(
      withSentinel(ds, journal, async () => {
        during = { light: pageValue(ds, "light"), dark: pageValue(ds, "dark"), journaled: readJournal(journal)?.files.map((f) => f.rel) };
        throw new Error("an app missed the sentinel");
      }),
    ).rejects.toThrow("an app missed the sentinel");
    expect(during).toEqual({ light: "#ff00ff", dark: "#ff00ff", journaled: ["tokens/themes/dark.tokens.json", "tokens/themes/light.tokens.json"] });
    expect(snapshot(ds)).toEqual(before);
    expect(readJournal(journal)?.restoredAt).toBeString();
  }, 30_000);

  test("after a run dies with the sentinel in place, the next refuses until --restore replays the journal", () => {
    const { root, ds, out, journal } = scratchRoot();
    const before = snapshot(ds);
    setSentinel(writeJournal(ds, journal));
    runPackageScript(ds, "build");

    expect(() => writeJournal(ds, journal)).toThrow(/unrestored propagate journal/);
    const restore = cli(["--restore", "--root", root], out);
    expect([restore.status, restore.stdout]).toEqual([0, expect.stringMatching(/restored tokens\/themes\/dark\.tokens\.json, tokens\/themes\/light\.tokens\.json/)]);
    expect(snapshot(ds)).toEqual(before);

    // Without the journal, theme files that still hold the sentinel are never journaled as the originals.
    setSentinel({ ...readJournal(journal)!, dsDir: realpathSync(ds) });
    rmSync(journal, { recursive: true });
    expect(() => writeJournal(ds, journal)).toThrow(/already sets color\.surface\.page to the sentinel/);
  }, 30_000);

  describe.skipIf(Boolean(browserSkip))("in Chromium", () => {
    test("the sentinel reaches a page that links the rebuilt tokens.css, and is gone after the restore", async () => {
      const { ds, journal } = scratchRoot();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 46962,
        fetch: (request) =>
          new URL(request.url).pathname === "/tokens.css"
            ? new Response(readFileSync(join(ds, "dist/css/tokens.css")), { headers: { "content-type": "text/css" } })
            : new Response(`<!doctype html><link rel="stylesheet" href="/tokens.css"><body style="background: var(--ds-color-surface-page)">page</body>`, {
                headers: { "content-type": "text/html" },
              }),
      });
      const browser = await loadPlaywright(MIRROR).chromium.launch(LAUNCH_OPTIONS);
      const pageStatus = async () => {
        const context = await browser.newContext(CONTEXT_OPTIONS);
        try {
          const page = await context.newPage();
          await page.goto("http://127.0.0.1:46962/");
          return (await sentinelAssertions(page, {}, SENTINEL_TOKEN, SENTINEL_COMPUTED)).map((a) => [a.id, a.status]);
        } finally {
          await context.close();
        }
      };
      try {
        const { value: during, restore } = await withSentinel(ds, journal, pageStatus);
        expect(during).toEqual([["sentinel: body background-color", "pass"]]);
        expect(restore.ok).toBe(true);
        expect(await pageStatus()).toEqual([["sentinel: body background-color", "fail"]]);
      } finally {
        await browser.close();
        server.stop(true);
      }
    }, 30_000);
  });
});

describe.skipIf(Boolean(browserSkip))("the CLI on a scratch tree with a live-linked app", () => {
  const UI_PORT = 46972;

  /** A root holding a fixture app whose tokens.css links the root's design-system, which lists only that app. */
  function liveTree() {
    const tree = scratchRoot(makeFixtureRoot(scratch));
    rmSync(join(tree.root, "app/tokens.css"));
    symlinkSync("../design-system/dist/css/tokens.css", join(tree.root, "app/tokens.css"));
    writeFileSync(join(tree.ds, "apps.json"), JSON.stringify({ version: 1, apps: [{ ...runnableFixtureApp({ ui: UI_PORT }), id: "live" }] }));
    // Playwright resolves from <root>/codecaine/core, as in the mirror.
    mkdirSync(join(tree.root, "codecaine"));
    symlinkSync(join(MIRROR, "codecaine/core"), join(tree.root, "codecaine/core"));
    return tree;
  }

  const spawnCli = (tree: ReturnType<typeof liveTree>) =>
    Bun.spawn([process.execPath, join(tree.ds, "scripts/verify-apps.ts"), "--propagate", "--root", tree.root, "--out-dir", tree.out, "live"], {
      env: { ...process.env, DS_RUN: tree.out },
      stdout: "pipe",
      stderr: "pipe",
    });

  const portOpen = (port: number) =>
    new Promise<boolean>((done) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
    });

  test("--propagate: the sentinel reaches the app, the run passes, and the design-system comes back byte-for-byte", async () => {
    const tree = liveTree();
    const before = snapshot(tree.ds);
    const run = spawnCli(tree);
    const code = await run.exited;
    const output = code === 0 ? "" : `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    expect([code, output]).toEqual([0, ""]);
    const results = readdirSync(join(tree.out, "live/verify"));
    const result = JSON.parse(readFileSync(join(tree.out, "live/verify", results[0]!), "utf8"));
    expect(result.assertions.map((a: any) => [a.id, a.status])).toEqual(
      expect.arrayContaining([
        ["sentinel: body background-color", "pass"],
        ["restore", "pass"],
      ]),
    );
    expect(snapshot(tree.ds)).toEqual(before);
  }, 60_000);

  test("Ctrl-C while the app runs stops it, restores and rebuilds the design-system, and exits 130", async () => {
    const tree = liveTree();
    const before = snapshot(tree.ds);
    const run = spawnCli(tree);
    try {
      const deadline = Date.now() + 30_000;
      while (!(await portOpen(UI_PORT)) && Date.now() < deadline) await Bun.sleep(100);
      expect(pageValue(tree.ds, "light")).toBe("#ff00ff");
      run.kill("SIGINT");
      expect(await run.exited).toBe(130);
      expect(snapshot(tree.ds)).toEqual(before);
      expect(readJournal(tree.journal)?.restoredAt).toBeString();
      expect(await portOpen(UI_PORT)).toBe(false);
    } finally {
      // A failed assertion above must not leave the CLI (and its app) running past the test.
      if (run.exitCode === null) {
        run.kill("SIGINT");
        await run.exited;
      }
    }
  }, 60_000);
});

describe("refusals", () => {
  const ownerExists = existsSync(OWNER_TREE);
  const links = mkdtempSync(join(scratch, "links-"));
  const ownerLink = join(links, "owner");
  const dsLinkRoot = join(links, "ds-link-root");
  if (ownerExists) {
    symlinkSync(OWNER_TREE, ownerLink);
    mkdirSync(dsLinkRoot);
    symlinkSync(join(OWNER_TREE, "design-system"), join(dsLinkRoot, "design-system"));
  }

  // No app ids and no STATE.md: even a broken refusal could not reach a rebuild.
  const refuses = (args: string[], message: RegExp) => {
    const out = mkdtempSync(join(scratch, "out-"));
    const result = cli(args, out);
    expect([result.status, result.stderr]).toEqual([1, expect.stringMatching(message)]);
    expect(existsSync(join(out, "propagate-journal"))).toBe(false);
  };

  test.each([
    ["--propagate without --root", ["--propagate"], /--propagate needs --root/],
    ["--restore without --root", ["--restore"], /--restore needs --root/],
  ])("%s", (_, args, message) => refuses(args, message));

  test.skipIf(!ownerExists).each([
    ["the owner's tree", ["--propagate", "--root", OWNER_TREE], /refuses the owner's tree/],
    ["a symlink to the owner's tree", ["--propagate", "--root", ownerLink], /refuses the owner's tree/],
    ["a design-system that links into the owner's tree", ["--propagate", "--root", dsLinkRoot], /resolves into the owner's tree/],
  ])("%s", (_, args, message) => refuses(args, message));
});

describe("eligibleApps", () => {
  const app = (id: string, mode: AppEntry["run"]["mode"], via: AppEntry["consume"]["via"], passes?: AppEntry["passes"]) =>
    ({ id, run: { mode, reason: mode === "none" ? "a library" : undefined }, consume: { via, detail: "" }, ...(passes ? { passes } : {}) }) as AppEntry;
  const req = { required: true } as const;
  const registry: Registry = {
    version: 1,
    apps: [
      app("web", "browser", "workspace"),
      app("deployed", "browser", "vendor-tgz"),
      app("lib", "none", "link"),
      app("half", "browser", "link"),
      app("desk", "electron", "npm-file"),
      // apps.json requires p2, which the ledger calls n/a: not done.
      app("strict", "browser", "workspace", { "1": req, "2": req, "3": req }),
      // apps.json marks p3 n/a, which the ledger still has as todo: done.
      app("lenient", "browser", "workspace", { "1": req, "2": req, "3": { required: false, reason: "library" } }),
    ],
  };
  const state = [
    "## app_ledger",
    "",
    "| id | wave | branch | p1 | p2 | p3 | literals |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| web | 1 | x | done | n/a | done | 0 / 0 |",
    "| deployed | 1 | x | done | done | done | 0 / 0 |",
    "| lib | 1 | x | done | n/a | n/a | 0 / 0 |",
    "| half | 1 | x | done | working | todo | 3 / 1 |",
    "| desk | 2 | x | done | done | done | 0 / 0 |",
    "| ghost | 2 | x | done | done | done | 0 / 0 |",
    "| idle | 2 | x | n/a | n/a | n/a | 0 / 0 |",
    "| strict | 2 | x | done | n/a | done | 0 / 0 |",
    "| lenient | 2 | x | done | done | todo | 0 / 0 |",
    "",
    "## tooling",
    "",
    "| unit | p1 |",
    "| --- | --- |",
    "| half | done |",
  ].join("\n");

  test("by default: every ledger app that is done by the progress rule (apps.json decides which passes count), runs and consumes the package live; every other row is reported", () => {
    const result = eligibleApps(registry, [], state);
    expect(result.apps.map((a) => a.id)).toEqual(["web", "desk", "lenient"]);
    expect(result.skipped).toEqual([
      { id: "deployed", reason: "consumes the package via vendor-tgz, not live" },
      { id: "lib", reason: "run mode none: a library" },
      { id: "half", reason: "not done (in flight: p1 done, p2 working, p3 todo)" },
      { id: "ghost", reason: "done in the ledger but not in apps.json" },
      { id: "idle", reason: "not done (todo: p1 n/a, p2 n/a, p3 n/a)" },
      { id: "strict", reason: "not done (in flight: p1 done, p2 n/a, p3 done)" },
    ]);
    expect(result.problems).toEqual([]);
  });

  test("listed apps are eligible whatever the ledger says; no list and no STATE.md is refused", () => {
    expect(eligibleApps(registry, ["half"], null).apps.map((a) => a.id)).toEqual(["half"]);
    expect(() => eligibleApps(registry, [], null)).toThrow(/STATE\.md/);
  });
});

describe("safety around a propagate run", () => {
  test("the restore build runs in its own process group, out of reach of a terminal's Ctrl-C", () => {
    const ds = mkdtempSync(join(scratch, "pgid-"));
    writeFileSync(join(ds, "package.json"), JSON.stringify({ scripts: { build: "ps -o pgid= -p $$" } }));
    const own = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();
    const result = runPackageScript(ds, "build");
    expect(result.ok).toBe(true);
    expect(result.output.trim().split("\n").pop()!.trim()).not.toBe(own);
  });

  test("before/after hashes catch a change to a file that was already modified before the run", () => {
    const { ds } = scratchRoot();
    writeFileSync(join(ds, "dist/json/light.json"), `${readFileSync(join(ds, "dist/json/light.json"), "utf8")} `);
    const before = buildHashes(ds);
    writeFileSync(join(ds, "dist/json/light.json"), `${readFileSync(join(ds, "dist/json/light.json"), "utf8")} `);
    rmSync(join(ds, "dist/json/dark.json"));
    writeFileSync(join(ds, "dist/new.txt"), "x");
    expect(hashChanges(before, buildHashes(ds))).toEqual(["dist/json/dark.json removed", "dist/json/light.json changed", "dist/new.txt added"]);
    expect(Object.keys(before)).toContain("tokens/themes/light.tokens.json");
  }, 30_000);

  test("propagateBlocker: an unrestored journal or a sentinel build blocks; a restored journal does not", () => {
    const { ds, out, journal } = scratchRoot();
    expect(propagateBlocker({ outDirs: [out], dsDirs: [ds] })).toBeNull();
    writeJournal(ds, journal);
    expect(propagateBlocker({ outDirs: [out], dsDirs: [ds] })).toMatch(/unrestored propagate journal/);
    writeFileSync(join(journal, "manifest.json"), JSON.stringify({ ...readJournal(journal), restoredAt: new Date().toISOString() }));
    expect(propagateBlocker({ outDirs: [out], dsDirs: [ds] })).toBeNull();
    const light = join(ds, "dist/json/light.json");
    writeFileSync(light, JSON.stringify({ ...JSON.parse(readFileSync(light, "utf8")), [SENTINEL_TOKEN]: "#FF00FF" }));
    expect(propagateBlocker({ outDirs: [out], dsDirs: [ds] })).toMatch(/light\.json sets color\.surface\.page to the propagate sentinel/);
  }, 30_000);

  test("snapshot and verify:apps refuse to run while a propagate journal is unrestored, before starting anything", () => {
    const { root, ds, out, journal } = scratchRoot();
    writeJournal(ds, journal);
    const registry = join(root, "apps.json");
    const fixture = runnableFixtureApp({ ui: 46975 });
    const entry = { ...fixture, id: "blocked-app", gates: { ...fixture.gates, verify: { required: true }, snapshot: { required: true } } };
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [entry] }));
    const env = { ...process.env, DS_RUN: out };
    const verify = spawnSync(process.execPath, [join(DESIGN_SYSTEM_ROOT, "scripts/verify-apps.ts"), "--root", root, "--out-dir", out, "--registry", registry], { encoding: "utf8", env });
    expect([verify.status, verify.stderr]).toEqual([1, expect.stringMatching(/refusing to verify: an unrestored propagate journal/)]);
    const snapshot = spawnSync(process.execPath, [join(DESIGN_SYSTEM_ROOT, "scripts/snapshot.ts"), "--app", "blocked-app", "--set", "s", "--root", root, "--out-dir", out, "--registry", registry], { encoding: "utf8", env });
    expect([snapshot.status, snapshot.stderr]).toEqual([2, expect.stringMatching(/refusing to capture: an unrestored propagate journal/)]);
    expect(existsSync(join(out, "blocked-app"))).toBe(false);
  }, 30_000);
});

describe("links out of the design-system", () => {
  /** Replaces `path` with a symlink to `target`, which first gets a copy of what `path` held. */
  const linkOut = (path: string, target: string) => {
    cpSync(path, target, { recursive: true });
    rmSync(path, { recursive: true });
    symlinkSync(target, path);
  };

  // Each row stands in for a scratch design-system that links a file of the owner's tree (here `outside`).
  test.each([
    ["a theme file that is a symlink", (ds: string, outside: string) => linkOut(join(ds, "tokens/themes/light.tokens.json"), join(outside, "light.tokens.json")), /tokens\/themes\/light\.tokens\.json in \S+ is a symlink/],
    ["tokens/themes/ as a symlink", (ds: string, outside: string) => linkOut(join(ds, "tokens/themes"), join(outside, "themes")), /tokens\/themes in \S+ is a symlink/],
    ["dist/ as a symlink", (ds: string, outside: string) => linkOut(join(ds, "dist"), join(outside, "dist")), /^dist in \S+ is a symlink/],
    ["a symlink inside dist/", (ds: string, outside: string) => linkOut(join(ds, "dist/light.json"), join(outside, "light.json")), /dist\/light\.json in \S+ is a symlink/],
    [
      "a hard link inside dist/ (the build rewrites it in place)",
      (ds: string, outside: string) => {
        cpSync(join(ds, "dist/light.json"), join(outside, "light.json"));
        rmSync(join(ds, "dist/light.json"));
        linkSync(join(outside, "light.json"), join(ds, "dist/light.json"));
      },
      /dist\/light\.json in \S+ is hard-linked/,
    ],
    ["guide/tokens.md as a symlink", (ds: string, outside: string) => linkOut(join(ds, "guide/tokens.md"), join(outside, "tokens.md")), /guide\/tokens\.md in \S+ is a symlink/],
    [
      "scripts/build.ts as a symlink (it builds the tree above its real path)",
      (ds: string, outside: string) => {
        writeFileSync(join(outside, "build.ts"), "// the owner's build\n");
        mkdirSync(join(ds, "scripts"));
        symlinkSync(join(outside, "build.ts"), join(ds, "scripts/build.ts"));
      },
      /scripts\/build\.ts in \S+ is a symlink/,
    ],
  ])("%s: --propagate refuses before journaling, and nothing outside is written", async (_, plant, message) => {
    const { ds, journal } = miniDs();
    const outside = mkdtempSync(join(scratch, "outside-"));
    plant(ds, outside);
    const before = contents(outside);
    let outsideDuringCheck: Record<string, string> | undefined;
    const error = await withSentinel(ds, journal, async () => {
      outsideDuringCheck = contents(outside);
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect({ refusal: error instanceof Refusal ? error.message : String(error), outsideDuringCheck, outside: contents(outside), journal: existsSync(journal) }).toEqual({
      refusal: expect.stringMatching(message),
      outsideDuringCheck: undefined,
      outside: before,
      journal: false,
    });
  });
});

describe("a build a crashed run left behind", () => {
  test("a journaled build records its own pid, start time and process group (not this process's) while it runs; the record is cleared when it returns", () => {
    // The toy build saves what the journal holds while it runs, and the identity of its parent (bun run).
    const { ds, journal } = miniDs(
      "cp ../out/propagate-journal/build.json identity.json && cp ../out/propagate-journal/manifest.json manifest-during.json && echo $PPID > ppid && LC_ALL=C ps -o lstart= -p $PPID > ppid-started",
    );
    writeJournal(ds, journal);
    const result = runPackageScript(ds, "build", journal);
    if (!result.ok) throw new Error(result.output);
    const identity = JSON.parse(readFileSync(join(ds, "identity.json"), "utf8"));
    const bun = Number(readFileSync(join(ds, "ppid"), "utf8"));
    const normalize = (text: string) => text.trim().split(/\s+/).join(" ");
    expect({
      identity: { ...identity, started: normalize(identity.started) },
      during: JSON.parse(readFileSync(join(ds, "manifest-during.json"), "utf8")).activeBuild?.script,
      after: { activeBuild: readJournal(journal)?.activeBuild, identityFile: existsSync(join(journal, "build.json")) },
    }).toEqual({
      identity: { pid: bun, pgid: bun, started: normalize(readFileSync(join(ds, "ppid-started"), "utf8")), script: "build" },
      during: "build",
      after: { activeBuild: undefined, identityFile: false },
    });
    expect(identity.pgid).not.toBe(groupOf(process.pid));
  });

  test("--restore stops the orphaned build's whole group before it restores the theme files, then rebuilds", async () => {
    // The first build (the crashed run's) waits; on SIGTERM it saves what the theme file held at that moment.
    // Later builds copy the theme into dist/.
    const { ds, journal } = miniDs(
      "if [ -e slow ]; then rm slow; trap 'cp tokens/themes/light.tokens.json theme-at-stop.json; exit 0' TERM; ps -o pgid= -p $$ > group; : > ready; sleep 30 & wait; else cp tokens/themes/light.tokens.json dist/light.json; fi",
    );
    setSentinel(writeJournal(ds, journal));
    writeFileSync(join(ds, "slow"), "");
    const propagate = join(import.meta.dir, "../scripts/lib/verify/propagate.ts");
    // A propagate run that is killed (SIGKILL: no handler runs) while its build runs.
    const run = Bun.spawn([process.execPath, "-e", `import { runPackageScript } from ${JSON.stringify(propagate)}; runPackageScript(${JSON.stringify(ds)}, "build", ${JSON.stringify(journal)});`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(join(ds, "ready"))) {
        if (Date.now() > deadline) throw new Error("the build never started");
        await Bun.sleep(50);
      }
      run.kill("SIGKILL");
      await run.exited;
      const pgid = Number(readFileSync(join(ds, "group"), "utf8"));
      const restore = restoreFromJournal(journal);
      expect({
        stopped: restore.stoppedBuild && { ...restore.stoppedBuild, pid: restore.stoppedBuild.pid === pgid },
        themeAtStop: readOrNull(join(ds, "theme-at-stop.json")),
        group: liveGroupMembers(pgid),
        restored: [readOrNull(join(ds, "tokens/themes/light.tokens.json")), readOrNull(join(ds, "dist/light.json")), restore.ok],
      }).toEqual({
        stopped: { pid: true, script: "build", outcome: expect.stringMatching(/^stopped: SIGTERM/) },
        themeAtStop: expect.stringContaining("#ff00ff"),
        group: [],
        restored: [THEME, THEME, true],
      });
    } finally {
      run.kill("SIGKILL");
      // On a failure above, the build may still run: kill the group its own script recorded (alive, so the id is still its).
      const pgid = Number(readOrNull(join(ds, "group")) ?? Number.NaN);
      if (pgid > 1 && liveGroupMembers(pgid).length) process.kill(-pgid, "SIGKILL");
    }
  }, 30_000);

  test("a recorded build whose pid now has another start time is never signalled, and the restore goes ahead", () => {
    const { ds, journal } = miniDs();
    setSentinel(writeJournal(ds, journal));
    const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      const pid = stranger.pid!;
      const pgid = groupOf(pid);
      writeFileSync(join(journal, "build.json"), JSON.stringify({ pid, pgid, started: "Thu Jan  1 00:00:00 1970", script: "build" }));
      writeFileSync(join(journal, "manifest.json"), JSON.stringify({ ...readJournal(journal), activeBuild: { script: "build", identity: "build.json", requestedAt: new Date().toISOString() } }));
      const restore = restoreFromJournal(journal);
      expect({
        outcome: restore.stoppedBuild?.outcome,
        stranger: liveGroupMembers(pgid),
        restored: [readOrNull(join(ds, "tokens/themes/light.tokens.json")), restore.ok],
        activeBuild: readJournal(journal)?.activeBuild,
      }).toEqual({
        outcome: expect.stringMatching(/^not signalled: pid \d+ is another process now/),
        stranger: [pid],
        restored: [THEME, true],
        activeBuild: undefined,
      });
    } finally {
      stranger.kill("SIGKILL");
    }
  });
});

describe("what a propagate build runs", () => {
  test("the build's own shell records its identity with the system ps, rm and mv, never ones planted in PATH", () => {
    const { ds, journal } = miniDs("cp ../out/propagate-journal/build.json identity.json && cp tokens/themes/light.tokens.json dist/light.json");
    const planted = plantBin(mkdtempSync(join(scratch, "path-")));
    writeJournal(ds, journal);
    const path = process.env.PATH;
    process.env.PATH = planted.path;
    try {
      const result = runPackageScript(ds, "build", journal);
      expect({ ok: result.ok, recorded: existsSync(join(ds, "identity.json")), planted: planted.calls() }).toEqual({ ok: true, recorded: true, planted: [] });
    } finally {
      process.env.PATH = path;
    }
  });

  test("a build script changed after journaling never runs: the restore copies the theme files back, then refuses to build", () => {
    const { ds, journal } = miniDs();
    setSentinel(writeJournal(ds, journal));
    // What an app could do while it ran during the propagate check: rewrite the design-system's build.
    writeFileSync(join(ds, "package.json"), JSON.stringify({ scripts: { build: "touch tampered", check: "touch tampered" } }));
    expect(() => restoreFromJournal(journal)).toThrow(/package\.json, bunfig\.toml, tsconfig\.json or scripts\/ changed since the propagate journal was written/);
    expect({ tampered: existsSync(join(ds, "tampered")), theme: readOrNull(join(ds, "tokens/themes/light.tokens.json")) }).toEqual({ tampered: false, theme: THEME });
  });
});
