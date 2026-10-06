/**
 * OS-level containment for every process a rollout run starts (macOS `sandbox-exec`, Seatbelt).
 *
 * The profile is generated per run and is the run's hard boundary; the request guard and egress sampling
 * are evidence on top. Deny by default:
 *   network  outbound only to the run's own loopback ports (its registry port block and allowedLocalPorts),
 *            never an owner port, never a non-loopback address; listening only on its block; Unix sockets
 *            only the system sockets the runtimes need (DNS) and sockets under the run's temp dir. Every
 *            listener the run did not start counts as an owner service.
 *   reads    nothing under the real home except the --root tree, the runtimes the apps start with
 *            (~/.bun, ~/.nvm) and the Playwright browser cache (plus stat of home and the dirs on the way to
 *            them, so realpath works); never a `.env*` file anywhere; never a credential store or the
 *            owner's tree (HOME_SECRETS, OWNER_TREE unless it is the --root), even inside a readable dir
 *   writes   nowhere (deny file-write* under "/") except the --root tree, the run's temp dir and the
 *            device files runtimes open; never the design-system checkout the tool runs from or the tool's
 *            out dir (logs, run records), even inside --root. Nothing on PATH (/usr/local/bin is the
 *            owner's), no other temp dir, no cache dir: a run can plant nothing an unsandboxed process runs
 *   signals  only processes inside this same sandbox (the run's own)
 *
 * Seatbelt matches the kernel's canonical path (realpath, on-disk case, /Users rather than the firmlink
 * spelling), so every path in the profile is canonicalized first. Later rules win over earlier ones. The
 * profile is inherited by every descendant. Chromium cannot install its own Seatbelt sandbox inside one,
 * so a sandboxed Electron app runs with `--no-sandbox` (the outer profile still contains the whole tree).
 *
 * The kernel does not log denials of sandbox-exec profiles on this macOS (26.x): `log show --predicate
 * 'sender == "Sandbox"'` lists only system daemons' denials, with `(debug deny)` and `(with message ...)`
 * too. A denied operation surfaces only as EPERM in the run's own output; the egress sampling stays the
 * independent evidence for network traffic.
 *
 * NETWORK RULE SHAPES. Scanning every run port block (46900-46939, 47000-47259) under generated profiles
 * showed two Seatbelt bugs: with any `(remote unix-socket ...)` rule after the per-port
 * `(allow network-outbound (remote ip "localhost:<port>"))` rules, connects to some allowed ports fail
 * with EPERM; and per-port `(allow network-bind ...)` rules after `(deny network-bind (local ip "*:*"))`
 * deny some allowed ports whatever the address form (localhost, *, tcp, ip4). Which ports fail depends on
 * the profile text. Deny rules were reliable in every shape. So the Unix-socket rules come before the IP
 * rules, and binding is a single `(deny network-bind (require-not (require-any <the allowed ports and the
 * run's socket dir>)))`; test/sandbox.test.ts re-scans every block with the generated profile.
 *
 * Fail closed: sandboxCommand throws SandboxUnavailable when sandbox-exec is missing or cannot apply a
 * profile (for example when the tool itself already runs inside a sandbox that forbids nesting).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { HOME_SECRETS, OWNER_PORTS, OWNER_TREE } from "./owner";
import { SYSTEM_BIN } from "./system-bin";
import { DESIGN_SYSTEM_ROOT } from "./registry";
import { canonicalPath, realHome, sameDir } from "./safe-paths";

export { realHome };

export const SANDBOX_EXEC = SYSTEM_BIN.sandboxExec;

export class SandboxUnavailable extends Error {
  override name = "SandboxUnavailable";
}

export interface SandboxPolicy {
  /** The real user's home. Reads and writes under it are denied except as listed below. */
  home: string;
  /** Directories the run may write (the --root tree, the run's temp dir). */
  writable: string[];
  /** Directories inside `writable` the run may not write (the design-system checkout, the tool's out dir). */
  readOnly?: string[];
  /** Directories under `home` the run may read (the --root tree, runtimes, the browser cache). */
  readable?: string[];
  /** Paths the run may neither read nor write, even inside `readable` (they win over it). */
  hidden: string[];
  /** Paths inside `hidden` the run may still read (not write): the design-system checkout the tool runs from. */
  readableInHidden?: string[];
  /** Loopback ports the run may connect to. Omitted: every loopback port except `deniedPorts` (legacy). */
  connectPorts?: number[];
  /** Loopback ports the run may listen on; "any" for an Electron app (DevTools and the inspector bind port 0). */
  bindPorts?: number[] | "any";
  /** Unix sockets the run may connect to: exact paths, and every socket under these dirs. */
  unixSockets?: { paths: string[]; dirs: string[] };
  /** Loopback ports the run may never connect to or listen on, whatever else allows them (owner ports). */
  deniedPorts: readonly number[];
}

