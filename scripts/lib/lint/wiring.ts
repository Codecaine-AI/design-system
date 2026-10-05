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
 *   uses the preset @codecaine-ai/design-system/tailwind-v3-preset.
 * - A design-system stylesheet that does not resolve is a violation; another
 *   stylesheet that does not resolve (an alias, say) is a warning.
 */

import { dirname, join } from "node:path";
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

export function checkWiring(ctx: AppContext): CheckOutput {
  const { app } = ctx;
  const violations: Finding[] = [];
  const warnings: Finding[] = [];

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

  for (const u of graph.unresolved) {
    const isDs = graph.loads.some((l) => l.from === u.from && l.line === u.line && l.spec === u.spec);
    (isDs ? violations : warnings).push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve` });
  }

  const first = (...kinds: string[]) => graph.loads.find((l) => kinds.includes(l.kind));
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
  } else if (tw === "v3") {
    const appRoot = ctx.appRoot;
    const repoRoot = resolvePath(ctx.root, app.repo);
    const config = findTailwindConfig(appRoot, isInside(appRoot, repoRoot) ? repoRoot : appRoot);
    if (!config) violations.push({ file: app.root, line: 0, message: "Tailwind v3 app has no tailwind.config.* in the app root or above it in the repo" });
    else {
      const text = readText(config) ?? "";
      if (!text.includes(PRESET) || !/\bpresets\b/.test(text)) {
        violations.push({ file: ctx.rel(config), line: lineOf(text, "presets"), message: `does not use the preset: add presets: [require("${PRESET}")]` });
      }
    }
  }

  return { violations, warnings };
}
