/**
 * Check 6, structure (guide/code-structure.md).
 *
 * Folder-standard apps (`folderStandard: true`):
 * - every `_components/` folder in the scan dirs holds only PascalCase folders,
 *   no loose files (dotfiles aside);
 * - every component folder has an `index.tsx` (`index.ts` in plain DOM apps);
 * - every .tsx/.jsx file outside `_components/<Name>/index.tsx` is a component in the
 *   wrong place, whatever its name or folder (`components/Panel/index.tsx`,
 *   `shell/style-rail-nav.tsx`, `features/x/App.tsx`), except entry files:
 *   - the registry's entry file, and every module an HTML page in the scan dirs loads
 *     with `<script src>` (`playground.html` -> `src/playground/main.tsx`);
 *   - `main`, `App`, `mdx-components` and `index` directly in a root: the app root, its
 *     `src/`, or the folder of one of those entry modules;
 *   - inside an `app/` or `pages/` router folder, route entries (`page`) for every stack,
 *     and in a Next.js app (stack summary "Next …") the special files (`layout`,
 *     `template`, `loading`, `error`, `not-found`, `global-error`, `default`, `forbidden`,
 *     `unauthorized`, the metadata images, `_app`, `_document`, `_error`).
 *   A plain-DOM slice's entry is `index.ts`, never .tsx, so the rule does not reach it.
 * - a hook file is `use<Name>.ts` and holds no JSX: `use<Name>.tsx`/`.jsx` is a violation,
 *   and so is JSX in a `use<Name>.js`/`.ts` file.
 * Every app: no source file (.ts .tsx .js .jsx .css in the scan dirs; tests,
 * generated and vendored files skipped) is over 400 lines. For libraries
 * (`kind: "library"`) over-400 files are warnings, not violations.
 */

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lexJs, stripHtml } from "../../scan-literals";
import { resolvePath } from "../registry";
import { resolveModule } from "./modules";
import type { AppContext, CheckOutput, Finding } from "./types";
import { MAX_LINES } from "./types";
import { isDir, isFile, realpathOrNull } from "./workspace";

