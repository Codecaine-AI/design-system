#!/usr/bin/env bun
/**
 * lint:apps: the conformance linter. Proves each app in apps.json is connected to the
 * design system: one message per violation, exit 1 when a required check fails.
 *
 *   bun run lint:apps [--root <dir>] [--pass <1|2|3>] [--json] [--out-dir <dir>] [--registry <apps.json>] [app...]
 *
 * Checks (scripts/lib/lint/): 1 resolution, 2 wiring, 3 literals, 4 names (pass 1),
 * 5 shell (pass 2), 6 structure (pass 3). Without --pass every check the registry marks
 * required runs; a check marked n/a reports n/a with the registry's reason.
 *
 * Registry and token data come from the design-system checkout this script runs from;
 * app sources come from --root (default: the directory that holds this checkout).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DESIGN_SYSTEM_ROOT, REGISTRY_PATH, loadRegistry, validateRegistry } from "./lib/registry";
import { safeAppId, safeOutputPath } from "./lib/safe-paths";
import { loadDesignSystem } from "./lib/lint/design-system";
import { exitCode, formatText, lintApps, registryDirOf } from "./lib/lint/run";
import type { PassNumber } from "./lib/lint/types";
import { realpathOrNull } from "./lib/lint/workspace";

const USAGE = `Usage: bun run lint:apps [--root <dir>] [--pass <1|2|3>] [--json] [--out-dir <dir>] [--registry <apps.json>] [app...]

  --root <dir>        workspace tree to check (default: ${resolve(DESIGN_SYSTEM_ROOT, "..")})
  --pass <n>          1: resolution, wiring, literals, names; 2: + shell; 3: + structure
                      (default: every check the registry marks required)
  --json              print the JSON report
  --out-dir <dir>     also write the JSON report to <dir>/lint/<timestamp>.json
  --registry <path>   apps.json to read (default: ${REGISTRY_PATH}); allowlists resolve beside it
  app...              app ids (default: every app in the registry)

Exit: 0 when every required check passes, 1 when one fails, 2 on a usage error
(bad flags, unknown app, unreadable or invalid registry, no or stale design-system
build, an --out-dir in the owner's tree).
`;

interface Args {
  root: string;
  pass: PassNumber | null;
  json: boolean;
  outDir: string | null;
  registry: string;
  apps: string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { root: resolve(DESIGN_SYSTEM_ROOT, ".."), pass: null, json: false, outDir: null, registry: REGISTRY_PATH, apps: [] };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--root": args.root = resolve(value(i++, a)); break;
      case "--pass": {
        const v = value(i++, a);
        if (!["1", "2", "3"].includes(v)) throw new Error("--pass takes 1, 2 or 3");
        args.pass = Number(v) as PassNumber;
        break;
      }
      case "--json": args.json = true; break;
      case "--out-dir": args.outDir = resolve(value(i++, a)); break;
      case "--registry": args.registry = resolve(value(i++, a)); break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        args.apps.push(a);
    }
  }
  return args;
}

function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`lint:apps: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const root = realpathOrNull(args.root);
  if (!root) {
    process.stderr.write(`lint:apps: root not found: ${args.root}\n`);
    process.exit(2);
  }
  let registry;
  try {
    registry = loadRegistry(args.registry);
  } catch (err) {
    process.stderr.write(`lint:apps: cannot read ${args.registry}: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const unknown = args.apps.filter((id) => !registry.apps.some((a) => a.id === id));
  if (unknown.length) {
    process.stderr.write(`lint:apps: not in ${args.registry}: ${unknown.join(", ")}\n`);
    process.exit(2);
  }
  const problems = validateRegistry(registry);
  for (const app of registry.apps) {
    try {
      safeAppId(app.id);
    } catch (err) {
      problems.push(`${(err as Error).message}`);
    }
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`lint:apps: registry: ${p}\n`);
    process.stderr.write(`lint:apps: ${args.registry} has ${problems.length} problem(s); fix the registry first\n`);
    process.exit(2);
  }
  let outDir: string | null = null;
  if (args.outDir) {
    try {
      outDir = safeOutputPath(args.outDir, { root, label: "--out-dir" });
    } catch (err) {
      process.stderr.write(`lint:apps: ${(err as Error).message}\n`);
      process.exit(2);
    }
  }

  let ds;
  try {
    ds = loadDesignSystem();
  } catch (err) {
    process.stderr.write(`lint:apps: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const report = lintApps({ root, registry, registryDir: registryDirOf(args.registry), ds, pass: args.pass, apps: args.apps });
  const json = JSON.stringify(report, null, 2) + "\n";
  if (outDir) {
    const dir = join(outDir, "lint");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, json);
    if (!args.json) process.stderr.write(`lint:apps: wrote ${file}\n`);
  }
  process.stdout.write(args.json ? json : formatText(report) + "\n");
  process.exitCode = exitCode(report);
  return;
}

if (import.meta.main) main();
