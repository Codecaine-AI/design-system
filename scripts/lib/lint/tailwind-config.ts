/**
 * Tailwind v3: the app's tailwind.config.* (in the app root, else up to the repo root)
 * exports a config whose `presets` array holds the preset
 * @codecaine-ai/design-system/tailwind-v3-preset (`require(…)` or a binding of it).
 * Part of check 2 (wiring); wiring.ts calls checkPreset.
 */

import { dirname, join } from "node:path";
import { lexJs } from "../../scan-literals";
import { resolvePath } from "../registry";
import type { AppContext, Finding } from "./types";
import { isFile, isInside, lineOf, readText } from "./workspace";

const PRESET = "@codecaine-ai/design-system/tailwind-v3-preset";
export const TW_CONFIGS = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts", "tailwind.config.cts", "tailwind.config.mts"];

export function findTailwindConfig(start: string, stop: string): string | null {
  let dir = start;
  for (;;) {
    for (const n of TW_CONFIGS) if (isFile(join(dir, n))) return join(dir, n);
    if (dir === stop || !isInside(dir, stop)) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Index of the bracket closing the one at `open` (code characters only), or -1. */
function closeOf(text: string, inStr: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (inStr[i]) continue;
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") if (--depth === 0) return i;
  }
  return -1;
}

/** Top-level comma-separated parts of the bracket span (open, close). */
function topLevelParts(text: string, inStr: Uint8Array, open: number, close: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (inStr[i]) continue;
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start, close).trim());
  return parts.filter(Boolean);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * True when the config the file exports (`module.exports =`, `export default`, through a
 * `defineConfig(…)`-style wrapper or a `const config = …` binding) has a `presets` array that
 * holds the preset: `require("…preset")` or a name bound to it by `require` or `import`.
 */
export function exportsPreset(raw: string): boolean {
  const { text, inStr } = lexJs(raw); // comments blanked: a commented-out preset does not count
  const code = (i: number) => !inStr[i];
  const presetSpec = `(?<q>["'])${esc(PRESET)}\\k<q>`;
  const bindings = new Set<string>();
  for (const re of [
    new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*require\\(\\s*${presetSpec}\\s*\\)`, "g"),
    new RegExp(`(?<![\\w$.])import\\s+(?:\\*\\s+as\\s+)?([\\w$]+)\\s+from\\s+${presetSpec}`, "g"),
  ]) {
    for (const m of text.matchAll(re)) if (code(m.index!)) bindings.add(m[1]);
  }
  const isPreset = (part: string) => {
    const p = part.replace(/\.default$/, "").replace(/\s+as\s+[\w$.<>]+$/, "").trim();
    return new RegExp(`^require\\(\\s*${presetSpec}\\s*\\)$`).test(p) || bindings.has(p);
  };

  // The exported value: skip wrapper calls and follow one binding.
  const objectAt = (from: number, seen = 0): number => {
    let i = from;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] === "{") return i;
    if (text[i] === "(") return objectAt(i + 1, seen);
    const word = /^[\w$.]+/.exec(text.slice(i))?.[0];
    if (!word || seen > 3) return -1;
    let j = i + word.length;
    while (/\s/.test(text[j] ?? "")) j++;
    if (text[j] === "(") return objectAt(j + 1, seen + 1);
    const decl = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${esc(word)}\\s*(?::[^=]+)?=`, "g").exec(text);
    return decl && code(decl.index) ? objectAt(decl.index + decl[0].length, seen + 1) : -1;
  };
  for (const m of text.matchAll(/(?<![\w$.])(?:module\s*\.\s*exports\s*=|export\s+default\s+)/g)) {
    if (!code(m.index!)) continue;
    const open = objectAt(m.index! + m[0].length);
    if (open === -1) continue;
    const close = closeOf(text, inStr, open);
    if (close === -1) continue;
    const arrayHasPreset = (arrOpen: number) => {
      const arrClose = closeOf(text, inStr, arrOpen);
      return arrClose !== -1 && topLevelParts(text, inStr, arrOpen, arrClose).some(isPreset);
    };
    for (const part of topLevelParts(text, inStr, open, close)) {
      const at = text.indexOf(part, open);
      const kv = /^(["']?)presets\1\s*:\s*/.exec(part);
      if (kv && text[at + kv[0].length] === "[" && arrayHasPreset(at + kv[0].length)) return true;
      // `{ presets }` or `presets: list`: a binding to an array.
      const ref = part === "presets" ? "presets" : kv ? /^[\w$]+$/.exec(part.slice(kv[0].length).trim())?.[0] : undefined;
      if (ref) {
        const decl = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${esc(ref)}\\s*(?::[^=]+)?=\\s*\\[`, "g").exec(text);
        if (decl && code(decl.index) && arrayHasPreset(decl.index + decl[0].length - 1)) return true;
      }
    }
  }
  return false;
}

export function checkPreset(ctx: AppContext): Finding[] {
  const { app, appRoot } = ctx;
  const repoRoot = resolvePath(ctx.root, app.repo);
  const config = findTailwindConfig(appRoot, isInside(appRoot, repoRoot) ? repoRoot : appRoot);
  if (!config) return [{ file: app.root, line: 0, message: "Tailwind v3 app has no tailwind.config.* in the app root or above it in the repo" }];
  const raw = readText(config) ?? "";
  if (exportsPreset(raw)) return [];
  return [{ file: ctx.rel(config), line: lineOf(raw, "presets"), message: `does not use the preset: add presets: [require("${PRESET}")] to the exported config` }];
}