/** Basename `.env` and everything that starts with it (`.env.local`, `.envrc`, `.env-local`, `.env_prod`), in any directory. */
export const ENV_FILE_REGEX = String.raw`/\.env[^/]*$`;

/**
 * Unix sockets the runtimes need: DNS (getaddrinfo goes through mDNSResponder, so `localhost` resolves)
 * and syslog. Found empirically: bun, node, python3 and Vite start and serve with only these.
 */
export const SYSTEM_UNIX_SOCKETS = ["/private/var/run/mDNSResponder", "/private/var/run/syslog"];

/**
 * Device files a run may open for writing: the null/zero devices, its terminal, inherited descriptors
 * (/dev/stdout is /dev/fd/1), pseudo-terminals, and dtrace's helper (the dynamic linker opens it).
 */
const WRITABLE_DEVICES = [
  ...["/dev/null", "/dev/zero", "/dev/tty", "/dev/ptmx", "/dev/dtracehelper"].map((path) => `(literal "${path}")`),
  '(subpath "/dev/fd")',
  '(regex #"^/dev/ttys[0-9]+$")',
].join(" ");

/** Runtime dirs under the real home that apps start from (relative to it): bun, nvm's node, Playwright's browsers. */
export const HOME_RUNTIMES = [".bun", ".nvm", "Library/Caches/ms-playwright"];

function sbString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function canonicalAll(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => canonicalPath(path)))];
}

function filters(kind: "subpath" | "literal", paths: readonly string[]): string {
  return canonicalAll(paths)
    .map((path) => `(${kind} ${sbString(path)})`)
    .join(" ");
}

function checkPort(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`sandbox: invalid port ${port}`);
}

/** Every dir from `home` (exclusive) up to `dir`'s parent: stat-able so realpath of `dir` works. */
function ancestorsBelow(home: string, dir: string): string[] {
  const out: string[] = [];
  for (let current = dirname(dir); current !== home && current.startsWith(`${home}/`); current = dirname(current)) out.push(current);
  return out;
}

