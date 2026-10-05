/**
 * The profile proof's verdict on connections: lsof lines of a run are classified so that only
 * traffic to or between the run's own ports passes. A wrong verdict would mark a profile proven
 * while it talks to the owner's docs service.
 */
import { describe, expect, test } from "bun:test";

import { foreignConnections, parseLsof } from "../scripts/registry-prove.ts";

// Real `lsof -nP -a -p <pids> -i` output shape (macOS), for a run that started :47020 and :47021.
const LSOF = `COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
bun     101 Ford    4u  IPv4 0x6eeb1c8fbf4be36c      0t0  TCP 127.0.0.1:47020 (LISTEN)
node    102 Ford   20u  IPv4 0x520670b85e70833      0t0  TCP 127.0.0.1:47021 (LISTEN)
node    102 Ford   21u  IPv4 0x3b2e573a246d80f7      0t0  TCP 127.0.0.1:47021->127.0.0.1:49647 (ESTABLISHED)
node    102 Ford   22u  IPv4 0xed9c65a12aae4e7f      0t0  TCP 127.0.0.1:49700->127.0.0.1:47020 (ESTABLISHED)
bun     101 Ford   23u  IPv4 0x5b17601d488af892      0t0  TCP 127.0.0.1:49701->127.0.0.1:4820 (SYN_SENT)
bun     101 Ford   24u  IPv4 0xeffa52a222195ffb      0t0  TCP 192.168.1.20:49702->140.82.112.3:443 (ESTABLISHED)
bun     101 Ford   25u  IPv6 0x9ef5a7b9d7abba34      0t0  TCP [::1]:49703->[::1]:4840 (ESTABLISHED)
bun     101 Ford   26u  IPv4 0x16fa58e2c8459b57      0t0  UDP 192.168.1.20:5353->224.0.0.251:5353`;

describe("foreignConnections", () => {
  const conns = parseLsof(LSOF);
  const foreign = foreignConnections(conns, new Set([47020, 47021])).map((c) => c.raw.split(/\s+/).slice(8).join(" "));

  test("passes listeners, inbound browser traffic and the run's own vite-to-api hop", () => {
    expect(conns).toHaveLength(8);
    expect(foreign).not.toContain("127.0.0.1:47020 (LISTEN)");
    expect(foreign).not.toContain("127.0.0.1:47021->127.0.0.1:49647 (ESTABLISHED)");
    expect(foreign).not.toContain("127.0.0.1:49700->127.0.0.1:47020 (ESTABLISHED)");
  });

  test("flags owner ports, other local ports over IPv6 and every non-loopback peer", () => {
    expect(foreign).toEqual([
      "127.0.0.1:49701->127.0.0.1:4820 (SYN_SENT)",
      "192.168.1.20:49702->140.82.112.3:443 (ESTABLISHED)",
      "[::1]:49703->[::1]:4840 (ESTABLISHED)",
      "192.168.1.20:5353->224.0.0.251:5353",
    ]);
  });
});
