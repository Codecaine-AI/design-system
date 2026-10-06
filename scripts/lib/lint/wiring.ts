/**
 * Check 2, wiring: the entry stylesheet loads the design system in order.
 *
 * - @codecaine-ai/design-system/fonts.css, then tokens.css, then layout.css on shell
 *   apps (bundle order, across every stylesheet the entry reaches). Dark-first
 *   surfaces may load tokens-dark-first.css instead of tokens.css; light-dark apps
 *   may not.
 * - Fonts come from the design-system package only (decision 20):
 *   @codecaine-ai/text-measure's fonts.css does not count, and loading it is a
 *   violation at its line.
 * - host-contract.css is optional; when loaded it sits after the tokens and before
 *   layout.css, and its variant pairs with the tokens' (tokens-dark-first.css with
 *   host-contract-dark-first.css).
 * - Tailwind v4 compiles each stylesheet a JS module imports or a page links, and
 *   each <style> block, on its own (a compilation root, see loads.ts). One root must
 *   import Tailwind (`tailwindcss` or `tailwindcss/theme.css`), then
 *   tailwind-strict.css, then tailwind.css. In every root, strict comes after
 *   Tailwind, tailwind.css after strict, and no Tailwind import after strict (it
 *   restores Tailwind's default theme). Any other root that imports Tailwind without
 *   strict and tailwind.css after it compiles with Tailwind's default theme.
 * - Tailwind v3: tailwind.config.* (in the app root, else up to the repo root)
 *   exports a config whose `presets` array holds the preset
 *   @codecaine-ai/design-system/tailwind-v3-preset (`require(…)` or a binding of it).
 * - A design-system stylesheet loaded under a media query or supports condition
 *   (`@import "…/tokens.css" print`, `<link media="print">`) does not apply to every
 *   view. It is a violation when no unconditional load of the same kind exists
 *   (tokens.css and tokens-dark-first.css count as one kind; so do the two
 *   host-contract variants).
 * - A design-system @import after a rule is ignored (loads.ts `inert`): a violation.
 * - A design-system stylesheet that does not resolve is a violation, and so is any
 *   stylesheet the entry HTML page links itself; another stylesheet that does not
 *   resolve (an alias, say) is a warning.
 */

import { isDsLoad, isTailwindLoad, type Load, type LoadKind } from "./loads";
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
};

const DS_FONTS = "@codecaine-ai/design-system/fonts.css";

/** Kinds that stand in for each other: a conditional load is fine when the group has an unconditional one. */
const group = (kind: LoadKind) => (kind === "tokens-dark-first" ? "tokens" : kind === "host-contract-dark-first" ? "host-contract" : kind);

/** Tailwind's full import or its default theme: what tailwind-strict.css must follow. */
const isTailwindTheme = (l: Load) => l.kind === "tailwindcss" || l.kind === "tailwindcss-theme";
/** A Tailwind specifier as the author wrote it, quoted. */
const twName = (l: Load) => `"${l.spec.replace(/[?#].*$/, "")}"`;

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
  const loc = (l: Load) => `${ctx.rel(l.from)}:${l.line}`;

  const entryIsPage = /\.(?:html?)$/i.test(graph.entry!);
  for (const u of graph.unresolved) {
    const isDs = graph.loads.some((l) => isDsLoad(l) && l.from === u.from && l.line === u.line && l.spec === u.spec);
    if (isDs) violations.push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve` });
    else if (entryIsPage && u.from === graph.entry) {
      violations.push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve; the entry page links it, so the page loads no styles from it` });
    } else warnings.push({ file: ctx.rel(u.from), line: u.line, message: `${u.spec} does not resolve` });
  }

  for (const l of graph.inert) {
    if (!isDsLoad(l)) continue;
    violations.push({ ...at(l), message: `${l.spec} comes after a rule, so it is ignored; move the @import above the first rule` });
  }

  const unconditional = new Set(graph.loads.filter((l) => isDsLoad(l) && !l.condition).map((l) => group(l.kind)));
  for (const l of graph.loads) {
    if (!l.condition || !isDsLoad(l) || unconditional.has(group(l.kind))) continue;
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
  // Decision 20: text-measure's copy of the fonts does not count. Its violation names the fix, so it
  // replaces the "does not load fonts.css" one.
  const tmFonts = [...graph.loads, ...graph.inert].filter((l) => l.kind === "text-measure-fonts");
  for (const l of tmFonts) {
    violations.push({
      ...at(l),
      message: fonts
        ? `@codecaine-ai/text-measure/fonts.css loads the fonts a second time; ${DS_FONTS} (${loc(fonts)}) already does, so remove it (decision 20)`
        : `@codecaine-ai/text-measure/fonts.css does not count as the fonts: load ${DS_FONTS} (decision 20)`,
    });
  }
  if (!fonts && !tmFonts.length) violations.push({ file: entryRel, line: 1, message: `does not load fonts.css: load ${DS_FONTS} (decision 20) before the tokens` });
  if (!tokens) {
    violations.push({ file: entryRel, line: 1, message: `does not load @codecaine-ai/design-system/${darkFirst ? "tokens.css or tokens-dark-first.css" : "tokens.css"}` });
  }
  const before = (a: Load | undefined, b: Load | undefined) => (a && b ? graph.loads.indexOf(a) < graph.loads.indexOf(b) : true);
  if (fonts && tokens && !before(fonts, tokens)) {
    violations.push({ ...at(fonts), message: `fonts.css loads after ${NAMES[tokens.kind]} (${loc(tokens)}); load the fonts first` });
  }
  if (app.shell) {
    if (!layout) violations.push({ file: entryRel, line: 1, message: "shell app does not load @codecaine-ai/design-system/layout.css" });
    else if (tokens && !before(tokens, layout)) {
      violations.push({ ...at(layout), message: `layout.css loads before ${NAMES[tokens.kind]} (${loc(tokens)}); load it after the tokens` });
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
      violations.push({ ...at(host), message: `${NAMES[host.kind]} loads before ${NAMES[tokens.kind]} (${loc(tokens)}); load it after the tokens` });
    }
    if (layout && !before(host, layout)) {
      violations.push({ ...at(host), message: `${NAMES[host.kind]} loads after layout.css (${loc(layout)}); load it before layout.css` });
    }
  }

  if ((app.stack?.tailwind ?? "none") === "v4") violations.push(...tailwindV4(ctx, graph.loads, entryRel));

  return { violations, warnings };
}

