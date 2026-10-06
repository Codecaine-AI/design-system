# Port probe for test/sandbox.test.ts, run inside a generated sandbox profile (not an app).
# argv: <own ports, comma-separated> <outside ports> <run tmp dir> <a Unix socket outside the run>
# Prints "all-ok" or the checks that went wrong. Only EPERM counts as "denied by the sandbox": a port
# another process holds answers EADDRINUSE or connects, which still means the sandbox let it through.
import errno
import os
import socket
import sys

own = [int(p) for p in sys.argv[1].split(",") if p]
outside = [int(p) for p in sys.argv[2].split(",") if p]
tmp = sys.argv[3]
outside_sock = sys.argv[4]
bad = []


def bind(port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port))
        return 0
    except OSError as e:
        return e.errno
    finally:
        s.close()


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


for port in own:
    if bind(port) == errno.EPERM:
        bad.append(f"bind {port} denied")
    if connect(port) == errno.EPERM:
        bad.append(f"connect {port} denied")
for port in outside:
    if bind(port) != errno.EPERM:
        bad.append(f"bind {port} ALLOWED")
    if connect(port) != errno.EPERM:
        bad.append(f"connect {port} ALLOWED")
if bind(0) != errno.EPERM:
    bad.append("bind ephemeral ALLOWED")

path = os.path.join(tmp, f"probe-{os.getpid()}.sock")
server = socket.socket(socket.AF_UNIX)
try:
    server.bind(path)
    server.listen()
    client = socket.socket(socket.AF_UNIX)
    client.connect(path)
    client.close()
except OSError as e:
    bad.append(f"unix socket in the run tmp: errno {e.errno}")
finally:
    server.close()
    if os.path.exists(path):
        os.unlink(path)

client = socket.socket(socket.AF_UNIX)
try:
    client.connect(outside_sock)
    bad.append("unix socket outside the run ALLOWED")
except OSError as e:
    if e.errno != errno.EPERM:
        bad.append(f"unix socket outside the run: errno {e.errno}")
finally:
    client.close()

try:
    socket.getaddrinfo("localhost", 80)
except OSError as e:
    bad.append(f"DNS failed: {e}")

print(" ".join(bad) if bad else "all-ok")
