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

import type { Load } from "./loads";
import { checkPreset } from "./tailwind-config";
import type { AppContext, CheckOutput, Finding } from "./types";

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