/** Tailwind v4: Tailwind, tailwind-strict.css and tailwind.css in order, in one compilation root. */
function tailwindV4(ctx: AppContext, loads: Load[], entryRel: string): Finding[] {
  const out: Finding[] = [];
  const at = (l: Load) => ({ file: ctx.rel(l.from), line: l.line });
  const loc = (l: Load) => `${ctx.rel(l.from)}:${l.line}`;
  const rootName = (id: string) => {
    const hash = id.lastIndexOf("#style");
    return hash === -1 ? ctx.rel(id) : `${ctx.rel(id.slice(0, hash))}${id.slice(hash)}`;
  };
  const live = loads.filter((l) => !l.condition);
  const strict = live.find((l) => l.kind === "tw-strict");
  const theme = live.find((l) => l.kind === "tw-theme");
  const tailwind = live.find(isTailwindTheme);
  if (!strict) out.push({ file: entryRel, line: 1, message: "Tailwind v4 app does not import @codecaine-ai/design-system/tailwind-strict.css" });
  if (!theme) out.push({ file: entryRel, line: 1, message: "Tailwind v4 app does not import @codecaine-ai/design-system/tailwind.css" });

  const roots = new Map<string, Load[]>();
  for (const l of live) {
    if (!isTailwindLoad(l) && l.kind !== "tw-strict" && l.kind !== "tw-theme") continue;
    if (!roots.has(l.root)) roots.set(l.root, []);
    roots.get(l.root)!.push(l);
  }
  let good: string | null = null;
  let misordered = false;
  /** The first Tailwind import of each root that has no strict and tailwind.css after its last one. */
  const unfinished: Load[] = [];
  for (const [id, ls] of roots) {
    const tws = ls.filter(isTailwindTheme);
    const s = ls.find((l) => l.kind === "tw-strict");
    const d = ls.find((l) => l.kind === "tw-theme");
    if (s && d && ls.indexOf(d) < ls.indexOf(s)) {
      misordered = true;
      out.push({ ...at(s), message: `tailwind-strict.css loads after tailwind.css (${loc(d)}); after it, strict clears the design-system keys` });
    }
    const afterStrict = s ? tws.find((t) => ls.indexOf(t) > ls.indexOf(s)) : undefined;
    if (s && afterStrict) {
      misordered = true;
      if (tws[0] === afterStrict) {
        out.push({ ...at(s), message: `tailwind-strict.css loads before ${twName(afterStrict)} (${loc(afterStrict)}); Tailwind's defaults would come back` });
      } else {
        out.push({ ...at(afterStrict), message: `${twName(afterStrict)} loads after tailwind-strict.css (${loc(s)}); it restores Tailwind's default theme` });
      }
    }
    if (!tws.length) continue;
    const last = ls.indexOf(tws[tws.length - 1]);
    const s2 = ls.findIndex((l, i) => i > last && l.kind === "tw-strict");
    const done = s2 !== -1 && ls.some((l, i) => i > s2 && l.kind === "tw-theme");
    if (done) good ??= id;
    else unfinished.push(tws[0]);
  }

  if (good) {
    for (const t of unfinished) {
      out.push({
        ...at(t),
        message: `${twName(t)} starts its own Tailwind compilation (${rootName(t.root)}) without tailwind-strict.css and tailwind.css after it, so Tailwind's default theme applies there; import them after it, as ${rootName(good)} does`,
      });
    }
  } else if (!misordered && strict && theme) {
    if (!tailwind) {
      out.push({ file: entryRel, line: 1, message: 'Tailwind v4 app does not import "tailwindcss": @import it before tailwind-strict.css and tailwind.css, in the same stylesheet' });
    } else {
      out.push({
        ...at(tailwind),
        message: `tailwindcss, tailwind-strict.css and tailwind.css are compiled as separate stylesheets (${loc(tailwind)}, ${loc(strict)}, ${loc(theme)}); @import all three, in that order, in one stylesheet`,
      });
    }
  }
  return out;
}
