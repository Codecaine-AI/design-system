/**
 * Check 2, wiring: the entry stylesheet loads the design system in order.
 *
 * - fonts.css (the design system's, or @codecaine-ai/text-measure's), then
 *   tokens.css, then layout.css on shell apps. Dark-first surfaces may load
 *   tokens-dark-first.css instead of tokens.css; light-dark apps may not.
 * - host-contract.css is optional; when loaded it sits after the tokens and before
 *   layout.css, and its variant pairs with the tokens' (tokens-dark-first.css with
 *   host-contract-dark-first.css).
 * - Tailwind v4: tailwind-strict.css after `tailwindcss` and before tailwind.css.
 * - Tailwind v3: tailwind.config.* (in the app root, else up to the repo root)
 *   exports a config whose `presets` array holds the preset
 *   @codecaine-ai/design-system/tailwind-v3-preset (`require(…)` or a binding of it).
 * - A design-system stylesheet loaded under a media query or supports condition
 *   (`@import "…/tokens.css" print`, `<link media="print">`) does not count: it does
 *   not apply to every view. Each one is a violation.
 * - A design-system stylesheet that does not resolve is a violation, and so is any
 *   stylesheet the entry HTML page links itself; another stylesheet that does not
 *   resolve (an alias, say) is a warning.
 */

import { dirname, join } from "node:path";
import { lexJs } from "../../scan-literals";
import { resolvePath } from "../registry";
import type { Load } from "./loads";
import type { AppContext, CheckOutput, Finding } from "./types";
import { isFile, isInside, lineOf, readText } from "./workspace";

const PRESET = "@codecaine-ai/design-system/tailwind-v3-preset";
const TW_CONFIGS = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts", "tailwind.config.cts", "tailwind.config.mts"];

const NAMES: Record<string, string> = {
  fonts: "fonts.css",
  tokens: "tokens.css",
  "tokens-dark-first": "tokens-dark-first.css",
  "host-contract": "host-contract.css",
  "host-contract-dark-first": "host-contract-dark-first.css",
  layout: "layout.css",
  "tw-strict": "tailwind-strict.css",
  "tw-theme": "tailwind.css",
  tailwindcss: '"tailwindcss"',
};

