/**
 * The page pin (scripts/lib/page-pin.ts) forwards a page's request or tunnel only to a listener a run process
 * holds, and writes no byte upstream until a run process holds the server end of the connection.
 *
 * "Run processes" here are children this test starts and names to the pin; everything else (this process's
 * own servers) stands for a process the run did not start. Ports are ephemeral.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";

import { processStart, selfCheck } from "../scripts/lib/libproc.ts";
import { startPagePin, type PinInputs } from "../scripts/lib/page-pin.ts";

const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const child of children) child.kill(9);
});

/** A run process: a child listening on an ephemeral loopback port that answers "run <path>". */
async function runProcess(opts: { reusePort?: boolean } = {}): Promise<{ pid: number; port: number }> {
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `const s = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: ${!!opts.reusePort}, fetch: (r) => new Response("run " + new URL(r.url).pathname) }); console.log(s.port); setInterval(() => {}, 1e6);`,
    ],
    { stdout: "pipe" },
  );
  children.push(child);
  const port = Number(await readLine(child));
  return { pid: child.pid, port };
}

async function readLine(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.trim();
}

/** A pin whose run is `pids`, every port allowed but the owner's (the pin refuses those itself). */
async function pin(pids: number[], extra: Partial<PinInputs> = {}) {
  const refused: Array<{ entry: string; violation?: string }> = [];
  const processes = new Map(pids.map((pid) => [pid, processStart(pid)!]));
  const started = await startPagePin({
    processes: () => processes,
    refresh: () => undefined,
    allowed: () => true,
    refused: (entry, violation) => void refused.push({ entry, violation }),
    ...extra,
  });
  return { pin: started, refused, processes };
}

/** Sends `head` to the pin and returns everything it answers (until it closes the connection). */
function exchange(port: number, head: string, then?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (then && data.includes("200 Connection Established") && !data.includes("run ")) socket.write(then);
    });
    socket.on("error", () => resolve(`${data}<error>`));
    socket.on("close", () => resolve(data));
    socket.write(head);
  });
}

/** A server of this process (not a run process): counts connections and bytes. */
async function stranger() {
  const seen = { connections: 0, bytes: 0 };
  const server = createServer((socket) => {
    seen.connections++;
    socket.on("data", (chunk) => (seen.bytes += chunk.length));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { seen, port: (server.address() as { port: number }).port, close: () => server.close() };
}

describe("libproc", () => {
  test("reads this platform's socket and process structs right (the pin and the hold refuse to run otherwise)", async () => {
    expect(await selfCheck()).toBeNull();
  });
});

describe("page pin", () => {
  test("forwards a plain request and a tunnel to a run process's listener, closing each plain exchange", async () => {
    const run = await runProcess();
    const { pin: p, refused } = await pin([run.pid]);
    try {
      const plain = await exchange(p.port, `GET http://127.0.0.1:${run.port}/plain HTTP/1.1\r\nhost: 127.0.0.1:${run.port}\r\n\r\n`);
      expect(plain).toMatch(/^HTTP\/1\.1 200/);
      expect(plain).toMatch(/\r\nconnection: close\r\n/i);
      expect(plain).toEndWith("run /plain");
      const tunnel = await exchange(p.port, `CONNECT 127.0.0.1:${run.port} HTTP/1.1\r\n\r\n`, `GET /tunnel HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`);
      expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established");
      expect(tunnel).toEndWith("run /tunnel");
      // localhost goes to the family the run listens on.
      expect(await exchange(p.port, `GET http://localhost:${run.port}/lh HTTP/1.1\r\nhost: localhost:${run.port}\r\n\r\n`)).toEndWith("run /lh");
      expect(refused).toEqual([]);
    } finally {
      await p.stop();
    }
  });

  test("a listener no run process holds is never contacted: no connection, no byte; the page gets a network error", async () => {
    const other = await stranger();
    const { pin: p, refused } = await pin([]);
    try {
      expect(await exchange(p.port, `GET http://127.0.0.1:${other.port}/secret HTTP/1.1\r\nhost: x\r\n\r\n`)).not.toContain("HTTP/1.1");
      expect(await exchange(p.port, `CONNECT 127.0.0.1:${other.port} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 502");
      expect(other.seen).toEqual({ connections: 0, bytes: 0 });
      expect(refused.map((r) => [r.entry.replace(/:\d+/, ":P"), r.violation])).toEqual([
        ["PIN GET http://127.0.0.1:P/secret (no run process listens there)", undefined],
        ["PIN CONNECT 127.0.0.1:P (no run process listens there)", undefined],
      ]);
    } finally {
      await p.stop();
      other.close();
    }
  });

  test("owner ports, ports the run may not reach, and hosts that are not loopback are refused before anything is contacted", async () => {
    const run = await runProcess();
    const { pin: p, refused } = await pin([run.pid], { allowed: (port) => port !== run.port });
    try {
      for (const target of [`127.0.0.1:4803`, `127.0.0.1:${run.port}`, `example.com:${run.port}`, `0.0.0.0:${run.port}`, `127.0.0.2:${run.port}`])
        expect(await exchange(p.port, `CONNECT ${target} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 403");
      expect(refused).toHaveLength(5);
      expect(refused.every((r) => r.entry.endsWith("(not a port of the run)"))).toBe(true);
    } finally {
      await p.stop();
    }
  });

  test("a run listener with SO_REUSEPORT is refused and recorded: a stranger could share it", async () => {
    const run = await runProcess({ reusePort: true });
    const { pin: p, refused } = await pin([run.pid]);
    try {
      expect(await exchange(p.port, `CONNECT 127.0.0.1:${run.port} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 502");
      expect(refused[0]?.violation).toContain("SO_REUSEPORT");
    } finally {
      await p.stop();
    }
  });

  test("a peer whose pid is the run's but whose start time is not (a reused pid) never gets a byte", async () => {
    const run = await runProcess();
    const { pin: p, refused, processes } = await pin([run.pid], { acceptTimeoutMs: 300 });
    processes.set(run.pid, "1.0"); // another process once had this pid
    try {
      expect(await exchange(p.port, `CONNECT 127.0.0.1:${run.port} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 502");
      expect(refused[0]?.violation).toContain("no run process accepted the page's connection");
    } finally {
      await p.stop();
    }
  });
});
