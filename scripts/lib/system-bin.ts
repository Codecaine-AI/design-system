/**
 * The system tools the rollout tools run, by absolute path. Never through PATH: PATH holds user-writable
 * dirs (/usr/local/bin is the owner's on this machine), and a binary planted there would run unsandboxed
 * in the tool the next time it calls `ps` or `lsof`. These live on the sealed system volume.
 *
 * Tests may point an entry at a stand-in (for example a `ps` that fails) and must restore it.
 */
export const SYSTEM_BIN = {
  ps: "/bin/ps",
  lsof: "/usr/sbin/lsof",
  id: "/usr/bin/id",
  dscl: "/usr/bin/dscl",
  git: "/usr/bin/git",
  sandboxExec: "/usr/bin/sandbox-exec",
  sh: "/bin/sh",
  tar: "/usr/bin/tar",
};

/** The environment for a system tool: a PATH of system dirs only, so whatever it runs in turn is a system binary too. */
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
