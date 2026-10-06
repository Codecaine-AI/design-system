/**
 * The page pin (guard-lsof fix round 2): every connection a guarded page makes to a local port goes through
 * this forward proxy, which the runner owns, and the proxy writes no byte upstream until it has verified,
 * with libproc, that the upstream connection's peer socket belongs to a live run process.
 *
 * guardedContext gives every context `proxy: { server: <this>, bypass: "<-loopback>" }`, so Chromium sends
 * loopback traffic here too: documents, fetch/XHR, event streams and media as absolute-form requests
 * ("GET http://127.0.0.1:47021/x HTTP/1.1"), WebSockets and the guard's own route.fetch as CONNECT tunnels.
 * launchBrowser's sandbox lets Chromium connect to this proxy only, never to the block itself, so a context
 * without the proxy reaches nothing.
 *
 * For one request or tunnel:
 *   1. The target must be a loopback literal (127.0.0.1, [::1]) or localhost, never an owner port, and a
 *      port of the run (`inputs.allowed`); otherwise it is refused and nothing is contacted.
 *   2. Pre-check: a run process must listen on the target address now (libproc), else it is refused and
 *      nothing is contacted. `localhost` goes to the family the run listens on.
 *   3. Connect, then find the peer: the run process's socket whose local port is the target and whose
 *      remote port is this connection's local port. Only a live run process (pid and start time) counts.
 *      Until it is found nothing is written; if it is not found (a process the run did not start accepted
 *      the connection, or no one did in time) the connection is reset, unwritten, and the attempt is recorded (a violation when it was not the run's).
 *   4. Then the request head is written (origin form, `Connection: close`), or the tunnel is opened, and
 *      the bytes flow both ways. A verified tunnel keeps its connection: keep-alive inside it stays pinned.
 *
 * The connection itself is made before the peer can be known: in the moment between the pre-check and the
 * connect, a process that binds a port the run let go of in that moment can accept it. It receives no byte.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

import { coversLoopback, processStart, socketFds, TCP_ESTABLISHED, TCP_LISTEN, tcpSocket, tcpSockets } from "./libproc";
import { OWNER_PORTS } from "./owner";

export interface PinInputs {
  /** The run's live processes now: pid -> start ("<sec>.<usec>", libproc). */
  processes(): Map<number, string>;
  /** Ports a socket of this process (the runner) may serve as the run's (the built-in static server). */
  selfPorts?: () => number[];
  /** Re-reads the run's processes (a child started since the last read). */
  refresh(): void;
  /** Whether the run may be reached on this port at all (its block, allowedLocalPorts). */
  allowed(port: number): boolean;
  /** Records a request or tunnel the pin refused; `violation` when a process the run did not start was involved. */
  refused(entry: string, violation?: string): void;
  /** Called for every request or tunnel the pin forwards (after the peer was verified). */
  forwarded?: (entry: string) => void;
  /** How long a run process may take to accept a connection. */
  acceptTimeoutMs?: number;
}

export interface PagePin {
  port: number;
  stop(): Promise<void>;
}

/** How long the peer of an upstream connection may take to show up in a run process. */
const ACCEPT_TIMEOUT_MS = 5_000;
/** The most a request head may be before it is refused. */
const MAX_HEAD = 64 * 1024;

type Loopback = "127.0.0.1" | "::1";

/** The loopback addresses a host may mean, in the order they are tried; null for anything else. */
function hostAddresses(host: string): Loopback[] | null {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "127.0.0.1") return ["127.0.0.1"];
  if (bare === "::1") return ["::1"];
  if (bare === "localhost" || bare.endsWith(".localhost")) return ["127.0.0.1", "::1"];
  return null;
}

/** The run process listening on loopback `address`:`port`, or null. */
function runListener(inputs: PinInputs, address: Loopback, port: number): { pid: number; reusePort: boolean } | null {
  for (const pid of inputs.processes().keys()) {
    if (pid === process.pid && !(inputs.selfPorts?.() ?? []).includes(port)) continue;
    for (const fd of socketFds(pid)) {
      const socket = tcpSocket(pid, fd);
      if (socket && socket.state === TCP_LISTEN && socket.localPort === port && coversLoopback(socket, address)) return { pid, reusePort: socket.reusePort };
    }
  }
  return null;
}

