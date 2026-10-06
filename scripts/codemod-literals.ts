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
 * with ΔE) and an empty `approve`. apply changes only rows with `"approve": "yes"`, and only in
 * files whose whole text is still what propose read.
 *
 * Known limits (round 3; each either leaves a row without a replacement or needs the reviewer):
 * - JS: a value gets a replacement only where the code at the literal shows it reaches CSS: a JSX
 *   style object (style, sx, css, *Style props), an object a style-named holder or a CSSProperties
 *   type holds, `el.style.x =`, `el.style.setProperty`, `setAttribute("style" | an SVG color)`, a
 *   CSS template (also styled/css tagged templates and their interpolated functions), an SVG
 *   presentation attribute of an SVG element. A value bound through a variable
 *   (`const c = "#fff"; <div style={{ color: c }}>`), passed to or returned by another function
 *   (`treeVars({…})`, `L.geoJSON(d, { style: {…} })`), or kept in a settings, theme or palette
 *   object is "not known to reach CSS": no replacement, even where it does reach CSS. A nearest-color
 *   pick in JS needs a CSS property in its slot.
 * - A style-named holder (`buttonStyle`, `styles`) is trusted unless the file draws on a canvas or
 *   imports a chart, map, graph or scene library; there only JSX style attributes and CSSProperties
 *   types count. Chart and map option keys (series, graphic, stylers, paint, ECharts' itemStyle…)
 *   veto any style name inside them. A file importing React Native, react-pdf or Satori gets no JS
 *   replacements. Other non-CSS consumers of a style-named object are not detected.
 * - The JS reading is lexical. Brackets inside a regex literal between a literal and its holder can
 *   misread the holder; check rows next to regex literals.
 * - Tailwind classes in JS are rewritten in class lists only: not in compared strings, non-class
 *   attributes or prose. Prose is a word with a capital letter or end punctuation outside brackets,
 *   so a class list holding a capitalised custom class (`ProseMirror`) is left alone too.
 * - SVG presentation attributes take var() in browsers but not in a rasterizer such as resvg; SVG
 *   documents and HTML held in JS strings are never changed except their <style> bodies and style=""
 *   values (a page template), and not at all when the string is an SVG image.
 * - Markup: <script> blocks, element text, other attributes (title, alt, aria-*, content, value),
 *   component props, HTML's own bgcolor and <font color>, and Markdown prose, inline, fenced and
 *   indented code are never changed. Only <style> bodies, style attributes, class attributes and
 *   presentation attributes of SVG elements are. An indented paragraph after a blank line in
 *   Markdown reads as code.
 * - Roles from names: the last role word decides, so a name whose role comes first (`bg-input`,
 *   `text-highlight`) reads by its last word. A fallback's own variable (`var(--docs-page, #fdfdfd)`)
 *   is not read as a hint. Mask colors and SVG filter flood/lighting colors get no token.
 * - Canvas 2D is the assignment's target (`.fillStyle`, `.strokeStyle`, `.shadowColor`, `.font`,
 *   `.filter`, `.letterSpacing`, `.wordSpacing`, not under `.style`) or `addColorStop`; a color kept
 *   in a constant and assigned later reads as "not known to reach CSS", not "canvas".
 * - Tailwind targets come from the registry (stack.tailwind; stack.hostTailwind for a library its
 *   hosts compile). A library with hosts on different Tailwinds is proposed for the one named.
 *   Classes with one radius per corner (`rounded-[6px_0_0_6px]`) stay unmapped (no per-corner set).
 * - Roles (round 3): a CSS custom property takes the role its readers in the scanned files give it
 *   (`prop: var(--x)`, `bg-[var(--x)]`, `--y: var(--x)` followed on, a `--color-*` theme variable's
 *   utilities); read nowhere, in two roles, or only inside color-mix(), it gets no token, so a
 *   theme read only by files outside the scan paths is a hand edit. color.text.on-solid needs a
 *   solid hint (a solid, primary or accent word, or a solid background on the same rule, style
 *   object or element). `color-scheme` marks its block's theme; a rule, style object or class
 *   string whose own background is of the other theme is a fixed region and gets no color token.
 *   A state attribute counts only by its static value, and a selector list says a word only when
 *   every branch does. A nearest pick keeps a translucent literal's alpha or gets none, and
 *   color.backdrop needs a scrim, overlay, backdrop or modal hint. Paint inside an SVG <mask>,
 *   <clipPath> or a <pattern> a mask uses gets no token. A generic background may still take
 *   fill.hover or fill.active without a hover or selected state, and a faint hued wash may take a
 *   gray fill (categorical badges lose their hue).
 * - apply refuses every row of a file whose text changed since propose (whole-file hash): re-run
 *   propose after any edit, including an earlier apply of part of the same table.
 * - By design (decision 21a), `--root` naming the owner's tree itself is allowed for the owner's
 *   own apply after the merge; the run never passes it.
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyTable } from "./lib/codemod/apply.ts";
import { applyRoot, tableDir } from "./lib/codemod/paths.ts";
import { ALL_CATEGORIES, DEFAULT_CATEGORIES, propose, type ScanInput } from "./lib/codemod/propose.ts";
import { droppedText, readTable, summarize, writeTable, type Table } from "./lib/codemod/table.ts";
import { loadTokens, type Theme } from "./lib/codemod/tokens.ts";
import type { TailwindTarget } from "./lib/codemod/size-role.ts";
import { DESIGN_SYSTEM_ROOT, loadRegistry, type AppEntry } from "./lib/registry.ts";
import { safeAppId } from "./lib/safe-paths.ts";
import { SYSTEM_BIN, SYSTEM_PATH } from "./lib/system-bin.ts";

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
  --tailwind <v>     v3, v4 or uno: the Tailwind the class replacements target (default: the
                     registry's stack.tailwind; for a library its hosts compile, stack.hostTailwind;
                     else v4). uno: an UnoCSS host, no class rewrites