/** The Seatbelt profile text for a policy. */
export function sandboxProfile(policy: SandboxPolicy): string {
  for (const port of [...policy.deniedPorts, ...(policy.connectPorts ?? []), ...(Array.isArray(policy.bindPorts) ? policy.bindPorts : [])]) checkPort(port);
  const denied = new Set(policy.deniedPorts);
  const home = canonicalPath(policy.home);
  const lines = ["(version 1)", "(allow default)"];

  lines.push(";; signals: only this sandbox's own processes", "(deny signal)", "(allow signal (target same-sandbox))");

  // Rule order and shape below work around Seatbelt bugs found on macOS 26.5 by scanning every port block
  // (see NETWORK RULE SHAPES in the header): a Unix-socket rule placed after the IP allow rules, or a
  // per-port `(allow network-bind ...)` after a `(deny network-bind (local ip "*:*"))`, makes the kernel
  // deny some allowed ports. Unix-socket rules come first, and binding is one negated deny rule.
  lines.push(";; network: deny by default; the run's own loopback ports only, never a denied port");
  const tmpSockets = policy.unixSockets ? canonicalAll(policy.unixSockets.dirs) : [];
  if (policy.unixSockets) {
    lines.push("(deny network-outbound (remote unix-socket))");
    const allowed = [
      // A socket's own realpath fails (EOPNOTSUPP): canonicalize its directory.
      ...[...new Set(policy.unixSockets.paths.map((path) => join(canonicalPath(dirname(path)), basename(path))))].map((path) => `(path-literal ${sbString(path)})`),
      ...tmpSockets.map((path) => `(subpath ${sbString(path)})`),
    ];
    for (const filter of allowed) lines.push(`(allow network-outbound (remote unix-socket ${filter}))`);
  }
  lines.push('(deny network-outbound (remote ip "*:*"))');
  if (policy.connectPorts === undefined) {
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
    for (const port of policy.deniedPorts) lines.push(`(deny network-outbound (remote ip "localhost:${port}"))`);
  } else for (const port of [...new Set(policy.connectPorts)].filter((p) => !denied.has(p)).sort((a, b) => a - b)) lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
  if (policy.bindPorts === "any") {
    lines.push('(allow network-bind (local ip "localhost:*"))');
    for (const port of policy.deniedPorts) lines.push(`(deny network-bind (local ip "localhost:${port}"))`);
  } else if (policy.bindPorts !== undefined) {
    const ports = [...new Set(policy.bindPorts)].filter((p) => !denied.has(p)).sort((a, b) => a - b);
    const keep = [...ports.map((port) => `(local ip "localhost:${port}")`), ...tmpSockets.map((path) => `(local unix-socket (subpath ${sbString(path)}))`)];
    lines.push(keep.length ? `(deny network-bind (require-not (require-any ${keep.join(" ")})))` : "(deny network-bind)");
  }

  lines.push(";; writes: nowhere but the writable dirs and the devices every runtime opens; never their read-only parts");
  lines.push('(deny file-write* (subpath "/"))');
  if (policy.writable.length) lines.push(`(allow file-write* ${filters("subpath", policy.writable)})`);
  lines.push(`(allow file-write* ${WRITABLE_DEVICES})`);
  if (policy.readOnly?.length) lines.push(`(deny file-write* ${filters("subpath", policy.readOnly)})`);

  if (policy.readable) {
    lines.push(";; reads under home: only the readable dirs (and stat of home and the dirs on the way to them)");
    lines.push(`(deny file-read* ${filters("subpath", [home])})`);
    const readable = canonicalAll(policy.readable);
    if (readable.length) lines.push(`(allow file-read* ${filters("subpath", readable)})`);
    const onTheWay = [home, ...readable.flatMap((dir) => ancestorsBelow(home, dir))];
    lines.push(`(allow file-read-metadata ${filters("literal", onTheWay)})`);
  }

  lines.push(";; hidden: neither read nor write, even inside a readable dir; no .env file anywhere (last, so it always wins)");
  if (policy.hidden.length) lines.push(`(deny file-read* file-write* ${filters("subpath", policy.hidden)})`);
  if (policy.hidden.length && policy.readableInHidden?.length) lines.push(`(allow file-read* ${filters("subpath", policy.readableInHidden)})`);
  // A #"..." regex literal takes the pattern as written: backslashes are not string escapes there.
  lines.push(`(deny file-read* file-write* (regex #"${ENV_FILE_REGEX}"))`);
  return `${lines.join("\n")}\n`;
}

