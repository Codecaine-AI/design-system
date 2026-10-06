/**
 * The runner's egress verdicts: a failed lsof is never an empty (clean) observation, and a run process's
 * outbound connection counts as its own only while a run process listens on the target port.
 */
import { describe, expect, test } from "bun:test";

import { egressConnections, lsofResult, parseLsof } from "../scripts/lib/egress.ts";

const HEADER = "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME";
const ESTABLISHED = "bun     101 Ford   22u  IPv4 0xed9c65a12aae4e7f      0t0  TCP 127.0.0.1:49700->127.0.0.1:47020 (ESTABLISHED)";

describe("lsofResult", () => {
  test.each([
    ["exit 0 with sockets", 0, `${HEADER}\n${ESTABLISHED}`, "", true],
    ["exit 1 with nothing printed (no sockets)", 1, "", "", true],
    ["exit 1 listing the pids still alive (one exited meanwhile)", 1, `${HEADER}\n${ESTABLISHED}`, "", true],
    ["exit 1 with an error message", 1, "", "lsof: illegal option character: Z", false],
    ["killed by a signal", null, "", "", false],
    ["exit 2", 2, "", "", false],
  ] as Array<[string, number | null, string, string, boolean]>)("%s", (_, code, stdout, stderr, ok) => {
    expect(lsofResult(code, stdout, stderr).ok).toBe(ok);
  });
});

describe("egressConnections", () => {
  // A run that listens on 47021 now and listened on 47020 before (a helper that exited).
  const conns = parseLsof(
    [
      HEADER,
      "node    102 Ford   21u  IPv4 0x3b2e573a246d80f7      0t0  TCP 127.0.0.1:47020->127.0.0.1:49647 (ESTABLISHED)",
      "node    102 Ford   23u  IPv4 0x3b2e573a246d80f8      0t0  TCP 127.0.0.1:49800->127.0.0.1:47021 (ESTABLISHED)",
      ESTABLISHED,
    ].join("\n"),
  );

  test("an outbound connection to a port the run gave up leaves the run; inbound ones to it do not", () => {
    const egress = egressConnections(conns, { inbound: new Set([47020, 47021]), outbound: new Set([47021]) });
    expect(egress.map((c) => c.raw)).toEqual([ESTABLISHED]);
  });
});
