/**
 * Exclusive ownership of the addresses a run serves (app-runner's helper; guard-lsof fix round 1).
 *
 * Nothing is held up front: the app binds its ports as it always did, and a run process that contacts a
 * port nobody serves (a dead kernel URL) still gets "connection refused". Once a read shows a run process
 * listening on a block address, the address is watched (only that loopback family: taking the other one
 * would turn a run process's "refused" there into a reset; the guard refuses a `localhost` URL unless both
 * families are the run's or the runner's):
 *   - the run processes listening there are exit-watched (kqueue NOTE_EXIT): when the last one exits, the
 *     worker takes the address at once, or, when another process already holds it, marks it tainted;
 *   - the worker checks about every millisecond (libproc, no lsof) that one of those processes still
 *     listens there; the guard allows the address only while that holds, so a listener the run closes
 *     without exiting is refused within about a millisecond;
 *   - the worker tries to take every watched address about every millisecond, which fails while anyone
 *     holds it: a closed listener is taken within about a millisecond, unless another process binds it
 *     first (the check above already refuses it, and the next read, which no longer shows the run there,
 *     taints it).
 * A taken address is the runner's for the rest of the run: it listens there and resets every connection,
 * unread, so no other process can listen there. A tainted address is refused for the rest of the run
 * (unless the worker later takes it). An app that restarts its server on the same port mid-run therefore
 * fails to bind it again: loudly, never by reaching a stranger.
 *
 * Every socket is close-on-exec (no run process inherits one) and listens on loopback only. The worker owns
 * the sockets and writes each address's state into shared memory, which the request guard reads
 * synchronously: the main thread may stall (a synchronous `ps`), the worker does not.
 */

/** A loopback address the guard and the holds speak of: IPv4 or IPv6 loopback. */
export type LoopbackAddress = "127.0.0.1" | "::1";
export const LOOPBACK_ADDRESSES: readonly LoopbackAddress[] = ["127.0.0.1", "::1"];

/** free: not held by the runner (the run may hold it); runner: held by the runner (dead); tainted: another process took it from the run. */
export type HoldState = "free" | "runner" | "tainted";
const STATES: HoldState[] = ["free", "runner", "tainted"];

/** Shared-memory layout: [state x 2N][watch x 2N][control]; index = portIndex * 2 + family (0 = 127.0.0.1, 1 = ::1). */
export interface HoldLayout {
  ports: number[];
  sab: SharedArrayBuffer;
}

export class BlockHold {
  readonly ports: readonly number[];
  private readonly view: Int32Array;
  private readonly index = new Map<number, number>();
  private worker?: Worker;
  private stopped = false;

  /** `ports`: the run's block. Call start() before the first run process starts. */
  constructor(ports: readonly number[]) {
    this.ports = [...ports];
    this.ports.forEach((port, i) => this.index.set(port, i));
    // [state x 2N][watch x 2N][control][verified x 2N]
    this.view = new Int32Array(new SharedArrayBuffer(4 * (6 * this.ports.length + 1)));
  }

  /** Starts the worker; rejects when it cannot watch listeners here (kqueue, the libproc layout check). */
  async start(): Promise<void> {
    if (this.ports.length === 0) return;
    const worker = new Worker(new URL("./port-hold-worker.ts", import.meta.url).href);
    this.worker = worker;
    const ready = await new Promise<{ ok: boolean; problems: string[] }>((resolve) => {
      worker.addEventListener("message", (event: MessageEvent) => resolve(event.data), { once: true });
      worker.addEventListener("error", (event: any) => resolve({ ok: false, problems: [`the port-hold worker failed: ${event?.message ?? String(event)}`] }), { once: true });
      worker.postMessage({ ports: this.ports, sab: this.view.buffer });
    });
    worker.unref?.();
    if (!ready.ok) {
      await this.stop();
      throw new Error(`cannot watch the run's port block: ${ready.problems.join("; ")}`);
    }
  }

  private slot(address: LoopbackAddress, port: number): number | undefined {
    const i = this.index.get(port);
    return i === undefined ? undefined : i * 2 + (address === "::1" ? 1 : 0);
  }

  /** Whether `port` is in the block this hold covers. */
  covers(port: number): boolean {
    return this.index.has(port);
  }

  /** The state of a loopback address of a block port; "free" outside the block. */
  state(address: LoopbackAddress, port: number): HoldState {
    const slot = this.slot(address, port);
    return slot === undefined ? "free" : STATES[Atomics.load(this.view, slot)]!;
  }

  /**
   * Whether a run process verifiably listens on this watched address right now (checked by the worker
   * about every millisecond with libproc, against the holders the reads reported).
   */
  verified(address: LoopbackAddress, port: number): boolean {
    const slot = this.slot(address, port);
    return slot !== undefined && Atomics.load(this.view, 4 * this.ports.length + 1 + slot) === 1;
  }

  /** Takes the address the moment nothing holds it any more (the run let go). */
  watch(address: LoopbackAddress, port: number) {
    const slot = this.slot(address, port);
    if (slot !== undefined && !this.stopped) Atomics.store(this.view, 2 * this.ports.length + slot, 1);
  }

  /**
   * The run processes a read saw listening on a loopback address. When the last of them exits, the worker
   * takes the address at once, or, when something else already holds it, marks it tainted.
   */
  holders(address: LoopbackAddress, port: number, pids: readonly number[]) {
    const slot = this.slot(address, port);
    if (slot !== undefined && !this.stopped) this.worker?.postMessage({ holders: [slot, [...pids]] });
  }

  /** Marks an address another process took from the run: refused for the rest of the run (unless the worker takes it back). */
  taint(address: LoopbackAddress, port: number) {
    const slot = this.slot(address, port);
    if (slot !== undefined) Atomics.compareExchange(this.view, slot, 0, 2);
  }

  /** Releases every hold (after the run's processes are gone). */
  async stop(): Promise<void> {
    this.stopped = true;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    const control = 4 * this.ports.length;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      worker.addEventListener("message", () => (clearTimeout(timer), resolve()), { once: true });
      Atomics.store(this.view, control, 1);
      Atomics.notify(this.view, control);
    });
    worker.terminate();
  }
}
