/**
 * A PATH with planted `git`, `ps`, `lsof`, `rm` and `mv` in front: each records its call in a marker
 * file, then runs the real system binary, so a tool that resolves them through PATH still works but
 * leaves a trace. The tools must call SYSTEM_BIN paths instead (scripts/lib/system-bin.ts).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REAL: Record<string, string> = { git: "/usr/bin/git", ps: "/bin/ps", lsof: "/usr/sbin/lsof", rm: "/bin/rm", mv: "/bin/mv" };

export interface PlantedBin {
  /** PATH value: the planted dir first, then `rest`. */
  path: string;
  /** Every planted call so far ("<name> <args>"), one per line. */
  calls(): string[];
}

export function plantBin(dir: string, rest = process.env.PATH ?? ""): PlantedBin {
  const bin = join(dir, "planted-bin");
  mkdirSync(bin, { recursive: true });
  const marker = join(dir, "planted-calls.txt");
  for (const [name, real] of Object.entries(REAL)) {
    const script = join(bin, name);
    writeFileSync(script, `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> '${marker}'\nexec ${real} "$@"\n`);
    chmodSync(script, 0o755);
  }
  return {
    path: `${bin}:${rest}`,
    calls: () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : []),
  };
}