const LINE_EXTS = new Set(["ts", "tsx", "js", "jsx", "css"]);
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const INDEX_FILES = ["index.tsx", "index.ts", "index.jsx", "index.js"];
/** Entry files by basename (guide/code-structure.md, "Components"), only directly in a root: they wire the app. */
const APP_ENTRY_FILES = new Set(["main", "App", "mdx-components"]);
/** The Next.js special files: entries only in a Next.js app, inside an `app/` or `pages/` router folder (`page` is a route entry for every stack). */
const NEXT_FILES = new Set([
  "layout", "template", "loading", "error", "not-found", "global-error", "default", "forbidden", "unauthorized",
  "opengraph-image", "twitter-image", "icon", "apple-icon", "_app", "_document", "_error",
]);
const NEXT_STACK = /\bNext(?:\.js)?\b/;
const HOOK_FILE = /^use[A-Z][A-Za-z0-9]*$/;
/** Hook-named scripts that must not hold JSX (.tsx and .jsx are violations by extension). */
const SCRIPT_EXTS = new Set(["ts", "mts", "cts", "js", "mjs", "cjs"]);
/** A JSX closing tag or fragment, or a self-closing element, in code (not in a string). */
const JSX = /<\/(?:[A-Za-z][\w.:-]*)?\s*>|<[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/>/g;

function hasJsx(src: string): boolean {
  const { text, inStr } = lexJs(src);
  for (const m of text.matchAll(JSX)) if (!inStr[m.index!] && !inStr[m.index! + 1]) return true;
  return false;
}

const toPascal = (name: string) => name.replace(/(^|[-_.\s]+)([a-z0-9])/gi, (_m, _sep, c: string) => c.toUpperCase());

export function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export function checkStructure(ctx: AppContext): CheckOutput {
  const { app } = ctx;
  const violations: Finding[] = [];
  const warnings: Finding[] = [];
  const sources = ctx.sources();

  for (const s of sources) {
    if (!LINE_EXTS.has(s.ext)) continue;
    const n = lineCount(s.text);
    if (n <= MAX_LINES) continue;
    const finding = { file: s.rel, line: 0, message: `${n} lines, over the ${MAX_LINES}-line limit; split it` };
    (app.kind === "library" ? warnings : violations).push(finding);
  }

  if (app.folderStandard) {
    // Entry modules: the registry entry and the scripts the app's pages load. Source roots: an
    // index.tsx directly in one of them is the app's entry (src/index.tsx beside main.tsx).
    const entry = app.entryStylesheet ? realpathOrNull(resolvePath(ctx.root, app.entryStylesheet)) : null;
    const entries = new Set<string>(entry ? [entry] : []);
    const serveRoot = resolvePath(ctx.root, app.run?.serveRoot ?? app.run?.cwd ?? app.root);
    for (const page of sources) {
      if (page.ext !== "html" && page.ext !== "htm") continue;
      for (const m of stripHtml(page.text).matchAll(/<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const hit = resolveModule(m[1] ?? m[2] ?? m[3], page.abs, serveRoot, ctx.root);
        const real = hit ? realpathOrNull(hit) : null;
        if (real) entries.add(real);
      }
    }
    const roots = new Set<string>();
    for (const p of [ctx.appRoot, join(ctx.appRoot, "src"), ...[...entries].map((e) => dirname(e))]) {
      const real = realpathOrNull(p);
      if (real && isDir(real)) roots.add(real);
    }
    const appRoot = realpathOrNull(ctx.appRoot) ?? ctx.appRoot;
    const next = NEXT_STACK.test(app.stack?.summary ?? "");
    const inRouter = (file: string) => {
      const rel = file.startsWith(appRoot + "/") ? file.slice(appRoot.length + 1) : file;
      return rel.split("/").slice(0, -1).some((d) => d === "app" || d === "pages");
    };

    const componentDirs = new Set<string>();
    for (const s of sources) {
      const parts = s.abs.split("/");
      for (let i = parts.length - 2; i >= 0; i--) if (parts[i] === "_components") componentDirs.add(parts.slice(0, i + 1).join("/"));

      const ext = s.ext;
      const component = ext === "tsx" || ext === "jsx";
      if (!component && !SCRIPT_EXTS.has(ext)) continue;
      const file = basename(s.abs);
      const name = file.replace(/\.[^.]+$/, "");
      const parent = dirname(s.abs);
      const grand = dirname(parent);
      // In its place, or reported by the folder pass below (loose files, non-Pascal folders).
      if (basename(parent) === "_components" || (name === "index" && basename(grand) === "_components")) continue;
      if (HOOK_FILE.test(name)) {
        const message = component
          ? `hook file ${file}: a hook file is ${name}.${ext === "jsx" ? "js" : "ts"} with no JSX; rename it, or move the markup to _components/<Name>/index.${ext}`
          : hasJsx(s.text)
            ? `hook file ${file} holds JSX; move the markup to _components/<Name>/index.${/^[mc]?ts$/.test(ext) ? "tsx" : "jsx"}`
            : null;
        if (message) violations.push({ file: s.rel, line: 0, message });
        continue;
      }
      if (!component) continue;
      const real = realpathOrNull(s.abs) ?? s.abs;
      const inRoot = roots.has(realpathOrNull(parent) ?? parent);
      if (entries.has(real) || ((APP_ENTRY_FILES.has(name) || name === "index") && inRoot)) continue;
      if ((name === "page" || (next && NEXT_FILES.has(name))) && inRouter(real)) continue;
      const inFolder = basename(grand) === "_components" && PASCAL.test(basename(parent));
      const target = name === "index" ? basename(parent) : name;
      violations.push({
        file: s.rel,
        line: 0,
        message: inFolder
          ? `component file ${basename(s.abs)} in ${basename(parent)}/; a component folder renders one component from index.${ext}`
          : APP_ENTRY_FILES.has(name)
            ? `entry file ${file} is not in a source root (the app root, src/ or an entry's folder); move it there, or make it a component in _components/${toPascal(name)}/index.${ext}`
            : `component file outside _components/<Name>/index.${ext}; move it to _components/${toPascal(target)}/index.${ext}`,
      });
    }
    for (const dir of [...componentDirs].sort()) {
      if (!isDir(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const rel = ctx.rel(join(dir, e.name));
        if (!e.isDirectory()) {
          violations.push({ file: rel, line: 0, message: "loose file in _components/; components are folders: _components/<Name>/index.tsx" });
        } else if (!PASCAL.test(e.name)) {
          violations.push({ file: rel, line: 0, message: `_components/${e.name} is not a PascalCase component folder` });
        } else if (!INDEX_FILES.some((f) => isFile(join(dir, e.name, f)))) {
          violations.push({ file: rel, line: 0, message: `component folder ${e.name} has no index.tsx` });
        }
      }
    }
  }
  return { violations, warnings };
}