apply options:
  --table <path>     the mapping JSON; only rows with "approve": "yes" change
  --dry-run          report what would change without writing
  Files are edited only inside the root (--root, else the table's root). The owner's tree is
  refused unless --root names it. A file that changed since propose (whole-file hash) keeps all
  its rows: run propose again.
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
  tailwind?: "v3" | "v4" | "uno";
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
        if (t !== "v3" && t !== "v4" && t !== "uno") throw new Error("--tailwind is v3, v4 or uno");
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

export function designSystemCommit(): string | null {
  // git by absolute path, never through PATH (scripts/lib/system-bin.ts).
  const r = spawnSync(SYSTEM_BIN.git, ["rev-parse", "HEAD"], { cwd: DESIGN_SYSTEM_ROOT, encoding: "utf8", env: { ...process.env, PATH: SYSTEM_PATH } });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The Tailwind that compiles an app's classes, and where that comes from: the app's own
 * stack.tailwind; for a library or template whose hosts compile its classes (stack.utilityClasses),
 * the host's stack.hostTailwind (v4 when the registry does not say).
 */
export function classTarget(app: AppEntry | null): { tailwind: TailwindTarget; from: string } {
  if (!app) return { tailwind: "v4", from: "default" };
  if (app.stack.tailwind !== "none") return { tailwind: app.stack.tailwind, from: "stack.tailwind" };
  if (app.stack.utilityClasses) return { tailwind: app.stack.hostTailwind ?? "v4", from: app.stack.hostTailwind ? "stack.hostTailwind" : "default: no stack.hostTailwind" };
  return { tailwind: "none", from: "stack.tailwind" };
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
  const target = args.tailwind ? { tailwind: args.tailwind, from: "--tailwind" } : classTarget(app);
  const tailwind = target.tailwind;
  const categories = args.all ? ALL_CATEGORIES : DEFAULT_CATEGORIES;
  const outDir = args.outDir ?? process.env.DS_RUN ?? join(tmpdir(), "ds-rollout");
  const dir = tableDir(outDir, args.app!);
  const { rows, dropped, files } = propose(loadTokens(), input, { appId: args.app!, defaultTheme, categories: new Set(categories), tailwind });
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
    files,
    rows,
  };
  const { json, md } = writeTable(dir, table);
  const s = table.summary;
  const left = droppedText(dropped);
  process.stdout.write(
    `${args.app}: ${s.rows} rows, ${s.role} by role, ${s.nearest} by nearest color, ${s.unmapped} unmapped, ${s.handEdit} need a hand edit\n` +
      `classes target ${tailwind === "uno" ? "UnoCSS (no class rewrites)" : tailwind === "none" ? "Tailwind v4 (the app has no Tailwind build)" : `Tailwind ${tailwind}`} (${target.from})\n` +
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
  for (const f of r.staleFiles) process.stdout.write(`  stale ${f.file}: ${f.reason} (${f.rows} approved rows skipped)\n`);
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
