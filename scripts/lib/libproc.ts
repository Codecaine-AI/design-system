/**
 * The TCP sockets and identities of processes, read through libproc (no lsof, no ps): the request
 * guard's page pin (page-pin.ts) and the block hold's worker (port-hold-worker.ts) use it.
 *
 * struct socket_fdinfo and struct proc_bsdinfo offsets are darwin arm64's (sys/proc_info.h, checked with
 * clang); selfCheck() verifies them against a socket of this process, and every caller refuses to work
 * (fails closed) when it does not pass.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_pidfdinfo: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

const PROC_PIDLISTFDS = 1;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDFDSOCKETINFO = 3;
const PROX_FDTYPE_SOCKET = 2;
const SOCKET_FDINFO_SIZE = 792;
const SOI_FAMILY = 184;
const SOI_OPTIONS = 188;
const SOI_KIND = 256;
const SOCKINFO_TCP = 2;
const INSI_FPORT = 264;
const INSI_LPORT = 268;
const INSI_VFLAG = 288;
const INSI_FADDR = 296;
const INSI_LADDR = 312;
const TCPSI_STATE = 344;
const BSDINFO_SIZE = 136;
const PBI_START_TVSEC = 120;
const PBI_START_TVUSEC = 128;
const AF_INET = 2;
const AF_INET6 = 30;
const INI_IPV4 = 0x1;
const SO_REUSEPORT = 0x200;
export const TCP_LISTEN = 1;
export const TCP_ESTABLISHED = 4;

/** A TCP socket of a process. Addresses are "127.0.0.1", "::1", "0.0.0.0", "::" or another literal. */
export interface TcpSocket {
  fd: number;
  /** The socket's family: 6 for an AF_INET6 socket, whatever addresses it also accepts. */
  family: 4 | 6;
  /** An AF_INET6 socket that also takes IPv4 (not IPV6_V6ONLY): its vflag carries IPv4. */
  dualStack: boolean;
  state: number;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /** SO_REUSEPORT is set: another socket with it may share the address. */
  reusePort: boolean;
}

const info = new DataView(new ArrayBuffer(SOCKET_FDINFO_SIZE));

function address(offset: number, family: 4 | 6): string {
  const bytes = new Uint8Array(info.buffer, offset, 16);
  if (family === 4) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  if (bytes.every((byte) => byte === 0)) return "::";
  if (bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1";
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2) words.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return words.join(":");
}

/** The TCP socket behind fd `fd` of `pid`, or null (not a TCP socket, gone, or not readable). */
export function tcpSocket(pid: number, fd: number): TcpSocket | null {
  if (libc.symbols.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, ptr(info), SOCKET_FDINFO_SIZE) < SOCKET_FDINFO_SIZE) return null;
  if (info.getInt32(SOI_KIND, true) !== SOCKINFO_TCP) return null;
  const af = info.getInt32(SOI_FAMILY, true);
  if (af !== AF_INET && af !== AF_INET6) return null;
  const family = af === AF_INET ? 4 : 6;
  return {
    fd,
    family,
    dualStack: family === 6 && (info.getUint8(INSI_VFLAG) & INI_IPV4) !== 0,
    state: info.getInt32(TCPSI_STATE, true),
    localAddress: address(INSI_LADDR, family),
    localPort: info.getUint16(INSI_LPORT, false),
    remoteAddress: address(INSI_FADDR, family),
    remotePort: info.getUint16(INSI_FPORT, false),
    reusePort: (info.getInt16(SOI_OPTIONS, true) & SO_REUSEPORT) !== 0,
  };
}

/** Every socket fd of `pid` ([] when it is gone or not readable). */
export function socketFds(pid: number): number[] {
  const size = libc.symbols.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, null, 0);
  if (size <= 0) return [];
  const list = new DataView(new ArrayBuffer(size + 8 * 64));
  const got = libc.symbols.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(list), list.byteLength);
  const fds: number[] = [];
  for (let i = 0; i + 8 <= got; i += 8) if (list.getUint32(i + 4, true) === PROX_FDTYPE_SOCKET) fds.push(list.getInt32(i, true));
  return fds;
}

/** Every TCP socket of `pid`. */
export function tcpSockets(pid: number): TcpSocket[] {
  return socketFds(pid).flatMap((fd) => tcpSocket(pid, fd) ?? []);
}

/** A process's start time as "<sec>.<usec>" (its identity with the pid), or null when it is gone. */
export function processStart(pid: number): string | null {
  const bsd = new DataView(new ArrayBuffer(BSDINFO_SIZE));
  if (libc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(bsd), BSDINFO_SIZE) < BSDINFO_SIZE) return null;
  return `${bsd.getBigUint64(PBI_START_TVSEC, true)}.${bsd.getBigUint64(PBI_START_TVUSEC, true)}`;
}

/** Whether a listening socket takes connections to loopback `address` ("127.0.0.1" or "::1") on its port. */
export function coversLoopback(socket: TcpSocket, address: "127.0.0.1" | "::1"): boolean {
  if (address === "127.0.0.1") return socket.family === 4 ? ["127.0.0.1", "0.0.0.0"].includes(socket.localAddress) : socket.dualStack && socket.localAddress === "::";
  return socket.family === 6 && ["::1", "::"].includes(socket.localAddress);
}

/**
 * Checks the offsets above on sockets of this process: an IPv4 listener, an IPv6-only and a dual-stack IPv6
 * listener (Bun.listen), and a connection between two of them. Null when they read back right, else why not.
 */
export async function selfCheck(): Promise<string | null> {
  const { connect, createServer } = await import("node:net");
  const servers: Array<import("node:net").Server> = [];
  const listen = (host: string, ipv6Only: boolean) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer((socket) => socket.on("error", () => undefined));
      servers.push(server);
      server.once("error", reject);
      server.listen({ host, port: 0, ipv6Only }, () => resolve((server.address() as { port: number }).port));
    });
  try {
    const v4 = await listen("127.0.0.1", false);
    const v6only = await listen("::", true);
    const dual = await listen("::", false);
    const client = connect({ host: "127.0.0.1", port: v4 });
    await new Promise<void>((resolve, reject) => (client.once("connect", resolve), client.once("error", reject)));
    const clientPort = client.localPort;
    const mine = tcpSockets(process.pid);
    client.destroy();
    const find = (port: number, state: number) => mine.find((socket) => socket.localPort === port && socket.state === state);
    const a = find(v4, TCP_LISTEN);
    const b = find(v6only, TCP_LISTEN);
    const c = find(dual, TCP_LISTEN);
    const d = mine.find((socket) => socket.remotePort === v4 && socket.state === TCP_ESTABLISHED);
    if (!a || a.family !== 4 || a.localAddress !== "127.0.0.1" || !coversLoopback(a, "127.0.0.1") || coversLoopback(a, "::1")) return "IPv4 listener misread";
    if (!b || b.family !== 6 || b.localAddress !== "::" || coversLoopback(b, "127.0.0.1") || !coversLoopback(b, "::1")) return "IPv6-only wildcard listener misread";
    if (!c || !c.dualStack || !coversLoopback(c, "127.0.0.1")) return "dual-stack IPv6 listener misread";
    if (!d || d.localPort !== clientPort || d.remoteAddress !== "127.0.0.1") return "established connection misread";
    if (processStart(process.pid) === null) return "process start time unreadable";
    return null;
  } catch (error) {
    return `self-check failed: ${String(error)}`;
  } finally {
    for (const server of servers) server.close();
  }
}
