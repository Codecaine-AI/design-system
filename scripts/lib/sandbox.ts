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
 *   writes   nowhere (deny file-write* under "/") except the app's own checkouts (checkouts.ts appScope:
 *            decision 29), the run's temp dir and the device files runtimes open. Inside those, never a
 *            `.git` entry or anything under one, never a git dir inside --root, never another repository's
 *            checkout nested there; and none of those dirs itself can be renamed or removed (a rename
 *            would carry what it holds past every path rule). Everything else under --root is read-only: the run folder and the
 *            tool's out dir, .tooling/*, .bun-global, every design-system checkout, Core's node_modules
 *            with Playwright and Electron (also listed by name, toolPackageDirs). Nothing on PATH
 *            (/usr/local/bin is the owner's), no other temp dir, no cache dir: a run can plant nothing an
 *            unsandboxed process runs
 *   services no LaunchServices open (lsopen), no AppleEvents, no lookup of cfprefsd or LaunchServices
 *            (`open` would start an unsandboxed app; cfprefsd reads and writes ~/Library/Preferences on a
 *            process's behalf, past the file rules: denied, CFPreferences falls back to the files)
 *   signals  only processes inside this same sandbox (the run's own)
 *
 * Policies: runPolicy (app runs; with `suiteNetwork` or the older `anyLoopback`, test suites), packPolicy
 * (npm pack: writes only its staging and npm HOME, no network) and browserPolicy (Chromium for snapshot,
 * verify and the profile proof: the run's ports only, writes only its own profile and temp dir).
 *
 * Seatbelt matches the kernel's canonical path (realpath, on-disk case, /Users rather than the firmlink
 * spelling), so every path in the profile is canonicalized first. Later rules win over earlier ones. The
 * profile is inherited by every descendant. Chromium cannot install its own Seatbelt sandbox inside one,
 * so a sandboxed Chromium or Electron runs with `--no-sandbox` (the outer profile still contains the tree).
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
 * `(local ip "localhost:<port>")` matches every local address, not only loopback, and Seatbelt has no
 * working inbound peer filter: a run may listen on 0.0.0.0 or a LAN address of an allowed port. The app
 * runner's egress sampling treats such a listener as a violation and stops the run at once (app-runner.ts);
 * for test suites (anyLoopback, suiteNetwork) test:apps must do the same with egress.ts exposedListeners.
 * Seatbelt has no port ranges ("localhost:49152-65535" is an invalid address): a suite's ephemeral range
 * is 16384 rules (about 4.5 s to compile, so such a profile goes to sandbox-exec as a file, -f), and a bind
 * to port 0 matches no single port, so a suite's binds stay a deny list (owner ports and the listeners
 * found at start) while its connects are the allow list.
 *
 * Fail closed: sandboxCommand throws SandboxUnavailable when sandbox-exec is missing or cannot apply a
 * profile (for example when the tool itself already runs inside a sandbox that forbids nesting).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { HOME_SECRETS, OWNER_PORTS, OWNER_TREE } from "./owner";
import { toolPackageDirs } from "./playwright";
import { SYSTEM_BIN } from "./system-bin";
import { DESIGN_SYSTEM_ROOT } from "./registry";
import { canonicalPath, realHome, safeTempBase, sameDir } from "./safe-paths";

export { realHome };

export const SANDBOX_EXEC = SYSTEM_BIN.sandboxExec;

export class SandboxUnavailable extends Error {
  override name = "SandboxUnavailable";
}

export interface SandboxPolicy {
  /** The real user's home. Reads and writes under it are denied except as listed below. */
  home: string;
  /** Directories the run may write (the app's own checkouts, the run's temp dir). */
  writable: string[];
  /** Names of sandbox-exec -D parameters whose values are writable dirs (Chromium's profile dir). */
  writableParams?: string[];
  /** Directories inside which every `.git` entry, and everything under one, is read-only (the writable checkouts). */
  gitProtected?: string[];
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
 * Mach services no run process may look up: cfprefsd (it reads and writes ~/Library/Preferences for the
 * caller, past the file rules) and LaunchServices (`open`, which starts apps outside the sandbox).
 */
export const DENIED_MACH_SERVICES = ["com.apple.cfprefsd.daemon", "com.apple.cfprefsd.agent", "com.apple.coreservices.launchservicesd"];
export const DENIED_MACH_PREFIXES = ["com.apple.lsd."];

/** The macOS ephemeral port range (net.inet.ip.portrange.first/last): where a suite's own servers listen. */
export const EPHEMERAL_PORTS = { min: 49152, max: 65535 } as const;

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

/** The sandbox-exec -D parameter that carries Chromium's profile dir into browserPolicy's profile. */
export const BROWSER_PROFILE_PARAM = "DS_PROFILE_DIR";

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

/** A path as a literal inside a Seatbelt #"..." regex (which ends at a `"`, so a path with one is refused). */
function regexLiteral(path: string): string {
  if (path.includes('"')) throw new Error(`sandbox: a path with a double quote cannot go into a profile regex: ${path}`);
  return path.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
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
  lines.push(
    ";; services: no LaunchServices open, no AppleEvents, no cfprefsd or LaunchServices lookup",
    "(deny lsopen)",
    "(deny appleevent-send)",
    `(deny mach-lookup ${[...DENIED_MACH_SERVICES.map((name) => `(global-name ${sbString(name)})`), ...DENIED_MACH_PREFIXES.map((prefix) => `(global-name-prefix ${sbString(prefix)})`)].join(" ")})`,
  );

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
  const writable = [...(policy.writable.length ? [filters("subpath", policy.writable)] : []), ...(policy.writableParams ?? []).map((name) => `(subpath (param ${sbString(name)}))`)];
  if (writable.length) lines.push(`(allow file-write* ${writable.join(" ")})`);
  lines.push(`(allow file-write* ${WRITABLE_DEVICES})`);
  // Seatbelt checks a rename by its two paths only, so a writable dir renamed away carries everything in
  // it past every path rule below (its `.git`, the read-only checkouts nested in it): move it, rewrite,
  // move it back. So no writable dir and no gitProtected dir can itself be renamed, replaced or removed.
  // A `literal` rule covers the dir's own entry only: what it holds stays writable (checked by its own
  // path), and creating it again where it exists still fails with EEXIST, not EPERM (mkdir -p works).
  const tops = canonicalAll([...policy.writable, ...(policy.gitProtected ?? [])]);
  if (tops.length) lines.push(`(deny file-write* ${filters("literal", tops)})`);
  if (policy.readOnly?.length) {
    lines.push(`(deny file-write* ${filters("subpath", policy.readOnly)})`);
    // Seatbelt checks a rename's two paths, never what the moved dir holds: renaming an ancestor of a
    // read-only dir (inside a writable one) away, writing into it and renaming it back would get past the
    // rule above. So every dir between a writable dir and a read-only dir in it can be neither renamed
    // nor removed (entries in it stay writable: they are checked by their own paths). The writable dir
    // itself is guarded above.
    const writableDirs = canonicalAll(policy.writable);
    const ancestors = new Set<string>();
    for (const dir of canonicalAll(policy.readOnly))
      for (const top of writableDirs) if (dir.startsWith(`${top}/`)) for (let at = dirname(dir); at !== top && at.startsWith(`${top}/`); at = dirname(at)) ancestors.add(at);
    if (ancestors.size) lines.push(`(deny file-write* ${[...ancestors].sort().map((path) => `(literal ${sbString(path)})`).join(" ")})`);
  }
  // Every `.git` entry (file or dir) at any depth, and everything under one: git config, hooks, the index.
  for (const dir of canonicalAll(policy.gitProtected ?? [])) lines.push(`(deny file-write* (regex #"^${regexLiteral(dir)}/(.*/)?\\.git(/|$)"))`);

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
  /**
   * The dirs under --root the run may write: the app's own checkouts (checkouts.ts appScope().writable,
   * decision 29), or the checkouts test:apps scans. Default: none, so a run writes only its temp dir.
   * Every `.git` entry inside them stays read-only.
   */
  writable?: string[];
  /** Inside `writable`, never writable: other repositories' checkouts nested there, git dirs inside --root. */
  readOnly?: string[];
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
   * Test suites (decision 31): connect only to the app's block and the ephemeral range 49152-65535, minus
   * `listeners` (every port something listened on when the run started) and the denied ports; listen on
   * any port but those (Seatbelt cannot single out a bind to port 0, nor a loopback address from 0.0.0.0:
   * the caller checks for listeners beyond loopback, egress.ts exposedListeners). Owner ports never.
   */
  suiteNetwork?: { listeners: readonly number[] };
  /**
   * Superseded by suiteNetwork (decision 31): connect to and listen on any loopback port except
   * `deniedPorts` and `extraDeniedPorts` (decision 27). Never for app runs.
   */
  anyLoopback?: boolean;
  /** The ports never contacted or bound (default OWNER_PORTS; tests pass stand-ins). */
  deniedPorts?: readonly number[];
  /** Denied on top of `deniedPorts` (with anyLoopback: the listeners found at start). */
  extraDeniedPorts?: readonly number[];
}

/** The read-only dirs under --root every run gets, whatever it may write: the tool's and the run's own. */
function toolDirsUnder(root: string, outDir: string, designSystems: string[]): string[] {
  const dirs = [
    ...designSystems,
    outDir,
    // The run folder ($DS_RUN), the tooling worktrees, the bun link registry the run.env points at.
    process.env.DS_RUN,
    join(root, ".tooling"),
    join(root, ".bun-global"),
    process.env.BUN_INSTALL_GLOBAL_DIR,
    process.env.BUN_INSTALL_BIN,
    // Playwright and Electron, which the tool loads from Core's node_modules.
    ...toolPackageDirs(root),
  ];
  return [...new Set(dirs.filter((dir): dir is string => typeof dir === "string" && dir.length > 0 && existsSync(dir)))];
}

/**
 * The run policy: writes only in the given dirs (the app's own checkouts) and the run's temp dir, never a
 * `.git` entry there, never the tool's dirs (toolDirsUnder); reads under home only in `root`, the runtimes
 * and the browser cache; credential stores and the owner's tree hidden (the owner's tree is readable when
 * it is `root` itself; the design-system checkout stays readable inside a hidden owner tree); network only
 * to the app's own block and allowedLocalPorts; listening only on its block; owner ports never.
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
  const denied = [...new Set([...(opts.deniedPorts ?? OWNER_PORTS), ...(opts.extraDeniedPorts ?? [])])];
  const writable = opts.writable ?? [];
  let connectPorts: number[] | undefined = [...block, ...(opts.allowedLocalPorts ?? [])];
  let bindPorts: number[] | "any" = opts.bindAnyPort ? "any" : block;
  let deniedPorts = denied;
  if (opts.suiteNetwork) {
    const listeners = new Set(opts.suiteNetwork.listeners);
    const ephemeral = Array.from({ length: EPHEMERAL_PORTS.max - EPHEMERAL_PORTS.min + 1 }, (_, i) => EPHEMERAL_PORTS.min + i);
    connectPorts = [...block, ...ephemeral].filter((port) => !listeners.has(port));
    bindPorts = "any";
    deniedPorts = [...new Set([...denied, ...listeners])].sort((a, b) => a - b);
  } else if (opts.anyLoopback) {
    connectPorts = undefined;
    bindPorts = "any";
  }
  return {
    home,
    writable: [...writable, opts.tmp],
    gitProtected: writable,
    readOnly: [...new Set([...toolDirsUnder(opts.root, opts.outDir, designSystems), ...(opts.readOnly ?? [])])],
    readable: [opts.root, opts.tmp, opts.outDir, ...designSystems, ...HOME_RUNTIMES.map((rel) => join(home, rel))],
    hidden,
    readableInHidden: [designSystem],
    connectPorts,
    bindPorts,
    unixSockets: { paths: SYSTEM_UNIX_SOCKETS, dirs: [opts.tmp] },
    deniedPorts,
  };
}

export interface PackPolicyOptions {
  /** The package being packed (npm's cwd): readable, never writable. */
  packageRoot: string;
  /** npm's --pack-destination. */
  staging: string;
  /** npm's HOME (its cache, config and TMPDIR live there). */
  npmHome: string;
  home?: string;
  ownerTree?: string;
}

/**
 * npm pack (decision 31): writes only `staging` and `npmHome`; no network at all (no IP, no Unix socket,
 * no bind); reads under home only the package and the runtimes (~/.nvm holds npm and node); credential
 * stores and the owner's tree hidden (the package stays readable inside it). PATH is the caller's to pin.
 */
export function packPolicy(opts: PackPolicyOptions): SandboxPolicy {
  const home = opts.home ?? realHome();
  return {
    home,
    writable: [opts.staging, opts.npmHome],
    readOnly: [opts.packageRoot],
    readable: [opts.packageRoot, opts.staging, opts.npmHome, ...HOME_RUNTIMES.map((rel) => join(home, rel))],
    hidden: [...HOME_SECRETS.map((rel) => join(home, rel)), opts.ownerTree ?? OWNER_TREE],
    readableInHidden: [opts.packageRoot],
    connectPorts: [],
    bindPorts: [],
    unixSockets: { paths: [], dirs: [] },
    deniedPorts: OWNER_PORTS,
  };
}

export interface BrowserPolicyOptions {
  /** The browser's own HOME and TMPDIR (a fresh temp dir of the tool's). */
  browserHome: string;
  /** Loopback ports the browser may connect to: the running app's block and allowedLocalPorts. */
  connectPorts: number[];
  /** More dirs under the home it may read (snapshot:sheet's file: pages). */
  readable?: string[];
  home?: string;
  ownerTree?: string;
  deniedPorts?: readonly number[];
}

/**
 * Chromium (decision 29): connect only to the run's ports on loopback; no listening; writes only its
 * own temp dir and its profile dir (the sandbox-exec -D parameter BROWSER_PROFILE_PARAM, which the
 * launcher sets from Playwright's --user-data-dir); reads under home only the Playwright browser cache;
 * credential stores and the owner's tree hidden.
 */
export function browserPolicy(opts: BrowserPolicyOptions): SandboxPolicy {
  const home = opts.home ?? realHome();
  return {
    home,
    writable: [opts.browserHome],
    writableParams: [BROWSER_PROFILE_PARAM],
    readable: [opts.browserHome, join(home, "Library/Caches/ms-playwright"), ...(opts.readable ?? [])],
    hidden: [...HOME_SECRETS.map((rel) => join(home, rel)), opts.ownerTree ?? OWNER_TREE],
    connectPorts: opts.connectPorts,
    bindPorts: [],
    unixSockets: { paths: SYSTEM_UNIX_SOCKETS, dirs: [opts.browserHome] },
    deniedPorts: opts.deniedPorts ?? OWNER_PORTS,
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

/** A profile longer than this goes to sandbox-exec as a file: argv is limited (ARG_MAX, 1 MiB with the environment). */
export const INLINE_PROFILE_MAX = 64 * 1024;

let profileDir: string | undefined;

/**
 * Writes a profile to a file in a dir of the tool's own (a fresh dir under the system temp dir, which no
 * run can write; removed when this process exits) and returns its path.
 */
export function writeProfileFile(profile: string, dir?: string): string {
  if (!dir) {
    if (!profileDir || !existsSync(profileDir)) {
      profileDir = mkdtempSync(join(safeTempBase(), "ds-sbpl-"));
      const made = profileDir;
      process.once("exit", () => rmSync(made, { recursive: true, force: true }));
    }
    dir = profileDir;
  }
  const path = join(dir, `profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`);
  writeFileSync(path, profile, { mode: 0o600, flag: "wx" });
  return path;
}

/**
 * `argv` wrapped in sandbox-exec under `policy`, with `params` as -D parameters (a policy's
 * writableParams need theirs). Throws SandboxUnavailable when it cannot be contained.
 */
export function sandboxCommand(policy: SandboxPolicy, argv: string[], sandboxExec = SANDBOX_EXEC, params: Record<string, string> = {}): string[] {
  const reason = sandboxUnavailable(sandboxExec);
  if (reason) throw new SandboxUnavailable(`no OS sandbox for run processes: ${reason}`);
  for (const name of policy.writableParams ?? []) if (!params[name]) throw new Error(`sandbox: the profile needs the parameter ${name}`);
  const defines = Object.entries(params).flatMap(([name, value]) => ["-D", `${name}=${canonicalPath(value)}`]);
  const profile = sandboxProfile(policy);
  return profile.length > INLINE_PROFILE_MAX ? [sandboxExec, ...defines, "-f", writeProfileFile(profile), ...argv] : [sandboxExec, ...defines, "-p", profile, ...argv];
}
