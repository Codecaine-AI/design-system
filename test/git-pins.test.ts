/**
 * Every git call of the tools (scripts/lib/git.ts): pinned to the repository recorded before the first app
 * starts, hook-free, no fsmonitor, no system or global config, an empty HOME. The attack (Opus R3 P0-1,
 * Codex R3 P0 2): a run process rewrites a checkout's `.git` (or its config) so that the tool's next
 * `git status` runs a command of the run's choosing outside the sandbox. A fsmonitor hook that touches a
 * marker file stands in for that command. Scratch repositories only; no app, no port.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appScope, statusSnapshot } from "../scripts/lib/checkouts.ts";
import { gitAt, gitEnv, GitPinChanged, GitPinError, markAppsStarted, pinFor, pinnedGit, pinRepos, resetPinsForTests } from "../scripts/lib/git.ts";
import { treeState } from "../scripts/lib/provenance.ts";
import type { AppEntry } from "../scripts/lib/registry.ts";
import { runPolicy, sandboxCommand, sandboxUnavailable } from "../scripts/lib/sandbox.ts";
import { SYSTEM_BIN } from "../scripts/lib/system-bin.ts";
import { appWriteScope } from "../scripts/test-apps.ts";
import { workspaceRoot } from "./support.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-git-pins-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetPinsForTests());

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([SYSTEM_BIN.git, "-c", "user.email=test@example.invalid", "-c", "user.name=test", "-C", cwd, ...args], { env: { PATH: "/usr/bin:/bin", HOME: scratch } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

/** A root holding the app's repository at <root>/app (one commit), and a fsmonitor hook that touches `marker`. */
function fixture() {
  const root = mkdtempSync(join(scratch, "root-"));
  const app = join(root, "app");
  mkdirSync(app);
  writeFileSync(join(app, "index.html"), "<p>app</p>");
  git(app, "init", "-q");
  git(app, "add", ".");
  git(app, "commit", "-q", "-m", "app");
  const marker = join(root, "marker");
  const hook = join(root, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  const entry = { id: "pins-fixture", repo: "app", root: "app", scan: { paths: ["app"], exclude: [] } } as unknown as AppEntry;
  return { root, app, marker, hook, entry };
}

/** A crafted git dir: a copy of the app's, with core.fsmonitor and a post-index-change hook set to `hook`. */
function craftedGitDir(app: string, at: string, hook: string): string {
  cpSync(join(app, ".git"), at, { recursive: true });
  writeFileSync(join(at, "config"), `${readFileSync(join(at, "config"), "utf8")}[core]\n\tfsmonitor = ${hook}\n\thooksPath = ${join(at, "hooks")}\n`);
  mkdirSync(join(at, "hooks"), { recursive: true });
  cpSync(hook, join(at, "hooks", "post-index-change"));
  return at;
}

describe("pinned, hook-free git", () => {
  test("a repository's own fsmonitor (set before the pin) never runs: every call overrides it", () => {
    const t = fixture();
    git(t.app, "config", "core.fsmonitor", t.hook);
    const pin = pinFor(t.app)!;
    writeFileSync(join(t.app, "index.html"), "<p>changed</p>");
    expect(pinnedGit(pin, ["status", "--porcelain"]).stdout).toContain("index.html");
    pinnedGit(pin, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
    expect(existsSync(t.marker)).toBe(false);
  });

  test("a `.git` the run rewrote to point at a crafted git dir: the provenance refuses, the hook never runs", () => {
    const t = fixture();
    pinRepos([t.app]); // as startApp does before the first app process
    markAppsStarted();
    // What a run process would do if the sandbox let it (the sandbox test below shows it does not).
    const evil = craftedGitDir(t.app, join(t.root, "evil-git"), t.hook);
    rmSync(join(t.app, ".git"), { recursive: true, force: true });
    writeFileSync(join(t.app, ".git"), `gitdir: ${evil}\n`);
    writeFileSync(join(t.app, "index.html"), "<p>changed</p>");
    expect(() => treeState(t.root, t.entry)).toThrow(GitPinChanged);
    expect(existsSync(t.marker)).toBe(false);
  });

  test("the pinned git dir's config gaining a fsmonitor after the pin: refused before git runs", () => {
    const t = fixture();
    const pin = pinFor(t.app)!;
    writeFileSync(join(t.app, ".git", "config"), `${readFileSync(join(t.app, ".git", "config"), "utf8")}[core]\n\tfsmonitor = ${t.hook}\n`);
    expect(() => pinnedGit(pin, ["status", "--porcelain"])).toThrow(GitPinChanged);
    expect(existsSync(t.marker)).toBe(false);
  });

  test("an upstream or remote setting added to the config (git push -u, by the owner) does not refuse the pin", () => {
    const t = fixture();
    const pin = pinFor(t.app)!;
    git(t.app, "config", "branch.main.remote", "origin");
    git(t.app, "config", "remote.origin.url", "https://example.invalid/repo.git");
    git(t.app, "config", "user.name", "someone");
    expect(pinnedGit(pin, ["rev-parse", "HEAD"]).status).toBe(0);
    git(t.app, "config", "core.sshCommand", "/tmp/x");
    expect(() => pinnedGit(pin, ["rev-parse", "HEAD"])).toThrow(GitPinChanged);
  });

  test("no global or system config: a ~/.gitconfig with a fsmonitor in the tool's HOME is never read", () => {
    const t = fixture();
    const home = join(t.root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), `[core]\n\tfsmonitor = ${t.hook}\n`);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      writeFileSync(join(t.app, "index.html"), "<p>changed</p>");
      treeState(t.root, t.entry);
    } finally {
      process.env.HOME = saved;
    }
    expect(existsSync(t.marker)).toBe(false);
    const env = gitEnv();
    expect(env.HOME).not.toBe(home);
    expect([env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_NOSYSTEM, "GIT_DIR" in env]).toEqual(["/dev/null", "1", false]);
  });

  test("after the first app started, a repository that was not pinned before is refused", () => {
    const a = fixture();
    const b = fixture();
    pinRepos([a.app]);
    markAppsStarted();
    expect(pinFor(a.app)?.workTree).toBe(realpathSync(a.app));
    expect(() => pinFor(b.app)).toThrow(GitPinError);
    expect(() => treeState(b.root, b.entry)).toThrow(GitPinError);
  });
});

