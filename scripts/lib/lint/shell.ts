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
 * - `.ds-shell` markup: a reachable file renders ds-shell, and ds-sidebar,
 *   ds-sidebar-toggle, ds-workspace, ds-topbar and ds-main are rendered in its component
 *   subtree (the file and the modules it imports; for a script an HTML page loads, the
 *   page and all its scripts) or in the subtree of a module that renders the file's
 *   component with props or children (slot composition: App renders
 *   `<Shell sidebar={<Sidebar />}>` and imports Sidebar). The best such module counts.
 *   A module that renders the component bare (`<App />` beside `<Panels />`) fills no slot.
 *
 * A static-only app (`run.mode` none: nothing checks its shell at runtime) must also
 * render the shell, not only import it. The file F that renders ds-shell (or the
 * AppShell copy's index) is rendered when it is a root (the entry, an HTML page, a
 * Next.js route file), a page loads it, or a reachable importer renders one of the
 * names it binds from F: `<Name`, `<ns.Name`, `createElement(Name`, `h(Name`,
 * `jsx(Name`, a router's `Component: Name` / `component={Name}`, for default, named and
 * namespace imports and `const Name = lazy(() => import("…"))`. A barrel that re-exports
 * F is followed two levels. A side-effect import renders F only when F has no exports
 * (a script that runs on import). Markup in a function F exports but never calls still
 * counts (a known limit; verify:apps checks rendered shells at runtime).
 *
 * An app with `shell: false` has no shell to check (n/a).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { lexJs } from "../../scan-literals";
import { TEMPLATE_APPSHELL, dsClassesIn } from "./design-system";
import { importersOf, isPageFile, moduleBindings, subtreeOf, type ModuleGraph } from "./modules";
import type { AppContext, CheckOutput, Finding } from "./types";
import { lineAt, lineFinder, readText, realpathOrNull, type SourceFile } from "./workspace";

export const SHELL_CLASSES = ["ds-shell", "ds-sidebar", "ds-sidebar-toggle", "ds-workspace", "ds-topbar", "ds-main"];

const INDEX_FILES = ["index.tsx", "index.jsx", "index.ts", "index.js"];
const HTML_FILE = /\.html?$/i;
/** Barrels followed between a module and the file that renders its component. */
const MAX_BARRELS = 2;

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

// ---------------------------------------------------------------------------
// Is a file's component rendered?

interface RenderInfo {
  rendered: boolean;
  /** Modules that render the file's component with props or children: their imports can fill its slots. */
  composers: string[];
  /** The first import that binds the file (or a barrel of it) without rendering anything from it. */
  unrendered: { file: string; index: number; names: string[]; from: string } | null;
}

const escape = (s: string) => s.replace(/\$/g, "\\$");
const CALLS = "(?:createElement|h|jsxs?|jsxDEV|_jsxs?)";

