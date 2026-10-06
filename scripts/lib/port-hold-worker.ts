/**
 * port-hold.ts's worker: owns the runner's sockets on a run's port block, resets every connection to them,
 * and takes each watched loopback address the moment no run process holds it (see port-hold.ts). Runs its
 * own loop, so a stalled main thread never delays a take.
 */
import { dlopen, FFIType, ptr, read } from "bun:ffi";

import { coversLoopback, selfCheck, socketFds, TCP_LISTEN, tcpSocket } from "./libproc";

declare const self: Worker;

const AF_INET = 2;
const AF_INET6 = 30;
const SOCK_STREAM = 1;
const SOL_SOCKET = 0xffff;
const SO_REUSEADDR = 0x4;
const SO_LINGER = 0x80;
const IPPROTO_IPV6 = 41;
const IPV6_V6ONLY = 27;
/** _IO('f', 1): set close-on-exec. */
const FIOCLEX = 0x20006601n;
const POLLIN = 0x1;
/** How long one loop waits for a process exit before it tries the watched addresses again. */
const SWEEP_MS = 1;

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  accept: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  // fcntl is variadic, which bun:ffi cannot call on arm64; ioctl(FIOCLEX) takes no third argument.
  ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  kqueue: { args: [], returns: FFIType.i32 },
  kevent: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  __error: { args: [], returns: FFIType.ptr },
});
const errno = () => read.i32(libc.symbols.__error()!, 0);
const ONE = new Int32Array([1]);
/** struct linger { l_onoff = 1, l_linger = 0 }: close() sends a reset. */
const RESET = new Int32Array([1, 0]);

// struct kevent (64-bit): ident u64, filter i16, flags u16, fflags u32, data i64, udata u64 = 32 bytes.
const KEVENT_SIZE = 32;
const EVFILT_PROC = -5;
const EV_ADD = 0x1;
const EV_ONESHOT = 0x10;
const EV_ERROR = 0x4000;
const NOTE_EXIT = 0x80000000;
/** struct timespec: zero for registering, one sweep for waiting. */
const ZERO = new BigInt64Array([0n, 0n]);
const WAIT = new BigInt64Array([0n, BigInt(SWEEP_MS * 1_000_000)]);

/** Whether fd `fd` of `pid` is a TCP socket listening on `port` and taking loopback `family` (libproc.ts). */
function listensOn(pid: number, fd: number, family: 4 | 6, port: number): boolean {
  const socket = tcpSocket(pid, fd);
  return !!socket && socket.state === TCP_LISTEN && socket.localPort === port && coversLoopback(socket, family === 4 ? "127.0.0.1" : "::1");
}

/** The fd of `pid` listening as listensOn says, trying `hint` first; -1 when none. */
function listeningFd(pid: number, hint: number, family: 4 | 6, port: number): number {
  if (hint >= 0 && listensOn(pid, hint, family, port)) return hint;
  return socketFds(pid).find((fd) => listensOn(pid, fd, family, port)) ?? -1;
}

/** sockaddr_in / sockaddr_in6 for the loopback address. */
function loopback(family: 4 | 6, port: number): Uint8Array {
  const addr = new Uint8Array(family === 4 ? 16 : 28);
  addr[0] = addr.length;
  addr[1] = family === 4 ? AF_INET : AF_INET6;
  addr[2] = port >> 8;
  addr[3] = port & 0xff;
  if (family === 4) addr.set([127, 0, 0, 1], 4);
  else addr[23] = 1;
  return addr;
}

/** Every hold (each listens). */
const listening: number[] = [];

/**
 * A close-on-exec socket listening on the loopback address of `family` and `port`; or the errno when the
 * bind fails. SO_REUSEADDR: a connection of the run's left in TIME_WAIT must not keep the runner out.
 */
