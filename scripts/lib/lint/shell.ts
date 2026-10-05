/**
 * Check 5, shell: a shell app renders the design-system app shell.
 *
 * Either of these passes (a hand-written AppShell folder passes through the markup):
 * - an `AppShell` copied from templates/react-app-shell: a `_components/AppShell/`
 *   folder in the scan dirs holds every non-test file of the template (by path, not
 *   by bytes; apps may add files), still renders every ds-* class the template
 *   renders, and is imported by another app file;
 * - `.ds-shell` markup: the scan dirs (markup and string literals, not CSS
 *   selectors) render ds-shell, ds-sidebar, ds-sidebar-toggle, ds-workspace,
 *   ds-topbar and ds-main.
 * An app with `shell: false` has no shell to check (n/a).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lexJs, stripHtml } from "../../scan-literals";
import { DS_CLASS, TEMPLATE_APPSHELL, dsClassesInJs } from "./design-system";
import type { AppContext, CheckOutput, Finding } from "./types";
import { lineFinder } from "./workspace";

export const SHELL_CLASSES = ["ds-shell", "ds-sidebar", "ds-sidebar-toggle", "ds-workspace", "ds-topbar", "ds-main"];

interface Copy {
  dir: string;
  violations: Finding[];
}

function checkCopy(ctx: AppContext, dir: string): Copy {
  const { files, classes } = ctx.ds.template;
  const violations: Finding[] = [];
  const dirRel = ctx.rel(dir);
  const rendered = new Set<string>();
  for (const f of files) {
    if (!existsSync(join(dir, f))) violations.push({ file: dirRel, line: 0, message: `AppShell copy is missing ${f} from ${TEMPLATE_APPSHELL}` });
  }
  for (const s of ctx.sources()) {
    if (!s.abs.startsWith(dir + "/") || s.kind !== "js") continue;
    for (const c of dsClassesInJs(s.text).keys()) rendered.add(c);
  }
  for (const c of [...classes].sort()) {
    if (!rendered.has(c)) violations.push({ file: `${dirRel}/index.tsx`, line: 0, message: `AppShell copy no longer renders .${c} (the template does)` });
  }
  if (!isImported(ctx, dir)) {
    violations.push({ file: dirRel, line: 0, message: "AppShell copy is not imported by any other app file; render it from App.tsx or a RouterShell" });
  }
  return { dir, violations };
}

const IMPORT_SPEC =
  /(?<![\w$.])(?:import|export)\s+(?!type\b)(?:[\w$*{}\s,]*?\s+from\s+)?(["'])([^"'\n]+)\1|(?<![\w$.])import\(\s*(["'])([^"'\n]+)\3\s*\)/g;

/** True when a source file outside the copy imports it (relative path, or an alias ending in _components/AppShell). */
function isImported(ctx: AppContext, dir: string): boolean {
  for (const s of ctx.sources()) {
    if (s.kind !== "js" || s.abs.startsWith(dir + "/")) continue;
    const { text, inStr } = lexJs(s.text);
    for (const m of text.matchAll(IMPORT_SPEC)) {
      if (inStr[m.index!]) continue;
      const spec = (m[2] ?? m[4]).replace(/\/+$/, "");
      if (spec.startsWith(".")) {
        const target = resolve(dirname(s.abs), spec);
        if (target === dir || (target.startsWith(dir) && /^\/index(?:\.[jt]sx?)?$/.test(target.slice(dir.length)))) return true;
      } else if (/(?:^|\/)_components\/AppShell(?:\/index(?:\.[jt]sx?)?)?$/.test(spec)) return true;
    }
  }
  return false;
}

/** First place each ds-* class is rendered: in JS string literals or HTML markup, never as a CSS selector. */
function renderedClasses(ctx: AppContext, skipDirs: string[]): Map<string, { file: string; line: number }> {
  const found = new Map<string, { file: string; line: number }>();
  for (const s of ctx.sources()) {
    if (s.kind !== "js" && s.kind !== "html") continue;
    if (skipDirs.some((d) => s.abs.startsWith(d + "/"))) continue;
    const line = lineFinder(s.text);
    if (s.kind === "js") {
      for (const [c, i] of dsClassesInJs(s.text)) if (!found.has(c)) found.set(c, { file: s.rel, line: line(i) });
    } else {
      const text = stripHtml(s.text).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));
      for (const m of text.matchAll(DS_CLASS)) if (!found.has(m[0])) found.set(m[0], { file: s.rel, line: line(m.index!) });
    }
  }
  return found;
}

export function checkShell(ctx: AppContext): CheckOutput {
  const { app } = ctx;
  if (!app.shell) return { violations: [], warnings: [], na: `${app.id} is not a shell app (shell: false in apps.json)` };

  // Route 1: an AppShell copied from the template.
  const copyDirs = new Set<string>();
  for (const s of ctx.sources()) {
    const m = s.abs.match(/^(.*\/_components\/AppShell)\//);
    if (m) copyDirs.add(m[1]);
  }
  const copies = [...copyDirs].map((d) => checkCopy(ctx, d)).sort((a, b) => a.violations.length - b.violations.length);
  if (copies.length && !copies[0].violations.length) return { violations: [], warnings: [] };

  // Route 2: .ds-shell markup (also how a hand-written AppShell passes). Markup in an
  // AppShell folder that no app file imports is never rendered, so it does not count.
  const found = renderedClasses(ctx, [...copyDirs].filter((d) => !isImported(ctx, d)));
  const root = found.get("ds-shell");
  const markup: Finding[] = [];
  if (root) {
    for (const c of SHELL_CLASSES.slice(1)) {
      if (!found.has(c)) markup.push({ file: root.file, line: root.line, message: `the .ds-shell markup has no .${c}` });
    }
    if (!markup.length) return { violations: [], warnings: [] };
  }

  // Neither route passes: an AppShell folder is judged as a template copy, else the markup.
  if (copies.length) return { violations: copies[0].violations, warnings: [] };
  if (root) return { violations: markup, warnings: [] };
  const where = app.scan?.paths?.[0] ?? app.root;
  return {
    violations: [{ file: where, line: 0, message: "renders no .ds-shell markup and has no AppShell copied from templates/react-app-shell" }],
    warnings: [],
  };
}
