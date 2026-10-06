/**
 * Check 5, shell: a shell app renders the design-system app shell.
 *
 * Only rendered markup counts: a ds-* class in a class context (class-context.ts:
 * className/class values, clsx/cn arguments, classList calls, class attributes) in a
 * scan-dir file the app's entry reaches through imports (modules.ts). A dead constant
 * that lists the class names, or a file nothing imports, renders nothing.
 *
 * Either of these passes (a hand-written AppShell folder passes through the markup):
 * - an `AppShell` copied from templates/react-app-shell: a `_components/AppShell/`
 *   folder in the scan dirs holds every non-test file of the template (by path, not
 *   by bytes; apps may add files), still renders every ds-* class the template
 *   renders, and the entry reaches its index;
 * - `.ds-shell` markup: a reachable file renders ds-shell, and that file together with
 *   the modules it imports (its component subtree) renders ds-sidebar,
 *   ds-sidebar-toggle, ds-workspace, ds-topbar and ds-main.
 * An app with `shell: false` has no shell to check (n/a).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_APPSHELL, dsClassesIn } from "./design-system";
import { reachableFrom } from "./modules";
import type { AppContext, CheckOutput, Finding } from "./types";
import { lineFinder, realpathOrNull, type SourceFile } from "./workspace";

export const SHELL_CLASSES = ["ds-shell", "ds-sidebar", "ds-sidebar-toggle", "ds-workspace", "ds-topbar", "ds-main"];

const INDEX_FILES = ["index.tsx", "index.jsx", "index.ts", "index.js"];

interface Rendered {
  source: SourceFile;
  /** Each ds-* class the file renders, at its first offset. */
  classes: Map<string, number>;
}

/** Reachable scan-dir sources by real path, with the ds-* classes each renders. */
function renderedSources(ctx: AppContext): Map<string, Rendered> {
  const { reachable } = ctx.modules();
  const out = new Map<string, Rendered>();
  for (const s of ctx.sources()) {
    if (s.kind !== "js" && s.kind !== "html") continue;
    const real = realpathOrNull(s.abs) ?? s.abs;
    if (!reachable.has(real)) continue;
    out.set(real, { source: s, classes: dsClassesIn(s.text, s.kind) });
  }
  return out;
}

function checkCopy(ctx: AppContext, dir: string, entryRel: string): Finding[] {
  const { files, classes } = ctx.ds.template;
  const violations: Finding[] = [];
  const dirRel = ctx.rel(dir);
  for (const f of files) {
    if (!existsSync(join(dir, f))) violations.push({ file: dirRel, line: 0, message: `AppShell copy is missing ${f} from ${TEMPLATE_APPSHELL}` });
  }
  // What the copy's own files render (whether the entry reaches it is checked below).
  const inCopy = new Set<string>();
  for (const s of ctx.sources()) {
    if (s.abs.startsWith(dir + "/") && s.kind === "js") for (const c of dsClassesIn(s.text, s.kind).keys()) inCopy.add(c);
  }
  for (const c of [...classes].sort()) {
    if (!inCopy.has(c)) violations.push({ file: `${dirRel}/index.tsx`, line: 0, message: `AppShell copy no longer renders .${c} (the template does)` });
  }
  const index = INDEX_FILES.map((f) => realpathOrNull(join(dir, f))).find((p) => p !== null);
  if (!index || !ctx.modules().reachable.has(index)) {
    violations.push({ file: dirRel, line: 0, message: `AppShell copy is not imported by any file reachable from the entry (${entryRel}); render it from App.tsx or a RouterShell` });
  }
  return violations;
}

export function checkShell(ctx: AppContext): CheckOutput {
  const { app } = ctx;
  if (!app.shell) return { violations: [], warnings: [], na: `${app.id} is not a shell app (shell: false in apps.json)` };

  const graph = ctx.modules();
  const entryRel = app.entryStylesheet ?? app.root;
  if (!graph.entryExists) {
    return { violations: [{ file: entryRel, line: 0, message: "entry not found: cannot tell which files the app renders" }], warnings: [] };
  }
  const rendered = renderedSources(ctx);

  // Route 1: an AppShell copied from the template.
  const copyDirs = new Set<string>();
  for (const s of ctx.sources()) {
    const m = s.abs.match(/^(.*\/_components\/AppShell)\//);
    if (m) copyDirs.add(m[1]);
  }
  const copies = [...copyDirs].map((d) => checkCopy(ctx, d, entryRel)).sort((a, b) => a.length - b.length);
  if (copies.length && !copies[0].length) return { violations: [], warnings: [] };

  // Route 2: .ds-shell markup with its parts in the same file or the modules it imports.
  let best: { root: Rendered; missing: string[] } | null = null;
  for (const [real, r] of rendered) {
    if (!r.classes.has("ds-shell")) continue;
    const subtree = reachableFrom(graph, real);
    const have = new Set<string>();
    for (const f of subtree) for (const c of rendered.get(f)?.classes.keys() ?? []) have.add(c);
    const missing = SHELL_CLASSES.slice(1).filter((c) => !have.has(c));
    if (!missing.length) return { violations: [], warnings: [] };
    if (!best || missing.length < best.missing.length) best = { root: r, missing };
  }

  // Neither route passes: an AppShell folder is judged as a template copy, else the markup.
  if (copies.length) return { violations: copies[0], warnings: [] };
  if (best) {
    const { source, classes } = best.root;
    const line = lineFinder(source.text)(classes.get("ds-shell")!);
    return {
      violations: best.missing.map((c) => ({ file: source.rel, line, message: `the .ds-shell markup has no .${c} in its file or the modules it imports` })),
      warnings: [],
    };
  }
  const where = app.scan?.paths?.[0] ?? app.root;
  const how = graph.roots.length ? `in a file reachable from ${entryRel}` : `(no module entry found from ${entryRel})`;
  return {
    violations: [{ file: where, line: 0, message: `renders no .ds-shell markup ${how} and has no AppShell copied from templates/react-app-shell` }],
    warnings: [],
  };
}
