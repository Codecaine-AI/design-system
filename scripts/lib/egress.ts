/**
 * Server-side egress evidence: what a run's processes are connected to, read from `lsof`.
 *
 * The OS sandbox (sandbox.ts) is the boundary; this is the evidence that it held and that the run
 * talked only to itself. A connection leaves the run when its peer is not loopback, is an owner port,
 * or is a loopback port no run process listens on. Inbound connections to the run's listeners pass.
 *
 * A failed or missing lsof is never read as "no connections": lsofConnections reports it, and callers
 * treat the observation as inconclusive.
 */
import { OWNER_PORTS } from "./owner";
import { SYSTEM_BIN, SYSTEM_PATH } from "./system-bin";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]"]);

export function isLoopbackAddress(host: string): boolean {
  return LOOPBACK.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
}

export interface Connection {
  pid: number;
  command?: string;
  proto: string;
  local: { host: string; port: number };
  remote?: { host: string; port: number };
  state?: string;
  raw: string;
}

function splitHostPort(s: string): { host: string; port: number } | null {
  const i = s.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(s.slice(i + 1));
  if (s.slice(i + 1) === "" || !Number.isInteger(port)) return null;
  return { host: s.slice(0, i), port };
}

/** Parse `lsof -nP -i` output into connections; the header and unparsable lines are dropped. */
export function parseLsof(output: string): Connection[] {
  const out: Connection[] = [];
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9 || cols[0] === "COMMAND") continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid)) continue;
    const m = cols.slice(8).join(" ").match(/^(\S+?)(?:->(\S+))?(?:\s+\((\w+)\))?$/);
    if (!m) continue;
    const local = splitHostPort(m[1]!);
    if (!local) continue;
    const remote = m[2] ? (splitHostPort(m[2]) ?? undefined) : undefined;
    out.push({ pid, command: cols[0], proto: cols[7]!, local, remote, state: m[3], raw: line.trim() });
  }
  return out;
}

/**
 * Connections that leave the run. `inbound`: ports the run listens or listened on (a connection whose
 * local port is one of them was accepted by the run). `outbound`: ports a run process may connect to
 * (the run's current listeners and the profile's allowedLocalPorts). Owner ports and non-loopback peers
 * always leave the run.
 */
export function egressConnections(conns: Connection[], ports: { inbound: ReadonlySet<number>; outbound: ReadonlySet<number> }): Connection[] {
  return conns.filter((c) => {
    if (!c.remote) return false; // a listener or an unconnected socket
    if (!isLoopbackAddress(c.remote.host)) return true;
    if (OWNER_PORTS.includes(c.remote.port)) return true;
    if (ports.inbound.has(c.local.port)) return false;
    return !ports.outbound.has(c.remote.port);
  });
}

/** egressConnections with one port set for both directions (the profile proof's view). */
export function foreignConnections(conns: Connection[], ownPorts: ReadonlySet<number>): Connection[] {
  return egressConnections(conns, { inbound: ownPorts, outbound: ownPorts });
}

export type LsofResult = { ok: true; conns: Connection[] } | { ok: false; reason: string };

/**
 * What an lsof run says. lsof exits 1 both when a selection matched nothing and on errors; with -w
 * (warnings off) an error always prints to stderr. Exit 0, or exit 1 with an empty stderr, is an
 * observation; anything else is a failure, never an empty result.
 */
export function lsofResult(code: number | null, stdout: string, stderr: string): LsofResult {
  // Exit 1 without a message also covers a pid that exited between `ps` and lsof (the rest still listed).
  if (code === 0 || (code === 1 && stderr.trim() === "")) return { ok: true, conns: parseLsof(stdout) };
  return { ok: false, reason: `lsof exited ${code}${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}` };
}

/** How long one lsof may run before it is killed and the sample counts as failed. */
export const LSOF_TIMEOUT_MS = 10_000;

/** TCP sockets of `pids` (`lsof -nP -w -a -p <pids> -iTCP`, or `-i` for UDP too). A hung lsof is killed and fails. */
export async function lsofConnections(pids: number[], protocol: "-iTCP" | "-i" = "-iTCP", timeoutMs = LSOF_TIMEOUT_MS): Promise<LsofResult> {
  if (pids.length === 0) return { ok: true, conns: [] };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([SYSTEM_BIN.lsof, "-nP", "-w", "-a", "-p", pids.join(","), protocol], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { PATH: SYSTEM_PATH } });
  } catch (error) {
    return { ok: false, reason: `lsof did not run: ${error instanceof Error ? error.message : String(error)}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    if (timedOut) return { ok: false, reason: `lsof timed out after ${timeoutMs} ms` };
    return lsofResult(code, stdout, stderr);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a socket listens beyond loopback (0.0.0.0, ::, `*`, a LAN address): other hosts can connect.
 * Seatbelt cannot refuse such a bind (its `localhost` matches every local address) nor filter the peers a
 * listener accepts, so the tools check for it themselves: the app runner (egress sampling) and, for test
 * suites, test:apps (exposedListeners on the command's processes).
 */
export function isExposedListener(c: Connection): boolean {
  return !c.remote && c.state === "LISTEN" && !isLoopbackAddress(c.local.host);
}

/** The listeners of `pids` that other hosts can reach (isExposedListener); a failed lsof is reported, never "none". */
export async function exposedListeners(pids: number[]): Promise<{ ok: true; listeners: Connection[] } | { ok: false; reason: string }> {
  const result = await lsofConnections(pids);
  if (!result.ok) return result;
  return { ok: true, listeners: result.conns.filter(isExposedListener) };
}

/** One line per connection, for violations and reports: "egress: bun(123) 127.0.0.1:50000->127.0.0.1:4820 (ESTABLISHED)". */
export function describeConnection(c: Connection): string {
  const name = c.remote ? `${c.local.host}:${c.local.port}->${c.remote.host}:${c.remote.port}` : `${c.local.host}:${c.local.port}`;
  return `egress: ${c.command ?? "?"}(${c.pid}) ${c.proto} ${name}${c.state ? ` (${c.state})` : ""}`;
}