function findTailwindConfig(start: string, stop: string): string | null {
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

function checkPreset(ctx: AppContext): Finding[] {
  const { app, appRoot } = ctx;
  const repoRoot = resolvePath(ctx.root, app.repo);
  const config = findTailwindConfig(appRoot, isInside(appRoot, repoRoot) ? repoRoot : appRoot);
  if (!config) return [{ file: app.root, line: 0, message: "Tailwind v3 app has no tailwind.config.* in the app root or above it in the repo" }];
  const raw = readText(config) ?? "";
  if (exportsPreset(raw)) return [];
  return [{ file: ctx.rel(config), line: lineOf(raw, "presets"), message: `does not use the preset: add presets: [require("${PRESET}")] to the exported config` }];
}

export function checkWiring(ctx: AppContext): CheckOutput {
  const { app } = ctx;
  const violations: Finding[] = [];
  const warnings: Finding[] = [];

  // Tailwind v3 reads its preset from the config, whatever the entry stylesheet does.
  if ((app.stack?.tailwind ?? "none") === "v3") violations.push(...checkPreset(ctx));

  if (!app.entryStylesheet) {
    violations.push({ file: app.root, line: 0, message: "apps.json gives no entryStylesheet to check" });
    return { violations, warnings };
  }
  const graph = ctx.loads();
  if (!graph.entryExists) {
    violations.push({ file: app.entryStylesheet, line: 0, message: "entry stylesheet not found" });
    return { violations, warnings };
  }
  const entryRel = ctx.rel(graph.entry!);
  const at = (l: Load) => ({ file: ctx.rel(l.from), line: l.line });

  const entryIsPage = /\.(?:html?)$/i.test(graph.entry!);
  for (const u of graph.unresolved) {
    const isDs = graph.loads.some((l) => l.from === u.from && l.line === u.line && l.spec === u.spec);
    if (isDs) violations.push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve` });
    else if (entryIsPage && u.from === graph.entry) {
      violations.push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve; the entry page links it, so the page loads no styles from it` });
    } else warnings.push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve` });
  }

  for (const l of graph.loads) {
    if (!l.condition || l.kind === "tailwindcss") continue;
    violations.push({ ...at(l), message: `${l.spec} loads only under "${l.condition}", so it does not apply to every view; load it without a media or supports condition` });
  }

  const first = (...kinds: string[]) => graph.loads.find((l) => kinds.includes(l.kind) && !l.condition);
  const fonts = first("fonts");
  const darkFirst = app.theme?.rule === "dark-first";
  const tokens = darkFirst ? first("tokens", "tokens-dark-first") : first("tokens");
  const layout = first("layout");

  if (!darkFirst) {
    const df = first("tokens-dark-first");
    if (df) violations.push({ ...at(df), message: "loads tokens-dark-first.css, which is for dark-first surfaces; this app's theme rule is light-dark (load tokens.css)" });
  }
  if (!fonts) violations.push({ file: entryRel, line: 1, message: "does not load fonts.css (@codecaine-ai/design-system/fonts.css) before the tokens" });
  if (!tokens) {
    violations.push({ file: entryRel, line: 1, message: `does not load @codecaine-ai/design-system/${darkFirst ? "tokens.css or tokens-dark-first.css" : "tokens.css"}` });
  }
  const before = (a: Load | undefined, b: Load | undefined) => (a && b ? graph.loads.indexOf(a) < graph.loads.indexOf(b) : true);
  if (fonts && tokens && !before(fonts, tokens)) {
    violations.push({ ...at(fonts), message: `fonts.css loads after ${NAMES[tokens.kind]} (${ctx.rel(tokens.from)}:${tokens.line}); load the fonts first` });
  }
  if (app.shell) {
    if (!layout) violations.push({ file: entryRel, line: 1, message: "shell app does not load @codecaine-ai/design-system/layout.css" });
    else if (tokens && !before(tokens, layout)) {
      violations.push({ ...at(layout), message: `layout.css loads before ${NAMES[tokens.kind]} (${ctx.rel(tokens.from)}:${tokens.line}); load it after the tokens` });
    }
  }

  const host = first("host-contract", "host-contract-dark-first");
  if (host) {
    const hostDark = host.kind === "host-contract-dark-first";
    if (hostDark && !darkFirst) {
      violations.push({ ...at(host), message: "loads host-contract-dark-first.css, which is for dark-first surfaces; this app's theme rule is light-dark (load host-contract.css)" });
    } else if (tokens && hostDark !== (tokens.kind === "tokens-dark-first")) {
      violations.push({ ...at(host), message: `loads ${NAMES[host.kind]} with ${NAMES[tokens.kind]}; pair the variants (tokens-dark-first.css with host-contract-dark-first.css)` });
    }
    if (tokens && !before(tokens, host)) {
      violations.push({ ...at(host), message: `${NAMES[host.kind]} loads before ${NAMES[tokens.kind]} (${ctx.rel(tokens.from)}:${tokens.line}); load it after the tokens` });
    }
    if (layout && !before(host, layout)) {
      violations.push({ ...at(host), message: `${NAMES[host.kind]} loads after layout.css (${ctx.rel(layout.from)}:${layout.line}); load it before layout.css` });
    }
  }

  const tw = app.stack?.tailwind ?? "none";
  if (tw === "v4") {
    const strict = first("tw-strict");
    const theme = first("tw-theme");
    const base = first("tailwindcss");
    if (!strict) violations.push({ file: entryRel, line: 1, message: "Tailwind v4 app does not import @codecaine-ai/design-system/tailwind-strict.css" });
    if (!theme) violations.push({ file: entryRel, line: 1, message: "Tailwind v4 app does not import @codecaine-ai/design-system/tailwind.css" });
    if (strict && theme && !before(strict, theme)) {
      violations.push({ ...at(strict), message: `tailwind-strict.css loads after tailwind.css (${ctx.rel(theme.from)}:${theme.line}); after it, strict clears the design-system keys` });
    }
    if (strict && base && !before(base, strict)) {
      violations.push({ ...at(strict), message: `tailwind-strict.css loads before "tailwindcss" (${ctx.rel(base.from)}:${base.line}); Tailwind's defaults would come back` });
    }
  }

  return { violations, warnings };
}
