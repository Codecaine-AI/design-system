/**
 * OS-level containment for every process a rollout run starts (macOS `sandbox-exec`, Seatbelt).
 *
 * The profile is the run's hard boundary; the request guard and egress sampling are evidence on top:
 *   network  outbound only to loopback, never to a denied (owner) port, never to a non-loopback address
 *   writes   denied under the real user's home, except inside the `writable` dirs (the --root tree,
 *            the run's temp dir, the run folder); the system temp dirs are outside home and stay writable
 *   reads    denied for every `.env` / `.env.*` file anywhere, and for the `hidden` paths (the owner's
 *            tree when it is not the --root, the owner's Electron profile, credential stores)
 *
 * Seatbelt matches the kernel's canonical path (realpath, on-disk case, /Users rather than the
 * firmlink spelling), so every path in the profile is canonicalized first. The profile is inherited by
 * every descendant. Chromium cannot install its own Seatbelt sandbox inside one, so a sandboxed
 * Electron app runs with `--no-sandbox` (the outer profile still contains the whole tree).
 *
 * Fail closed: sandboxCommand throws SandboxUnavailable when sandbox-exec is missing or cannot apply a
 * profile (for example when the tool itself already runs inside a sandbox that forbids nesting).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { OWNER_PORTS, OWNER_TREE } from "./owner";
import { canonicalPath, sameDir } from "./safe-paths";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export class SandboxUnavailable extends Error {
  override name = "SandboxUnavailable";
}

export interface SandboxPolicy {
  /** The real user's home. Writes under it are denied except inside `writable`. */
  home: string;
  /** Directories the run may write inside `home`. */
  writable: string[];
  /** Paths the run may neither read nor write (checked after `writable`, so they win). */
  hidden: string[];
  /** Loopback ports the run may never connect to. */
  deniedPorts: readonly number[];
}

/** Basename `.env` or `.env.<anything>`, in any directory. */
export const ENV_FILE_REGEX = String.raw`/\.env(\.[^/]*)?$`;

function sbString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function subpaths(paths: string[]): string {
  return [...new Set(paths.map((path) => canonicalPath(path)))].map((path) => `(subpath ${sbString(path)})`).join(" ");
}

/** The Seatbelt profile text for a policy. */
export function sandboxProfile(policy: SandboxPolicy): string {
  for (const port of policy.deniedPorts) if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`sandbox: invalid port ${port}`);
  const lines = [
    "(version 1)",
    "(allow default)",
    ";; network: loopback only, and never a denied port",
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    ...policy.deniedPorts.map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`),
    ";; writes: nothing under the real home outside the writable dirs",
    `(deny file-write* ${subpaths([policy.home])})`,
  ];
  if (policy.writable.length) lines.push(`(allow file-write* ${subpaths(policy.writable)})`);
  // A #"..." regex literal takes the pattern as written: backslashes are not string escapes there.
  lines.push(";; reads: no .env files, nothing hidden", `(deny file-read* file-write* (regex #"${ENV_FILE_REGEX}"))`);
  if (policy.hidden.length) lines.push(`(deny file-read* file-write* ${subpaths(policy.hidden)})`);
  return `${lines.join("\n")}\n`;
}

/** The real user's home (from the user database, not $HOME). */
export function realHome(): string {
  return userInfo().homedir;
}

/** Credential stores and the owner's Electron profile, relative to the real home. */
const HIDDEN_IN_HOME = [".ssh", ".aws", ".gnupg", ".netrc", ".npmrc", ".docker", ".config/gh", "Library/Keychains", "Library/Application Support/Electron"];

/**
 * The run policy: writes only in `root`, the run's temp dir and the run folder (out dir); the owner's
 * tree hidden unless `root` is that tree; owner ports denied.
 */
export function runPolicy(opts: { root: string; tmp: string; outDir: string; home?: string; ownerTree?: string; deniedPorts?: readonly number[] }): SandboxPolicy {
  const home = opts.home ?? realHome();
  const owner = opts.ownerTree ?? OWNER_TREE;
  const hidden = HIDDEN_IN_HOME.map((rel) => join(home, rel));
  if (!sameDir(opts.root, owner)) hidden.push(owner);
  return { home, writable: [opts.root, opts.tmp, opts.outDir], hidden, deniedPorts: opts.deniedPorts ?? OWNER_PORTS };
}

const selfTests = new Map<string, string | null>();

/** Why sandbox-exec cannot contain a process here, or null when it can (cached per binary). */
export function sandboxUnavailable(sandboxExec = SANDBOX_EXEC): string | null {
  if (selfTests.has(sandboxExec)) return selfTests.get(sandboxExec)!;
  let reason: string | null = null;
  if (process.platform !== "darwin") reason = `sandbox-exec is macOS only (platform ${process.platform})`;
  else if (!existsSync(sandboxExec)) reason = `${sandboxExec} does not exist`;
  else {
    const probe = spawnSync(sandboxExec, ["-p", '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))', "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error) reason = `${sandboxExec} failed to run: ${probe.error.message}`;
    else if (probe.status !== 0) reason = `${sandboxExec} cannot apply a profile here (exit ${probe.status}): ${(probe.stderr ?? "").trim()}`;
  }
  selfTests.set(sandboxExec, reason);
  return reason;
}

/** `argv` wrapped in sandbox-exec under `policy`. Throws SandboxUnavailable when it cannot be contained. */
export function sandboxCommand(policy: SandboxPolicy, argv: string[], sandboxExec = SANDBOX_EXEC): string[] {
  const reason = sandboxUnavailable(sandboxExec);
  if (reason) throw new SandboxUnavailable(`no OS sandbox for run processes: ${reason}`);
  return [sandboxExec, "-p", sandboxProfile(policy), ...argv];
}
