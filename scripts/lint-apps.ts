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
 *
 * Known limits (static analysis; verify:apps checks runnable apps at runtime):
 * - wiring: a late @import counts in a root whose closure imports any Tailwind stylesheet
 *   (Tailwind 4 inlines quoted @imports wherever they stand), and is never judged inert in
 *   Sass/Less files or in <style> strings of a server-rendered JS entry. A CSS file reached
 *   from two roots is walked once (the first root gets its loads); an @import cycle can hide
 *   Tailwind from the closure check. A Tailwind import after the first tailwind-strict.css in
 *   a root fails even when a later strict clears it again.
 * - wiring: unused HTML strings in a server-rendered entry still count as its page (decision 21c).
 * - Tailwind v3 config: writes are read in source order, not run order; `let` reassignments,
 *   getters and `Object.assign({}, a, b)` as the export are not followed; `exports.presets =`
 *   after `module.exports =` counts although Node drops it; a spread inside `theme` that is not
 *   a local object literal is not reported; without dist/tailwind/preset-v3.cjs the theme-key
 *   rule finds nothing.
 * - literals: the app's Tailwind config is scanned, but scan-literals counts only its colors,
 *   not px values nested in a theme object (`fontSize: { sm: "14px" }`); a config that
 *   scan.exclude or scan.ext filters out stays unscanned. Classes bound through variables
 *   (`const c = "shadow"; className={c}`) are not class contexts (decision 21c); container
 *   variants (`@md:`) count in any JS string, as palette classes do.
 * - names: bindings by aliasing (`const v = cssVar`), `import(pkg).then(({ cssVar }) => …)` and
 *   nested destructuring are not followed; a re-export cycle can cache a partial export list. In
 *   a file with no design-system binding only near-miss token strings count (first two segments
 *   name a real group), so a typo in the second segment passes. A non-optional TS type key
 *   `{ "--ds-x": string }` or a regex holding `--ds-x:` reads as a declaration. Any file that
 *   opens with the package's header comment is skipped as a copy.
 * - shell: only direct importers of the ds-shell file (through up to two barrels) fill its
 *   slots; a module that renders the shell with props or children counts for parts beside it
 *   too. Markup in an exported function that is imported but never called still counts
 *   (decision 21c); the "rendered, not only imported" rule applies only to run.mode none and
 *   skips import forms it cannot read (`require`, an unbound dynamic import).
 * - structure: a script an HTML page loads is an entry only when that page is in the scan paths.
 * - resolution: a library's own packed copy of the package is compared by tokens.css only.
 * - --out-dir: `lint/` and the report file are checked before the run and again right before
 *   the write; a symlink swapped in between that check and the write is not caught (Node has
 *   no O_NOFOLLOW for directories).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateLoadedRegistry } from "./lib/app-runner";
import { DESIGN_SYSTEM_ROOT, REGISTRY_PATH, loadRegistry } from "./lib/registry";
import { canonicalPath, safeAppId, safeChildPath, safeOutputPath } from "./lib/safe-paths";
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
build, an --out-dir in the owner's tree or in any git checkout, a lint/ or report path
under --out-dir that is a symlink).
`;

interface Args {
  root: string;
  pass: PassNumber | null;
  json: boolean;
  outDir: string | null;
  registry: string;
  apps: string[];
}

/** The git checkout (a directory holding `.git`) that holds `dir` or one of its ancestors, or null. */
export function gitCheckoutOf(dir: string): string | null {
  for (let d = canonicalPath(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * Where the JSON report goes: `<out-dir>/lint/<timestamp>.json`. The out-dir is refused in the owner's
 * tree and in any git checkout (a report is run output, never a source change); `lint/` and the file are
 * validated as children of it, so a symlinked `lint/` cannot carry the write elsewhere.
 */
export function reportPath(outDir: string, root: string, stamp: string): string {
  const base = safeOutputPath(outDir, { root, label: "--out-dir" });
  const checkout = gitCheckoutOf(base);
  if (checkout) throw new Error(`--out-dir ${outDir} is inside the git checkout ${checkout}; write reports outside any checkout (the run folder or a temp dir)`);
  return safeChildPath({ base, root, label: "--out-dir" }, "lint", `${stamp}.json`);
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
  // The same rules every registry-loading tool applies (registry:check's, port blocks included).
  try {
    validateLoadedRegistry(registry, args.registry);
    for (const app of registry.apps) safeAppId(app.id);
  } catch (err) {
    process.stderr.write(`lint:apps: registry: ${(err as Error).message}\nlint:apps: fix the registry first\n`);
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let reportFile: string | null = null;
  if (args.outDir) {
    try {
      reportFile = reportPath(args.outDir, root, stamp);
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
  if (reportFile) {
    try {
      mkdirSync(dirname(reportFile), { recursive: true });
      // Checked again right before the write: a symlink planted while the checks ran is refused too.
      // `wx` never follows or replaces an existing file at the last component.
      writeFileSync(reportPath(args.outDir!, root, stamp), json, { flag: "wx" });
    } catch (err) {
      process.stderr.write(`lint:apps: ${(err as Error).message}\n`);
      process.exit(2);
    }
    if (!args.json) process.stderr.write(`lint:apps: wrote ${reportFile}\n`);
  }
  process.stdout.write(args.json ? json : formatText(report) + "\n");
  // Not process.exit(): it drops whatever a pipe has not taken yet (a 1.8 MB report arrived cut at 1.5 MB).
  process.exitCode = exitCode(report);
}

if (import.meta.main) main();