function holdLoopback(family: 4 | 6, port: number): { fd: number } | { errno: number } {
  const fd = libc.symbols.socket(family === 4 ? AF_INET : AF_INET6, SOCK_STREAM, 0);
  if (fd < 0) return { errno: errno() };
  const fail = () => {
    const code = errno();
    libc.symbols.close(fd);
    return { errno: code };
  };
  if (libc.symbols.ioctl(fd, FIOCLEX) !== 0) return fail();
  libc.symbols.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, ptr(ONE), 4);
  if (family === 6) libc.symbols.setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, ptr(ONE), 4);
  const addr = loopback(family, port);
  if (libc.symbols.bind(fd, ptr(addr), addr.length) !== 0 || libc.symbols.listen(fd, 64) !== 0) return fail();
  listening.push(fd);
  return { fd };
}

/** Resets every connection waiting on a hold, unread (poll first: accept never blocks the loop). */
function resetConnections() {
  if (listening.length === 0) return;
  const fds = new DataView(new ArrayBuffer(8 * listening.length));
  listening.forEach((fd, i) => {
    fds.setInt32(i * 8, fd, true);
    fds.setInt16(i * 8 + 4, POLLIN, true);
  });
  if (libc.symbols.poll(ptr(fds), listening.length, 0) <= 0) return;
  listening.forEach((fd, i) => {
    if (!(fds.getInt16(i * 8 + 6, true) & POLLIN)) return;
    const conn = libc.symbols.accept(fd, null, null);
    if (conn < 0) return;
    libc.symbols.setsockopt(conn, SOL_SOCKET, SO_LINGER, ptr(RESET), 8);
    libc.symbols.close(conn);
  });
}

/** The run processes holding each watched address (slot), from main's reads; their exits are watched with kqueue. */
const holders = new Map<number, Set<number>>();
/** The last fd seen listening, per slot and holder ("slot pid"). */
const fdHints = new Map<string, number>();
const watchedPids = new Set<number>();
let kq = -1;
const pendingExits: number[] = [];

/** Registers NOTE_EXIT for a pid; a pid already gone counts as exited now. */
function watchExit(pid: number) {
  if (watchedPids.has(pid)) return;
  watchedPids.add(pid);
  const change = new DataView(new ArrayBuffer(KEVENT_SIZE));
  change.setBigUint64(0, BigInt(pid), true);
  change.setInt16(8, EVFILT_PROC, true);
  change.setUint16(10, EV_ADD | EV_ONESHOT, true);
  change.setUint32(12, NOTE_EXIT, true);
  const out = new DataView(new ArrayBuffer(KEVENT_SIZE));
  const n = libc.symbols.kevent(kq, ptr(change), 1, ptr(out), 1, ptr(ZERO));
  if (n < 0) pendingExits.push(pid);
  else if (n === 1 && out.getUint16(10, true) & EV_ERROR) {
    if (out.getBigInt64(16, true) !== 0n) pendingExits.push(pid); // ESRCH: already gone
  } else if (n === 1) pendingExits.push(Number(out.getBigUint64(0, true))); // another pid's exit, returned here
}

/** Pids that exited since the last call (waits up to one sweep for the first). */
function exitedPids(): number[] {
  const out = new DataView(new ArrayBuffer(KEVENT_SIZE * 16));
  const n = libc.symbols.kevent(kq, null, 0, ptr(out), 16, ptr(pendingExits.length ? ZERO : WAIT));
  const exited = pendingExits.splice(0);
  for (let i = 0; i < n; i++) if (out.getInt16(i * KEVENT_SIZE + 8, true) === EVFILT_PROC) exited.push(Number(out.getBigUint64(i * KEVENT_SIZE, true)));
  return exited;
}

self.onmessage = (event: MessageEvent) => {
  if (event.data?.holders) {
    // { holders: [slot, pids] }: the run processes the newest read saw listening on that address.
    const [slot, pids] = event.data.holders as [number, number[]];
    holders.set(slot, new Set(pids));
    for (const pid of pids) watchExit(pid);
    return;
  }
  void run(event.data);
};

