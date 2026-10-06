#!/usr/bin/env bun
/**
 * codemod:literals: propose a design-system token for every hard-coded style literal in an app,
 * and apply only the rows a reviewer approved.
 *
 *   bun run codemod:literals --app <id> [--root <dir>] [--out-dir <dir>] propose [--paths <p>...] [--all]
 *   bun run codemod:literals [--app <id>] [--root <dir>] apply --table <mapping.json> [--dry-run]
 *
 * propose runs scan-literals with hits over the app's registry scan spec (or --paths for an app
 * not in the registry yet) and writes <out-dir>/<app>/codemod/mapping-<n>.json and .md. Each row
 * holds the literal, its context, the proposed token, how it was chosen (role, or nearest color
 * with ΔE) and an empty `approve`. apply changes only rows with `"approve": "yes"`.
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyTable } from "./lib/codemod/apply.ts";
import { applyRoot, tableDir } from "./lib/codemod/paths.ts";
import { ALL_CATEGORIES, DEFAULT_CATEGORIES, propose, type ScanInput } from "./lib/codemod/propose.ts";
import { droppedText, readTable, summarize, writeTable, type Table } from "./lib/codemod/table.ts";
import { loadTokens, type Theme } from "./lib/codemod/tokens.ts";
import { DESIGN_SYSTEM_ROOT, loadRegistry } from "./lib/registry.ts";
import { safeAppId } from "./lib/safe-paths.ts";

const USAGE = `Usage:
  bun run codemod:literals --app <id> [--root <dir>] [--out-dir <dir>] propose [options]
  bun run codemod:literals [--app <id>] [--root <dir>] apply --table <mapping.json> [--dry-run]

propose options:
  --paths <path>     scan this root-relative file or directory instead of the registry spec (repeatable;
                     required for an app not in apps.json yet)
  --exclude <glob>   passed to scan-literals (repeatable; adds to the registry's excludes)
  --ext <list>       passed to scan-literals (for example +md)
  --theme <t>        theme a literal renders in when no dark selector says otherwise (default: the
                     registry theme rule, light unless dark-first)
  --all              add rows for the soft signals too (px spacing, rem font sizes, [var()] classes);
                     without it the summary counts what was left out
  --tailwind <v>     v3 or v4: the Tailwind the class replacements target (default: the registry's
                     stack.tailwind, else v4)

apply options:
  --table <path>     the mapping JSON; only rows with "approve": "yes" change
  --dry-run          report what would change without writing
  Files are edited only inside the root (--root, else the table's root). The owner's tree is
  refused unless --root names it.
`;

interface Args {
  command: "propose" | "apply" | null;
  app: string | null;
  root: string | null;
  outDir: string | null;
  paths: string[];
  exclude: string[];
  ext?: string;
  theme?: Theme;
  tailwind?: "v3" | "v4";
  all: boolean;
  table: string | null;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { command: null, app: null, root: null, outDir: null, paths: [], exclude: [], all: false, table: null, dryRun: false };
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    switch (x) {
      case "propose":
      case "apply":
        a.command = x;
        break;
      case "--app": a.app = need(i++, x); break;
      case "--root": a.root = resolve(need(i++, x)); break;
      case "--out-dir": a.outDir = resolve(need(i++, x)); break;
      case "--paths": a.paths.push(...need(i++, x).split(",").filter(Boolean)); break;
      case "--exclude": a.exclude.push(need(i++, x)); break;
      case "--ext": a.ext = need(i++, x); break;
      case "--theme": {
        const t = need(i++, x);
        if (t !== "light" && t !== "dark") throw new Error("--theme is light or dark");
        a.theme = t;
        break;
      }
      case "--all": a.all = true; break;
      case "--tailwind": {
        const t = need(i++, x);
        if (t !== "v3" && t !== "v4") throw new Error("--tailwind is v3 or v4");
        a.tailwind = t;
        break;
      }
      case "--table": a.table = resolve(need(i++, x)); break;
      case "--dry-run": a.dryRun = true; break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown argument ${x}`);
    }
  }
  if (!a.command) throw new Error("give a command: propose or apply");
  if (a.command === "propose" && !a.app) throw new Error("propose needs --app <id>");
  if (a.app) safeAppId(a.app);
  if (a.command === "apply" && !a.table) throw new Error("apply needs --table <path>");
  return a;
}

function designSystemCommit(): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: DESIGN_SYSTEM_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runPropose(args: Args): void {
  const root = args.root ?? resolve(DESIGN_SYSTEM_ROOT, "..");
  const app = loadRegistry().apps.find((x) => x.id === args.app) ?? null;
  if (!app && !args.paths.length) throw new Error(`apps.json has no app "${args.app}": pass --paths for an app not in the registry yet`);
  const input: ScanInput = {
    root,
    paths: args.paths.length ? args.paths : app!.scan.paths,
    exclude: [...(args.paths.length ? [] : (app?.scan.exclude ?? [])), ...args.exclude],
    ext: args.ext ?? (args.paths.length ? undefined : app?.scan.ext),
  };
  const defaultTheme: Theme = args.theme ?? (app?.theme.rule === "dark-first" ? "dark" : "light");
  const tailwind = args.tailwind ?? app?.stack.tailwind ?? "v4";
  const categories = args.all ? ALL_CATEGORIES : DEFAULT_CATEGORIES;
  const outDir = args.outDir ?? process.env.DS_RUN ?? join(tmpdir(), "ds-rollout");
  const dir = tableDir(outDir, args.app!);
  const { rows, dropped } = propose(loadTokens(), input, { appId: args.app!, defaultTheme, categories: new Set(categories), tailwind });
  const table: Table = {
    tool: "codemod-literals",
    version: 1,
    app: args.app!,
    root,
    createdAt: new Date().toISOString(),
    designSystem: { root: DESIGN_SYSTEM_ROOT, commit: designSystemCommit() },
    scan: { paths: input.paths, exclude: input.exclude, ...(input.ext ? { ext: input.ext } : {}), categories },
    tailwind,
    dropped,
    summary: summarize(rows),
    rows,
  };
  const { json, md } = writeTable(dir, table);
  const s = table.summary;
  const left = droppedText(dropped);
  process.stdout.write(
    `${args.app}: ${s.rows} rows, ${s.role} by role, ${s.nearest} by nearest color, ${s.unmapped} unmapped, ${s.handEdit} need a hand edit\n` +
      (left ? `left out (soft categories; --all adds them): ${left}\n` : "") +
      `review: ${md}\napprove in: ${json}\n`,
  );
}

function runApply(args: Args): number {
  const table = readTable(args.table!);
  if (args.app && args.app !== table.app) throw new Error(`--app ${args.app} does not match the table's app ${table.app}`);
  const root = applyRoot(args.root ?? table.root, args.root !== null);
  const r = applyTable(table, root, { dryRun: args.dryRun });
  const verb = args.dryRun ? "would apply" : "applied";
  process.stdout.write(`${table.app}: ${verb} ${r.applied.length} rows in ${r.files.length} files under ${root}; ${r.unapproved} rows not approved\n`);
  for (const f of r.files) process.stdout.write(`  changed ${f}\n`);
  for (const { row, reason } of r.skipped) process.stdout.write(`  skipped #${row.id} ${row.file}:${row.line} ${JSON.stringify(row.literal)}: ${reason}\n`);
  return r.skipped.length ? 1 : 0;
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`codemod-literals: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    if (args.command === "propose") runPropose(args);
    else process.exitCode = runApply(args);
  } catch (err) {
    process.stderr.write(`codemod-literals: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

if (import.meta.main) main();
