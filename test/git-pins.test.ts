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

import { appScope } from "../scripts/lib/checkouts.ts";
import { gitEnv, GitPinChanged, GitPinError, markAppsStarted, pinFor, pinnedGit, pinRepos, resetPinsForTests } from "../scripts/lib/git.ts";
import { treeState } from "../scripts/lib/provenance.ts";
import type { AppEntry } from "../scripts/lib/registry.ts";
import { runPolicy, sandboxCommand, sandboxUnavailable } from "../scripts/lib/sandbox.ts";
import { SYSTEM_BIN } from "../scripts/lib/system-bin.ts";

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