/** Whether `src` renders any of `locals`, and whether it passes one props or children. */
function usesOf(file: string, src: string, locals: string[]): { rendered: boolean; composes: boolean } {
  // A Vue, Svelte or Astro template is markup: search it as written. JS/TS: code only.
  const page = isPageFile(file);
  const { text, inStr } = page ? { text: src, inStr: new Uint8Array(src.length) } : lexJs(src);
  let rendered = false;
  let composes = false;
  for (const local of locals) {
    const name = `${escape(local)}(?:\\.[\\w$]+)*`;
    for (const m of text.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
      if (inStr[m.index!]) continue;
      rendered = true;
      // `<X />` and `<X></X>` pass nothing; an attribute or a child fills a slot.
      const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 400).trimStart();
      if (rest.startsWith("/>")) continue;
      if (rest.startsWith(">") && rest.slice(1).trimStart().startsWith("</")) continue;
      composes = true;
    }
    if (page) continue;
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${CALLS}\\(\\s*${name}\\s*(?=[,)])`, "g"))) {
      if (inStr[m.index!]) continue;
      rendered = true;
      const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
      if (!/^(?:\)|,\s*(?:null|undefined|\{\s*\})\s*\))/.test(rest)) composes = true;
    }
    const routed = new RegExp(`(?<![\\w$])(?:Component|component)\\s*:\\s*${escape(local)}(?![\\w$])|(?<![\\w$])component\\s*=\\s*\\{\\s*${escape(local)}\\s*\\}`);
    for (const m of text.matchAll(new RegExp(routed.source, "g"))) if (!inStr[m.index!]) rendered = true;
  }
  return { rendered, composes };
}

/** True when a JS/TS module exports nothing: importing it runs it for its effects. */
function hasExports(src: string): boolean {
  const { text, inStr } = lexJs(src);
  for (const m of text.matchAll(/(?<![\w$.])(?:export\b|module\.exports\b|exports\.)/g)) if (!inStr[m.index!]) return true;
  return false;
}

function renderInfo(graph: ModuleGraph, file: string): RenderInfo {
  const info: RenderInfo = { rendered: false, composers: [], unrendered: null };
  if (graph.roots.includes(file)) {
    info.rendered = true;
    return info;
  }
  const runsOnImport = !isPageFile(file) && !hasExports(readText(file) ?? "");
  const seen = new Set<string>();
  /** `target` is `file` or a barrel of it; `wanted` is the target's exports that carry `file`'s ("*" for all). */
  const visit = (target: string, wanted: "*" | Set<string>, depth: number) => {
    for (const importer of importersOf(graph, target)) {
      const key = `${importer}\0${target}`;
      if (seen.has(key) || !graph.reachable.has(importer)) continue;
      seen.add(key);
      if (HTML_FILE.test(importer)) {
        info.rendered = true; // a page runs the scripts it loads
        continue;
      }
      const src = readText(importer) ?? "";
      const specs = graph.resolved.get(importer);
      const bindings = moduleBindings(importer, src).filter((b) => specs?.get(b.spec) === target);
      if (!bindings.length) {
        info.rendered = true; // an import form this check does not read (require, a bare dynamic import): not judged
        continue;
      }
      for (const b of bindings) {
        if (b.routed) {
          info.rendered = true;
          continue;
        }
        if (b.reexports) {
          const passed: "*" | Set<string> =
            b.reexports === "*"
              ? wanted
              : new Set(b.reexports.filter((p) => wanted === "*" || p.imported === "*" || wanted.has(p.imported)).map((p) => p.exported));
          if (passed === "*" || passed.size) {
            if (depth >= MAX_BARRELS) info.rendered = true; // deeper barrels are not followed: not judged
            else visit(importer, passed, depth + 1);
          }
          if (!b.names.length) continue; // `export … from`: binds nothing locally
        }
        const names = b.names.filter((n) => wanted === "*" || n.imported === "*" || wanted.has(n.imported));
        if (b.names.length && !names.length) continue; // binds other exports of a barrel
        const use = names.length ? usesOf(importer, src, names.map((n) => n.local)) : { rendered: depth === 0 && runsOnImport, composes: false };
        if (use.rendered) {
          info.rendered = true;
          if (use.composes && !info.composers.includes(importer)) info.composers.push(importer);
        } else if (!b.reexports && !info.unrendered) {
          info.unrendered = { file: importer, index: b.index, names: names.map((n) => n.local), from: target };
        }
      }
    }
  };
  visit(file, "*", 0);
  return info;
}

/** The first component name a module exports, for the message. */
function componentName(src: string): string {
  return src.match(/export\s+(?:default\s+)?(?:function|class|const|let)\s+([A-Z][\w$]*)/)?.[1] ?? "Shell";
}

function renderViolation(ctx: AppContext, file: string, info: RenderInfo): Finding {
  const why = "run.mode is none, so nothing checks the shell at runtime";
  const u = info.unrendered;
  if (!u) {
    const name = componentName(readText(file) ?? "");
    return { file: ctx.rel(file), line: 0, message: `renders the shell, but no reachable file renders it; render <${name}> in a reachable file. ${why}` };
  }
  const what = u.names.length ? `${u.names.join(", ")} from ${ctx.rel(u.from)}` : ctx.rel(u.from);
  const name = u.names.length ? u.names[0] : componentName(readText(file) ?? "");
  const via = u.from !== file ? ` (${ctx.rel(u.from)} re-exports the shell in ${ctx.rel(file)})` : "";
  return {
    file: ctx.rel(u.file),
    line: lineAt(readText(u.file) ?? "", u.index),
    message: `imports ${what} but never renders it; render <${name}> in a reachable file${via}. ${why}`,
  };
}

// ---------------------------------------------------------------------------

function checkCopy(ctx: AppContext, dir: string, entryRel: string, renderOf: ((f: string) => RenderInfo) | null): Finding[] {
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
  } else if (renderOf) {
    const info = renderOf(index);
    if (!info.rendered) violations.push(renderViolation(ctx, index, info));
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
  const staticOnly = app.run?.mode === "none";
  const infos = new Map<string, RenderInfo>();
  const renderOf = (f: string) => {
    if (!infos.has(f)) infos.set(f, renderInfo(graph, f));
    return infos.get(f)!;
  };

  // Route 1: an AppShell copied from the template.
  const copyDirs = new Set<string>();
  for (const s of ctx.sources()) {
    const m = s.abs.match(/^(.*\/_components\/AppShell)\//);
    if (m) copyDirs.add(m[1]);
  }
  const copies = [...copyDirs].map((d) => checkCopy(ctx, d, entryRel, staticOnly ? renderOf : null)).sort((a, b) => a.length - b.length);
  if (copies.length && !copies[0].length) return { violations: [], warnings: [] };

  // Route 2: .ds-shell markup with its parts in its subtree or in that of a module that fills its slots.
  let best: { root: Rendered; missing: string[] } | null = null;
  let unrendered: Finding | null = null;
  for (const [real, r] of rendered) {
    if (!r.classes.has("ds-shell")) continue;
    const info = renderOf(real);
    let missing: string[] | null = null;
    for (const start of [real, ...info.composers]) {
      const have = new Set<string>();
      for (const f of subtreeOf(graph, start)) for (const c of rendered.get(f)?.classes.keys() ?? []) have.add(c);
      const m = SHELL_CLASSES.slice(1).filter((c) => !have.has(c));
      if (!missing || m.length < missing.length) missing = m;
    }
    if (!missing!.length) {
      if (!staticOnly || info.rendered) return { violations: [], warnings: [] };
      unrendered ??= renderViolation(ctx, real, info);
      continue;
    }
    if (!best || missing!.length < best.missing.length) best = { root: r, missing: missing! };
  }

  // Neither route passes: an AppShell folder is judged as a template copy, else the markup.
  if (copies.length) return { violations: copies[0], warnings: [] };
  if (unrendered) return { violations: [unrendered], warnings: [] };
  if (best) {
    const { source, classes } = best.root;
    const line = lineFinder(source.text)(classes.get("ds-shell")!);
    return {
      violations: best.missing.map((c) => ({
        file: source.rel,
        line,
        message: `the .ds-shell markup has no .${c} in its file or the modules it imports, nor in those of a module that renders it with props or children`,
      })),
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
