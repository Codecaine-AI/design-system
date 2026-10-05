/**
 * Check 6, structure (guide/code-structure.md).
 *
 * Folder-standard apps (`folderStandard: true`):
 * - every `_components/` folder in the scan dirs holds only PascalCase folders,
 *   no loose files (dotfiles aside);
 * - every component folder has an `index.tsx` (`index.ts` in plain DOM apps);
 * - a PascalCase .tsx/.jsx file outside `_components/<Name>/index.tsx` is a component
 *   in the wrong place (`App.tsx` is an entry file and stays).
 * Every app: no source file (.ts .tsx .js .jsx .css in the scan dirs; tests,
 * generated and vendored files skipped) is over 400 lines. For libraries
 * (`kind: "library"`) over-400 files are warnings, not violations.
 */

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AppContext, CheckOutput, Finding } from "./types";
import { MAX_LINES } from "./types";
import { isDir, isFile } from "./workspace";

const LINE_EXTS = new Set(["ts", "tsx", "js", "jsx", "css"]);
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const INDEX_FILES = ["index.tsx", "index.ts", "index.jsx", "index.js"];
const ENTRY_COMPONENTS = new Set(["App"]);

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
    const componentDirs = new Set<string>();
    for (const s of sources) {
      const parts = s.abs.split("/");
      for (let i = parts.length - 2; i >= 0; i--) if (parts[i] === "_components") componentDirs.add(parts.slice(0, i + 1).join("/"));

      const ext = s.ext;
      const name = basename(s.abs).replace(/\.[^.]+$/, "");
      const parent = dirname(s.abs);
      // A loose file directly in _components/ is reported by the folder pass below.
      if ((ext === "tsx" || ext === "jsx") && PASCAL.test(name) && !ENTRY_COMPONENTS.has(name) && basename(parent) !== "_components") {
        const inFolder = basename(dirname(parent)) === "_components" && PASCAL.test(basename(parent));
        violations.push({
          file: s.rel,
          line: 0,
          message: inFolder
            ? `component file ${basename(s.abs)} in ${basename(parent)}/; a component folder renders one component from index.${ext}`
            : `component file outside _components/<Name>/index.${ext}; move it to _components/${name}/index.${ext}`,
        });
      }
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