/** The run process (pid and start time still match) holding the server end of our connection, or null. */
function runPeer(inputs: PinInputs, first: number, port: number, clientPort: number): number | null {
  const processes = inputs.processes();
  for (const pid of [first, ...[...processes.keys()].filter((pid) => pid !== first)]) {
    const started = processes.get(pid);
    if (!started || (pid === process.pid && !(inputs.selfPorts?.() ?? []).includes(port))) continue;
    const peer = tcpSockets(pid).find((socket) => socket.localPort === port && socket.remotePort === clientPort && socket.state !== TCP_LISTEN);
    if (peer) return processStart(pid) === started ? pid : null;
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Closes a socket with a reset, so the peer gets no orderly end either. */
function reset(socket: Socket) {
  try {
    (socket as any).resetAndDestroy?.() ?? socket.destroy();
  } catch {
    socket.destroy();
  }
}

/**
 * Opens a pinned upstream connection to the run, or explains why not. Writes nothing to it.
 */
async function openPinned(inputs: PinInputs, host: string, port: number): Promise<{ socket: Socket } | { status: number; reason: string; violation?: string }> {
  const addresses = hostAddresses(host);
  if (!addresses || OWNER_PORTS.includes(port) || !inputs.allowed(port)) return { status: 403, reason: "not a port of the run" };
  let target: { address: Loopback; pid: number; reusePort: boolean } | null = null;
  for (let attempt = 0; attempt < 2 && !target; attempt++) {
    if (attempt) inputs.refresh();
    for (const address of addresses) {
      const listener = runListener(inputs, address, port);
      if (listener) {
        target = { address, ...listener };
        break;
      }
    }
  }
  if (!target) return { status: 502, reason: "no run process listens there" };
  // SO_REUSEPORT lets any process listen on the same address beside the run, and the kernel shares the
  // connections out: no connection to it can be kept from a stranger, so none is made.
  if (target.reusePort) {
    const why = `the run's listener on ${target.address}:${port} sets SO_REUSEPORT, so a process the run did not start may share it; the page pin does not connect to it`;
    return { status: 502, reason: why, violation: why };
  }
  const socket = connect({ host: target.address, port, noDelay: true });
  socket.pause();
  const connected = await new Promise<Error | null>((resolve) => {
    socket.once("connect", () => resolve(null));
    socket.once("error", resolve);
  });
  if (connected) {
    socket.destroy();
    return { status: 502, reason: `connect failed: ${connected.message}` };
  }
  const clientPort = socket.localPort!;
  const deadline = performance.now() + (inputs.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS);
  let refreshed = false;
  for (let polls = 0; ; polls++) {
    const pid = runPeer(inputs, target.pid, port, clientPort);
    if (pid !== null) return { socket };
    if (socket.destroyed) return { status: 502, reason: "the upstream closed before a run process took it" };
    // The listener the pre-check saw is gone and no run process has the connection. If our connection was
    // dropped (the run's closing listener, the block hold's reset) the run just let go; if it stays open,
    // a process the run did not start accepted it.
    if (polls > 5 && !runListener(inputs, target.address, port)) {
      await sleep(50);
      // Our end of the connection, read without reading from it: still established means someone holds the other end.
      const ours = tcpSockets(process.pid).find((mine) => mine.localPort === clientPort && mine.remotePort === port);
      const dropped = socket.destroyed || !ours || ours.state !== TCP_ESTABLISHED;
      if (runPeer(inputs, target.pid, port, clientPort) !== null && !socket.destroyed) return { socket };
      reset(socket);
      if (dropped) return { status: 502, reason: `the run let go of ${target.address}:${port}` };
      const why = `a process the run did not start accepted the page's connection to ${target.address}:${port}; no byte was written to it`;
      return { status: 502, reason: why, violation: why };
    }
    if (performance.now() > deadline) {
      reset(socket);
      const why = `no run process accepted the page's connection to ${target.address}:${port} within ${inputs.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS} ms`;
      return { status: 502, reason: why, violation: why };
    }
    if (!refreshed && polls === 20) {
      refreshed = true;
      inputs.refresh(); // a run child forked since the last read may have accepted it
    }
    await sleep(polls < 50 ? 1 : 10);
  }
}

/** Splits a head into its lines; null until the blank line arrives. */
function headOf(buffer: Buffer): { lines: string[]; rest: Buffer } | null {
  const end = buffer.indexOf("\r\n\r\n");
  if (end < 0) return null;
  return { lines: buffer.subarray(0, end).toString("latin1").split("\r\n"), rest: buffer.subarray(end + 4) };
}

const HOP_BY_HOP = /^(connection|keep-alive|proxy-connection|proxy-authorization|proxy-authenticate):/i;

function reply(client: Socket, status: number, reason: string) {
  const body = `page pin: ${reason}\n`;
  client.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/** Pipes upstream to client, adding `connection: close` to the response head (unless it switches protocols). */
function pipeResponse(upstream: Socket, client: Socket) {
  let pending: Buffer | null = Buffer.alloc(0);
  upstream.on("data", (chunk: Buffer) => {
    if (pending === null) return void client.write(chunk);
    pending = Buffer.concat([pending, chunk]);
    const head = headOf(pending);
    if (!head) return;
    pending = null;
    const switching = /^HTTP\/\d\.\d 101\b/.test(head.lines[0]!);
    const lines = switching ? head.lines : [...head.lines.filter((line) => !HOP_BY_HOP.test(line)), "connection: close"];
    client.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), head.rest]));
  });
  upstream.on("end", () => client.end());
  upstream.on("error", () => client.destroy());
  upstream.resume();
}

