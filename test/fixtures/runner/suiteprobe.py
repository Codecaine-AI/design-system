# Port probe for test/sandbox.test.ts (suiteNetwork), run inside a generated sandbox profile (not an app).
# argv: <allowed ports, comma-separated, or lo-hi ranges> <denied ports, same form>
# Connects to every port: nothing listens on most of them, so an allowed connect fails with ECONNREFUSED
# (or connects) and only a denied one fails with EPERM. Then a server of its own on an ephemeral port
# (bind to port 0) and a connect to it. Prints "all-ok" or what went wrong (at most 20 ports per kind).
import errno
import socket
import sys


def ports(spec):
    out = []
    for part in spec.split(","):
        if not part:
            continue
        if "-" in part:
            lo, hi = part.split("-")
            out.extend(range(int(lo), int(hi) + 1))
        else:
            out.append(int(part))
    return out


allowed = ports(sys.argv[1])
denied = set(ports(sys.argv[2]))
bad = []


def connect(port):
    c = socket.socket()
    c.settimeout(1)
    try:
        c.connect(("127.0.0.1", port))
        return 0
    except OSError as e:
        return e.errno
    finally:
        c.close()


wrongly_denied = [p for p in allowed if p not in denied and connect(p) == errno.EPERM]
wrongly_allowed = [p for p in denied if connect(p) != errno.EPERM]
if wrongly_denied:
    bad.append(f"denied {len(wrongly_denied)}: {wrongly_denied[:20]}")
if wrongly_allowed:
    bad.append(f"ALLOWED {len(wrongly_allowed)}: {wrongly_allowed[:20]}")

server = socket.socket()
try:
    server.bind(("127.0.0.1", 0))
    server.listen()
    port = server.getsockname()[1]
    if port in denied:
        bad.append(f"ephemeral server landed on a denied port {port}")
    elif connect(port) != 0:
        bad.append(f"own ephemeral server {port} not reachable")
except OSError as e:
    bad.append(f"own ephemeral server: errno {e.errno}")
finally:
    server.close()

print(" ".join(bad) if bad else "all-ok")
