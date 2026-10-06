/**
 * Check 6, structure (guide/code-structure.md).
 *
 * Folder-standard apps (`folderStandard: true`):
 * - every `_components/` folder in the scan dirs holds only PascalCase folders,
 *   no loose files (dotfiles aside);
 * - every component folder has an `index.tsx` (`index.ts` in plain DOM apps);
 * - every .tsx/.jsx file outside `_components/<Name>/index.tsx` is a component in the
 *   wrong place, whatever its name or folder (`components/Panel/index.tsx`,
 *   `shell/style-rail-nav.tsx`), except:
 *   - entry files: `main`, `App`, route entries (`page`) and the Next.js special files
 *     (`layout`, `template`, `loading`, `error`, `not-found`, `global-error`, `default`,
 *     `forbidden`, `unauthorized`, the metadata images, `_app`, `_document`), the
 *     registry's entry file, and an `index.tsx` at the root of the app's sources;
 *   - hook files (`use<Name>.tsx`), which hold no component.
 *   A plain-DOM slice's entry is `index.ts`, never .tsx, so the rule does not reach it.
 * Every app: no source file (.ts .tsx .js .jsx .css in the scan dirs; tests,
 * generated and vendored files skipped) is over 400 lines. For libraries
 * (`kind: "library"`) over-400 files are warnings, not violations.
 */

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolvePath } from "../registry";
import type { AppContext, CheckOutput, Finding } from "./types";
import { MAX_LINES } from "./types";
import { isDir, isFile, realpathOrNull } from "./workspace";

const LINE_EXTS = new Set(["ts", "tsx", "js", "jsx", "css"]);
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const INDEX_FILES = ["index.tsx", "index.ts", "index.jsx", "index.js"];
/** Entry files by basename (guide/code-structure.md, "Components"): they wire the app, its routes or a region. */
const ENTRY_FILES = new Set([
  "main", "App", "page",
  // Next.js special files.
  "layout", "template", "loading", "error", "not-found", "global-error", "default", "forbidden", "unauthorized",
  "opengraph-image", "twitter-image", "icon", "apple-icon", "_app", "_document", "_error",
]);
const HOOK_FILE = /^use[A-Z][A-Za-z0-9]*$/;

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
    // Source roots: an index.tsx directly in one of them is the app's entry (src/index.tsx).
    const roots = new Set<string>();
    for (const p of [...(app.scan?.paths ?? []).map((x) => resolvePath(ctx.root, x)), ctx.appRoot, join(ctx.appRoot, "src")]) {
      const real = realpathOrNull(p);
      if (real) roots.add(isDir(real) ? real : dirname(real));
    }
    const entry = app.entryStylesheet ? realpathOrNull(resolvePath(ctx.root, app.entryStylesheet)) : null;

    const componentDirs = new Set<string>();
    for (const s of sources) {
      const parts = s.abs.split("/");
      for (let i = parts.length - 2; i >= 0; i--) if (parts[i] === "_components") componentDirs.add(parts.slice(0, i + 1).join("/"));

      const ext = s.ext;
      if (ext !== "tsx" && ext !== "jsx") continue;
      const name = basename(s.abs).replace(/\.[^.]+$/, "");
      const parent = dirname(s.abs);
      const grand = dirname(parent);
      // In its place, or reported by the folder pass below (loose files, non-Pascal folders).
      if (basename(parent) === "_components" || (name === "index" && basename(grand) === "_components")) continue;
      if (ENTRY_FILES.has(name) || HOOK_FILE.test(name) || s.abs === entry || (name === "index" && roots.has(parent))) continue;
      const inFolder = basename(grand) === "_components" && PASCAL.test(basename(parent));
      const target = name === "index" ? basename(parent) : name;
      violations.push({
        file: s.rel,
        line: 0,
        message: inFolder
          ? `component file ${basename(s.abs)} in ${basename(parent)}/; a component folder renders one component from index.${ext}`
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