function handle(inputs: PinInputs, client: Socket) {
  client.on("error", () => undefined);
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const head = headOf(buffer);
    if (!head) {
      if (buffer.length > MAX_HEAD) reply(client, 431, "request head too large");
      return;
    }
    client.off("data", onData);
    void forward(inputs, client, head.lines, head.rest);
  };
  client.on("data", onData);
}

/**
 * While the pin verifies the upstream, the client keeps being read: what it sends is kept for later, and if
 * it ends or closes (its context closed, the request was aborted) nothing is sent upstream at all.
 */
function holdClient(client: Socket) {
  const kept: Buffer[] = [];
  let gone = client.destroyed;
  const onData = (chunk: Buffer) => void kept.push(chunk);
  const onGone = () => void (gone = true);
  client.on("data", onData);
  client.once("end", onGone);
  client.once("close", onGone);
  return {
    gone: () => gone || client.destroyed,
    /** Stops keeping; returns what was kept. The caller pipes from here on. */
    release: () => {
      client.off("data", onData);
      client.off("end", onGone);
      client.off("close", onGone);
      return Buffer.concat(kept);
    },
  };
}

async function forward(inputs: PinInputs, client: Socket, lines: string[], rest: Buffer) {
  const [method = "", target = ""] = lines[0]!.split(" ");
  const tunnel = method.toUpperCase() === "CONNECT";
  let url: URL;
  try {
    url = new URL(tunnel ? `http://${target}` : target);
  } catch {
    return reply(client, 400, "not a proxy request");
  }
  if (!tunnel && url.protocol !== "http:") return reply(client, 400, "only http");
  const port = Number(url.port || 80);
  const entry = `${tunnel ? "CONNECT" : method} ${tunnel ? target : url.href}`;
  const held = holdClient(client);
  const opened = await openPinned(inputs, url.hostname, port);
  if (!("socket" in opened)) {
    held.release();
    inputs.refused(`PIN ${entry} (${opened.reason})`, opened.violation);
    // A tunnel gets the refusal as a status (Chromium: ERR_TUNNEL_CONNECTION_FAILED); a plain request a reset,
    // so the page sees a network error, as from the guard, never a response.
    if (tunnel) return reply(client, opened.status, opened.reason);
    return reset(client);
  }
  const upstream = opened.socket;
  if (held.gone()) {
    held.release();
    return reset(upstream);
  }
  client.pause();
  const later = Buffer.concat([rest, held.release()]);
  inputs.forwarded?.(entry);
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  if (tunnel) {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (later.length) upstream.write(later);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.resume();
    client.resume();
    return;
  }
  const upgrade = lines.some((line) => /^upgrade:/i.test(line));
  const headers = lines.slice(1).filter((line) => !HOP_BY_HOP.test(line) || (upgrade && /^connection:/i.test(line)));
  upstream.write(Buffer.concat([Buffer.from(`${method} ${url.pathname}${url.search} ${lines[0]!.split(" ")[2] ?? "HTTP/1.1"}\r\n${[...headers, ...(upgrade ? [] : ["connection: close"])].join("\r\n")}\r\n\r\n`, "latin1"), later]));
  pipeResponse(upstream, client);
  client.pipe(upstream);
  client.resume();
}

/** Starts the page pin on an ephemeral loopback port. */
export async function startPagePin(inputs: PinInputs): Promise<PagePin> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    handle(inputs, client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