async function run(data: { ports: number[]; sab: SharedArrayBuffer; heartbeat: SharedArrayBuffer }) {
  const { ports, sab } = data;
  const heartbeat = new BigInt64Array(data.heartbeat);
  const beat = () => Atomics.store(heartbeat, 0, BigInt(Date.now()));
  beat();
  kq = libc.symbols.kqueue();
  const view = new Int32Array(sab);
  const n = ports.length;
  const control = 4 * n;
  const verified = 4 * n + 1;
  const fds: number[] = [];
  const problems: string[] = [];
  if (kq < 0) problems.push(`kqueue failed (errno ${errno()})`);
  const layout = await selfCheck();
  if (layout) problems.push(`libproc: ${layout}`);
  // The socket_fdinfo layout, checked on a listener of the worker's own on the block's first port, which
  // no run process holds yet (the hold starts before the first one does); released at once.
  if (ports.length) {
    const check = holdLoopback(4, ports[0]!);
    if (!("fd" in check)) problems.push(`127.0.0.1:${ports[0]} is taken (errno ${check.errno})`);
    else {
      if (listeningFd(process.pid, -1, 4, ports[0]!) !== check.fd) problems.push("libproc's socket_fdinfo layout is not the one this tool reads (cannot verify listeners)");
      listening.splice(listening.indexOf(check.fd), 1);
      libc.symbols.close(check.fd);
    }
  }
  self.postMessage({ ok: problems.length === 0, problems });
  if (problems.length) {
    for (const fd of fds) libc.symbols.close(fd);
    return;
  }
  const take = (slot: number) => {
    const result = holdLoopback(slot % 2 === 1 ? 6 : 4, ports[slot >> 1]!);
    if (!("fd" in result)) return false;
    fds.push(result.fd);
    Atomics.store(view, slot, 1);
    return true;
  };
  while (Atomics.load(view, control) === 0) {
    beat();
    // The last run process holding an address exited: the address is the runner's now, or, when something
    // else already holds it, tainted (no run process holds it any more).
    const exited = new Set(exitedPids());
    if (exited.size) {
      for (const [slot, pids] of holders) {
        if (![...pids].some((pid) => exited.has(pid))) continue;
        for (const pid of exited) pids.delete(pid);
        if (pids.size || Atomics.load(view, slot) === 1) continue;
        if (!take(slot)) {
          Atomics.store(view, slot, 2);
          self.postMessage({ tainted: slot });
        }
      }
      for (const pid of exited) watchedPids.delete(pid);
    }
    // Every watched address nothing holds any more (a listener the run closed without exiting).
    for (let slot = 0; slot < 2 * n; slot++) {
      if (Atomics.load(view, 2 * n + slot) !== 1 || Atomics.load(view, slot) === 1) continue;
      take(slot);
    }
    // Every watched address the run serves: does one of its holders still listen there, now? The guard
    // allows such an address only while this says yes (a listener the run closed is refused within a sweep).
    for (let slot = 0; slot < 2 * n; slot++) {
      if (Atomics.load(view, 2 * n + slot) !== 1) continue;
      let ok = false;
      if (Atomics.load(view, slot) === 0) {
        for (const pid of holders.get(slot) ?? []) {
          const key = `${slot} ${pid}`;
          const fd = listeningFd(pid, fdHints.get(key) ?? -1, slot % 2 === 1 ? 6 : 4, ports[slot >> 1]!);
          if (fd >= 0) {
            fdHints.set(key, fd);
            ok = true;
            break;
          }
        }
      }
      Atomics.store(view, verified + slot, ok ? 1 : 0);
    }
    resetConnections();
    // Let main's holder messages in (kevent above already waited up to one sweep).
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (const fd of fds) libc.symbols.close(fd);
  if (kq >= 0) libc.symbols.close(kq);
  self.postMessage({ stopped: true });
}