/**
 * A git dir at `at`: a copy of the app's, whose config defines `filter.pwn.clean` (it touches `marker`),
 * plus `* filter=pwn` in the app's work tree `.gitattributes` and index.html changed, so the tool's next
 * `git status` / `git diff HEAD` there would run the filter (the reviewer's probe, Opus R4 P0-1).
 */
function pwnGitDir(app: string, at: string, marker: string): string {
  cpSync(join(app, ".git"), at, { recursive: true });
  writeFileSync(join(at, "config"), `${readFileSync(join(at, "config"), "utf8")}[filter "pwn"]\n\tclean = touch '${marker}'; cat\n`);
  writeFileSync(join(app, ".gitattributes"), "* filter=pwn\n");
  writeFileSync(join(app, "index.html"), "<p>changed by the run</p>");
  return at;
}

/** git as an unsandboxed tool process ran it before this round: from `cwd`, letting git search for the repository. */
function plainGit(cwd: string, args: string[]) {
  return Bun.spawnSync([SYSTEM_BIN.git, "--no-optional-locks", ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" } });
}

describe("planted git dirs and attributes (Opus R4 P0-1, P0-2)", () => {
  test("a `.git` naming a git dir inside the checkout's own files (planted while the checkout was renamed away): the next tool process refuses it, and its filter never runs", () => {
    const t = fixture();
    const evil = pwnGitDir(t.app, join(t.app, "evil"), t.marker);
    rmSync(join(t.app, ".git"), { recursive: true, force: true });
    writeFileSync(join(t.app, ".git"), `gitdir: ${evil}\n`);
    // A fresh tool process (nothing pinned yet), as snapshot or test:apps would be after the run.
    let error: unknown;
    try {
      treeState(t.root, t.entry);
    } catch (caught) {
      error = caught;
    }
    expect(existsSync(t.marker)).toBe(false);
    expect(error).toBeInstanceOf(GitPinError);
    expect(String(error)).toMatch(/refusing its git dir .*evil: it lies in the files of the checkout/);
  });

  test("a `.git` naming a git dir in a temp dir (a run's own) is refused; the checkout's own `.git` dir is accepted", () => {
    const t = fixture();
    expect(pinFor(t.app)?.gitDir).toBe(realpathSync(join(t.app, ".git")));
    resetPinsForTests();
    const runTmp = mkdtempSync(join(scratch, "ds-run-fixture-"));
    const evil = pwnGitDir(t.app, join(runTmp, "evil", ".git"), t.marker);
    rmSync(join(t.app, ".git"), { recursive: true, force: true });
    writeFileSync(join(t.app, ".git"), `gitdir: ${evil}\n`);
    expect(() => pinFor(t.app)).toThrow(/refusing its git dir .*: it lies in the temp dir/);
    expect(existsSync(t.marker)).toBe(false);
  });

  test("a work-tree .gitattributes selects no filter: every call reads attributes from the empty tree (sha1 and sha256)", () => {
    for (const format of ["sha1", "sha256"]) {
      resetPinsForTests();
      const root = mkdtempSync(join(scratch, `attrs-${format}-`));
      const app = join(root, "app");
      mkdirSync(app);
      writeFileSync(join(app, "index.html"), "<p>app</p>");
      git(app, "init", "-q", `--object-format=${format}`);
      git(app, "add", ".");
      git(app, "commit", "-q", "-m", "app");
      const marker = join(root, "marker");
      // A filter driver the repository's own config defines (git-lfs does this), set before the pin.
      git(app, "config", "filter.pwn.clean", `touch '${marker}'; cat`);
      const pin = pinFor(app)!;
      // What a run may write in its checkout: a .gitattributes that selects the driver, and a change.
      writeFileSync(join(app, ".gitattributes"), "* filter=pwn diff=pwn merge=pwn\n");
      writeFileSync(join(app, "index.html"), "<p>changed by the run</p>");
      const status = pinnedGit(pin, ["status", "--porcelain"]);
      const diff = pinnedGit(pin, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
      expect([status.status, diff.status]).toEqual([0, 0]);
      expect(diff.stdout).toContain("changed by the run");
      expect(existsSync(marker)).toBe(false);
      expect(pin.objectFormat).toBe(format);
      // The same diff the way git reads attributes by default runs the driver: the fixture is live.
      plainGit(app, ["diff", "HEAD"]);
      expect(existsSync(marker)).toBe(true);
    }
  });

  test("gitAt goes through the checkout's pin: a git dir the caller recorded from elsewhere is refused", () => {
    const t = fixture();
    const evil = pwnGitDir(t.app, join(t.root, "elsewhere-git"), t.marker);
    let error: unknown;
    try {
      gitAt({ workTree: t.app, gitDir: evil }, ["diff", "HEAD"]);
    } catch (caught) {
      error = caught;
    }
    expect(existsSync(t.marker)).toBe(false);
    expect(error).toBeInstanceOf(GitPinChanged);
    expect(gitAt({ workTree: t.app, gitDir: join(t.app, ".git") }, ["rev-parse", "HEAD"]).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  /** A root holding the app's checkout `repo` and a sibling checkout; `repo/pkg` (the app's root) holds a planted bare repository. */
  function plantedBare(worktree: (t: { pkg: string; sibling: string }) => string) {
    const root = mkdtempSync(join(scratch, "bare-"));
    const repo = join(root, "repo");
    const pkg = join(repo, "pkg");
    const sibling = join(root, "sibling");
    for (const dir of [pkg, sibling]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<p>x</p>");
    }
    for (const dir of [repo, sibling]) {
      git(dir, "init", "-q");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "x");
    }
    const marker = join(root, "marker");
    // What a run may write in its checkout's subdir: no `.git` segment anywhere, so the sandbox allows it.
    // A bare repository (HEAD, objects/, refs/, config) with a core.worktree and a filter driver.
    const source = join(root, "planted-src");
    Bun.spawnSync([SYSTEM_BIN.git, "init", "-q", "--bare", source], { env: { PATH: "/usr/bin:/bin", HOME: scratch } });
    cpSync(source, pkg, { recursive: true });
    writeFileSync(join(pkg, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree({ pkg, sibling })}\n[filter "pwn"]\n\tclean = touch '${marker}'; cat\n`);
    const app = { id: "bare-fixture", repo: "repo/pkg", root: "repo/pkg", scan: { paths: ["repo/pkg"], exclude: [] } } as unknown as AppEntry;
    return { root, repo, pkg, sibling, marker, app };
  }

  test("a bare repository planted in an app subdir with core.worktree naming another checkout (Opus R4 P0-2) does not widen the writable set", () => {
    const t = plantedBare(({ sibling }) => sibling);
    // The old discovery (git rev-parse from the dir) takes the planted repository and its work tree.
    expect(plainGit(t.pkg, ["rev-parse", "--show-toplevel"]).stdout.toString().trim()).toBe(realpathSync(t.sibling));
    const scope = appScope(t.root, t.app);
    expect(scope.writable).toEqual([realpathSync(t.repo)]);
    expect(scope.checkouts).toEqual([realpathSync(t.repo)]);
  });

  test("a bare repository planted in an app subdir with a staged index, a .gitattributes and a filter (Opus R4 P0-2): test:apps' status runs no filter", () => {
    const t = plantedBare(({ pkg }) => pkg);
    writeFileSync(join(t.pkg, ".gitattributes"), "* filter=pwn\n");
    Bun.spawnSync([SYSTEM_BIN.git, `--git-dir=${t.pkg}`, `--work-tree=${t.pkg}`, "add", "index.html", ".gitattributes"], { env: { PATH: "/usr/bin:/bin", HOME: scratch } });
    rmSync(t.marker, { force: true });
    writeFileSync(join(t.pkg, "index.html"), "<p>changed by the run</p>");
    // As test:apps does before (and after) each command.
    const write = appWriteScope(t.root, t.app);
    statusSnapshot(write);
    expect(existsSync(t.marker)).toBe(false);
    expect(write.checkouts).toEqual([realpathSync(t.repo)]);
    expect(write.gitDirs).toEqual({ [realpathSync(t.repo)]: realpathSync(join(t.repo, ".git")) });
  });
});

describe.skipIf(!workspaceRoot())("the mirror's checkouts", () => {
  test("every checkout of the mirror pins: worktrees whose git dirs sit in the owner's tree, system-view's own .git, submodule worktrees", () => {
    const root = workspaceRoot()!;
    const dirs = ["system-view", "design-system", "codecaine/core", "codecaine/core/sequence", "codecaine/core/agent-kernel", "codecaine/core/docs-system/external/annotations", "codecaine/core/canvas/tools/docs-framework", "lascari-ai/personal-site"]
      .map((dir) => join(root, dir))
      .filter((dir) => existsSync(join(dir, ".git")));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const pin = pinFor(dir)!;
      expect(pin.workTree).toBe(realpathSync(dir));
      expect(pin.objectFormat).toBe("sha1");
      expect(pinnedGit(pin, ["rev-parse", "HEAD"]).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe.skipIf(Boolean(sandboxUnavailable()))("the run sandbox keeps every `.git` read-only", () => {
  test("a sandboxed process cannot rewrite the checkout's .git or its config, so the tool's git runs no command of its", () => {
    const t = fixture();
    pinRepos([t.app]);
    const scope = appScope(t.root, t.entry);
    expect(scope.writable).toEqual([realpathSync(t.app)]);
    const tmp = mkdtempSync(join(scratch, "run-tmp-"));
    const policy = runPolicy({ root: t.root, tmp, outDir: join(t.root, "out"), writable: scope.writable, readOnly: scope.readOnly, home: join(scratch, "no-home"), ownerTree: join(scratch, "no-owner") });
    const evil = join(t.app, "evil-git");
    const attack = [
      `cp -R '${join(t.app, ".git")}' '${evil}'`,
      `printf '[core]\\n\\tfsmonitor = ${t.hook}\\n' >> '${join(evil, "config")}'`,
      `printf '[core]\\n\\tfsmonitor = ${t.hook}\\n' >> '${join(t.app, ".git", "config")}' || echo config-denied`,
      `mv '${join(t.app, ".git")}' '${join(t.app, "git-moved")}' || echo move-denied`,
      `echo 'gitdir: ${evil}' > '${join(t.app, ".git")}' || echo rewrite-denied`,
      `echo changed > '${join(t.app, "index.html")}' && echo app-write-ok`,
    ].join("; ");
    const result = Bun.spawnSync(sandboxCommand(policy, ["/bin/sh", "-c", attack]), { cwd: tmp, stdout: "pipe", stderr: "pipe" });
    const said = result.stdout.toString();
    for (const line of ["config-denied", "move-denied", "rewrite-denied", "app-write-ok"]) expect(said).toContain(line);
    // The crafted copy (a plain dir the app may write) is there, but the checkout's `.git` still points at
    // the pinned git dir: the tool's git reads the real repository and runs no hook.
    const state = treeState(t.root, t.entry);
    expect(state.appHead).toMatch(/^[0-9a-f]{40}$/);
    expect(state.appDirty).toBe(2); // index.html modified, evil-git/ untracked
    expect(existsSync(t.marker)).toBe(false);
  });
});