export interface RunPolicyOptions {
  root: string;
  tmp: string;
  /** The tool's out dir (logs, run records): readable, never writable by the run. */
  outDir: string;
  home?: string;
  ownerTree?: string;
  /**
   * The design-system checkout the tool runs from: readable, never writable. Default DESIGN_SYSTEM_ROOT.
   * `<root>/design-system`, when it exists, is read-only as well, whichever checkout the tool runs from.
   */
  designSystem?: string;
  /** The app's port block (registry: 47000 + 10 x index): connect and listen. */
  blockPorts?: number[];
  /** runProfile.allowedLocalPorts: connect only. */
  allowedLocalPorts?: number[];
  /** Electron: listen on any non-owner loopback port (DevTools, the inspector). */
  bindAnyPort?: boolean;
  /**
   * Test suites that start their own servers on ephemeral ports (test:apps): connect to and listen on any
   * loopback port except `deniedPorts`. The deny-list policy runs had before decision 22; never for app runs.
   */
  anyLoopback?: boolean;
  /** The ports never contacted or bound (default OWNER_PORTS; tests pass stand-ins). */
  deniedPorts?: readonly number[];
  /**
   * Denied on top of `deniedPorts`: with `anyLoopback`, every loopback port that already has a listener
   * when the run starts (decision 22: a listener the run did not start is an owner service).
   */
  extraDeniedPorts?: readonly number[];
}

/**
 * The run policy: writes only in `root` and the run's temp dir, never in the design-system checkout or
 * the out dir; reads under home only in `root`, the runtimes and the browser cache; credential stores and
 * the owner's tree hidden (the owner's tree is readable and writable when it is `root` itself; the
 * design-system checkout stays readable inside a hidden owner tree); network only to the app's own block
 * and allowedLocalPorts; listening only on its block; owner ports never.
 */
export function runPolicy(opts: RunPolicyOptions): SandboxPolicy {
  const home = opts.home ?? realHome();
  const owner = opts.ownerTree ?? OWNER_TREE;
  const designSystem = opts.designSystem ?? DESIGN_SYSTEM_ROOT;
  // The design-system checkout the tool runs from may be a tooling worktree; the tree's own
  // <root>/design-system is just as much the tool's (its apps.json, scripts, dist): read-only for runs too.
  const rootDesignSystem = join(opts.root, "design-system");
  const designSystems = [designSystem, ...(existsSync(rootDesignSystem) ? [rootDesignSystem] : [])];
  const ownerRun = sameDir(opts.root, owner);
  const hidden = HOME_SECRETS.map((rel) => join(home, rel));
  if (!ownerRun) hidden.push(owner);
  const block = opts.blockPorts ?? [];
  return {
    home,
    writable: [opts.root, opts.tmp],
    readOnly: [...designSystems, opts.outDir],
    readable: [opts.root, opts.tmp, opts.outDir, ...designSystems, ...HOME_RUNTIMES.map((rel) => join(home, rel))],
    hidden,
    readableInHidden: [designSystem],
    connectPorts: opts.anyLoopback ? undefined : [...block, ...(opts.allowedLocalPorts ?? [])],
    bindPorts: opts.anyLoopback || opts.bindAnyPort ? "any" : block,
    unixSockets: { paths: SYSTEM_UNIX_SOCKETS, dirs: [opts.tmp] },
    deniedPorts: [...new Set([...(opts.deniedPorts ?? OWNER_PORTS), ...(opts.extraDeniedPorts ?? [])])],
  };
}

const selfTests = new Map<string, string | null>();

/** Why sandbox-exec cannot contain a process here, or null when it can (cached per binary). */
export function sandboxUnavailable(sandboxExec = SANDBOX_EXEC): string | null {
  if (selfTests.has(sandboxExec)) return selfTests.get(sandboxExec)!;
  let reason: string | null = null;
  if (process.platform !== "darwin") reason = `sandbox-exec is macOS only (platform ${process.platform})`;
  else if (!existsSync(sandboxExec)) reason = `${sandboxExec} does not exist`;
  else {
    const probe = spawnSync(sandboxExec, ["-p", '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(deny signal)(allow signal (target same-sandbox))', "/usr/bin/true"], {
      encoding: "utf8",
      timeout: 10_000,
    });
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
