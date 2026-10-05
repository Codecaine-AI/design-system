# docs-system → design-system literal mapping

Phase 2 migrates docs-system onto `@codecaine-ai/design-system` with 0 changed pixels. This file lists every color and design-value literal in the seed files and the token variable that reproduces it exactly, so the migration is a mechanical find-and-replace.

- Seed root: `/Users/Ford/workspace/codecaine/core/docs-system/` (paths below are relative to it).
- Token names: `dist/css/tokens.css`. Resolved values: `dist/json/{base,light,dark}.json`. Every theme token exists three ways: `--ds-<path>` (follows `data-theme`), `--ds-light-<path>` and `--ds-dark-<path>` (pinned).
- `local` means no token reproduces the literal exactly, or the literal is not a design token. The note says which, and the nearest token when there is one.
- "fallback" marks a literal inside a `var(--x, literal)` fallback. Two kinds behave differently:
  - Fallbacks of token-layer variables (`--docs-*` declared in `semantic.css`, `--palette-*`, `--color-*`) never paint in docs-system, because the variable is always defined.
  - Fallbacks of style-rail variables (`--style-*`, `--docs-grip-*`, `--docs-highlight-*`, `--docs-dropcursor-*`, `--docs-scrollbar-*`, `--docs-list-*`) DO paint: the rail leaves them unset at stock, so the fallback is the stock value. Notes call these "rail stock default".

## Decisions that matter for phase 2

1. **Map the palette tier, keep the role formulas.** Replace the literals in `notion-palette.css` (and the literal colors in `semantic.css`'s theme blocks) with pinned variables: `--ds-light-*` inside the light blocks, `--ds-dark-*` inside the dark blocks. Never use an unqualified `--ds-*` inside docs-system's theme blocks: the dark blocks also style the dark code-panel island (`[data-code-panels="dark"] [data-code-surface]`) on a light page, where the unqualified variable holds the light value. Keep the role-token block (`semantic.css` 1279-1354) as formulas over `--palette-*`. The island overrides `--palette-page`, `--palette-panel`, `--palette-rule` and `--palette-rule-soft` (notion-palette.css 212-219), so 25 role values legitimately differ inside code panels (every `-line`, `--docs-hover`, `--docs-sunken`, `--docs-guide`, `--docs-border-strong`, `--docs-diff-*-bg`). Pointing those roles at ds variables would repaint every code panel.
2. **Values are already identical; proven in Chromium.** For 180 docs-system color variables, light and dark, the computed color equals the token's, through both the unqualified and the pinned variable: 898 checks, 0 mismatches (method in the appendix). Inside the island only the 25 island-relative roles from decision 1 differ, as designed. Re-run the check after any token edit during phase 2.
3. **Runtime layers re-apply literal copies of the defaults and will shadow tokens after migration.** Pixel parity holds (the copies equal the tokens), but a later token change will not show until these are cleared. Details in [Runtime layers](#runtime-layers-that-re-apply-defaults). The two that matter most:
   - The live Global theme (`~/.local/state/codecaine-docs/themes/global/theme.json`, read-only here) pins `colors.background #fdfdfd`, `sidebar #f9f9f9`, `text #2a2a2a`. `pageColorOverrideCss` writes them onto `--background`, `--card`, `--popover`, `--sidebar`, `--foreground` and the text vars at (0,3,0) on the light page, above anything `semantic.css` declares.
   - The active code theme (`cursor-dark-plus`) writes `--syntax-*` and `--docs-code-*` into code panes at (0,4,0)+. Its chrome differs from `semantic.css` (border `#303031` vs `#3C3C3C`, header `#C6C6C6` vs `#CCCCCC`, rule `#404040`, selection `#264F78`), so code panes paint the code theme's values, and `color.code.*` only paints when no code theme loads (static export, fetch failure).
4. **Unit and alpha equivalences used here are pixel-safe.** docs-system never sets the root font size, so `rem` maps to `px` at 16px (`0.75rem` → `--ds-font-size-ui-xs`). `999px` and `9999px` radii render identically (CSS clamps radii to half the box). Translucent colors were converted to `#rrggbbaa` only where the alpha is exact in 8 bits (0.2 → `33`, 0.4 → `66`); every other alpha stays `rgba()` in the tokens, so pills, glass and annotation washes stay bit-identical.
5. **Import `tokens.css` only; keep docs-system's own Tailwind bridge.** `dist/tailwind/theme.css` maps `rounded-*`, `font-sans` and `font-mono` straight to `--ds-*`, but docs-system's style rail rewrites `--radius`, `--font-tx02` and `--docs-font-code` at runtime, and its shadcn bridge already owns `--color-accent` and `--color-sidebar`. Importing the ds Tailwind theme would kill those rail knobs and collide on those keys. In phase 2, point docs-system's own `--radius`, `--font-tx02`, `--font-display`, `--docs-font-code`, `--style-code-width` and `--style-wide-width` at `var(--ds-…)` instead.

Smaller decisions, for reference:

- `--ds-color-fill-hover` is `--docs-hover` (table, tree, disclosure and media rows). `--ds-color-fill-active` is `--muted` (the sidebar's selected row). The docs sidebar's nav hover is `bg-muted/50`, half of fill-active mixed in oklab, not fill-hover. It stays a docs-local utility in phase 2.
- docs-system has two warning tones: the shadcn bridge's `--status-warning` is orange; the callout tone `--docs-tone-warning` is amber text over yellow fills. `--ds-color-status-warning-*` follows the callout tone. Map `--status-warning*` to the orange hue tokens, not to status-warning.
- `--palette-nav` (`#ebeced` / `#212830`) only feeds `--sidebar-accent`, which no component reads. It stays local; delete it later.
- Light `--palette-inset` does not exist in docs-system; `--ds-color-surface-inset` aliases the sidebar color in both themes. docs-system only reads it on the dark page.
- Reading size: the tokens use docs-system's stock values, `--ds-font-size-reading` 18px and `--ds-line-height-reading` 1.45 (`read-surface.css`, `DEFAULT_STYLE_RAIL_SETTINGS`, the repo's `themes/default`). The live Global theme overrides them through the rail to 16px / 1.6, and its `components/structured-table.json` sets the table text to 13px (stock 13.5px) and a 2.5px header rule. Screenshots of the live app show the overrides. Parity is unaffected either way, because the rail and theme layers still win. Decide which is canonical before other apps adopt `text-reading`.

## Literals that stay local

Per-file details are in each file's "Stays local" list. By reason:

1. **Role formulas** (`semantic.css` 1279-1354 and their mix percentages): they re-resolve inside the dark code-panel island. See decision 1.
2. **One component's knobs**: unitless multipliers (heading sizes 1.875 / 1.25, inline-code 0.85 / 0.35 / 0.1, divider spacing 2), percent knobs (link wash 14 / 12, change tint 8, select tint 15) and opacities (code rule 0.5, drag 0.3, drop line 0.9, drag-select 0.12). They tune one block, not the shared look.
3. **Off-scale metrics**: callout padding-x 14px, interaction header padding-y 9px, row padding 5px, table selection padding 3px, notes column 280px, sequence max height 420px, action pane 520px, field-name column 24ch, the page's left rail 88px, and the style rail's own sizes (13rem nav, 9.5rem select, 30x17px toggle, 15px heading). The nearest token would move pixels.
4. **Third-party and host defaults**: the `@codecaine-ai/sequence` diagram colors (light-on-white in both modes), the hljs fallbacks in `code.css` (old 5-token contract), the host-fallback palette in `docs-publish/src/editor.css`, the publish diagram chrome (`#fff`, `#ccc`, `#222`), and the export dialog's `system-ui` font and `#c33` error text.
5. **Effect internals**: the grain layer's `#fff` fill, the island's hairline mixes toward `#ffffff`, the header strip's `currentColor` mix.
6. **Unused**: `--palette-nav`, `--palette-soft-t`, `--font-tx02-semicondensed`, `--font-tx02-condensed`. Delete later.
7. **Runtime timings** that are style-rail knob defaults: page fade 80ms / 120ms, peek 300ms, highlight flash 2s, annotate breathe 0.72s / 2.6s.

## Runtime layers that re-apply defaults

These layers write values at runtime, above `semantic.css`. Most write literal copies of the stock values, so parity holds today, but after the migration a token change will not show where one of them still writes its own copy.

### Live state on this machine (read-only in phase 1)

| Layer | What it writes today | Phase 2 action |
| --- | --- | --- |
| `~/.local/state/codecaine-docs/themes/global/theme.json` `railDefaults.colors`: background `#fdfdfd`, sidebar `#f9f9f9`, text `#2a2a2a` | Through `pageColorOverrideCss` (code path 4 below): `--background`, `--card`, `--popover`, `--sidebar`, `--foreground`, `--card-foreground`, `--popover-foreground`, `--sidebar-foreground`, `--docs-viewer-text-body`, `--docs-viewer-text-heading` at (0,3,0) on the light page. The picks equal the stock tokens, so they only shadow. | Keep for parity. Afterwards set the three picks to `null`, so the light page, sidebar and text follow `--ds-light-color-surface-page`, `-surface-sidebar` and `-text-body`. |
| Same file, `railDefaults.typography`: `fontSize` 16, `lineHeight` 1.6; `grain.enabled` false; `blockLayout` widths for file-tree (1100px), structured-table (860px), code (920px) | `--style-font-size: 16px` and `--style-line-height: 1.6` inline on `<html>`, `--docs-grain-opacity: 0`, lane rules | Keep. Decide whether 16px / 1.6 or the stock 18px / 1.45 is the canonical reading size (see the decisions above). |
| `~/.local/state/codecaine-docs/themes/global/components/structured-table.json` (`fontSize` 13px, `headerRuleWidth` 2.5px, `headerRuleOpacity` 0.6, `rowRuleWidth` 1px, `headerWeight` 500) and `surfaces.json` (`radius` 2px) | Through `compileThemeCss` (code path 1): `--docs-table-*` and `--radius` in both theme blocks | Keep. `radius` 2px equals `--ds-radius-base`; drop it from `surfaces.json` later so a radius token change shows. |
| `~/.local/state/codecaine-docs/code-themes/active.json` → `cursor-dark-plus.json` (Dark+: border `#303031`, header `#C6C6C6`, rule `#404040`, selection `#264F78`) | Through `codeThemeStyleCss` (code path 6): `--syntax-*` and `--docs-code-*` in every code pane at (0,4,0) and up | Keep: code panes follow the editor theme the user imported. `color.syntax.*` and `color.code.*` paint only when no code theme loads. |

### Code paths

Specificity key: an inline `style` attribute beats every stylesheet rule on that element; `:root` and one attribute are (0,1,0) each. tokens.css switches unqualified --ds-* only on `[data-theme="dark"], .dark` (tokens.css:635), never inside the dark code-panel island.

1. **compileThemeCss** (`packages/docs-workbench/web/src/theme/theme-folders.ts:2233-2261`, injected by applyThemeCss 2266-2278 from App.tsx:355 / 405 / 435, and baked into the published head by `packages/docs-publish/src/theme-head.ts:44`)
   - Writes: theme.json `fonts` stacks (2248-2253) onto FONT_VARS (2115-2120): body -> --font-tx02; heading -> --font-display + --style-heading-font; code -> --docs-font-code; number -> --docs-font-numeric. The repo Default theme (`themes/default/theme.json:4-6`) holds literal copies of the stock stacks (Inter, Inter, IBM Plex Mono) that `theme/read-surface.css:39-48` `:root` already declares (--font-display 40, --font-tx02 41, --docs-font-code 47; --style-heading-font has no stylesheet declaration, its consumers fall back to --font-tx02). The same blocks carry every component token value verbatim (2236-2246): the classic theme writes stock-equal literals (`components/process-outline.json:2` stroke 1.5px, `:8` rootTextSize 13.5px, `:10` branchWeight 600, `:11` stepWeight 400, `:12` emptyTextSize 12px, `:15` noteInset 0px, `:20` noteAccent 0, `components/code.json:3` zebraOpacity 1).
   - Specificity: `:root, [data-theme="light"]` (0,1,0) (2255) and `[data-theme="dark"]` (0,1,0) / `[data-code-panels="dark"] [data-code-surface]` (0,2,0) (2230, 2259). It ties semantic.css and read-surface.css, and wins by order: the `<style id="docs-theme-folder-css">` is appended to `<head>` after the bundled sheets.
   - Phase 2: rewrite `themes/default/theme.json` `fonts` to `var(--ds-font-family-sans)` / `var(--ds-font-family-sans)` / `var(--ds-font-family-mono)`, or delete the block because it equals stock. compileThemeCss writes strings verbatim and readThemeDefinition only needs a non-empty string (2149-2150). Do the same for the classic stock-equal component keys listed above: delete them, or write the var. Otherwise the literal shadows a re-pointed read-surface.css / semantic.css.

2. **styleRailVars unconditional emission** (`packages/docs-workbench/web/src/shell/style-rail-settings.ts:1035-1037`, plus 1087 and 1091-1097)
   - Writes: `--docs-page-transition-type: fade`, `--docs-page-fade-out: 80ms`, `--docs-page-fade-in: 120ms` with no stock check. The same applies to `--docs-grain-opacity: 0.15`, `--docs-grain-blend-mode: var(--docs-grain-auto-blend)`, `--docs-grain-boost: var(--docs-grain-auto-boost)` and `--style-soften-font-glow` / `-icon-blur` / `-icon-glow` / `-icon-opacity` (0.16000000000000003px / 0.064px / 0.192px / 0.968 at stock, float artifact included). They land in three places: inline on `<html>` (applyStyleRailVars, `packages/docs-workbench/web/src/shell/StyleRail.tsx:147-151`, called from App.tsx:584), the dark-panel restatement (layer 5), and the static head `:root {}` (style-rail-settings.ts:1261-1264).
   - Specificity: inline style on `<html>`; (0,3,0) on dark panels; (0,1,0) in the published head.
   - Phase 2: keep. No ds token equals 80ms or 120ms (nearest --ds-motion-duration-fast 100ms), and grain and soften have no tokens, so nothing is shadowed today. The consumers carry the same 80ms / 120ms as var() fallbacks (docs-viewer `components/disclosure.tsx:28-30`, `transitions/PageTransition.tsx:17`). If page-transition durations are ever tokenized, first add the stock null-check the other knobs use (`=== d.transition.fadeOutMs ? null : …`). Without it, the inline copy shadows the token.

3. **Repo BASELINE differs from STOCK** (`style-rail-settings.ts:854-1104` compare against DEFAULT_STYLE_RAIL_SETTINGS, line 855; setStyleRailBaseline 425-429 installs theme.json `railDefaults` from App.tsx:360 / 409 / 441 / 522; `blockLayoutOverrideCss` 1220-1247)
   - Writes: `themes/default/theme.json` equals stock on every styleRailVars knob, so it emits nothing from styleRailVars. Its one divergence is `blockLayout["state-shape"]` (theme.json:112-115). blockLayoutOverrideCss turns it into `[data-doc-lane][data-doc-block-type="state-shape"] { max-width: 1120px; --docs-pane-split: 48%; }` (0,2,0) in `<style id="docs-style-rail-block-layout">` and in the published head. No token applies: 1120px is not --ds-layout-lane-wide 1100px. `themes/docs-system-classic/theme.json`, when selected, emits 32 off-stock vars, checked by running styleRailVars on the file: 31 inline (--style-font-size 16px, --style-line-height 1.5, --style-content-width 88ch, --radius 4px, --docs-dropcursor-width 6px, --docs-ref-color #262626, …) plus --sidebar through layer 4. Its codeFont "mono" also emits --docs-font-code as the FONT_STACKS.mono literal stack.
   - Specificity: inline on `<html>`; (0,3,0) restated on dark panels; (0,1,0) in the published head.
   - Phase 2: keep, because these only fire off-stock and are deliberate theme overrides. Two requirements:
     - Keep DEFAULT_STYLE_RAIL_SETTINGS (307-387) equal to the token values: 18 = --ds-font-size-reading, 1.45, 60ch, 88ch, 1100px, radius 2, padding 24 / 20 / 24, and so on. Emission is decided by `=== d.*`, so a token that moves without its stock constant makes a knob at the old value emit a literal that shadows the token.
     - Point FONT_STACKS (596-599) at `var(--ds-font-family-sans|serif|mono-system|mono)`. Every off-stock font emission then follows the token instead of copying the stack. Base tokens are theme-independent, so this is safe on dark panels too.

4. **pageColorOverrideCss** (`style-rail-settings.ts:1176-1180`, PAGE_COLOR_VARS 1111-1122, written to `<style id="docs-style-rail-page-colors">` by StyleRail.tsx:154 and to the published head)
   - Writes: --background, --card, --popover, --sidebar, --foreground, --card-foreground, --popover-foreground, --sidebar-foreground, --docs-viewer-text-body, --docs-viewer-text-heading. These are color picks (literal hex from `settings.colors`, for example a Global theme pinning its page) and tint mixes over `var(--color-bg-default)` / `var(--color-bg-sidebar)` / `var(--color-bg-gray)` (875, 883, 890). Both repo themes have null picks. The default theme also has both tints at 0, so its rules are empty. The classic theme's sidebarTint 10 writes `--sidebar: color-mix(in srgb, var(--color-bg-sidebar) 90%, var(--color-bg-gray) 10%)` into both rules.
   - Specificity: light rule `:root:not(.dark):not([data-theme="dark"])` (0,3,0), picks and tints. Dark rule `:root.dark, :root[data-theme="dark"]` (0,2,0), tints only (NO_COLOR_PICKS). Both outrank the (0,1,0) theme blocks. Neither reaches a dark code panel.
   - Phase 2: keep, because it fires only on a pick or tint. A pick always shadows --ds-light-color-surface-* by design. A pick that equals the stock token value should be cleared to null so the token answers. The tint bases may become the unqualified --ds-color-notion-bg-* (both rules sit on `:root`).

5. **codePanelOverrideCss** (`style-rail-settings.ts:1141-1148`, written to `<style id="docs-style-rail-code-panels">` by StyleRail.tsx:155 and to the published head)
   - Writes: every non-null rail var except PAGE_COLOR_VARS, restated on each dark code panel. At stock that is only the layer-2 set. Off-stock it adds --radius, `--accent: var(--color-bg-<family>)`, `--border: color-mix(in srgb, var(--color-pill-default) …)`, the component overrides, and so on.
   - Specificity: `:root[data-code-panels="dark"] [data-code-surface]` (0,3,0). That beats the (0,2,0) island blocks of semantic.css, notion-palette.css and compileThemeCss.
   - Phase 2: keep, because its var()/color-mix expressions must re-resolve against the island's dark palette. Do NOT rewrite the `var(--color-*)` references it carries (860-862, 868-869) to unqualified --ds-color-notion-*. Inside the island unqualified --ds-* keeps its light value, so dark panels on the light page would turn light. Either keep `--color-*` and re-point notion-palette.css per scope to --ds-light-* / --ds-dark-*, or first add an island block that re-points unqualified --ds-* at --ds-dark-*.

6. **code-theme-style.ts** (`packages/docs-workbench/web/src/theme/code-theme-style.ts:66-77`, applyCodeThemeStyle 80-89 from App.tsx:601)
   - Writes: the active code theme's `codeThemeCssVars` (`packages/docs-model/src/code-theme/css-vars.ts:34-49`). That is --syntax-<role> x 15, --syntax-<role>-font-style / -font-weight, --docs-code-block-bg, --docs-code-fg, --docs-code-gutter-fg, --docs-code-gutter-bg, --docs-code-block-border, --docs-code-selection, --docs-code-header-fg, --docs-code-lang-fg and --docs-code-rule. On the dark page with dark panels it also writes DARK_PAGE_PANEL_VARS (52-56). The default active theme is DARK_PLUS_CODE_THEME (`packages/docs-model/src/code-theme/code-theme.ts:140-175`; `packages/docs-server/src/code-themes.ts:39` DEFAULT_ACTIVE_CODE_THEME_ID):
     - Equal to --ds-dark-*: the 15 syntax roles, bg / gutter-bg #1E1E1E, gutter-fg #858585.
     - Different from the tokens: border #303031 (--ds-dark-color-code-border is #3c3c3c) and headerForeground #C6C6C6 (--ds-dark-color-code-header-fg is #cccccc).
     - No code token: selection #264F78, rule #404040, langForeground #569CD6.
   - Specificity: `:root[data-code-panels="dark"] [data-code-surface][data-code-surface]` (0,4,0). Page mode is `:root[data-code-panels="page"][data-theme="dark"] …` / `…:not([data-theme="dark"]) …` (0,5,0). The dark-page panel rule `:root[data-code-panels="dark"]:is(.dark, [data-theme="dark"]) …` is (0,5,0). These beat every token-carrying rule. Vars the rail sets are filtered out (line 60).
   - Phase 2: keep. The code theme is the central code style and is meant to win, so whenever the API serves a code theme, token edits do not reach code panes. A static export or a host without the API has an empty element, and the stylesheet tokens apply. Do not point DARK_PLUS_CODE_THEME at --ds-dark-* vars: border and header-fg differ, so pixels would move. Re-point DARK_PAGE_PANEL_VARS rows 53-54 to --ds-dark-color-surface-inset. Leave row 55 on `var(--palette-rule)`: the island re-declares that var as a mix over the panel bg (notion-palette.css:212-219), so the Primer rule token would move the border.

7. **GlassPanel inline styles** (`packages/docs-viewer/src/lab/glass/GlassPanel.tsx:142-188`)
   - Writes:
     - Literal fallbacks: `var(--docs-lab-panel-right, 24px)` (146), `blur(var(--docs-lab-glass-blur, 13px))` (155-156), `var(--annotation-accent, #8b5cf6)` (32, 33, 175), `var(--docs-action-pane-width, 520px)` (16) and the JS `|| 520` (80).
     - Plain literals: width 300 (15), top 12 (19 via 145), `${TRANSITION_MS}ms ${EASE}` (24-25 used at 29, 153, 176, 179, 182, 188), `color 150ms ease` (179, 182), breathe 0.72s / 2.6s ease-in-out (183).
   - Specificity: inline `style` attributes, so no stylesheet token can override them. The fallbacks paint only when the var is unset. semantic.css declares --docs-lab-glass-blur (14px = --ds-blur-glass, 600 / 1180), --annotation-accent (588 / 1169) and --docs-action-pane-width (613 / 1192), so 13px, #8b5cf6 and 520px never paint. --docs-lab-panel-right has no declaration anywhere, so its 24px fallback always paints.
   - Phase 2: put the vars into the inline strings: TRANSITION_MS / EASE -> `var(--ds-motion-duration-slow)` / `var(--ds-motion-easing-emphasized)`, `color 150ms ease` -> `var(--ds-motion-duration-base) var(--ds-motion-easing-standard)`, the 24px fallback -> `var(--ds-space-6)`. Keep 300, 520, 13px, #8b5cf6, 0.72s and 2.6s local. PANEL_TOP_INSET, PANEL_BOTTOM_GAP and the dock width also feed JS arithmetic (22, 81, 116). If they become vars, read them with getComputedStyle, as 76-80 already does for --docs-action-pane-width.

Also checked, no stock literal re-applied: the styleRailVars component overrides (895-916, 1100-1102) emit null when a value equals the registry default and are empty at stock. normalizeSettings and setStyleRailBaseline only produce settings objects; their CSS goes through layers 2-5.

## File mappings

One table per seed file, rows in line order. Var cells hold one variable, or several in order for a shorthand.

### packages/docs-workbench/web/src/theme/notion-palette.css

| Line | Declaration (as written, trimmed) | -> var | Note |
| --- | --- | --- | --- |
| 9 | `--color-text-default: #2A2A2A;` | `--ds-light-color-notion-text-default` |  |
| 10 | `--color-text-navigation: #245A81;` | `--ds-light-color-notion-text-navigation` |  |
| 14 | `--color-bg-default: #FDFDFD;` | `--ds-light-color-notion-bg-default` |  |
| 16 | `--color-bg-sidebar: #F9F9F9;` | `--ds-light-color-notion-bg-sidebar` |  |
| 17 | `--color-pill-default: rgba(206,205,202,0.5);` | `--ds-light-color-notion-pill-default` |  |
| 19 | `--color-text-gray: #9B9A97;` | `--ds-light-color-notion-text-gray` |  |
| 20 | `--color-bg-gray: #EBECED;` | `--ds-light-color-notion-bg-gray` |  |
| 21 | `--color-pill-gray: rgba(155,154,151,0.4);` | `--ds-light-color-notion-pill-gray` | = #9b9a9766 |
| 23 | `--color-text-brown: #64473A;` | `--ds-light-color-notion-text-brown` |  |
| 24 | `--color-bg-brown: #E9E5E3;` | `--ds-light-color-notion-bg-brown` |  |
| 25 | `--color-pill-brown: rgba(140,46,0,0.2);` | `--ds-light-color-notion-pill-brown` | = #8c2e0033 |
| 27 | `--color-text-orange: #D9730D;` | `--ds-light-color-notion-text-orange` |  |
| 28 | `--color-bg-orange: #FAEBDD;` | `--ds-light-color-notion-bg-orange` |  |
| 29 | `--color-pill-orange: rgba(245,93,0,0.2);` | `--ds-light-color-notion-pill-orange` | = #f55d0033 |
| 31 | `--color-text-yellow: #DFAB01;` | `--ds-light-color-notion-text-yellow` |  |
| 32 | `--color-bg-yellow: #FBF3DB;` | `--ds-light-color-notion-bg-yellow` |  |
| 33 | `--color-pill-yellow: rgba(233,168,0,0.2);` | `--ds-light-color-notion-pill-yellow` | = #e9a80033 |
| 35 | `--color-text-green: #0F7B6C;` | `--ds-light-color-notion-text-green` |  |
| 36 | `--color-bg-green: #DDEDEA;` | `--ds-light-color-notion-bg-green` |  |
| 37 | `--color-pill-green: rgba(0,135,107,0.2);` | `--ds-light-color-notion-pill-green` | = #00876b33 |
| 39 | `--color-text-blue: #0B6E99;` | `--ds-light-color-notion-text-blue` |  |
| 40 | `--color-bg-blue: #DDEBF1;` | `--ds-light-color-notion-bg-blue` |  |
| 41 | `--color-pill-blue: rgba(0,120,223,0.2);` | `--ds-light-color-notion-pill-blue` | = #0078df33 |
| 44 | `--color-accent-blue: rgb(0,120,223);` | `--ds-light-color-notion-accent-blue` | = #0078df |
| 46 | `--color-text-purple: #6940A5;` | `--ds-light-color-notion-text-purple` |  |
| 47 | `--color-bg-purple: #EAE4F2;` | `--ds-light-color-notion-bg-purple` |  |
| 48 | `--color-pill-purple: rgba(103,36,222,0.2);` | `--ds-light-color-notion-pill-purple` | = #6724de33 |
| 50 | `--color-text-pink: #AD1A72;` | `--ds-light-color-notion-text-pink` |  |
| 51 | `--color-bg-pink: #F4DFEB;` | `--ds-light-color-notion-bg-pink` |  |
| 52 | `--color-pill-pink: rgba(221,0,129,0.2);` | `--ds-light-color-notion-pill-pink` | = #dd008133 |
| 54 | `--color-text-red: #E03E3E;` | `--ds-light-color-notion-text-red` |  |
| 55 | `--color-bg-red: #FBE4E4;` | `--ds-light-color-notion-bg-red` |  |
| 56 | `--color-pill-red: rgba(255,0,26,0.2);` | `--ds-light-color-notion-pill-red` | = #ff001a33 |
| 69 | `--color-text-default: #D1D9E0;` | `--ds-dark-color-notion-text-default` |  |
| 70 | `--color-text-navigation: #4493F8;` | `--ds-dark-color-notion-text-navigation` |  |
| 71 | `--color-bg-default: #0D1117;` | `--ds-dark-color-notion-bg-default` |  |
| 74 | `--color-bg-sidebar: #010409;` | `--ds-dark-color-notion-bg-sidebar` |  |
| 75 | `--color-pill-default: rgba(101,108,118,0.5);` | `--ds-dark-color-notion-pill-default` |  |
| 77 | `--color-text-gray: #9198A1;` | `--ds-dark-color-notion-text-gray` |  |
| 78 | `--color-bg-gray: #1F252E;` | `--ds-dark-color-notion-bg-gray` |  |
| 79 | `--color-pill-gray: rgba(101,108,118,0.4);` | `--ds-dark-color-notion-pill-gray` | = #656c7666 |
| 81 | `--color-text-brown: #937264;` | `--ds-dark-color-notion-text-brown` |  |
| 82 | `--color-bg-brown: #434040;` | `--ds-dark-color-notion-bg-brown` |  |
| 83 | `--color-pill-brown: rgba(147,114,100,0.5);` | `--ds-dark-color-notion-pill-brown` |  |
| 85 | `--color-text-orange: #DD7330;` | `--ds-dark-color-notion-text-orange` |  |
| 86 | `--color-bg-orange: #2F2624;` | `--ds-dark-color-notion-bg-orange` |  |
| 87 | `--color-pill-orange: rgba(219,109,40,0.4);` | `--ds-dark-color-notion-pill-orange` | = #db6d2866 |
| 89 | `--color-text-yellow: #D29922;` | `--ds-dark-color-notion-text-yellow` |  |
| 90 | `--color-bg-yellow: #2E2B23;` | `--ds-dark-color-notion-bg-yellow` |  |
| 91 | `--color-pill-yellow: rgba(210,153,34,0.4);` | `--ds-dark-color-notion-pill-yellow` | = #d2992266 |
| 93 | `--color-text-green: #3FB950;` | `--ds-dark-color-notion-text-green` |  |
| 94 | `--color-bg-green: #1A3029;` | `--ds-dark-color-notion-bg-green` |  |
| 95 | `--color-pill-green: rgba(63,185,80,0.4);` | `--ds-dark-color-notion-pill-green` | = #3fb95066 |
| 97 | `--color-text-blue: #4493F8;` | `--ds-dark-color-notion-text-blue` |  |
| 98 | `--color-bg-blue: #1B2B3F;` | `--ds-dark-color-notion-bg-blue` |  |
| 99 | `--color-pill-blue: rgba(68,147,248,0.4);` | `--ds-dark-color-notion-pill-blue` | = #4493f866 |
| 101 | `--color-accent-blue: #4493F8;` | `--ds-dark-color-notion-accent-blue` |  |
| 103 | `--color-text-purple: #AB7DF8;` | `--ds-dark-color-notion-text-purple` |  |
| 104 | `--color-bg-purple: #29283F;` | `--ds-dark-color-notion-bg-purple` |  |
| 105 | `--color-pill-purple: rgba(171,125,248,0.4);` | `--ds-dark-color-notion-pill-purple` | = #ab7df866 |
| 107 | `--color-text-pink: #DD69A6;` | `--ds-dark-color-notion-text-pink` |  |
| 108 | `--color-bg-pink: #2F2434;` | `--ds-dark-color-notion-bg-pink` |  |
| 109 | `--color-pill-pink: rgba(219,97,162,0.4);` | `--ds-dark-color-notion-pill-pink` | = #db61a266 |
| 111 | `--color-text-red: #F85B53;` | `--ds-dark-color-notion-text-red` |  |
| 112 | `--color-bg-red: #332228;` | `--ds-dark-color-notion-bg-red` |  |
| 113 | `--color-pill-red: rgba(248,81,73,0.4);` | `--ds-dark-color-notion-pill-red` | = #f8514966 |
| 128 | `--palette-page: #fdfdfd;` | `--ds-light-color-surface-page` |  |
| 129 | `--palette-panel: #f8f8f7;` | `--ds-light-color-surface-panel` |  |
| 130 | `--palette-sidebar: #f9f9f9;` | `--ds-light-color-surface-sidebar` |  |
| 131 | `--palette-ink: #1f1f1f;` | `--ds-light-color-text-ink` |  |
| 132 | `--palette-text: #2a2a2a;` | `--ds-light-color-text-body` |  |
| 133 | `--palette-muted: #666562;` | `--ds-light-color-text-muted` |  |
| 134 | `--palette-faint: #9b9a97;` | `--ds-light-color-text-faint` |  |
| 135 | `--palette-rule: #e6e5e3;` | `--ds-light-color-border-default` |  |
| 136 | `--palette-rule-soft: #efeeec;` | `--ds-light-color-border-subtle` |  |
| 137 | `--palette-chip: #ebebe9;` | `--ds-light-color-fill-chip` |  |
| 138 | `--palette-nav: #ebeced;` | `local` | unused: only feeds --sidebar-accent (value equals --ds-light-color-gray-soft) |
| 139 | `--palette-link: #245a81;` | `--ds-light-color-link` |  |
| 140 | `--palette-accent: #0078df;` | `--ds-light-color-accent` |  |
| 141 | `--palette-glyph: #ffffff;` | `--ds-light-color-text-on-solid` |  |
| 147 | `--palette-gray: #666562;` | `--ds-light-color-gray-text` |  |
| 147 | `--palette-gray-solid: #9b9a97;` | `--ds-light-color-gray-solid` |  |
| 147 | `--palette-gray-soft: #ebeced;` | `--ds-light-color-gray-soft` |  |
| 148 | `--palette-blue: #0b6e99;` | `--ds-light-color-blue-text` |  |
| 148 | `--palette-blue-solid: #0b6e99;` | `--ds-light-color-blue-solid` |  |
| 148 | `--palette-blue-soft: #ddebf1;` | `--ds-light-color-blue-soft` |  |
| 149 | `--palette-teal: #0d7164;` | `--ds-light-color-teal-text` |  |
| 149 | `--palette-teal-solid: #0f7b6c;` | `--ds-light-color-teal-solid` |  |
| 149 | `--palette-teal-soft: #ddedea;` | `--ds-light-color-teal-soft` |  |
| 150 | `--palette-green: #26744f;` | `--ds-light-color-green-text` |  |
| 150 | `--palette-green-solid: #287c55;` | `--ds-light-color-green-solid` |  |
| 150 | `--palette-green-soft: #e2efe6;` | `--ds-light-color-green-soft` |  |
| 151 | `--palette-yellow: #805f01;` | `--ds-light-color-yellow-text` |  |
| 151 | `--palette-yellow-solid: #dfab01;` | `--ds-light-color-yellow-solid` |  |
| 151 | `--palette-yellow-soft: #fbf3db;` | `--ds-light-color-yellow-soft` |  |
| 154 | `--palette-amber: #9a5b00;` | `--ds-light-color-amber-text` |  |
| 155 | `--palette-orange: #9d530d;` | `--ds-light-color-orange-text` |  |
| 155 | `--palette-orange-solid: #d9730d;` | `--ds-light-color-orange-solid` |  |
| 155 | `--palette-orange-soft: #faebdd;` | `--ds-light-color-orange-soft` |  |
| 156 | `--palette-red: #c62121;` | `--ds-light-color-red-text` |  |
| 156 | `--palette-red-solid: #e03e3e;` | `--ds-light-color-red-solid` |  |
| 156 | `--palette-red-soft: #fbe4e4;` | `--ds-light-color-red-soft` |  |
| 157 | `--palette-violet: #6940a5;` | `--ds-light-color-violet-text` |  |
| 157 | `--palette-violet-solid: #6940a5;` | `--ds-light-color-violet-solid` |  |
| 157 | `--palette-violet-soft: #eae4f2;` | `--ds-light-color-violet-soft` |  |
| 158 | `--palette-pink: #ad1a72;` | `--ds-light-color-pink-text` |  |
| 158 | `--palette-pink-solid: #ad1a72;` | `--ds-light-color-pink-solid` |  |
| 158 | `--palette-pink-soft: #f4dfeb;` | `--ds-light-color-pink-soft` |  |
| 163 | `--palette-page: #0d1117;` | `--ds-dark-color-surface-page` |  |
| 164 | `--palette-panel: #151b23;` | `--ds-dark-color-surface-panel` |  |
| 165 | `--palette-sidebar: #010409;` | `--ds-dark-color-surface-sidebar` |  |
| 166 | `--palette-ink: #f0f6fc;` | `--ds-dark-color-text-ink` |  |
| 167 | `--palette-text: #d1d9e0;` | `--ds-dark-color-text-body` |  |
| 168 | `--palette-muted: #9198a1;` | `--ds-dark-color-text-muted` |  |
| 169 | `--palette-faint: #656c76;` | `--ds-dark-color-text-faint` |  |
| 170 | `--palette-rule: #3d444d;` | `--ds-dark-color-border-default` |  |
| 171 | `--palette-rule-soft: #262c36;` | `--ds-dark-color-border-subtle` |  |
| 172 | `--palette-chip: #21262d;` | `--ds-dark-color-fill-chip` |  |
| 173 | `--palette-nav: #212830;` | `local` | unused: only feeds --sidebar-accent (no token holds #212830) |
| 174 | `--palette-link: #4493f8;` | `--ds-dark-color-link` |  |
| 175 | `--palette-accent: #4493f8;` | `--ds-dark-color-accent` |  |
| 176 | `--palette-glyph: #0d1117;` | `--ds-dark-color-text-on-solid` |  |
| 178 | `--palette-inset: #010409;` | `--ds-dark-color-surface-inset` |  |
| 184 | `--palette-gray: #9198a1;` | `--ds-dark-color-gray-text` |  |
| 184 | `--palette-gray-solid: #656c76;` | `--ds-dark-color-gray-solid` |  |
| 185 | `--palette-blue: #4493f8;` | `--ds-dark-color-blue-text` |  |
| 185 | `--palette-blue-solid: #4493f8;` | `--ds-dark-color-blue-solid` |  |
| 186 | `--palette-teal: #39c5cf;` | `--ds-dark-color-teal-text` |  |
| 186 | `--palette-teal-solid: #39c5cf;` | `--ds-dark-color-teal-solid` |  |
| 187 | `--palette-green: #3fb950;` | `--ds-dark-color-green-text` |  |
| 187 | `--palette-green-solid: #3fb950;` | `--ds-dark-color-green-solid` |  |
| 188 | `--palette-yellow: #d29922;` | `--ds-dark-color-yellow-text` |  |
| 188 | `--palette-yellow-solid: #d29922;` | `--ds-dark-color-yellow-solid` |  |
| 189 | `--palette-amber: #d29922;` | `--ds-dark-color-amber-text` |  |
| 190 | `--palette-orange: #dd7330;` | `--ds-dark-color-orange-text` |  |
| 190 | `--palette-orange-solid: #db6d28;` | `--ds-dark-color-orange-solid` |  |
| 191 | `--palette-red: #f85b53;` | `--ds-dark-color-red-text` |  |
| 191 | `--palette-red-solid: #f85149;` | `--ds-dark-color-red-solid` |  |
| 192 | `--palette-violet: #ab7df8;` | `--ds-dark-color-violet-text` |  |
| 192 | `--palette-violet-solid: #ab7df8;` | `--ds-dark-color-violet-solid` |  |
| 193 | `--palette-pink: #dd69a6;` | `--ds-dark-color-pink-text` |  |
| 193 | `--palette-pink-solid: #db61a2;` | `--ds-dark-color-pink-solid` |  |
| 195 | `--palette-gray-soft: color-mix(in srgb, #656c76 13%, #151b23);` | `--ds-dark-color-gray-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 196 | `--palette-blue-soft: color-mix(in srgb, #4493f8 13%, #151b23);` | `--ds-dark-color-blue-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 197 | `--palette-teal-soft: color-mix(in srgb, #39c5cf 13%, #151b23);` | `--ds-dark-color-teal-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 198 | `--palette-green-soft: color-mix(in srgb, #3fb950 13%, #151b23);` | `--ds-dark-color-green-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 199 | `--palette-yellow-soft: color-mix(in srgb, #d29922 13%, #151b23);` | `--ds-dark-color-yellow-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 200 | `--palette-orange-soft: color-mix(in srgb, #db6d28 13%, #151b23);` | `--ds-dark-color-orange-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 201 | `--palette-red-soft: color-mix(in srgb, #f85149 13%, #151b23);` | `--ds-dark-color-red-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 202 | `--palette-violet-soft: color-mix(in srgb, #ab7df8 13%, #151b23);` | `--ds-dark-color-violet-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 203 | `--palette-pink-soft: color-mix(in srgb, #db61a2 13%, #151b23);` | `--ds-dark-color-pink-soft` | whole color-mix() equals the token value in dist/json/dark.json (its 13% goes with it) |
| 217 | `--palette-rule: color-mix(in srgb, var(--docs-code-block-bg) 74%, #ffffff);` | `local` | island recipe: white mix endpoint over the code panel bg; no --ds-dark-* token holds #ffffff |
| 218 | `--palette-rule-soft: color-mix(in srgb, var(--docs-code-block-bg) 86%, #ffffff);` | `local` | island recipe: white mix endpoint over the code panel bg; no --ds-dark-* token holds #ffffff |

#### Stays local

- Percentage knobs. They stay local because the role-token formulas in semantic.css read them (that block stays as formulas, see semantic.css below). The same percentages are already baked into the ds color-mix tokens:
  - `--palette-soft-t` 8% (142) / 13% (179): nothing reads it (grep across docs-system finds only these two declarations). The dark 13% is the amount the -soft mixes at 195-203 write literally, baked into `--ds-dark-color-<hue>-soft`. The light softs are opaque hex (`--ds-light-color-<hue>-soft`), so the light 8% has no ds counterpart.
  - `--palette-line-t` 45% (143) / 50% (180): read by `--docs-c-<hue>-line` (semantic.css 1299 to 1307). Baked into `--ds-light-color-<hue>-line` (45%) and `--ds-dark-color-<hue>-line` (50%), and so into their `color.status.*.line` aliases.
  - `--palette-selection-t` 18% (144) / 30% (181): read by `--docs-selection` (semantic.css 1294). Baked into `--ds-light-color-selection` / `--ds-dark-color-selection`.
  - `--palette-diff-mod-t` 9% (145) / 7% (182): read by `--docs-diff-mod-bg` (semantic.css 1337). Baked into `--ds-light-color-diff-mod-bg` / `--ds-dark-color-diff-mod-bg`.
- Island recipe percentages inside color-mix(): 217 `74%`, 218 `86%`. The island's rule and soft rule are measured from the code panel's own background toward `#ffffff`, so they follow whichever code theme sets `--docs-code-block-bg`. No token, and they must stay local.

### packages/docs-workbench/web/src/theme/semantic.css

| Line | Declaration (as written, trimmed) | -> var | Note |
| --- | --- | --- | --- |
| 43 | `--style-code-width: 88ch;` | `--ds-layout-lane-code` |  |
| 44 | `--style-wide-width: 1100px;` | `--ds-layout-lane-wide` |  |
| 45 | `--style-content-margin: 88px;` | `local` | docs page left rail; no token (nearest layout token --ds-layout-content-padding-x 40px is the content inline padding, a different thing; would move pixels) |
| 78, 705 | `--radius: 2px;` | `--ds-radius-base` |  |
| 109 | `--syntax-punctuation: #000000;` | `--ds-light-color-syntax-punctuation` |  |
| 110 | `--syntax-keyword: #0000FF;` | `--ds-light-color-syntax-keyword` |  |
| 111 | `--syntax-control: #AF00DB;` | `--ds-light-color-syntax-control` |  |
| 112 | `--syntax-function: #795E26;` | `--ds-light-color-syntax-function` |  |
| 113 | `--syntax-type: #267F99;` | `--ds-light-color-syntax-type` |  |
| 114 | `--syntax-key: #001080;` | `--ds-light-color-syntax-key` |  |
| 115 | `--syntax-string: #A31515;` | `--ds-light-color-syntax-string` |  |
| 116 | `--syntax-number: #098658;` | `--ds-light-color-syntax-number` |  |
| 117 | `--syntax-boolean: #0000FF;` | `--ds-light-color-syntax-boolean` |  |
| 118 | `--syntax-null: #0000FF;` | `--ds-light-color-syntax-null` |  |
| 119 | `--syntax-comment: #008000;` | `--ds-light-color-syntax-comment` |  |
| 120 | `--syntax-regex: #811F3F;` | `--ds-light-color-syntax-regex` |  |
| 121 | `--syntax-tag: #800000;` | `--ds-light-color-syntax-tag` |  |
| 122 | `--syntax-constant: #0070C1;` | `--ds-light-color-syntax-constant` |  |
| 123 | `--syntax-selector: #800000;` | `--ds-light-color-syntax-selector` |  |
| 136, 760 | `--docs-heading-weight: 600;` | `--ds-font-weight-semibold` |  |
| 137, 761 | `--docs-heading-margin-top: 40px;` | `--ds-space-10` |  |
| 138, 762 | `--docs-heading-margin-bottom: 12px;` | `--ds-space-3` |  |
| 144, 768 | `--docs-list-item-gap: 4px;` | `--ds-space-1` |  |
| 148, 774 | `--docs-code-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 154, 780 | `--docs-code-text-size: 13px;` | `--ds-font-size-code` | mono code block |
| 155, 781 | `--docs-code-line-height: 21px;` | `--ds-line-height-code` |  |
| 156, 782 | `--docs-code-pad-x: 12px;` | `--ds-space-3` |  |
| 157, 783 | `--docs-code-pad-top: 12px;` | `--ds-space-3` |  |
| 158, 784 | `--docs-code-pad-bottom: 12px;` | `--ds-space-3` |  |
| 163, 789 | `--docs-code-header-height: 32px;` | `--ds-space-8` | fixed height |
| 166, 792 | `--docs-code-header-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 167, 793 | `--docs-code-header-weight: 400;` | `--ds-font-weight-regular` |  |
| 179, 801 | `--docs-code-gutter-width: 40px;` | `--ds-space-10` | fixed width |
| 180, 802 | `--docs-code-gutter-pad-x: 12px;` | `--ds-space-3` |  |
| 181, 803 | `--docs-code-gutter-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 190, 812 | `--docs-code-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 194, 816 | `--docs-code-note-text-size: 13px;` | `--ds-font-size-ui-sm` | sans: the notes column is font-sans (docs-viewer code/classes.ts) |
| 195, 817 | `--docs-code-notes-width: 280px;` | `local` | no token; nearest widths --ds-layout-sidebar-width 220px / --ds-layout-inspector-width 360px would move pixels |
| 226, 843 | `--docs-callout-rail-width: 3px;` | `--ds-border-width-rail` |  |
| 227, 844 | `--docs-callout-hairline-width: 0px;` | `--ds-border-width-none` |  |
| 228, 845 | `--docs-callout-pad-x: 14px;` | `local` | off the 4px grid; nearest --ds-space-3 (12px) / --ds-space-4 (16px) would move pixels |
| 229, 846 | `--docs-callout-pad-y: 2px;` | `--ds-space-0-5` |  |
| 230, 847 | `--docs-callout-title-text-size: var(--style-font-size, 18px);` | `--ds-font-size-reading` | fallback of a style-rail var (--style-font-size is unset at stock, so this 18px paints) |
| 231, 848 | `--docs-callout-title-weight: 600;` | `--ds-font-weight-semibold` |  |
| 232, 849 | `--docs-callout-icon-size: 16px;` | `--ds-space-4` | fixed icon box |
| 234, 851 | `--docs-callout-margin: 20px;` | `--ds-space-5` |  |
| 237, 854 | `--docs-divider-thickness: 1px;` | `--ds-border-width-hairline` |  |
| 240, 857 | `--docs-image-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 242, 859 | `--docs-image-margin: 24px;` | `--ds-space-6` |  |
| 245, 862 | `--docs-video-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 247, 864 | `--docs-video-caption-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 248, 865 | `--docs-video-caption-gap: 8px;` | `--ds-space-2` |  |
| 249, 866 | `--docs-video-margin: 24px;` | `--ds-space-6` |  |
| 262, 871 | `--docs-file-tree-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 264, 873 | `--docs-file-tree-pad-y: 8px;` | `--ds-space-2` |  |
| 265, 874 | `--docs-file-tree-pad-x: 12px;` | `--ds-space-3` |  |
| 266, 875 | `--docs-file-tree-text-size: 13px;` | `--ds-font-size-code` | mono file-tree names |
| 267, 876 | `--docs-file-tree-line-height: 28px;` | `--ds-line-height-row` |  |
| 269, 878 | `--docs-file-tree-folder-weight: 400;` | `--ds-font-weight-regular` |  |
| 271, 880 | `--docs-file-tree-file-weight: 400;` | `--ds-font-weight-regular` |  |
| 273, 882 | `--docs-file-tree-note-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 294, 903 | `--docs-outline-rows-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 296, 905 | `--docs-outline-rows-pad-y: 8px;` | `--ds-space-2` |  |
| 297, 906 | `--docs-outline-rows-pad-x: 12px;` | `--ds-space-3` |  |
| 298, 907 | `--docs-outline-rows-text-size: 13px;` | `--ds-font-size-code` | mono outline rows |
| 299, 908 | `--docs-outline-rows-line-height: 28px;` | `--ds-line-height-row` |  |
| 302, 911 | `--docs-outline-rows-comment-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 303, 912 | `--docs-outline-rows-source-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 331, 940 | `--docs-stack-gap: 12px;` | `--ds-space-3` |  |
| 347, 956 | `--docs-table-header-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 350, 959 | `--docs-table-row-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 352, 961 | `--docs-table-cell-pad-y: 4px;` | `--ds-space-1` |  |
| 353, 962 | `--docs-table-cell-pad-x: 12px;` | `--ds-space-3` |  |
| 354, 963 | `--docs-table-font-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 355, 964 | `--docs-table-line-height: 1.45;` | `--ds-line-height-reading` |  |
| 356, 965 | `--docs-table-body-weight: 400;` | `--ds-font-weight-regular` |  |
| 361, 970 | `--docs-table-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 366, 975 | `--docs-table-header-weight: 500;` | `--ds-font-weight-medium` |  |
| 369, 978 | `--docs-table-column-rule-width: 0px;` | `--ds-border-width-none` |  |
| 372, 981 | `--docs-table-row-min-height: 28px;` | `--ds-space-7` | fixed (min) row height |
| 377, 986 | `--docs-table-handle-offset: 12px;` | `--ds-space-3` |  |
| 378, 987 | `--docs-table-selection-pad: 3px;` | `local` | off-scale padding; nearest --ds-space-0-5 (2px) / --ds-space-1 (4px) would move pixels; --ds-border-width-rail is 3px but is a border width |
| 408, 1017 | `--docs-interaction-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 409, 1018 | `--docs-interaction-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 410, 1019 | `--docs-interaction-pad-x: 16px;` | `--ds-space-4` |  |
| 411, 1020 | `--docs-interaction-title-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 412, 1021 | `--docs-interaction-title-weight: 600;` | `--ds-font-weight-semibold` |  |
| 413, 1022 | `--docs-interaction-header-pad-y: 9px;` | `local` | off-scale; nearest --ds-space-2 (8px) would move pixels |
| 414, 1023 | `--docs-interaction-header-text-size: 13px;` | `--ds-font-size-code` | mono operation name |
| 415, 1024 | `--docs-interaction-header-weight: 500;` | `--ds-font-weight-medium` |  |
| 416, 1025 | `--docs-interaction-desc-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 417, 1026 | `--docs-interaction-desc-line-height: 20px;` | `local` | no 20px line-height token; nearest --ds-line-height-code (21px) would move pixels (--ds-space-5 is 20px but is a spacing token) |
| 418, 1027 | `--docs-interaction-column-head-text-size: 13px;` | `--ds-font-size-ui-sm` | sans: the column head uses --docs-font-body, not the mono stack |
| 419, 1028 | `--docs-interaction-column-head-pad-y: 8px;` | `--ds-space-2` |  |
| 420, 1029 | `--docs-interaction-row-pad: 5px;` | `local` | off-scale; nearest --ds-space-1 (4px) / --ds-space-1-5 (6px) would move pixels |
| 421, 1030 | `--docs-interaction-indent: 16px;` | `--ds-space-4` |  |
| 422, 1031 | `--docs-interaction-note-name-text-size: 13px;` | `--ds-font-size-code` | mono field name |
| 423, 1032 | `--docs-interaction-note-name-weight: 500;` | `--ds-font-weight-medium` |  |
| 424, 1033 | `--docs-interaction-note-type-text-size: 13px;` | `--ds-font-size-code` | mono field type |
| 443, 1052 | `--docs-shape-row-pad: 5px;` | `local` | off-scale; nearest --ds-space-1 (4px) / --ds-space-1-5 (6px) would move pixels |
| 444, 1053 | `--docs-shape-row-min-height: 28px;` | `--ds-space-7` | fixed (min) row height |
| 445, 1054 | `--docs-shape-name-weight: 500;` | `--ds-font-weight-medium` |  |
| 446, 1055 | `--docs-shape-name-width: 24ch;` | `local` | no 24ch token; the only ch tokens are the lanes (--ds-layout-lane-text 60ch), which would move pixels |
| 449, 1058 | `--docs-shape-text-size: 13px;` | `--ds-font-size-code` | mono field name |
| 450, 1059 | `--docs-shape-type-text-size: 13px;` | `--ds-font-size-code` | mono field type |
| 451, 1060 | `--docs-shape-desc-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 452, 1061 | `--docs-shape-header-text-size: 13px;` | `--ds-font-size-code` | mono header |
| 453, 1062 | `--docs-shape-header-weight: 600;` | `--ds-font-weight-semibold` |  |
| 454, 1063 | `--docs-shape-pad-x: 16px;` | `--ds-space-4` |  |
| 455, 1064 | `--docs-shape-header-pad-y: 6px;` | `--ds-space-1-5` |  |
| 456, 1065 | `--docs-shape-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 458, 1067 | `--docs-shape-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 459, 1068 | `--docs-shape-header-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 460, 1069 | `--docs-shape-pane-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 461, 1070 | `--docs-shape-indent: 16px;` | `--ds-space-4` |  |
| 462, 1071 | `--docs-shape-child-rule-width: 1px;` | `--ds-border-width-hairline` |  |
| 477, 1083 | `--docs-link-rail-width: 3px;` | `--ds-border-width-rail` |  |
| 478, 1084 | `--docs-link-ring-width: 1.5px;` | `--ds-border-width-ring` |  |
| 479, 1085 | `--docs-link-text-size: 13px;` | `--ds-font-size-code` | mono linked CodeLines |
| 480, 1086 | `--docs-link-line-height: 21px;` | `--ds-line-height-code` |  |
| 481, 1087 | `--docs-link-gutter-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 482, 1088 | `--docs-link-gutter-width: 40px;` | `--ds-space-10` | fixed width |
| 516 | `--docs-process-outline-keyword-fg: #AF00DB;` | `--ds-light-color-syntax-control` | Light+ control |
| 517, 1106 | `--docs-process-outline-keyword-weight: 500;` | `--ds-font-weight-medium` |  |
| 518 | `--docs-process-outline-note-fg: #008000;` | `--ds-light-color-syntax-comment` | Light+ comment |
| 520 | `--docs-process-outline-note-bullet: #008000;` | `--ds-light-color-syntax-comment` | Light+ comment |
| 525, 1114 | `--docs-process-outline-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 526, 1115 | `--docs-process-outline-pad-y: 12px;` | `--ds-space-3` |  |
| 527, 1116 | `--docs-process-outline-pad-x: 12px;` | `--ds-space-3` |  |
| 528, 1117 | `--docs-process-outline-indent: 28px;` | `--ds-space-7` |  |
| 529, 1118 | `--docs-process-outline-row-gap: 4px;` | `--ds-space-1` |  |
| 530, 1119 | `--docs-process-outline-branch-gap: 16px;` | `--ds-space-4` |  |
| 531, 1120 | `--docs-process-outline-root-gap: 12px;` | `--ds-space-3` |  |
| 532, 1121 | `--docs-process-outline-arrow-gap: 4px;` | `--ds-space-1` |  |
| 533, 1122 | `--docs-process-outline-line-height: 24px;` | `local` | no 24px line-height token (--ds-line-height-code 21px, --ds-line-height-row 28px would move pixels); --ds-space-6 is 24px but is a spacing token |
| 534, 1123 | `--docs-process-outline-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 535, 1124 | `--docs-process-outline-root-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 536, 1125 | `--docs-process-outline-root-weight: 600;` | `--ds-font-weight-semibold` |  |
| 537, 1126 | `--docs-process-outline-branch-weight: 600;` | `--ds-font-weight-semibold` |  |
| 538, 1127 | `--docs-process-outline-step-weight: 400;` | `--ds-font-weight-regular` |  |
| 539, 1128 | `--docs-process-outline-empty-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 540, 1129 | `--docs-process-outline-note-text-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 541, 1130 | `--docs-process-outline-note-line-height: 21px;` | `--ds-line-height-code` | the only 21px line-height token (the note text itself is sans) |
| 542, 1131 | `--docs-process-outline-note-inset: 0px;` | `--ds-space-0` |  |
| 543, 1132 | `--docs-process-outline-note-border-width: 0px;` | `--ds-border-width-none` |  |
| 544, 1133 | `--docs-process-outline-note-rule-width: 0px;` | `--ds-border-width-none` |  |
| 545, 1134 | `--docs-process-outline-note-pad-y: 2px;` | `--ds-space-0-5` |  |
| 546, 1135 | `--docs-process-outline-note-pad-x: 0px;` | `--ds-space-0` |  |
| 547, 1136 | `--docs-process-outline-note-rule-gap: 0px;` | `--ds-space-0` |  |
| 549, 1138 | `--docs-process-outline-trace-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 552, 1141 | `--docs-process-outline-select-pad: 2px;` | `--ds-space-0-5` |  |
| 553, 1142 | `--docs-process-outline-focus-ring: 1px;` | `--ds-border-width-hairline` | outline width |
| 554, 1143 | `--docs-process-outline-stroke: 1.5px;` | `--ds-border-width-ring` |  |
| 562, 1147 | `--docs-sequence-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 565, 1150 | `--docs-sequence-padding: 12px;` | `--ds-space-3` |  |
| 566, 1151 | `--docs-sequence-max-height: 420px;` | `local` | no height token near 420px (nearest layout size --ds-layout-inspector-width 360px would move pixels) |
| 568, 1153 | `--docs-sequence-expand-text-size: 12px;` | `--ds-font-size-ui-xs` |  |
| 569, 1154 | `--docs-sequence-diagram-bg: #ffffff;` | `local` | @codecaine-ai/sequence built-in default; the diagram is light-on-white in both modes, so no theme token fits |
| 570, 1155 | `--docs-sequence-diagram-text: #252525;` | `local` | @codecaine-ai/sequence built-in default; the diagram is light-on-white in both modes, so no theme token fits |
| 571, 1156 | `--docs-sequence-line: #c77d2e;` | `local` | @codecaine-ai/sequence built-in default; the diagram is light-on-white in both modes, so no theme token fits |
| 572, 1157 | `--docs-sequence-actor-fill: #fff8f0;` | `local` | @codecaine-ai/sequence built-in default; the diagram is light-on-white in both modes, so no theme token fits |
| 575, 1160 | `--docs-sequence-fragment: #5b7fbd;` | `local` | @codecaine-ai/sequence built-in default; the diagram is light-on-white in both modes, so no theme token fits |
| 580, 1163 | `--docs-canvas-border-width: 1px;` | `--ds-border-width-hairline` |  |
| 583, 1166 | `--docs-canvas-padding: 0px;` | `--ds-space-0` |  |
| 588 | `--annotation-accent: #7862b8;` | `--ds-light-color-annotation-accent` |  |
| 589 | `--annotation-accent-lit: #5b4699;` | `--ds-light-color-annotation-accent-lit` |  |
| 590 | `--annotation-accent-dim: #9488bd;` | `--ds-light-color-annotation-accent-dim` |  |
| 591 | `--annotation-active-bg: rgba(120, 98, 184, 0.1);` | `--ds-light-color-annotation-active-bg` |  |
| 592 | `--annotation-surface: #ffffff;` | `--ds-light-color-annotation-surface` |  |
| 593 | `--annotation-text: #18181b;` | `--ds-light-color-annotation-text` |  |
| 594 | `--annotation-muted: #71717a;` | `--ds-light-color-annotation-muted` |  |
| 595 | `--annotation-border: rgba(120, 98, 184, 0.38);` | `--ds-light-color-annotation-border` |  |
| 596 | `--annotation-danger: #dc2626;` | `--ds-light-color-annotation-danger` |  |
| 599 | `--docs-lab-glass-bg: rgba(255, 255, 255, 0.85);` | `--ds-light-color-glass-bg` |  |
| 600, 1180 | `--docs-lab-glass-blur: 14px;` | `--ds-blur-glass` |  |
| 601 | `--docs-lab-panel-border: rgba(28, 22, 54, 0.14);` | `--ds-light-color-glass-border` |  |
| 602 | `--docs-lab-panel-shadow: 0 10px 32px rgba(30, 22, 60, 0.12), 0 1px 3px rgba(0, 0, 0, 0.07);` | `--ds-light-shadow-glass` | whole shadow value |
| 603 | `--docs-lab-zone-border: rgba(28, 22, 54, 0.09);` | `--ds-light-color-glass-zone-border` |  |
| 613, 1192 | `--docs-action-pane-width: 520px;` | `local` | no token; nearest --ds-layout-inspector-width (360px) would move pixels |
| 616, 1195 | `--docs-peek-width: min(48rem, 45vw);` | `local` / `local` | 48rem = 768px (rem->px): no layout token (nearest --ds-layout-inspector-width 360px / --ds-layout-lane-wide 1100px would move pixels); 45vw is a viewport cap with no token |
| 617, 1196 | `--docs-peek-duration: 300ms;` | `local` | nearest --ds-motion-duration-slow (260ms) would change the timing |
| 619, 1198 | `--docs-peek-divider-width: 1px;` | `--ds-border-width-hairline` |  |
| 621, 1200 | `--docs-peek-padding: 1.5rem;` | `--ds-space-6` | rem->px: 1.5rem = 24px |
| 625, 1204 | `--docs-ref-icon-size: 12px;` | `--ds-space-3` | fixed icon size |
| 627, 1206 | `--docs-ref-icon-gap: 2px;` | `--ds-space-0-5` |  |
| 635 | `--docs-inline-code-path-fg: #a31515;` | `--ds-light-color-code-chip-string` | typed chip, Light+; paths share the string color |
| 636 | `--docs-inline-code-string-fg: #a31515;` | `--ds-light-color-code-chip-string` | typed chip, Light+ |
| 637 | `--docs-inline-code-type-fg: #22728a;` | `--ds-light-color-code-chip-type` | typed chip, Light+ |
| 638 | `--docs-inline-code-call-fg: #795e26;` | `--ds-light-color-code-chip-call` | typed chip, Light+ |
| 639 | `--docs-inline-code-literal-fg: #08794f;` | `--ds-light-color-code-chip-literal` | typed chip, Light+ |
| 640 | `--docs-inline-code-keyword-fg: #0000ff;` | `--ds-light-color-code-chip-keyword` | typed chip, Light+ |
| 641 | `--docs-inline-code-prop-fg: #001080;` | `--ds-light-color-code-chip-prop` | typed chip, Light+ |
| 656, 1236 | `--docs-inline-code-border-width: 0px;` | `--ds-border-width-none` |  |
| 733 | `--syntax-punctuation: #D4D4D4;` | `--ds-dark-color-syntax-punctuation` |  |
| 734 | `--syntax-keyword: #569CD6;` | `--ds-dark-color-syntax-keyword` |  |
| 735 | `--syntax-control: #C586C0;` | `--ds-dark-color-syntax-control` |  |
| 736 | `--syntax-function: #DCDCAA;` | `--ds-dark-color-syntax-function` |  |
| 737 | `--syntax-type: #4EC9B0;` | `--ds-dark-color-syntax-type` |  |
| 738 | `--syntax-key: #9CDCFE;` | `--ds-dark-color-syntax-key` |  |
| 739 | `--syntax-string: #CE9178;` | `--ds-dark-color-syntax-string` |  |
| 740 | `--syntax-number: #B5CEA8;` | `--ds-dark-color-syntax-number` |  |
| 741 | `--syntax-boolean: #569CD6;` | `--ds-dark-color-syntax-boolean` |  |
| 742 | `--syntax-null: #569CD6;` | `--ds-dark-color-syntax-null` |  |
| 743 | `--syntax-comment: #6A9955;` | `--ds-dark-color-syntax-comment` |  |
| 744 | `--syntax-regex: #D16969;` | `--ds-dark-color-syntax-regex` |  |
| 745 | `--syntax-tag: #569CD6;` | `--ds-dark-color-syntax-tag` |  |
| 746 | `--syntax-constant: #4FC1FF;` | `--ds-dark-color-syntax-constant` |  |
| 747 | `--syntax-selector: #D7BA7D;` | `--ds-dark-color-syntax-selector` |  |
| 771 | `--docs-code-block-bg: #1E1E1E;` | `--ds-dark-color-code-bg` |  |
| 772 | `--docs-code-block-border: #3C3C3C;` | `--ds-dark-color-code-border` |  |
| 791 | `--docs-code-header-fg: #CCCCCC;` | `--ds-dark-color-code-header-fg` |  |
| 796 | `--docs-code-gutter-fg: #858585;` | `--ds-dark-color-code-gutter-fg` |  |
| 800 | `--docs-code-gutter-bg: #1E1E1E;` | `--ds-dark-color-code-gutter-bg` |  |
| 1105 | `--docs-process-outline-keyword-fg: #C586C0;` | `--ds-dark-color-syntax-control` | Dark+ control |
| 1107 | `--docs-process-outline-note-fg: #6A9955;` | `--ds-dark-color-syntax-comment` | Dark+ comment |
| 1109 | `--docs-process-outline-note-bullet: #6A9955;` | `--ds-dark-color-syntax-comment` | Dark+ comment |
| 1169 | `--annotation-accent: #8a7ab0;` | `--ds-dark-color-annotation-accent` |  |
| 1170 | `--annotation-accent-lit: #ad9dd0;` | `--ds-dark-color-annotation-accent-lit` |  |
| 1171 | `--annotation-accent-dim: #7a6d98;` | `--ds-dark-color-annotation-accent-dim` |  |
| 1172 | `--annotation-active-bg: rgba(138, 122, 176, 0.16);` | `--ds-dark-color-annotation-active-bg` |  |
| 1173 | `--annotation-surface: #1c1c20;` | `--ds-dark-color-annotation-surface` |  |
| 1174 | `--annotation-text: #e4e4e7;` | `--ds-dark-color-annotation-text` |  |
| 1175 | `--annotation-muted: #a1a1aa;` | `--ds-dark-color-annotation-muted` |  |
| 1176 | `--annotation-border: rgba(173, 157, 208, 0.3);` | `--ds-dark-color-annotation-border` |  |
| 1177 | `--annotation-danger: #f87171;` | `--ds-dark-color-annotation-danger` |  |
| 1179 | `--docs-lab-glass-bg: rgba(24, 24, 24, 0.72);` | `--ds-dark-color-glass-bg` |  |
| 1181 | `--docs-lab-panel-border: rgba(255, 255, 255, 0.12);` | `--ds-dark-color-glass-border` |  |
| 1182 | `--docs-lab-panel-shadow: 0 10px 32px rgba(0, 0, 0, 0.5);` | `--ds-dark-shadow-glass` | whole shadow value |
| 1183 | `--docs-lab-zone-border: rgba(255, 255, 255, 0.08);` | `--ds-dark-color-glass-zone-border` |  |
| 1210 | `--docs-inline-code-fg: #d4d4d4;` | `--ds-dark-color-code-chip-ink` | Dark+ default code ink |
| 1215 | `--docs-inline-code-path-fg: var(--syntax-string, #ce9178);` | `--ds-dark-color-code-chip-string` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-string |
| 1216 | `--docs-inline-code-string-fg: var(--syntax-string, #ce9178);` | `--ds-dark-color-code-chip-string` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-string |
| 1217 | `--docs-inline-code-type-fg: var(--syntax-type, #4ec9b0);` | `--ds-dark-color-code-chip-type` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-type |
| 1218 | `--docs-inline-code-call-fg: var(--syntax-function, #dcdcaa);` | `--ds-dark-color-code-chip-call` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-function |
| 1219 | `--docs-inline-code-literal-fg: var(--syntax-number, #b5cea8);` | `--ds-dark-color-code-chip-literal` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-number |
| 1220 | `--docs-inline-code-keyword-fg: var(--syntax-keyword, #569cd6);` | `--ds-dark-color-code-chip-keyword` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-keyword |
| 1221 | `--docs-inline-code-prop-fg: var(--syntax-key, #9cdcfe);` | `--ds-dark-color-code-chip-prop` | fallback (the dark block always defines the --syntax-* var); = --ds-dark-color-syntax-key |

#### Stays local

- Unitless multipliers (the consumer multiplies by 1em or by the reading size): 134, 758 `1` (paragraph spacing); 139, 763 `1.875`, 140, 764 `1.25` and 141, 765 `1` (heading h1 / h2 / h3 sizes); 233, 850 `1` (callout body text scale); 238, 855 `2` (divider spacing); 651, 1231 `0.85`, 652, 1232 `0.35` and 653, 1233 `0.1` (inline-code text size, pad-x, pad-y).
- Unitless percent knobs (the consumer multiplies by 1%): 288, 897 `8` (file-tree change tint); 474 `14` in light and 1080 `12` in dark (link wash); 548, 1137 `0` (process-outline note accent); 551, 1140 `15` (process-outline select tint). Also the `1%` factor in `calc(var(--docs-link-wash) * 1%)` at 475, 1081.
- Opacities: 186, 808 `1` (code zebra); 191, 813 `0.5` (code rule); 348, 957 `1` (table header rule); 351, 960 `1` (table row rule).
- Percentages inside color-mix() formulas over role and palette vars. Keep the formulas: the dark-block copies also run on the dark code-panel island, where `--docs-panel` and `--docs-rule` re-resolve (notion-palette.css 212-219). Literals: 145 `30%`; 164, 790 `4%`; 174 `65%`; 178 `30%`; 304, 913 `75%`; 322, 931 `60%`; 442, 1051 `75%`; 509 `45%`; 607, 609 `14%`; 612, 1191 `8%`; 664, 1244 `70%` and `30%`; 666, 1246 `84%`; 937 `7%`; 1098 `75%`; 1187, 1189 `18%`.
  - Page-level equalities, checked against dist/json: 145 == `--ds-light-color-code-bg`; 174 == `--ds-light-color-code-gutter-fg`; 178 == `--ds-light-color-code-gutter-bg`; 607, 609, 612 == `--ds-light-color-annotation-add-bg`, `-del-bg`, `-wash`; 1187, 1189, 1191 == `--ds-dark-color-annotation-add-bg`, `-del-bg`, `-wash`; 664 and 1244 == color.border.strong (light and dark); 666 and 1246 == color.text.secondary (light and dark).
  - No token: 164 and 790 (currentColor header strip), 304 and 913, 322 and 931, 442 and 1051, 475 and 1081, 509, 937, 1098.
- Keywords:
  - `transparent`: 145, 164, 185, 212, 215, 218, 221, 224, 304, 322, 344, 442, 473, 475, 521, 550, 564, 582, 607, 609, 612, 666, 790, 807, 829, 832, 835, 838, 841, 913, 931, 953, 1051, 1079, 1081, 1098, 1110, 1139, 1149, 1165, 1187, 1189, 1191, 1246, 1294.
  - `currentColor`: 164, 567, 624, 626, 790, 1152, 1203, 1205.
  - Others: `Highlight` (201, 823); `solid` border style (620, 1199); `row` flex direction (628, 1207); `color-scheme: light` (49) and `color-scheme: dark` (676).
- Role-token block 1279-1354 (declared once for every scope): keep it as var() / color-mix() formulas in phase 2. It re-resolves on each element, and on the dark code-panel island notion-palette.css 212-219 overrides `--palette-page`, `--palette-panel`, `--palette-rule` and `--palette-rule-soft` (to the code bg and its white mixes). So `--docs-page`, `--docs-panel`, `--docs-rule`, `--docs-rule-soft` and every formula built on them (`--docs-sunken`, `--docs-hover`, `--docs-guide`, `--docs-c-<hue>-line`, `--docs-diff-*-bg`) take island values that no pinned token holds. Its only literals are 1282 `5%`, 1283 `6%`, 1290 `45%`, 1335 `8%`, 1336 `8%`, 1351 `88%`, plus `transparent` at 1294. Page-level equalities, each checked against dist/json in light and dark:
  - Neutrals: `--docs-page`, `--docs-panel` == color.surface.page, color.surface.panel; `--docs-sunken` == color.surface.sunken; `--docs-hover` == color.fill.hover; `--docs-ink`, `--docs-text`, `--docs-muted`, `--docs-faint` == color.text.ink, body, muted, faint; `--docs-rule`, `--docs-rule-soft` == color.border.default, subtle; `--docs-guide` == color.border.guide.
  - Accents and chips: `--docs-link` == color.link; `--docs-accent` == color.accent; `--docs-focus-ring` == color.focus-ring; `--docs-selection` == color.selection; `--docs-tile-glyph` == color.text.on-solid; `--docs-chip-bg` == color.fill.chip; `--docs-chip-fg` == color.text.ink (not color.code.chip.ink, which is #d4d4d4 in dark).
  - Roster: `--docs-c-<hue>`, `-solid`, `-soft`, `-line` == color.<hue>.text, solid, soft, line; `--docs-c-amber` == color.amber.text.
  - Roles: `--docs-tone-info`, `-warning`, `-success`, `-risk` (each with `-solid`, `-soft`, `-line`) == color.status.info, warning, success, danger (risk == danger); `--docs-tone-decision` has no status token (it is color.violet.*); `--docs-cat-N`, `--docs-cat-N-soft` == color.category.N.text, soft; `--docs-diff-add`, `-del`, `-mod` == color.diff.add, del, mod; `--docs-diff-*-bg` == color.diff.*-bg.
  - Docs-only aliases with no ds token of their own: `--docs-fam-*` (text, code, tree, ref, flow = gray, blue, teal, violet, green) and `--docs-kind-*` (action, query, event = orange, blue, violet) alias hues. `--docs-syn-*` alias hues and neutrals (color.syntax.* is the VS Code code-panel set, not these); `--docs-syn-tag` (pink 88% into ink) matches no token.
- No literals: the dark-page code-panel rule 1363-1367 holds only var() references (`--palette-inset`, `--palette-rule`).

### packages/docs-workbench/web/src/theme/read-surface.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 40 | `--font-display: Inter, ui-sans-serif, system-ui, sans-serif;` | `--ds-font-family-sans` | Inter stack, exact (Spectre token name kept) |
| 41 | `--font-tx02: Inter, ui-sans-serif, system-ui, sans-serif;` | `--ds-font-family-sans` | Inter stack, exact |
| 42 | `--font-tx02-semicondensed: ui-sans-serif, system-ui, sans-serif;` | `local` | unused Spectre name; stack has no Inter, so --ds-font-family-sans would change it |
| 43 | `--font-tx02-condensed: ui-sans-serif, system-ui, sans-serif;` | `local` | unused Spectre name; stack has no Inter, so --ds-font-family-sans would change it |
| 47 | `--docs-font-code: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;` | `--ds-font-family-mono` | IBM Plex Mono stack, exact (style-rail Code font default) |
| 139 | `font-family: var(--font-tx02), ui-sans-serif, system-ui, sans-serif;` | `local` | fallback chain: literal families after the var; no token holds `var(...), ui-sans-serif, system-ui, sans-serif` |
| 164 | `font-family: var(--font-tx02), ui-sans-serif, system-ui, sans-serif;` | `local` | fallback chain: literal families after the var; no token holds `var(...), ui-sans-serif, system-ui, sans-serif` |
| 175 | `font-family: var(--font-tx02), ui-sans-serif, system-ui, sans-serif;` | `local` | fallback chain: literal families after the var; no token holds `var(...), ui-sans-serif, system-ui, sans-serif` |
| 184 | `font-size: var(--style-font-size, 18px);` | `--ds-font-size-reading` | fallback, rail stock default (18px) |
| 185 | `line-height: var(--style-line-height, 1.45);` | `--ds-line-height-reading` | fallback, rail stock default (1.45) |
| 186 | `letter-spacing: var(--style-letter-spacing, 0em);` | `--ds-letter-spacing-normal` | fallback, rail stock default (0em) |
| 203 | `font-size: var(--style-font-size, 18px);` | `--ds-font-size-reading` | fallback, rail stock default (18px) |
| 204 | `line-height: var(--style-line-height, 1.45);` | `--ds-line-height-reading` | fallback, rail stock default (1.45) |
| 205 | `letter-spacing: var(--style-letter-spacing, 0em);` | `--ds-letter-spacing-normal` | fallback, rail stock default (0em) |
| 209 | `font-family: var(--style-heading-font, var(--font-tx02)), ui-sans-serif, system-ui, sans-serif;` | `local` | fallback chain: literal families after the var; no token holds `var(...), ui-sans-serif, system-ui, sans-serif` |
| 253 | `font-size: calc(var(--style-font-size, 18px) * var(--docs-callout-body-text-scale, 1));` | `--ds-font-size-reading` | 18px: fallback, rail stock default; the scale fallback `1` stays local |
| 298 | `margin-top: 0;` | `--ds-space-0` | heading after a divider |
| 302 | `margin-top: 16px;` | `--ds-space-4` | h3 straight under its h2 |
| 306 | `margin-top: 0;` | `--ds-space-0` | text block under a heading |
| 310 | `transition: background 0.1s ease;` | `--ds-motion-duration-fast` / `--ds-motion-easing-standard` | 0.1s = 100ms; ease |

#### Stays local

- Unitless multipliers: 253 `1` (--docs-callout-body-text-scale fallback); 269 `1em` x2 (unit factor that turns the unitless --docs-inline-code-pad-* knobs into em)
- Keywords: 134 `none` (max-width)

### packages/docs-workbench/web/src/theme/style-rail.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 14 | `height: 1.75rem;` | `--ds-space-7` | rem->px 28px icon button |
| 15 | `width: 1.75rem;` | `--ds-space-7` | rem->px 28px |
| 18 | `border: 1px solid transparent;` | `--ds-border-width-hairline` |  |
| 32 | `height: 4px;` | `--ds-space-1` | range track height |
| 33 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 42 | `height: 12px;` | `--ds-space-3` | range thumb |
| 43 | `width: 12px;` | `--ds-space-3` | range thumb |
| 45 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 50 | `height: 12px;` | `--ds-space-3` | range thumb (Firefox) |
| 51 | `width: 12px;` | `--ds-space-3` | range thumb (Firefox) |
| 53 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 61 | `width: 30px;` | `local` | toggle track; off the 4px grid (nearest --ds-space-7 28px / --ds-space-8 32px) |
| 62 | `height: 17px;` | `local` | toggle track; nearest --ds-space-4 16px |
| 64 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 67 | `transition: background 150ms ease;` | `--ds-motion-duration-base` / `--ds-motion-easing-standard` | 150ms; ease |
| 73 | `top: 2px;` | `--ds-space-0-5` | knob inset |
| 74 | `left: 2px;` | `--ds-space-0-5` | knob inset |
| 75 | `height: 13px;` | `local` | knob = 17px track - 2 x 2px; nearest --ds-space-3 12px |
| 76 | `width: 13px;` | `local` | knob; nearest --ds-space-3 12px |
| 77 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 79 | `box-shadow: 0 0 0 1px var(--border);` | `--ds-border-width-hairline` | 1px ring drawn as shadow spread; `0 0 0` stays local |
| 80 | `transition: transform 150ms ease;` | `--ds-motion-duration-base` / `--ds-motion-easing-standard` | 150ms; ease |
| 88 | `transform: translateX(13px);` | `local` | knob travel = 30 - 13 - 2 x 2; nearest --ds-space-3 12px |
| 95 | `width: 2rem;` | `--ds-space-8` | rem->px 32px swatch |
| 96 | `height: 1.25rem;` | `--ds-space-5` | rem->px 20px swatch |
| 97 | `padding: 0;` | `--ds-space-0` |  |
| 98 | `border: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 105 | `padding: 1px;` | `local` | 1px swatch inset; no 1px space token (nearest --ds-space-0-5 2px); --ds-border-width-hairline is a border width, not spacing |
| 115 | `max-width: 9.5rem;` | `local` | rem->px 152px; no layout token |
| 116 | `border: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 120 | `font-size: 11px;` | `--ds-font-size-ui-2xs` | compact select |
| 121 | `padding: 0.25rem 0.375rem;` | `--ds-space-1` / `--ds-space-1-5` | rem->px 4px / 6px |
| 131 | `grid-template-columns: minmax(0, 1fr) 13rem;` | `local` | 13rem = 208px nav column (rem->px); nearest --ds-layout-sidebar-width 220px; `minmax(0, 1fr)` stays local |
| 147 | `padding: 1rem 1rem 0.75rem;` | `--ds-space-4` / `--ds-space-4` / `--ds-space-3` | rem->px 16px / 16px / 12px |
| 153 | `margin: 0;` | `--ds-space-0` |  |
| 155 | `font-size: 0.9375rem;` | `local` | rem->px 15px; nearest --ds-font-size-ui-lg 14px |
| 156 | `font-weight: 700;` | `--ds-font-weight-bold` |  |
| 157 | `letter-spacing: -0.01em;` | `local` | nearest --ds-letter-spacing-title -0.02em / --ds-letter-spacing-normal 0em |
| 161 | `margin: 0.125rem 0 0;` | `--ds-space-0-5` / `--ds-space-0` / `--ds-space-0` | rem->px 2px |
| 163 | `font-size: 0.75rem;` | `--ds-font-size-ui-xs` | rem->px 12px |
| 164 | `line-height: 1rem;` | `local` | rem->px 16px line box; no 16px line-height token (--ds-line-height-ui 1.5 gives 18px here) |
| 169 | `gap: 0.75rem;` | `--ds-space-3` | rem->px 12px |
| 170 | `padding: 0.75rem 1rem;` | `--ds-space-3` / `--ds-space-4` | rem->px 12px / 16px |
| 171 | `border-top: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 172 | `border-bottom: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 176 | `padding-bottom: 1rem;` | `--ds-space-4` | rem->px 16px |
| 184 | `margin-top: 0.375rem;` | `--ds-space-1-5` | rem->px 6px |
| 188 | `padding: 0.875rem 1rem 0.375rem;` | `local` / `--ds-space-4` / `--ds-space-1-5` | rem->px 14px (off grid; nearest --ds-space-3 12px) / 16px / 6px |
| 190 | `font-size: 0.6875rem;` | `--ds-font-size-ui-2xs` | rem->px 11px uppercase section label |
| 191 | `font-weight: 600;` | `--ds-font-weight-semibold` |  |
| 192 | `letter-spacing: 0.09em;` | `--ds-letter-spacing-micro` |  |
| 193 | `line-height: 1rem;` | `local` | rem->px 16px line box; no 16px line-height token |
| 198 | `width: 13rem;` | `local` | rem->px 208px nav column; nearest --ds-layout-sidebar-width 220px |
| 203 | `border-left: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 205 | `padding: 0.625rem 0.5rem;` | `local` / `--ds-space-2` | rem->px 10px (no 10px space; nearest --ds-space-2 8px / --ds-space-3 12px) / 8px |
| 209 | `padding: 0.625rem 0.625rem 0.25rem;` | `local` / `local` / `--ds-space-1` | rem->px 10px / 10px (off grid) / 4px |
| 211 | `font-size: 0.625rem;` | `--ds-font-size-micro` | rem->px 10px uppercase nav label |
| 212 | `font-weight: 600;` | `--ds-font-weight-semibold` |  |
| 213 | `letter-spacing: 0.09em;` | `--ds-letter-spacing-micro` |  |
| 214 | `line-height: 0.875rem;` | `local` | rem->px 14px line box; no 14px line-height token |
| 220 | `grid-template-columns: 0.875rem minmax(0, 1fr) auto;` | `local` | rem->px 14px icon column (nearest --ds-space-3 12px / --ds-space-4 16px); `minmax(0, 1fr) auto` stays local |
| 222 | `gap: 0.5rem;` | `--ds-space-2` | rem->px 8px |
| 224 | `min-height: 1.75rem;` | `--ds-space-7` | rem->px 28px nav row |
| 225 | `padding: 0.375rem 0.625rem;` | `--ds-space-1-5` / `local` | rem->px 6px / 10px (off grid) |
| 226 | `border: 0;` | `--ds-border-width-none` |  |
| 231 | `font-size: 0.75rem;` | `--ds-font-size-ui-xs` | rem->px 12px |
| 232 | `line-height: 1rem;` | `local` | rem->px 16px line box; no 16px line-height token |
| 242 | `outline: 2px solid var(--foreground);` | `--ds-border-width-focus` |  |
| 243 | `outline-offset: 1px;` | `local` | 1px offset; --ds-focus-ring-offset is 2px |
| 249 | `font-weight: 600;` | `--ds-font-weight-semibold` |  |
| 256 | `width: 0.875rem;` | `local` | rem->px 14px icon box; nearest --ds-space-3 12px / --ds-space-4 16px |
| 257 | `height: 0.875rem;` | `local` | rem->px 14px icon box |
| 262 | `width: 0.875rem;` | `local` | rem->px 14px icon box |
| 263 | `height: 0.875rem;` | `local` | rem->px 14px icon box |
| 274 | `gap: 0.1875rem;` | `local` | rem->px 3px; nearest --ds-space-0-5 2px / --ds-space-1 4px |
| 275 | `min-width: 0.75rem;` | `--ds-space-3` | rem->px 12px |
| 280 | `width: 5px;` | `local` | 5px dot; nearest --ds-space-1 4px / --ds-space-1-5 6px |
| 281 | `height: 5px;` | `local` | 5px dot |
| 283 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 289 | `font-size: 0.625rem;` | `--ds-font-size-micro` | rem->px 10px count |
| 291 | `line-height: 0.875rem;` | `local` | rem->px 14px line box; no 14px line-height token |
| 302 | `gap: 0.5rem;` | `--ds-space-2` | rem->px 8px |
| 307 | `width: 6px;` | `--ds-space-1-5` | 6px dot |
| 308 | `height: 6px;` | `--ds-space-1-5` | 6px dot |
| 310 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 315 | `border: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 321 | `padding: 0.5rem 0;` | `--ds-space-2` / `--ds-space-0` | rem->px 8px |
| 322 | `border: 0;` | `--ds-border-width-none` |  |
| 323 | `border-top: 1px solid var(--border);` | `--ds-border-width-hairline` |  |
| 327 | `font-size: 0.75rem;` | `--ds-font-size-ui-xs` | rem->px 12px |
| 337 | `outline: 2px solid var(--foreground);` | `--ds-border-width-focus` |  |
| 338 | `outline-offset: 1px;` | `local` | 1px offset; --ds-focus-ring-offset is 2px |
| 364 | `inset: 0;` | `--ds-space-0` | full-viewport grain layer |
| 366 | `z-index: 60;` | `--ds-z-top` | grain layer above all panels |
| 372 | `fill: #fff;` | `local` | grain effect internal, white in both themes; #ffffff equals only light-pinned on-solid / annotation-surface (unqualified on-solid is #0d1117 in dark) |
| 381 | `text-shadow: 0 0 var(--style-soften-font-glow, 0px)` | `local` | 0px blur: fallback, inert default when no rail var is set (the rail emits a computed px); no 0px blur token (--ds-blur-glass is 14px); `0 0` stays local |
| 386 | `filter: blur(var(--style-soften-icon-blur, 0px))` | `local` | 0px: fallback, inert default (not the rail stock value); no 0px blur token |
| 387 | `drop-shadow(0 0 var(--style-soften-icon-glow, 0px) currentColor);` | `local` | 0px glow: fallback, inert default; no 0px blur token; `0 0` stays local |

#### Stays local

- Opacities and multipliers: 354 `4`, 359 `1` (--docs-grain-auto-boost); 367 `0` (grain opacity fallback) and `1` (boost fallback); 388 `1` (icon opacity fallback)
- Percentages inside color-mix: 382 `22%`
- Zero shadow offsets / blur: 79 `0 0 0`; 381 `0 0`; 387 `0 0`
- Fluid / intrinsic sizes: 31, 223, 320 `100%`; 131 `minmax(0, 1fr)`; 220 `minmax(0, 1fr) auto`
- Layout resets and flex factors: `min-width: 0` 114, 133, 139, 300; `min-height: 0` 134, 140, 199; `flex-shrink: 0` 16, 63; `flex: 1 1 auto` 132; `flex: none` 282, 309
- Keywords: 18, 228, 316, 324, 382 `transparent`; 35 `outline: none`; 44, 52, 109 `border: none`; 89 `box-shadow: none`; 100 `background: none`; 230, 326 `font: inherit`; 267, 284, 295, 387 `currentColor`; 353 `overlay`, 358 and 368 `screen` (blend modes)

### packages/docs-workbench/web/src/theme/index.css

Imports only (`./notion-palette.css` line 6, `./semantic.css` line 7); no literals, no table.

### packages/docs-workbench/web/src/index.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 62 | `outline: 2px solid var(--docs-focus-ring);` | `--ds-border-width-focus` | shared focus ring |
| 63 | `outline-offset: 2px;` | `--ds-focus-ring-offset` |  |
| 90 | `width: calc(var(--docs-scrollbar-width, 10px) + var(--docs-scrollbar-padding, 0px) * 2);` | `local` / `--ds-space-0` | 10px: fallback, rail stock default; no 10px size token (nearest --ds-space-2 8px / --ds-space-3 12px; --ds-font-size-micro is a font size). 0px: fallback, rail stock default (scrollbar padding). `* 2` stays local |
| 91 | `height: calc(var(--docs-scrollbar-width, 10px) + var(--docs-scrollbar-padding, 0px) * 2);` | `local` / `--ds-space-0` | same as line 90 |
| 100 | `border: var(--docs-scrollbar-padding, 0px) solid transparent;` | `--ds-space-0` | fallback, rail stock default; the border is the padding knob (transparent-border trick), so space; --ds-border-width-none is equally exact |
| 102 | `border-radius: 999px;` | `--ds-radius-pill` | identical render (radius clamps at half the box) |
| 125 | `font-family: var(--style-heading-font, var(--font-tx02)), ui-sans-serif, system-ui, sans-serif;` | `local` | fallback chain: literal families after the var; no token holds `var(...), ui-sans-serif, system-ui, sans-serif` |
| 126 | `font-size: 2.25rem;` | `--ds-font-size-title` |  |
| 127 | `line-height: 1.2;` | `--ds-line-height-tight` |  |
| 128 | `font-weight: 700;` | `--ds-font-weight-bold` |  |
| 129 | `letter-spacing: -0.02em;` | `--ds-letter-spacing-title` |  |
| 132 | `margin: 0 0 var(--style-title-padding, 1.25rem);` | `--ds-space-0` / `--ds-space-0` / `--ds-space-5` | 1.25rem: fallback, rail stock default (rem->px 20px) |
| 187 | `initial-value: 100000px;` | `local` | fail-open sentinel of the registered lane property, not a design value |
| 191 | `--style-editor-text-lane: var(--style-content-width, 60ch);` | `--ds-layout-lane-text` | fallback, rail stock default (60ch) |
| 203 | `margin-top: 0;` | `--ds-space-0` |  |
| 217 | `box-shadow: 0 0 0 var(--docs-highlight-padding, 4px)` | `--ds-space-1` | 4px: fallback, rail stock default (highlight padding drawn as shadow spread); `0 0 0` stays local |
| 227 | `animation: docs-changed-flash 2s ease-out;` | `local` / `--ds-motion-easing-decelerate` | 2s flash: no duration token (longest is --ds-motion-duration-slow 260ms); ease-out |
| 228 | `border-radius: var(--docs-highlight-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius); rail stock radius 2 |
| 241 | `border-radius: var(--docs-highlight-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius); rail stock radius 2 |
| 242 | `box-shadow: 0 0 0 var(--docs-highlight-padding, 4px)` | `--ds-space-1` | 4px: fallback, rail stock default; `0 0 0` stays local |
| 297 | `z-index: 40;` | `--ds-z-overlay` | drag-select rubber band |
| 330 | `border-radius: var(--docs-dropcursor-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius); rail stock dropRadius 2 |
| 334 | `height: var(--docs-dropcursor-width, 3px) !important;` | `--ds-border-width-rail` | fallback, rail stock default (drop line) |
| 338 | `width: var(--docs-dropcursor-width, 3px) !important;` | `--ds-border-width-rail` | fallback, rail stock default (drop line) |
| 348 | `z-index: 20;` | `--ds-z-raised` | floating grip |
| 352 | `width: var(--docs-grip-size, 18px);` | `local` | 18px: fallback, rail stock default; off the space scale (nearest --ds-space-4 16px / --ds-space-5 20px; --ds-font-size-reading is a font size) |
| 353 | `height: calc(var(--docs-grip-size, 18px) * 4 / 3);` | `local` | 18px: fallback, rail stock default; `* 4 / 3` stays local |
| 364 | `transition: opacity var(--docs-grip-fade, 100ms) ease;` | `--ds-motion-duration-fast` / `--ds-motion-easing-standard` | 100ms: fallback, rail stock default; ease |
| 374 | `width: calc(var(--docs-grip-size, 18px) * 0.55);` | `local` | 18px: fallback, rail stock default; `* 0.55` stays local |

#### Stays local

- Unitless multipliers: 90, 91 `* 2`; 353 `* 4 / 3`; 374 `* 0.55`
- Opacities: 45 `outline-ring/50` (Tailwind 50% modifier); 97 `1` (--docs-scrollbar-opacity fallback) x `100%`; 286, 316 `0.3`; 302 `0.12` x `100%`; 329 `0.9`; 362 `0`; 368 `1`
- Zero shadow geometry: 217, 242 `0 0 0`; 222 `0 0 0 0` (keyframe end)
- Keywords: 98, 100, 110, 114, 221, 222, 271, 284, 303 `transparent`; 133, 244 `outline: none`; 272, 285 `box-shadow: none`; 375 `height: auto`

### packages/docs-workbench/web/src/pages/sequence-embed.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 15 | `--seq-bg: var(--docs-sequence-diagram-bg, #ffffff);` | `local` | fallback; @codecaine-ai/sequence package default; white diagram paper in both themes; #ffffff equals only light on-solid / annotation-surface (other roles) |
| 16 | `--seq-text: var(--docs-sequence-diagram-text, #252525);` | `local` | fallback; @codecaine-ai/sequence package default; no equal token |
| 17 | `--seq-accent: var(--docs-sequence-line, #c77d2e);` | `local` | fallback; @codecaine-ai/sequence package default; no equal token |
| 18 | `--seq-participant-fill: var(--docs-sequence-actor-fill, #fff8f0);` | `local` | fallback; @codecaine-ai/sequence package default; no equal token |
| 19 | `--seq-participant-stroke: var(--docs-sequence-actor-border, var(--docs-sequence-line, #c77d2e));` | `local` | fallback; @codecaine-ai/sequence package default; no equal token |
| 20 | `--seq-note-fill: var(--docs-sequence-note-bg, var(--docs-sequence-actor-fill, #fff8f0));` | `local` | fallback; @codecaine-ai/sequence package default; no equal token |
| 21 | `--seq-fragment-accent: var(--docs-sequence-fragment, #5b7fbd);` | `local` | fallback; @codecaine-ai/sequence package default; no equal token |
| 27 | `border: var(--docs-sequence-border-width, 1px) solid var(--docs-sequence-border, var(--border));` | `--ds-border-width-hairline` | fallback (semantic.css default) |
| 28 | `border-radius: var(--docs-sequence-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius) |
| 36 | `gap: 0.5rem;` | `--ds-space-2` | rem->px 8px |
| 38 | `padding: var(--docs-sequence-padding, 12px);` | `--ds-space-3` | fallback (semantic.css default) |
| 46 | `max-height: min(var(--docs-sequence-max-height, 420px), 55vh);` | `local` / `local` | 420px: fallback (semantic.css default), off-scale (nearest --ds-layout-inspector-width 360px); 55vh: viewport cap, no token |
| 52 | `gap: 0.375rem;` | `--ds-space-1-5` | rem->px 6px |
| 55 | `font-size: var(--docs-sequence-expand-text-size, 12px);` | `--ds-font-size-ui-xs` | fallback (semantic.css default) |
| 59 | `outline: 2px solid var(--ring);` | `--ds-border-width-focus` |  |
| 60 | `outline-offset: -3px;` | `local` | inset ring (negative offset); --ds-focus-ring-offset is +2px |
| 65 | `inset: 0;` | `--ds-space-0` |  |
| 70 | `margin: 0;` | `--ds-space-0` |  |
| 71 | `padding: 0;` | `--ds-space-0` |  |
| 72 | `border: 0;` | `--ds-border-width-none` |  |
| 96 | `outline: 2px solid var(--ring);` | `--ds-border-width-focus` |  |
| 97 | `outline-offset: -2px;` | `local` | inset ring (negative offset) |
| 103 | `top: 0;` | `--ds-space-0` |  |
| 104 | `left: 0;` | `--ds-space-0` |  |

#### Stays local

- Fluid / intrinsic sizes: 37, 44, 109 `100%`; 110 `100% !important`; 45 `height: auto`; 66 `100vw`; 67 `100dvh`
- Layout resets and flex factors: 25 `min-width: 0`; 84 `min-height: 0`; 83 `flex: 1`
- Coordinates: 105 `transform-origin: 0 0`
- Keywords: 29 `transparent` (fallback); 54 `currentColor` (fallback); 68 `max-width: none`; 69 `max-height: none`

### packages/docs-workbench/web/src/shell/export-dialog.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 1 | `.pdf-export-dialog{width:min(640px,calc(100vw - 32px))}` | `local` | `640px`: dialog width cap; no token (nearest --ds-layout-inspector-width 360px / --ds-layout-lane-wide 1100px) |
| 1 | `.pdf-export-dialog{width:min(640px,calc(100vw - 32px))}` | `--ds-space-8` | `32px`: viewport gutter (16px a side) |
| 1 | `.pdf-export-dialog{max-height:85vh}` | `local` | `85vh`: viewport cap; no token |
| 1 | `.pdf-export-dialog{padding:24px}` | `--ds-space-6` | `24px` |
| 1 | `.pdf-export-dialog{border:1px solid var(--border)}` | `--ds-border-width-hairline` | `1px` |
| 1 | `.pdf-export-dialog{border-radius:var(--radius,2px)}` | `--ds-radius-base` | `2px`: fallback (stock --radius) |
| 1 | `.pdf-export-dialog{font:14px/1.5 system-ui,sans-serif}` | `--ds-font-size-ui-lg` | `14px` (size) |
| 1 | `.pdf-export-dialog{font:14px/1.5 system-ui,sans-serif}` | `--ds-line-height-ui` | `1.5` (line height) |
| 1 | `.pdf-export-dialog{font:14px/1.5 system-ui,sans-serif}` | `local` | `system-ui,sans-serif` (family): differs from --ds-font-family-sans (Inter first); swapping it moves pixels |
| 1 | `.pdf-export-dialog{box-shadow:0 20px 80px #0004}` | `--ds-shadow-dialog` | whole shadow = shadow.dialog `0 20px 80px #00000044`; the rule is theme-independent and the token is identical in both themes, so the unqualified var |
| 2 | `.pdf-export-dialog::backdrop{background:#0006}` | `--ds-color-backdrop` | `#0006` = #00000066; identical in both themes and the rule is theme-independent, so the unqualified var |
| 2 | `.pdf-export-dialog header,.pdf-export-dialog footer,.pdf-selection-actions,.pdf-tree-row{gap:12px}` | `--ds-space-3` | `12px` |
| 3 | `.pdf-export-dialog h2{font-size:20px}` | `local` | `20px`: no font-size token (nearest --ds-font-size-reading 18px / --ds-font-size-title 36px) |
| 3 | `.pdf-export-dialog h2{font-weight:600}` | `--ds-font-weight-semibold` | `600` |
| 3 | `.pdf-export-dialog h2{margin:0}` | `--ds-space-0` | `0` |
| 3 | `.pdf-export-dialog p{margin:12px 0}` | `--ds-space-3` | `12px` |
| 3 | `.pdf-export-dialog p{margin:12px 0}` | `--ds-space-0` | `0` |
| 4 | `.pdf-export-dialog fieldset{border:0}` | `--ds-border-width-none` | `0` |
| 4 | `.pdf-export-dialog fieldset{padding:0}` | `--ds-space-0` | `0` |
| 4 | `.pdf-export-dialog fieldset{margin:0}` | `--ds-space-0` | `0` |
| 4 | `.pdf-export-dialog button{border:1px solid var(--border)}` | `--ds-border-width-hairline` | `1px` |
| 4 | `.pdf-export-dialog button{border-radius:var(--radius,2px)}` | `--ds-radius-base` | `2px`: fallback (stock --radius) |
| 4 | `.pdf-export-dialog button{padding:6px 12px}` | `--ds-space-1-5` | `6px` |
| 4 | `.pdf-export-dialog button{padding:6px 12px}` | `--ds-space-3` | `12px` |
| 5 | `.pdf-export-dialog :focus-visible{outline:2px solid var(--foreground)}` | `--ds-border-width-focus` | `2px` |
| 5 | `.pdf-export-dialog :focus-visible{outline-offset:2px}` | `--ds-focus-ring-offset` | `2px` |
| 5 | `.pdf-selection{max-height:32vh}` | `local` | `32vh`: viewport cap; no token |
| 5 | `.pdf-selection{border:1px solid var(--border)}` | `--ds-border-width-hairline` | `1px` |
| 5 | `.pdf-selection{border-radius:var(--radius,2px)}` | `--ds-radius-base` | `2px`: fallback (stock --radius) |
| 5 | `.pdf-selection{padding:8px}` | `--ds-space-2` | `8px` |
| 5 | `.pdf-selection{margin:8px 0 18px}` | `--ds-space-2` | `8px` |
| 5 | `.pdf-selection{margin:8px 0 18px}` | `--ds-space-0` | `0` |
| 5 | `.pdf-selection{margin:8px 0 18px}` | `local` | `18px`: off grid (nearest --ds-space-4 16px / --ds-space-5 20px) |
| 5 | `.pdf-tree{padding:0!important}` | `--ds-space-0` | `0` |
| 5 | `.pdf-tree{margin:0!important}` | `--ds-space-0` | `0` |
| 5 | `.pdf-tree .pdf-tree{padding-left:20px!important}` | `--ds-space-5` | `20px` nested tree indent |
| 5 | `.pdf-tree-row{min-height:32px}` | `--ds-space-8` | `32px` |
| 5 | `.pdf-tree-row{gap:4px}` | `--ds-space-1` | `4px` |
| 5 | `.pdf-tree-row label{gap:8px}` | `--ds-space-2` | `8px` |
| 5 | `.pdf-tree-row button{font-size:11px}` | `--ds-font-size-ui-2xs` | `11px` |
| 5 | `.pdf-tree-row button{padding:2px 6px}` | `--ds-space-0-5` | `2px` |
| 5 | `.pdf-tree-row button{padding:2px 6px}` | `--ds-space-1-5` | `6px` |
| 5 | `.pdf-selection-actions button{font-size:12px}` | `--ds-font-size-ui-xs` | `12px` |
| 5 | `.pdf-selection-actions button{padding:4px 8px}` | `--ds-space-1` | `4px` |
| 5 | `.pdf-selection-actions button{padding:4px 8px}` | `--ds-space-2` | `8px` |
| 6 | `.pdf-format{gap:6px}` | `--ds-space-1-5` | `6px` |
| 6 | `.pdf-format{font-weight:500}` | `--ds-font-weight-medium` | `500` |
| 6 | `.pdf-format select{padding:9px}` | `local` | `9px`: off grid (nearest --ds-space-2 8px) |
| 6 | `.pdf-format select{border:1px solid var(--border)}` | `--ds-border-width-hairline` | `1px` |
| 6 | `.pdf-format select{border-radius:var(--radius,2px)}` | `--ds-radius-base` | `2px`: fallback (stock --radius) |
| 6 | `.pdf-format-note{font-size:12px}` | `--ds-font-size-ui-xs` | `12px` |
| 6 | `.pdf-export-dialog footer{margin-top:20px}` | `--ds-space-5` | `20px` |
| 6 | `.pdf-export-dialog .pdf-error{color:#c33}` | `local` | `#c33`: no token equals #cc3333; candidate for --ds-color-status-danger-text later (would change pixels) |
| 6 | `.pdf-downloads{max-height:150px}` | `local` | `150px`: off every scale (space tops out at 64px) |
| 6 | `.pdf-downloads{margin-top:12px}` | `--ds-space-3` | `12px` |
| 6 | `.pdf-downloads p{font-size:12px}` | `--ds-font-size-ui-xs` | `12px` |

#### Stays local

- Fluid sizes: 1 `100vw` (inside the width calc); 6 `.pdf-format select{width:100%}`
- Layout resets and flex factors: 4 `fieldset{min-width:0}`; 5 `.pdf-tree-row label{min-width:0}`; 5 `.pdf-tree-row input{flex-shrink:0}`
- Opacities: 4 `button:disabled{opacity:.5}`
- Keywords: 1 `margin:auto`; 4 `button{font:inherit}`; 5 `.pdf-selection-actions span{margin-right:auto}`; 6 `select{color:inherit;font:inherit}`

### packages/docs-viewer/src/styles/code.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 24 | `font-family: var(--docs-font-code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);` | `local` | host fallback stack; equals no token (--ds-font-family-mono adds "IBM Plex Mono" first; --ds-font-family-mono-system adds 'SF Mono' and drops Monaco/Consolas) |
| 71 | `color: var(--syntax-key, var(--color-text-purple, #9065b0));` | `local` | host fallback, no equal token (docs-system --color-text-purple is #6940a5) |
| 88 | `color: var(--syntax-keyword, var(--syntax-boolean, var(--color-text-orange, #d9730d)));` | `--ds-light-color-notion-text-orange` | host fallback of --color-text-orange; exact equal (legacy Notion var 1:1) |
| 100 | `color: var(--syntax-selector, var(--syntax-key, var(--color-text-purple, #9065b0)));` | `local` | host fallback, no equal token |
| 108 | `color: var(--syntax-string, var(--color-text-green, #448361));` | `local` | host fallback, no equal token (docs-system --color-text-green is #0f7b6c) |
| 122 | `color: var(--syntax-comment, var(--docs-text-tertiary, var(--color-text-gray, gray)));` | `local` | `gray` (#808080): host fallback, no equal token (docs-system --color-text-gray is #9b9a97) |
| 135 | `color: var(--syntax-keyword, var(--syntax-key, var(--color-text-purple, #9065b0)));` | `local` | host fallback, no equal token |
| 143 | `color: var(--syntax-control, var(--syntax-keyword, var(--syntax-key, var(--color-text-purple, #9065b0))));` | `local` | host fallback, no equal token |
| 155 | `color: var(--syntax-key, var(--color-text-purple, #9065b0));` | `local` | host fallback, no equal token |
| 163 | `color: var(--syntax-constant, var(--syntax-number, var(--color-text-blue, #337ea9)));` | `local` | host fallback, no equal token (docs-system --color-text-blue is #0b6e99) |
| 173 | `color: var(--syntax-function, var(--syntax-string, var(--color-text-green, #448361)));` | `local` | host fallback, no equal token |
| 182 | `color: var(--syntax-type, var(--syntax-string, var(--color-text-green, #448361)));` | `local` | host fallback, no equal token |
| 188 | `color: var(--syntax-tag, var(--syntax-key, var(--color-text-purple, #9065b0)));` | `local` | host fallback, no equal token |
| 194 | `color: var(--syntax-regex, var(--syntax-string, var(--color-text-green, #448361)));` | `local` | host fallback, no equal token |
| 200 | `color: var(--syntax-number, var(--color-text-blue, #337ea9));` | `local` | host fallback, no equal token |
| 218 | `color: var(--syntax-boolean, var(--color-text-orange, #d9730d));` | `--ds-light-color-notion-text-orange` | host fallback of --color-text-orange; exact equal |
| 231 | `color: var(--syntax-null, var(--color-text-red, #d44c47));` | `local` | host fallback, no equal token (docs-system --color-text-red is #e03e3e) |
| 237 | `font-weight: 600;` | `--ds-font-weight-semibold` |  |
| 246 | `color: var(--docs-diff-del, var(--status-danger, #c62121));` | `--ds-light-color-red-text` | fallback; = light --palette-red (via --docs-c-red); diff.del and status.danger.text alias it |
| 250 | `color: var(--docs-diff-add, var(--status-success, #26744f));` | `--ds-light-color-green-text` | fallback; = light --palette-green (via --docs-c-green); diff.add and status.success.text alias it |
| 256 | `border-top-width: 0;` | `--ds-border-width-none` |  |
| 257 | `border-left-width: 0;` | `--ds-border-width-none` |  |
| 258 | `border-right-width: 0;` | `--ds-border-width-none` |  |
| 274 | `grid-template-columns: var(--docs-code-gutter-width, 40px) minmax(0, max-content) minmax(16ch, 1fr);` | `--ds-space-10` / `local` | 40px: fallback (semantic.css default), code gutter width; 16ch: comment column minimum, no ch token besides the 60ch/88ch lanes |
| 275 | `padding-top: var(--docs-code-pad-top, 12px);` | `--ds-space-3` | fallback (semantic.css default) |
| 276 | `padding-bottom: var(--docs-code-pad-bottom, 12px);` | `--ds-space-3` | fallback (semantic.css default) |
| 277 | `font-size: var(--docs-code-text-size, 13px);` | `--ds-font-size-code` | fallback (semantic.css default); monospace code text |
| 278 | `line-height: var(--docs-code-line-height, 21px);` | `--ds-line-height-code` | fallback (semantic.css default) |
| 282 | `grid-template-columns: var(--docs-code-gutter-width, 40px) 2ch minmax(0, max-content) minmax(16ch, 1fr);` | `--ds-space-10` / `local` / `local` | 40px: fallback (semantic.css default); 2ch sign column and 16ch comment minimum: no ch token |
| 294 | `padding-right: var(--docs-code-gutter-pad-x, 12px);` | `--ds-space-3` | fallback (semantic.css default) |
| 296 | `font-size: var(--docs-code-gutter-text-size, 12px);` | `--ds-font-size-ui-xs` | fallback (semantic.css default); line numbers |
| 298 | `color: var(--docs-code-gutter-fg, #888784);` | `local` | fallback; no equal token (light gutter-fg is a color-mix, dark is #858585) |
| 304 | `padding-left: var(--docs-code-pad-x, 12px);` | `--ds-space-3` | fallback (semantic.css default) |
| 311 | `padding-right: var(--docs-code-pad-x, 12px);` | `--ds-space-3` | fallback (semantic.css default) |
| 317 | `padding: 0 var(--docs-code-pad-x, 12px) 0 4ch;` | `--ds-space-0` / `--ds-space-3` / `--ds-space-0` / `local` | 12px: fallback (semantic.css default); 4ch comment gap: no ch token |
| 330 | `padding-right: 6px;` | `--ds-space-1-5` |  |
| 334 | `padding-left: 4px;` | `--ds-space-1` |  |
| 339 | `font-weight: 600;` | `--ds-font-weight-semibold` |  |
| 344 | `background-color: color-mix(in srgb, var(--docs-diff-add, #26744f) 8%, transparent);` | `--ds-light-color-green-text` | fallback; `8%` stays local |
| 348 | `background-color: color-mix(in srgb, var(--docs-diff-del, #c62121) 8%, transparent);` | `--ds-light-color-red-text` | fallback; `8%` stays local |
| 352 | `color: var(--docs-diff-add, #26744f);` | `--ds-light-color-green-text` | fallback |
| 356 | `color: var(--docs-diff-del, #c62121);` | `--ds-light-color-red-text` | fallback |
| 361 | `text-decoration-color: color-mix(in srgb, var(--docs-diff-del, #c62121) 70%, transparent);` | `--ds-light-color-red-text` | fallback; `70%` stays local |

#### Stays local

- Percentages inside color-mix: 344 `8%`; 348 `8%`; 361 `70%`
- Fluid tracks and grid counts: 274, 282 `minmax(0, max-content)` and `1fr`; 287 `grid-column: 1 / -1`; 310 `grid-column: span 2`
- Layout resets: 303, 316 `min-width: 0`
- Keywords: per-role font-style fallback `normal`: 56, 72, 82, 89, 101, 109, 116, 123, 136, 144, 156, 164, 174, 183, 189, 195, 201, 208, 219, 232
- Keywords: per-role font-weight fallback `inherit`: 57, 73, 83, 90, 102, 110, 117, 124, 137, 145, 157, 165, 175, 184, 190, 196, 202, 209, 220, 233
- Other keywords: 54 `background: transparent`; 55, 81, 115, 207 `inherit` (--color-text-default fallback); 64 `Highlight`; 241 `font-style: italic`; 344, 348, 361 `transparent`

### packages/docs-viewer/src/styles/image-grid.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 4 | `grid-template-columns: repeat(auto-fit, minmax(min(100%, max(220px, calc((100% - (var(--docs-grid-columns, 4) - 1) * 20px) / var(--docs-grid-columns, 4)))), 1fr));` | `local` / `--ds-space-5` | 220px min image track: equals --ds-layout-sidebar-width by value only (unrelated role), so local; 20px is the column gap of line 5 inside the calc |
| 5 | `gap: 24px 20px;` | `--ds-space-6` / `--ds-space-5` | row gap / column gap |
| 6 | `margin: 24px 0;` | `--ds-space-6` / `--ds-space-0` |  |
| 11 | `margin: 0;` | `--ds-space-0` |  |
| 16 | `background: var(--docs-panel, #f8f8f7);` | `--ds-light-color-surface-panel` | fallback (--docs-panel light value) |
| 17 | `border: var(--docs-image-border-width, 1px) solid var(--docs-image-border, #e6e5e3);` | `--ds-border-width-hairline` / `--ds-light-color-border-default` | fallbacks (1px knob default; --docs-image-border light value) |
| 18 | `border-radius: var(--docs-image-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius) |
| 24 | `min-height: 32px;` | `--ds-space-8` | panel header strip |
| 25 | `padding: 6px 12px;` | `--ds-space-1-5` / `--ds-space-3` |  |
| 26 | `background: var(--docs-panel, #f8f8f7);` | `--ds-light-color-surface-panel` | fallback |
| 27 | `border-bottom: 1px solid var(--docs-rule-soft, #efeeec);` | `--ds-border-width-hairline` / `--ds-light-color-border-subtle` | #efeeec: fallback (--docs-rule-soft light value) |
| 30 | `margin: 0;` | `--ds-space-0` |  |
| 32 | `font-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 33 | `font-weight: 600;` | `--ds-font-weight-semibold` |  |
| 34 | `line-height: 1.3;` | `local` | no 1.3 line height (nearest --ds-line-height-tight 1.2 / --ds-line-height-reading 1.45) |
| 35 | `color: var(--docs-ink, #1f1f1f);` | `--ds-light-color-text-ink` | fallback (--docs-ink light value) |
| 38 | `margin: 0;` | `--ds-space-0` |  |
| 41 | `margin-top: 8px;` | `--ds-space-2` | caption gap |
| 42 | `font-size: 13.5px;` | `--ds-font-size-ui-md` |  |
| 43 | `line-height: 1.5;` | `--ds-line-height-ui` |  |
| 44 | `color: var(--docs-muted, #666562);` | `--ds-light-color-text-muted` | fallback (--docs-muted light value) |

#### Stays local

- Fluid sizes and counts: 4 `100%` x2, `auto-fit`, `1fr`, column-count fallback `4` x2 and `- 1`; 7 `width: 100%`; 38 `width: 100%`, `max-width: 100%`, `height: auto`
- Layout resets: 8, 11, 31 `min-width: 0`

### packages/docs-viewer/src/styles/image-viewer.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 7 | `margin: 0;` | `--ds-space-0` |  |
| 8 | `padding: 0;` | `--ds-space-0` |  |
| 9 | `border: 0;` | `--ds-border-width-none` |  |
| 24 | `top: 8px;` | `--ds-space-2` | hint inset |
| 25 | `right: 8px;` | `--ds-space-2` | hint inset |
| 28 | `width: 28px;` | `--ds-space-7` | 28px hint box |
| 29 | `height: 28px;` | `--ds-space-7` | 28px hint box |
| 30 | `border: 1px solid var(--docs-rule, #e6e5e3);` | `--ds-border-width-hairline` / `--ds-light-color-border-default` | #e6e5e3: fallback (--docs-rule light value) |
| 31 | `border-radius: var(--radius, 2px);` | `--ds-radius-base` | fallback (stock --radius) |
| 32 | `background: var(--docs-page, #fdfdfd);` | `--ds-light-color-surface-page` | fallback (--docs-page light value) |
| 33 | `color: var(--docs-ink, #1f1f1f);` | `--ds-light-color-text-ink` | fallback (--docs-ink light value) |
| 35 | `transition: opacity 120ms ease-out;` | `local` / `--ds-motion-easing-decelerate` | 120ms: no token (between --ds-motion-duration-fast 100ms and -base 150ms); ease-out |
| 44 | `outline: 2px solid var(--docs-focus-ring, #0078df);` | `--ds-border-width-focus` / `--ds-light-color-focus-ring` | #0078df: fallback (--docs-focus-ring light value) |
| 45 | `outline-offset: 2px;` | `--ds-focus-ring-offset` |  |
| 51 | `outline-offset: -2px;` | `local` | inset ring (negative offset); --ds-focus-ring-offset is +2px |
| 56 | `inset: 0;` | `--ds-space-0` |  |
| 61 | `margin: 0;` | `--ds-space-0` |  |
| 62 | `padding: 0;` | `--ds-space-0` |  |
| 63 | `border: 0;` | `--ds-border-width-none` |  |
| 87 | `outline: 2px solid var(--docs-focus-ring, #0078df);` | `--ds-border-width-focus` / `--ds-light-color-focus-ring` | #0078df: fallback |
| 88 | `outline-offset: -2px;` | `local` | inset ring (negative offset) |
| 94 | `top: 0;` | `--ds-space-0` |  |
| 95 | `left: 0;` | `--ds-space-0` |  |

#### Stays local

- Opacities: 34 `0`; 40 `1`
- Fluid / intrinsic sizes: 5 `fit-content`; 6 `max-width: 100%`; 19 `width: 100%`; 57 `100vw`; 58 `100dvh`
- Layout resets and flex factors: 74 `flex: 1`; 75 `min-height: 0`
- Coordinates: 98 `transform-origin: 0 0`
- Keywords: 10 `background: none`; 59, 96 `max-width: none`; 60, 97 `max-height: none`

### packages/docs-viewer/src/styles/list-markers.css

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 7 | `color: var(--docs-list-marker-fg, #666562);` | `--ds-light-color-text-muted` | fallback (semantic.css default --docs-muted, light value) |
| 11 | `width: var(--docs-list-indent, 1.5rem);` | `--ds-space-6` | fallback, rail stock default (rem->px 24px marker column = indent step) |
| 12 | `height: 1.7em;` | `local` | pre-`lh` fallback box height; em-relative, no token |
| 48 | `padding-right: 8px;` | `--ds-space-2` |  |
| 50 | `font-family: var(--docs-font-numeric, var(--docs-font-code, ui-monospace, SFMono-Regular, Menlo, monospace));` | `local` | fallback stack; equals no token (--ds-font-family-mono-system adds 'SF Mono') |
| 58 | `font-size: 0.8125em;` | `local` | em-relative numeral size (14.625px on the 18px body); no relative font-size token |
| 59 | `font-weight: 500;` | `--ds-font-weight-medium` |  |
| 127 | `width: var(--docs-list-disc-size, 6px);` | `--ds-space-1-5` | fallback, rail stock default (disc) |
| 128 | `height: var(--docs-list-disc-size, 6px);` | `--ds-space-1-5` | fallback, rail stock default (disc) |
| 129 | `border: 0;` | `--ds-border-width-none` |  |
| 130 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 143 | `width: var(--docs-list-circle-size, 6px);` | `--ds-space-1-5` | fallback, rail stock default (circle) |
| 144 | `height: var(--docs-list-circle-size, 6px);` | `--ds-space-1-5` | fallback, rail stock default (circle) |
| 145 | `border: var(--docs-list-circle-thickness, 1.5px) solid currentColor;` | `--ds-border-width-ring` | fallback, rail stock default (circle stroke) |
| 146 | `border-radius: 9999px;` | `--ds-radius-pill` |  |
| 164 | `width: var(--docs-list-square-size, 5px);` | `local` | 5px square: fallback, rail stock default; nearest --ds-space-1 4px / --ds-space-1-5 6px |
| 165 | `height: var(--docs-list-square-size, 5px);` | `local` | 5px square: fallback, rail stock default |
| 166 | `border: 0;` | `--ds-border-width-none` |  |
| 167 | `border-radius: 0;` | `--ds-radius-none` |  |
| 189 | `margin-top: calc(var(--docs-list-item-gap, 4px) * 3);` | `--ds-space-1` | 4px: fallback (semantic.css default; theme-folder token, not a rail knob); `* 3` stays local |
| 190 | `margin-bottom: calc(var(--docs-list-item-gap, 4px) * 3);` | `--ds-space-1` | 4px: fallback (semantic.css default); `* 3` stays local |
| 194 | `font-weight: 600;` | `--ds-font-weight-semibold` | label parent |
| 195 | `color: var(--docs-ink, #1f1f1f);` | `--ds-light-color-text-ink` | fallback (--docs-ink light value) |
| 198 | `font-weight: 400;` | `--ds-font-weight-regular` |  |

#### Stays local

- Unitless multipliers: 189, 190 `* 3`
- Fluid sizes: 13 `1lh`
- Keywords: 6 `inherit` (font-family fallback); 14 `line-height: inherit`; 131, 145, 168 `currentColor`; 147 `transparent`

### packages/docs-publish/src/styles.css

No palette duplication: it imports the workbench token layer (`theme/index.css` = notion-palette.css + semantic.css, line 11) and the viewer/read-surface sheets, and declares no palette values of its own. The diagram chrome below is a static-export one-off.

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 36 | `text-shadow: 0 0 var(--style-soften-font-glow, 0px) color-mix(in srgb, var(--foreground) 22%, transparent);` | `local` | 0px: fallback, inert default (docsThemeHead emits the var); no 0px blur token (--ds-blur-glass is 14px) |
| 42 | `margin:2rem 0` | `--ds-space-8` / `--ds-space-0` | rem->px 32px |
| 42 | `border:1px solid var(--border)` | `--ds-border-width-hairline` |  |
| 42 | `border-radius:var(--radius,2px)` | `--ds-radius-base` | fallback (stock --radius) |
| 43 | `padding:14px 60px 14px 18px` | `local` / `local` / `local` / `local` | static-export one-off: 14px / 60px / 14px / 18px all off the space scale (nearest 12-16 / 64 / 12-16 / 16-20px) |
| 43 | `font-weight:600` | `--ds-font-weight-semibold` |  |
| 44 | `background:#fff` | `local` | static-export one-off: white diagram paper in both themes; #ffffff equals only light on-solid / annotation-surface |
| 45 | `margin:0` | `--ds-space-0` |  |
| 45 | `padding:0` | `--ds-space-0` |  |
| 45 | `border:0` | `--ds-border-width-none` |  |
| 46 | `top:8px` | `--ds-space-2` |  |
| 46 | `right:12px` | `--ds-space-3` |  |
| 46 | `width:36px` | `local` | nearest --ds-space-8 32px / --ds-space-10 40px |
| 46 | `height:36px` | `local` | nearest --ds-space-8 32px / --ds-space-10 40px |
| 46 | `border:1px solid #ccc` | `--ds-border-width-hairline` / `local` | #ccc equals only --ds-dark-color-code-header-fg (other role, dark only) |
| 46 | `border-radius:var(--radius,2px)` | `--ds-radius-base` | fallback (stock --radius) |
| 46 | `background:#fff` | `local` | static-export one-off (see line 44) |
| 46 | `color:#222` | `local` | no token equals #222222 |
| 46 | `font-size:25px` | `local` | no font-size token (nearest --ds-font-size-reading 18px / --ds-font-size-title 36px) |

#### Stays local

- Percentages inside color-mix: 36 `22%`
- Zero shadow offsets: 36 `0 0`
- Fluid sizes: 45 `width:100%`, `height:auto`
- Keywords: 36 `transparent`; 45 `max-height:none`

### packages/docs-publish/src/editor.css

The `.docs-draft-editor` block (lines 63-102) is a host-fallback palette. Exact-equal check: only `#fff` equals a token (light-pinned `--ds-light-color-text-on-solid` / `-annotation-surface`, unrelated roles); `#222`, `#2563eb`, `#f1f1ef`, `#d44c47`, `#2383e2`, `#448361`, `#cb912f` and every color-mix recipe equal no token. All stay local; metrics follow the rules.

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 40 | `--radius-sm: var(--radius, 2px);` | `--ds-radius-base` | fallback (stock --radius) |
| 41 | `--radius-md: var(--radius, 2px);` | `--ds-radius-base` | fallback (stock --radius) |
| 42 | `--radius-lg: var(--radius, 2px);` | `--ds-radius-base` | fallback (stock --radius) |
| 43 | `--radius-xl: var(--radius, 2px);` | `--ds-radius-base` | fallback (stock --radius) |
| 44 | `--font-display: Inter, ui-sans-serif, system-ui, sans-serif;` | `--ds-font-family-sans` | Inter stack, exact |
| 64 | `--background: var(--color-bg-default, #fff);` | `local` | host-fallback palette; --color-bg-default is #fdfdfd in docs-system; #fff equals only light on-solid / annotation-surface |
| 65 | `--foreground: var(--color-text-default, #222);` | `local` | host-fallback palette; no token equals #222222 (--color-text-default is #2a2a2a) |
| 68 | `--popover: var(--color-bg-default, #fff);` | `local` | host-fallback palette; see line 64 |
| 69 | `--popover-foreground: var(--color-text-default, #222);` | `local` | host-fallback palette; see line 65 |
| 70 | `--primary: var(--color-text-navigation, #2563eb);` | `local` | host-fallback palette; no equal token (--color-text-navigation is #245a81) |
| 71 | `--primary-foreground: var(--color-bg-default, #fff);` | `local` | host-fallback palette; see line 64 |
| 72 | `--secondary: var(--color-bg-sidebar, #f1f1ef);` | `local` | host-fallback palette; no equal token (--color-bg-sidebar is #f9f9f9) |
| 78 | `--destructive: #d44c47;` | `local` | host-fallback palette; no equal token (red.solid #e03e3e, red.text #c62121) |
| 82 | `--radius: 2px;` | `--ds-radius-base` | host metric; follows the rules |
| 83 | `--status-info: #2383e2;` | `local` | host-fallback palette; no equal token (status info #0b6e99) |
| 84 | `--status-info-fill: color-mix(in srgb, #2383e2 10%, transparent);` | `local` | host-fallback palette; `10%` stays local |
| 85 | `--status-info-border: color-mix(in srgb, #2383e2 35%, transparent);` | `local` | host-fallback palette; `35%` stays local |
| 86 | `--status-success: #448361;` | `local` | host-fallback palette; no equal token (status success #26744f) |
| 87 | `--status-success-fill: color-mix(in srgb, #448361 10%, transparent);` | `local` | host-fallback palette |
| 88 | `--status-success-border: color-mix(in srgb, #448361 35%, transparent);` | `local` | host-fallback palette |
| 89 | `--status-warning: #cb912f;` | `local` | host-fallback palette; no equal token (amber.text #9a5b00, yellow.solid #dfab01) |
| 90 | `--status-warning-fill: color-mix(in srgb, #cb912f 12%, transparent);` | `local` | host-fallback palette |
| 91 | `--status-warning-border: color-mix(in srgb, #cb912f 35%, transparent);` | `local` | host-fallback palette |
| 92 | `--status-danger: #d44c47;` | `local` | host-fallback palette; see line 78 |
| 93 | `--status-danger-fill: color-mix(in srgb, #d44c47 10%, transparent);` | `local` | host-fallback palette |
| 94 | `--status-danger-border: color-mix(in srgb, #d44c47 35%, transparent);` | `local` | host-fallback palette |
| 98 | `--color-bg-blue: color-mix(in srgb, #2383e2 14%, transparent);` | `local` | host-fallback palette; --color-bg-blue is #ddebf1 in docs-system |
| 99 | `--color-text-blue: #2383e2;` | `local` | host-fallback palette; --color-text-blue is #0b6e99 in docs-system |
| 109 | `border-width: 0;` | `--ds-border-width-none` |  |
| 109 | `border-radius: 0;` | `--ds-radius-none` |  |
| 109 | `margin: 0;` | `--ds-space-0` |  |
| 109 | `padding: 0;` | `--ds-space-0` |  |
| 116 | `margin-inline: 0;` | `--ds-space-0` | figure side margins |
| 127 | `top: -2px;` | `local` | negative offset, no token (= -1 x --ds-space-0-5); vendored prosemirror gapcursor value |
| 127 | `width: 20px;` | `--ds-space-5` |  |
| 127 | `border-top: 1px solid currentColor;` | `--ds-border-width-hairline` |  |
| 127 | `animation: docs-draft-cursor-blink 1.1s steps(2, start) infinite;` | `local` / `local` | 1.1s blink period: no duration token (slow is 260ms); `steps(2, start)`: no easing token; vendored |
| 133 | `initial-value: 100000px;` | `local` | fail-open sentinel, not a design value |
| 134 | `--style-editor-text-lane: var(--style-content-width, 60ch);` | `--ds-layout-lane-text` | fallback, rail stock default (60ch) |
| 136 | `margin-top: 0;` | `--ds-space-0` |  |
| 142 | `border-radius: var(--docs-highlight-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius); rail stock radius 2 |
| 143 | `box-shadow: 0 0 0 var(--docs-highlight-padding, 4px) var(--docs-highlight-color, var(--color-bg-blue));` | `--ds-space-1` | 4px: fallback, rail stock default; `0 0 0` stays local |
| 150 | `border-radius: var(--docs-dropcursor-radius, 2px);` | `--ds-radius-base` | fallback, rail stock default (dropRadius 2) |
| 151 | `height: var(--docs-dropcursor-width, 3px) !important;` | `--ds-border-width-rail` | fallback, rail stock default (drop line) |
| 152 | `width: var(--docs-dropcursor-width, 3px) !important;` | `--ds-border-width-rail` | fallback, rail stock default (drop line) |
| 154 | `z-index: 20;` | `--ds-z-raised` | floating grip |
| 155 | `width: var(--docs-grip-size, 18px);` | `local` | 18px: fallback, rail stock default; off the space scale (nearest 16px / 20px) |
| 155 | `height: calc(var(--docs-grip-size, 18px) * 4 / 3);` | `local` | 18px: fallback, rail stock default; `* 4 / 3` stays local |
| 157 | `transition: opacity var(--docs-grip-fade, 100ms) ease;` | `--ds-motion-duration-fast` / `--ds-motion-easing-standard` | 100ms: fallback, rail stock default; ease |
| 160 | `width: calc(var(--docs-grip-size, 18px) * 0.55);` | `local` | 18px: fallback, rail stock default; `* 0.55` stays local |
| 166 | `z-index: 40;` | `--ds-z-overlay` | rubber band |
| 166 | `border-radius: 2px;` | `--ds-radius-base` |  |
| 167 | `background-color: color-mix(in srgb, var(--docs-dragselect-color, #2383e2) calc(var(--docs-dragselect-opacity, 0.12) * 100%), transparent);` | `local` | #2383e2: host fallback (the workbench reads var(--color-text-blue) here); no equal token |
| 169 | `animation: docs-draft-changed-flash 2s ease-out;` | `local` / `--ds-motion-easing-decelerate` | 2s flash: no duration token; ease-out |
| 169 | `border-radius: var(--docs-highlight-radius, var(--radius, 2px));` | `--ds-radius-base` | fallback (stock --radius) |
| 171 | `box-shadow: 0 0 0 var(--docs-highlight-padding, 4px) var(--docs-highlight-color, var(--color-bg-blue));` | `--ds-space-1` | 4px: fallback, rail stock default; `0 0 0` stays local |

#### Stays local

- Percentages inside host color-mix recipes (no recipe equals a token): 74 `7%`; 75 `62%`; 76 `12%`; 79 `16%`; 81 `55%`; 84, 87, 93 `10%`; 85, 88, 91, 94 `35%`; 90 `12%`; 98 `14%`
- Opacities: 149, 164 `0.3`; 150 `0.9`; 157 `0`; 159 `1`; 167 `0.12` x `100%`
- Unitless multipliers: 155 `* 4 / 3`; 160 `* 0.55`
- Zero shadow geometry: 143, 171 `0 0 0`; 172 `0 0 0 0` (keyframe end)
- Fluid sizes: 114 `max-width: 100%`, `height: auto`; 160 `height: auto`
- Keywords: 74, 75, 76, 79, 81, 84, 85, 87, 88, 90, 91, 93, 94, 98, 108, 123, 124, 147, 149, 167, 172 `transparent`; 108 `font`/`letter-spacing`/`color: inherit`; 120, 144 `outline: none`; 127 `currentColor`, `infinite`; 147, 149 `box-shadow: none`

### packages/docs-workbench/web/src/shell/style-rail-settings.ts

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 316 | `fontSize: 18` | `--ds-font-size-reading` | typography.fontSize, px (--style-font-size) |
| 317 | `lineHeight: 1.45` | `--ds-line-height-reading` | typography.lineHeight, unitless (--style-line-height) |
| 318 | `letterSpacing: 0` | `--ds-letter-spacing-normal` | typography.letterSpacing, em: 0em (--style-letter-spacing) |
| 321 | `contentWidth: 60` | `--ds-layout-lane-text` | layout.contentWidth, ch: 60ch (--style-content-width) |
| 322 | `codeWidth: 88` | `--ds-layout-lane-code` | layout.codeWidth, ch: 88ch (--style-code-width) |
| 323 | `wideWidth: 1100` | `--ds-layout-lane-wide` | layout.wideWidth, px: 1100px (--style-wide-width) |
| 327 | `contentMargin: 88` | `local` | layout.contentMargin, px: 88px is off every scale (nearest --ds-space-16 64px; --ds-layout-content-padding-x is 40px); a token would move the left rail |
| 328 | `topPadding: 24` | `--ds-space-6` | layout.topPadding, px (--style-content-top) |
| 329 | `titlePadding: 20` | `--ds-space-5` | layout.titlePadding, px: title-to-content gap (--style-title-padding) |
| 330 | `bottomPadding: 24` | `--ds-space-6` | layout.bottomPadding, px (--style-content-bottom) |
| 331 | `radius: 2` | `--ds-radius-base` | layout.radius, px (--radius) |
| 339 | `fontSize: 14` | `--ds-font-size-ui-lg` | sidebar.fontSize, px: nav text (--docs-sidebar-font-size) |
| 340 | `padding: 4` | `--ds-space-1` | sidebar.padding, px: nav row padding-y (--docs-sidebar-item-py) |
| 343 | `guideWidth: 1` | `--ds-border-width-hairline` | sidebar.guideWidth, px: indent-guide stroke (--docs-sidebar-guide-width) |
| 356 | `highlight: { color: null, radius: 2, padding: 4, dragOpacity: 0.3, dropColor: null, dropWidth: 3, dropOpacity: 0.9, dropRadius: 2 }` | `--ds-radius-base` / `--ds-space-1` / `--ds-border-width-rail` / `--ds-radius-base` | px each, in order: radius 2 (--docs-highlight-radius; semantic.css: var(--radius)), padding 4 (--docs-highlight-padding, shadow-spread breathing room), dropWidth 3 (--docs-dropcursor-width: the drop line is a rail), dropRadius 2 (--docs-dropcursor-radius; semantic.css: var(--radius)); the opacities are in Stays local |
| 358 | `list: { discSize: 6, circleSize: 6, circleThickness: 1.5, squareSize: 5, indent: 24 }` | `--ds-space-1-5` / `--ds-space-1-5` / `--ds-border-width-ring` / `local` / `--ds-space-6` | px each, in order: discSize 6 (marker box), circleSize 6 (marker box), circleThickness 1.5 (circle ring stroke), squareSize 5 (off the grid: nearest --ds-space-1 4px / --ds-space-1-5 6px), indent 24 (--docs-list-indent) |
| 359 | `grip: { gap: 12, offsetY: 6, size: 18, color: null, fadeMs: 100 }` | `--ds-space-3` / `--ds-space-1-5` / `local` / `--ds-motion-duration-fast` | in order: gap 12px, offsetY 6px, size 18px (grip box: off the 4px grid, nearest --ds-space-4 16px / --ds-space-5 20px; 18px equals --ds-font-size-reading but this is a box), fadeMs 100 -> 100ms (grip fade) |
| 360 | `scrollbar: { width: 10, color: null, opacity: 1, padding: 0 }` | `local` / `--ds-space-0` | in order: width 10px (thumb width: off the grid, nearest --ds-space-2 8px / --ds-space-3 12px), padding 0px; opacity in Stays local |
| 361 | `transition: { type: "fade", fadeOutMs: 80, fadeInMs: 120 }` | `local` / `local` | ms, in order: fadeOutMs 80ms, fadeInMs 120ms; no duration token (nearest --ds-motion-duration-fast 100ms / --ds-motion-duration-base 150ms); emitted unconditionally (see Runtime layers 2) |
| 363 | `width: 48` | `local` | peek.width, rem: 48rem = 768px (rem->px); no layout token near it (--ds-layout-lane-wide is 1100px) |
| 364 | `durationMs: 300` | `local` | peek.durationMs, ms: 300ms; nearest --ds-motion-duration-slow 260ms would move the peek animation |
| 365 | `padding: 1.5` | `--ds-space-6` | peek.padding, rem: 1.5rem = 24px (rem->px) (--docs-peek-padding) |
| 367 | `dividerWidth: 1` | `--ds-border-width-hairline` | peek.dividerWidth, px (--docs-peek-divider-width) |
| 373 | `iconSize: 12` | `--ds-space-3` | reference.iconSize, px: fixed icon box on the grid (--docs-ref-icon-size) |
| 375 | `iconGap: 2` | `--ds-space-0-5` | reference.iconGap, px: icon-to-label gap (--docs-ref-icon-gap) |
| 383 | `actionPaneWidth: 520` | `local` | annotate.actionPaneWidth, px: 520px; nearest --ds-layout-inspector-width 360px (--docs-action-pane-width) |
| 437 | `{ id: "blue", label: "Blue" }` | `--ds-color-notion-text-blue` / `--ds-color-notion-bg-blue` / `--ds-color-notion-pill-blue` | accent family "blue": lines 860-862 build var(--color-text-blue) / var(--color-bg-blue) / var(--color-pill-blue) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); stock accent, so styleRailVars emits nothing for it (accented is false, line 859); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 438 | `{ id: "purple", label: "Purple" }` | `--ds-color-notion-text-purple` / `--ds-color-notion-bg-purple` / `--ds-color-notion-pill-purple` | accent family "purple": lines 860-862 build var(--color-text-purple) / var(--color-bg-purple) / var(--color-pill-purple) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 439 | `{ id: "pink", label: "Pink" }` | `--ds-color-notion-text-pink` / `--ds-color-notion-bg-pink` / `--ds-color-notion-pill-pink` | accent family "pink": lines 860-862 build var(--color-text-pink) / var(--color-bg-pink) / var(--color-pill-pink) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 440 | `{ id: "red", label: "Red" }` | `--ds-color-notion-text-red` / `--ds-color-notion-bg-red` / `--ds-color-notion-pill-red` | accent family "red": lines 860-862 build var(--color-text-red) / var(--color-bg-red) / var(--color-pill-red) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 441 | `{ id: "orange", label: "Orange" }` | `--ds-color-notion-text-orange` / `--ds-color-notion-bg-orange` / `--ds-color-notion-pill-orange` | accent family "orange": lines 860-862 build var(--color-text-orange) / var(--color-bg-orange) / var(--color-pill-orange) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 442 | `{ id: "yellow", label: "Yellow" }` | `--ds-color-notion-text-yellow` / `--ds-color-notion-bg-yellow` / `--ds-color-notion-pill-yellow` | accent family "yellow": lines 860-862 build var(--color-text-yellow) / var(--color-bg-yellow) / var(--color-pill-yellow) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 443 | `{ id: "green", label: "Green" }` | `--ds-color-notion-text-green` / `--ds-color-notion-bg-green` / `--ds-color-notion-pill-green` | accent family "green": lines 860-862 build var(--color-text-green) / var(--color-bg-green) / var(--color-pill-green) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 444 | `{ id: "brown", label: "Brown" }` | `--ds-color-notion-text-brown` / `--ds-color-notion-bg-brown` / `--ds-color-notion-pill-brown` | accent family "brown": lines 860-862 build var(--color-text-brown) / var(--color-bg-brown) / var(--color-pill-brown) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); brown has no hue token outside color.notion (no color.brown.*); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 445 | `{ id: "gray", label: "Gray" }` | `--ds-color-notion-text-gray` / `--ds-color-notion-bg-gray` / `--ds-color-notion-pill-gray` | accent family "gray": lines 860-862 build var(--color-text-gray) / var(--color-bg-gray) / var(--color-pill-gray) -> --accent-foreground + --docs-viewer-link / --accent / --ring; theme-following (one var right on both pages); island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 596 | `sans: "Inter, ui-sans-serif, system-ui, sans-serif"` | `--ds-font-family-sans` | whole stack matches; emitted off-stock onto --font-tx02 / --font-display / --style-heading-font / --docs-sidebar-font / --docs-font-numeric |
| 597 | `serif: "ui-serif, Georgia, 'Times New Roman', serif"` | `--ds-font-family-serif` | whole stack matches |
| 598 | `mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace"` | `--ds-font-family-mono-system` | whole stack matches (rail "Mono" choice) |
| 599 | `"plex-mono": "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"` | `--ds-font-family-mono` | whole stack matches once the JS escape is read (\" -> "); stock code font |
| 868 | `` ? `color-mix(in srgb, var(--color-pill-default) ${Math.round(layout.borderStrength * 100)}%, transparent)` `` | `--ds-color-notion-pill-default` | border strength <= 1 (off-stock only): legacy Notion var; feeds --border / --input / --sidebar-border / --docs-border-default; island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 869 | `` : `color-mix(in srgb, var(--color-pill-default) ${Math.round(100 - (layout.borderStrength - 1) * 60)}%, var(--color-text-gray) ${Math.round((layout.borderStrength - 1) * 60)}%)`; `` | `--ds-color-notion-pill-default` / `--ds-color-notion-text-gray` | border strength > 1 (off-stock only), in order: pill-default, text-gray; island caveat: codePanelOverrideCss (1147) restates this on every dark code panel, where the unqualified --ds-* var keeps its light value; see Runtime layers 5 |
| 875 | `const bgBase = colors.background ?? "var(--color-bg-default)";` | `--ds-color-notion-bg-default` | page tint base (--background / --card / --popover, PAGE_COLOR_VARS): written only by pageColorOverrideCss on :root (light and dark rules), never in the island, so the unqualified var is right in both themes |
| 883 | `const sidebarPick = colors.sidebar ?? "var(--color-bg-sidebar)";` | `--ds-color-notion-bg-sidebar` | sidebar tint base (--sidebar, PAGE_COLOR_VARS): :root-only like line 875; unqualified is right in both themes |
| 890 | `` `color-mix(in srgb, ${sidebarBase} ${100 - layout.sidebarTint}%, var(--color-bg-gray) ${layout.sidebarTint}%)` `` | `--ds-color-notion-bg-gray` | sidebar tint mix (--sidebar, PAGE_COLOR_VARS): :root-only; unqualified is right in both themes |
| 1187 | `text: "var(--style-content-width,60ch)"` | `--ds-layout-lane-text` | fallback that can paint: --style-content-width has no stylesheet declaration (the rail sets it only off-stock), so a block-layout override naming the text lane renders this 60ch |
| 1188 | `code: "var(--style-code-width,88ch)"` | `--ds-layout-lane-code` | fallback (semantic.css :root declares --style-code-width: 88ch) |
| 1189 | `wide: "var(--style-wide-width,1100px)"` | `--ds-layout-lane-wide` | fallback (semantic.css :root declares --style-wide-width: 1100px) |
| 1232 | `"margin-left: 0;"` | `--ds-space-0` | block-layout justify left (blockLayoutOverrideCss); "auto" in Stays local |

#### Stays local

- Unitless multipliers: 332 borderStrength 1; 349 frequency 0.8 (SVG baseFrequency); 350 contrast 1.3; 354 softening background 1 / font 0.8 / icons 0.8; 868-869 border-strength arithmetic (`* 100`, `100 -`, `* 60`); 1093 grain boost "1"; 1094-1097 soften factors 0.2 / 0.08 / 0.24 / 0.04 and `1 -`.
- Percentages and unitless percent knobs: 82-83 BLOCK_COLUMN_SPLIT_MIN 20 / MAX 80; 93-94 split defaults 44; 333 backgroundTint 0; 334 sidebarTint 0; 868-869, 878, 886, 890 color-mix percents (`${100 - tint}%`, `${tint}%`, sidebarTint); 1065 `washOpacity * 100`%; 1239 `${columnSplit}%`.
- Opacities: 344 guideOpacity 0.6; 348 grain opacity 0.15; 356 dragOpacity 0.3 / dropOpacity 0.9; 357 dragSelect opacity 0.12; 360 scrollbar opacity 1; 382 washOpacity 0.08; 1087 grain opacity expression (`: 0`).
- Keywords and option ids: 308 accent "blue"; 311-315 bodyFont "sans", headingFont "sans", codeFont "plex-mono", codePanels "dark", numberFont "body" (font ids resolve through FONT_STACKS rows 596-599); 338 font "sans"; 341 guides true; 347 enabled true; 353 blendMode "auto"; 361 type "fade"; 368 dividerStyle "solid"; 376 iconPosition "before"; every `null` color pick (309, 337, 342, 356, 357, 359, 360, 366, 371-372, 374, 379-381); 448-493 option lists; 868, 1065 `transparent`; 971 "none"; 1055 "row-reverse"; 1092-1093 `var(--docs-grain-auto-blend)` / `var(--docs-grain-auto-boost)`; 1190 full "none"; 1232-1233 `auto`.
- Validation bounds, never rendered: 513-514 BLOCK_LAYOUT_CUSTOM_WIDTH_MIN 240 / MAX 3000; every clampNumber min/max in normalizeSettings (709-836).
- Unit templates with no literal (the number comes from the settings object, mapped at 316-383): 929-1069 and 1071 `${n}px`, `${n}ch`, `${n}ms`, `${n}rem`, `${n}em`, `String(n)`.
- var() reference kept as a docs-system var: 1065 `var(--annotation-accent)` in the wash color-mix. A custom annotate accent is written to --annotation-accent at 1059 and must keep feeding this wash; its stock value equals --ds-color-annotation-accent.

### packages/docs-workbench/web/src/theme/theme-folders.ts

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 131 | `surfaces.radius -> --radius: 2px` | `--ds-radius-base` | px; global corner radius |
| 162 | `inline-code.borderWidth -> --docs-inline-code-border-width: 0px` | `--ds-border-width-none` | px; borderless chip at stock |
| 172 | `inline-code.radius -> --docs-inline-code-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 206 | `inline-code.weight -> --docs-inline-code-weight: 400` | `--ds-font-weight-regular` | font-weight; registry default only: semantic.css leaves the var unset so the chip inherits its weight; do not declare it |
| 243 | `linking.railWidth -> --docs-link-rail-width: 3px` | `--ds-border-width-rail` | px; linked-panel pin rail |
| 252 | `linking.ringWidth -> --docs-link-ring-width: 1.5px` | `--ds-border-width-ring` | px; linked-panel ring |
| 263 | `linking.textSize -> --docs-link-text-size: 13px` | `--ds-font-size-code` | px; 13px mono CodeLines (font-mono) |
| 272 | `linking.lineHeight -> --docs-link-line-height: 21px` | `--ds-line-height-code` | px; CodeLines line box |
| 281 | `linking.gutterTextSize -> --docs-link-gutter-text-size: 12px` | `--ds-font-size-ui-xs` | px; line numbers |
| 290 | `linking.gutterWidth -> --docs-link-gutter-width: 40px` | `--ds-space-10` | px; gutter width |
| 335 | `heading.weight -> --docs-heading-weight: 600` | `--ds-font-weight-semibold` | font-weight |
| 344 | `heading.marginTop -> --docs-heading-margin-top: 40px` | `--ds-space-10` | px; heading margin-top |
| 353 | `heading.marginBottom -> --docs-heading-margin-bottom: 12px` | `--ds-space-3` | px |
| 394 | `list-item.itemGap -> --docs-list-item-gap: 4px` | `--ds-space-1` | px; list item gap |
| 410 | `code.borderWidth -> --docs-code-border-width: 1px` | `--ds-border-width-hairline` | px; panel frame |
| 420 | `code.radius -> --docs-code-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 429 | `code.textSize -> --docs-code-text-size: 13px` | `--ds-font-size-code` | px; 13px mono |
| 439 | `code.lineHeight -> --docs-code-line-height: 21px` | `--ds-line-height-code` | px; drives row height, zebra and overlays |
| 448 | `code.padX -> --docs-code-pad-x: 12px` | `--ds-space-3` | px |
| 457 | `code.padTop -> --docs-code-pad-top: 12px` | `--ds-space-3` | px |
| 466 | `code.padBottom -> --docs-code-pad-bottom: 12px` | `--ds-space-3` | px |
| 476 | `code.headerHeight -> --docs-code-header-height: 32px` | `--ds-space-8` | px; header strip height |
| 487 | `code.headerTextSize -> --docs-code-header-text-size: 12px` | `--ds-font-size-ui-xs` | px; header label |
| 495 | `code.headerWeight -> --docs-code-header-weight: 400` | `--ds-font-weight-regular` | font-weight |
| 527 | `code.gutterTextSize -> --docs-code-gutter-text-size: 12px` | `--ds-font-size-ui-xs` | px; line numbers |
| 536 | `code.gutterWidth -> --docs-code-gutter-width: 40px` | `--ds-space-10` | px; gutter width |
| 545 | `code.gutterPadX -> --docs-code-gutter-pad-x: 12px` | `--ds-space-3` | px |
| 558 | `code.ruleWidth -> --docs-code-rule-width: 1px` | `--ds-border-width-hairline` | px; internal rule |
| 585 | `code.noteTextSize -> --docs-code-note-text-size: 13px` | `--ds-font-size-ui-sm` | px; 13px sans: the notes column is font-sans (docs-viewer components/code/classes.ts CODE_NOTES_ASIDE_CLASSES) |
| 594 | `code.notesWidth -> --docs-code-notes-width: 280px` | `local` | px; 280px: no token (nearest --ds-layout-sidebar-width 220px / --ds-layout-inspector-width 360px); either would move the notes column |
| 638 | `callout.railWidth -> --docs-callout-rail-width: 3px` | `--ds-border-width-rail` | px; callout tone rail |
| 647 | `callout.hairlineWidth -> --docs-callout-hairline-width: 0px` | `--ds-border-width-none` | px |
| 656 | `callout.radius -> --docs-callout-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 665 | `callout.padX -> --docs-callout-pad-x: 14px` | `local` | px; 14px: off the 4px grid (nearest --ds-space-3 12px / --ds-space-4 16px) |
| 674 | `callout.padY -> --docs-callout-pad-y: 2px` | `--ds-space-0-5` | px |
| 685 | `callout.titleTextSize -> --docs-callout-title-text-size: 18px` | `--ds-font-size-reading` | px; semantic.css: var(--style-font-size, 18px) |
| 693 | `callout.titleWeight -> --docs-callout-title-weight: 600` | `--ds-font-weight-semibold` | font-weight |
| 702 | `callout.iconSize -> --docs-callout-icon-size: 16px` | `--ds-space-4` | px; icon box |
| 719 | `callout.margin -> --docs-callout-margin: 20px` | `--ds-space-5` | px; callout block margin |
| 731 | `divider.thickness -> --docs-divider-thickness: 1px` | `--ds-border-width-hairline` | px |
| 758 | `image.borderWidth -> --docs-image-border-width: 1px` | `--ds-border-width-hairline` | px |
| 767 | `image.radius -> --docs-image-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 776 | `image.margin -> --docs-image-margin: 24px` | `--ds-space-6` | px; media block margin |
| 789 | `video.borderWidth -> --docs-video-border-width: 1px` | `--ds-border-width-hairline` | px |
| 798 | `video.radius -> --docs-video-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 807 | `video.captionTextSize -> --docs-video-caption-text-size: 13.5px` | `--ds-font-size-ui-md` | px; caption |
| 816 | `video.captionGap -> --docs-video-caption-gap: 8px` | `--ds-space-2` | px; caption gap |
| 825 | `video.margin -> --docs-video-margin: 24px` | `--ds-space-6` | px; media block margin |
| 848 | `file-tree.borderWidth -> --docs-file-tree-border-width: 1px` | `--ds-border-width-hairline` | px |
| 857 | `file-tree.radius -> --docs-file-tree-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 866 | `file-tree.padY -> --docs-file-tree-pad-y: 8px` | `--ds-space-2` | px |
| 875 | `file-tree.padX -> --docs-file-tree-pad-x: 12px` | `--ds-space-3` | px |
| 884 | `file-tree.textSize -> --docs-file-tree-text-size: 13px` | `--ds-font-size-code` | px; 13px mono names |
| 893 | `file-tree.lineHeight -> --docs-file-tree-line-height: 28px` | `--ds-line-height-row` | px; 28px tree rows |
| 902 | `file-tree.folderWeight -> --docs-file-tree-folder-weight: 400` | `--ds-font-weight-regular` | font-weight |
| 911 | `file-tree.fileWeight -> --docs-file-tree-file-weight: 400` | `--ds-font-weight-regular` | font-weight |
| 921 | `file-tree.noteTextSize -> --docs-file-tree-note-text-size: 13.5px` | `--ds-font-size-ui-md` | px; 13.5px sans notes |
| 970 | `structured-table.borderWidth -> --docs-table-border-width: 1px` | `--ds-border-width-hairline` | px |
| 979 | `structured-table.radius -> --docs-table-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 991 | `structured-table.headerTextSize -> --docs-table-header-text-size: 13.5px` | `--ds-font-size-ui-md` | px; semantic.css derives it from --docs-table-font-size (13.5px) |
| 999 | `structured-table.headerWeight -> --docs-table-header-weight: 500` | `--ds-font-weight-medium` | font-weight |
| 1009 | `structured-table.headerRuleWidth -> --docs-table-header-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1027 | `structured-table.rowRuleWidth -> --docs-table-row-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1046 | `structured-table.columnRuleWidth -> --docs-table-column-rule-width: 0px` | `--ds-border-width-none` | px; no column rules at stock |
| 1064 | `structured-table.cellPaddingY -> --docs-table-cell-pad-y: 4px` | `--ds-space-1` | px; cell padding-y |
| 1073 | `structured-table.cellPaddingX -> --docs-table-cell-pad-x: 12px` | `--ds-space-3` | px |
| 1084 | `structured-table.rowMinHeight -> --docs-table-row-min-height: 28px` | `--ds-space-7` | px; row height floor (fixed height on the grid) |
| 1095 | `structured-table.fontSize -> --docs-table-font-size: 13.5px` | `--ds-font-size-ui-md` | px; table cells |
| 1104 | `structured-table.lineHeight -> --docs-table-line-height: 1.45` | `--ds-line-height-reading` | unitless; kind "number" (no unit) but a line-height on the scale, not a multiplier knob |
| 1112 | `structured-table.bodyWeight -> --docs-table-body-weight: 400` | `--ds-font-weight-regular` | font-weight |
| 1124 | `structured-table.handleRadius -> --docs-table-handle-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 1133 | `structured-table.handleOffset -> --docs-table-handle-offset: 12px` | `--ds-space-3` | px; offset |
| 1142 | `structured-table.selectionPadding -> --docs-table-selection-pad: 3px` | `local` | px; 3px: off the grid (nearest --ds-space-0-5 2px / --ds-space-1 4px) |
| 1191 | `interaction-surface.radius -> --docs-interaction-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 1200 | `interaction-surface.borderWidth -> --docs-interaction-border-width: 1px` | `--ds-border-width-hairline` | px |
| 1209 | `interaction-surface.ruleWidth -> --docs-interaction-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1219 | `interaction-surface.padX -> --docs-interaction-pad-x: 16px` | `--ds-space-4` | px |
| 1229 | `interaction-surface.titleTextSize -> --docs-interaction-title-text-size: 13.5px` | `--ds-font-size-ui-md` | px; sans panel title |
| 1237 | `interaction-surface.titleWeight -> --docs-interaction-title-weight: 600` | `--ds-font-weight-semibold` | font-weight |
| 1247 | `interaction-surface.headerPadY -> --docs-interaction-header-pad-y: 9px` | `local` | px; 9px: off the grid (nearest --ds-space-2 8px) |
| 1256 | `interaction-surface.headerTextSize -> --docs-interaction-header-text-size: 13px` | `--ds-font-size-code` | px; 13px mono operation name ([data-operation-name] uses --docs-font-code) |
| 1264 | `interaction-surface.headerWeight -> --docs-interaction-header-weight: 500` | `--ds-font-weight-medium` | font-weight |
| 1274 | `interaction-surface.descTextSize -> --docs-interaction-desc-text-size: 13.5px` | `--ds-font-size-ui-md` | px |
| 1283 | `interaction-surface.descLineHeight -> --docs-interaction-desc-line-height: 20px` | `local` | px; 20px: off the line-height scale (nearest --ds-line-height-code 21px) |
| 1293 | `interaction-surface.columnHeadTextSize -> --docs-interaction-column-head-text-size: 13px` | `--ds-font-size-ui-sm` | px; 13px sans Parameters / Returns label ([data-op-card-head] uses --docs-font-body) |
| 1302 | `interaction-surface.columnHeadPadY -> --docs-interaction-column-head-pad-y: 8px` | `--ds-space-2` | px |
| 1312 | `interaction-surface.rowPad -> --docs-interaction-row-pad: 5px` | `local` | px; 5px: off the grid (nearest --ds-space-1 4px / --ds-space-1-5 6px) |
| 1321 | `interaction-surface.indent -> --docs-interaction-indent: 16px` | `--ds-space-4` | px; indent step |
| 1330 | `interaction-surface.noteNameTextSize -> --docs-interaction-note-name-text-size: 13px` | `--ds-font-size-code` | px; 13px mono field name (field-ledger --fl-name-size) |
| 1338 | `interaction-surface.noteNameWeight -> --docs-interaction-note-name-weight: 500` | `--ds-font-weight-medium` | font-weight |
| 1347 | `interaction-surface.noteTypeTextSize -> --docs-interaction-note-type-text-size: 13px` | `--ds-font-size-code` | px; 13px mono type (field-ledger --fl-type-size) |
| 1385 | `state-shape.rowPad -> --docs-shape-row-pad: 5px` | `local` | px; 5px: off the grid (nearest --ds-space-1 4px / --ds-space-1-5 6px) |
| 1394 | `state-shape.rowMinHeight -> --docs-shape-row-min-height: 28px` | `--ds-space-7` | px; row height floor (fixed height on the grid) |
| 1403 | `state-shape.nameWeight -> --docs-shape-name-weight: 500` | `--ds-font-weight-medium` | font-weight |
| 1415 | `state-shape.nameWidth -> --docs-shape-name-width: 24ch` | `local` | ch; 24ch name column; no ch token near it (--ds-layout-lane-text is 60ch) |
| 1424 | `state-shape.textSize -> --docs-shape-text-size: 13px` | `--ds-font-size-code` | px; 13px mono field name |
| 1433 | `state-shape.typeTextSize -> --docs-shape-type-text-size: 13px` | `--ds-font-size-code` | px; 13px mono type |
| 1442 | `state-shape.descTextSize -> --docs-shape-desc-text-size: 13.5px` | `--ds-font-size-ui-md` | px |
| 1451 | `state-shape.headerTextSize -> --docs-shape-header-text-size: 13px` | `--ds-font-size-code` | px; 13px mono shape name ([data-shape-name] uses --docs-font-code) |
| 1459 | `state-shape.headerWeight -> --docs-shape-header-weight: 600` | `--ds-font-weight-semibold` | font-weight |
| 1469 | `state-shape.padX -> --docs-shape-pad-x: 16px` | `--ds-space-4` | px |
| 1478 | `state-shape.headerPadY -> --docs-shape-header-pad-y: 6px` | `--ds-space-1-5` | px; panel header padding-y |
| 1487 | `state-shape.borderWidth -> --docs-shape-border-width: 1px` | `--ds-border-width-hairline` | px |
| 1496 | `state-shape.radius -> --docs-shape-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 1506 | `state-shape.ruleWidth -> --docs-shape-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1515 | `state-shape.headerRuleWidth -> --docs-shape-header-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1525 | `state-shape.paneRuleWidth -> --docs-shape-pane-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1535 | `state-shape.indent -> --docs-shape-indent: 16px` | `--ds-space-4` | px; indent step |
| 1544 | `state-shape.childRuleWidth -> --docs-shape-child-rule-width: 1px` | `--ds-border-width-hairline` | px |
| 1599 | `process-outline.borderWidth -> --docs-process-outline-border-width: 1px` | `--ds-border-width-hairline` | px |
| 1608 | `process-outline.padY -> --docs-process-outline-pad-y: 12px` | `--ds-space-3` | px |
| 1617 | `process-outline.padX -> --docs-process-outline-pad-x: 12px` | `--ds-space-3` | px |
| 1626 | `process-outline.indent -> --docs-process-outline-indent: 28px` | `--ds-space-7` | px; indent on the grid |
| 1635 | `process-outline.rowGap -> --docs-process-outline-row-gap: 4px` | `--ds-space-1` | px |
| 1646 | `process-outline.branchGap -> --docs-process-outline-branch-gap: 16px` | `--ds-space-4` | px |
| 1655 | `process-outline.rootGap -> --docs-process-outline-root-gap: 12px` | `--ds-space-3` | px |
| 1665 | `process-outline.arrowGap -> --docs-process-outline-arrow-gap: 4px` | `--ds-space-1` | px |
| 1674 | `process-outline.lineHeight -> --docs-process-outline-line-height: 24px` | `local` | px; 24px: off the line-height scale (21px code / 28px row); 24px is --ds-space-6 but this is a line box |
| 1683 | `process-outline.textSize -> --docs-process-outline-text-size: 13.5px` | `--ds-font-size-ui-md` | px; sans steps |
| 1692 | `process-outline.rootTextSize -> --docs-process-outline-root-text-size: 13.5px` | `--ds-font-size-ui-md` | px |
| 1700 | `process-outline.rootWeight -> --docs-process-outline-root-weight: 600` | `--ds-font-weight-semibold` | font-weight |
| 1708 | `process-outline.branchWeight -> --docs-process-outline-branch-weight: 600` | `--ds-font-weight-semibold` | font-weight |
| 1716 | `process-outline.stepWeight -> --docs-process-outline-step-weight: 400` | `--ds-font-weight-regular` | font-weight |
| 1724 | `process-outline.keywordWeight -> --docs-process-outline-keyword-weight: 500` | `--ds-font-weight-medium` | font-weight |
| 1733 | `process-outline.emptyTextSize -> --docs-process-outline-empty-text-size: 12px` | `--ds-font-size-ui-xs` | px |
| 1742 | `process-outline.noteTextSize -> --docs-process-outline-note-text-size: 13.5px` | `--ds-font-size-ui-md` | px |
| 1751 | `process-outline.noteLineHeight -> --docs-process-outline-note-line-height: 21px` | `--ds-line-height-code` | px; 21px value match (the note text is sans) |
| 1760 | `process-outline.noteInset -> --docs-process-outline-note-inset: 0px` | `--ds-space-0` | px |
| 1769 | `process-outline.noteBorderWidth -> --docs-process-outline-note-border-width: 0px` | `--ds-border-width-none` | px; note box off at stock |
| 1778 | `process-outline.noteRuleWidth -> --docs-process-outline-note-rule-width: 0px` | `--ds-border-width-none` | px; note rule off at stock |
| 1787 | `process-outline.notePadY -> --docs-process-outline-note-pad-y: 2px` | `--ds-space-0-5` | px |
| 1796 | `process-outline.notePadX -> --docs-process-outline-note-pad-x: 0px` | `--ds-space-0` | px |
| 1806 | `process-outline.noteRuleGap -> --docs-process-outline-note-rule-gap: 0px` | `--ds-space-0` | px |
| 1816 | `process-outline.traceTextSize -> --docs-process-outline-trace-text-size: 12px` | `--ds-font-size-ui-xs` | px; mono trace tag; 12px maps only to ui-xs |
| 1827 | `process-outline.focusRing -> --docs-process-outline-focus-ring: 1px` | `--ds-border-width-hairline` | px; 1px outline width (--ds-border-width-focus is 2px) |
| 1837 | `process-outline.stroke -> --docs-process-outline-stroke: 1.5px` | `--ds-border-width-ring` | px; rail and elbow stroke |
| 1866 | `process-outline.selectPad -> --docs-process-outline-select-pad: 2px` | `--ds-space-0-5` | px |
| 1895 | `sequence.borderWidth -> --docs-sequence-border-width: 1px` | `--ds-border-width-hairline` | px |
| 1904 | `sequence.radius -> --docs-sequence-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 1913 | `sequence.padding -> --docs-sequence-padding: 12px` | `--ds-space-3` | px |
| 1923 | `sequence.maxHeight -> --docs-sequence-max-height: 420px` | `local` | px; 420px: no token (nearest --ds-layout-inspector-width 360px) |
| 1932 | `sequence.expandTextSize -> --docs-sequence-expand-text-size: 12px` | `--ds-font-size-ui-xs` | px |
| 1951 | `outline-rows.borderWidth -> --docs-outline-rows-border-width: 1px` | `--ds-border-width-hairline` | px |
| 1960 | `outline-rows.radius -> --docs-outline-rows-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 1969 | `outline-rows.padY -> --docs-outline-rows-pad-y: 8px` | `--ds-space-2` | px |
| 1978 | `outline-rows.padX -> --docs-outline-rows-pad-x: 12px` | `--ds-space-3` | px |
| 1987 | `outline-rows.textSize -> --docs-outline-rows-text-size: 13px` | `--ds-font-size-code` | px; 13px mono rows |
| 1996 | `outline-rows.lineHeight -> --docs-outline-rows-line-height: 28px` | `--ds-line-height-row` | px; 28px outline rows |
| 2007 | `outline-rows.commentTextSize -> --docs-outline-rows-comment-text-size: 13.5px` | `--ds-font-size-ui-md` | px |
| 2016 | `outline-rows.sourceTextSize -> --docs-outline-rows-source-text-size: 12px` | `--ds-font-size-ui-xs` | px |
| 2058 | `stack.gap -> --docs-stack-gap: 12px` | `--ds-space-3` | px |
| 2067 | `stack.radius -> --docs-stack-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 2092 | `canvas.borderWidth -> --docs-canvas-border-width: 1px` | `--ds-border-width-hairline` | px |
| 2101 | `canvas.radius -> --docs-canvas-radius: 2px` | `--ds-radius-base` | px; semantic.css derives it from --radius (2px at stock) |
| 2110 | `canvas.padding -> --docs-canvas-padding: 0px` | `--ds-space-0` | px; padding mat off at stock |

#### Stays local

- Color registry entries (210 tokens built with `color(...)`, first shell.background at 107, last canvas.bg at 2084): they carry no defaultValue, so there is no literal to map; their stock values live in semantic.css.
- Unitless multipliers: inline-code.textSize 0.85 (180); inline-code.padX 0.35 (188); inline-code.padY 0.1 (196); paragraph.spacing 1 (324); heading.h1Size 1.875 (363); heading.h2Size 1.25 (371); heading.h3Size 1 (379); callout.bodyTextScale 1 (710); divider.spacing 2 (740).
- Unitless percent knobs: linking.washStrength 14 (234); file-tree.changeTint 8 (951); process-outline.noteAccent 0 (1845); process-outline.selectTint 15 (1857).
- Opacities: code.ruleOpacity 0.5 (566); code.zebraOpacity 1 (574); structured-table.headerRuleOpacity 1 (1017); structured-table.rowRuleOpacity 1 (1035); structured-table.columnRuleOpacity 1 (1054).
- Validation bounds, never rendered: every registry `min` / `max` / `step` (slider range; e.g. 127-129 for surfaces.radius).
- FONT_VARS (2115-2120): surface -> var-name lists (body -> --font-tx02; heading -> --font-display, --style-heading-font; code -> --docs-font-code; number -> --docs-font-numeric); no literals. The stacks they receive come from theme.json `fonts` (see themes/default/theme.json and Runtime layers 1).
- compileThemeCss (2233-2261), THEME_DARK_SELECTOR (2230), applyThemeCss (2266-2278): no literals; they write theme values verbatim (Runtime layers 1).
- BUILTIN_THEMES (2285-2298): no design literals (name "Default", `dark: false`, `railDefaults: {}`, `components: {}`).

### packages/docs-workbench/web/src/theme/code-theme-style.ts

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 53 | `"--docs-code-block-bg": "var(--palette-inset)"` | `--ds-dark-color-surface-inset` | dark page only: the rule at line 72 is `:root[data-code-panels="dark"]:is(.dark, [data-theme="dark"]) …`, so the pinned dark var; --palette-inset dark = #010409 |
| 54 | `"--docs-code-gutter-bg": "var(--palette-inset)"` | `--ds-dark-color-surface-inset` | dark page only: the rule at line 72 is `:root[data-code-panels="dark"]:is(.dark, [data-theme="dark"]) …`, so the pinned dark var; --palette-inset dark = #010409 |
| 55 | `"--docs-code-block-border": "var(--palette-rule)"` | `local` | dark page only, but NOT --ds-dark-color-border-default (#3d444d): on the panel element itself notion-palette.css:212-219 (0,3,0) re-declares --palette-rule as color-mix(in srgb, var(--docs-code-block-bg) 74%, #ffffff), and line 53 sets that bg to #010409, so this border renders color-mix(#010409 74%, #ffffff) ≈ #434549, which no token holds; semantic.css:1366 carries the same var(--palette-rule); keep the var() reference |

#### Stays local

- No other literals: the selectors (34, 37-40, 72) are attribute selectors, and every other value comes from `codeThemeCssVars(theme)` at runtime (the active code theme; built-in Dark+ / Light+ literals live in docs-model `src/code-theme/code-theme.ts:140-213`, outside this file). See Runtime layers 6.

### packages/docs-viewer/src/lab/glass/GlassPanel.tsx

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 15 | `edit: { width: 300 }` | `local` | px (React inline width): 300px dock width; nearest --ds-layout-sidebar-width 220px / --ds-layout-inspector-width 360px; also read in JS (DOCK_DEFAULT_WIDTH at 22, onWidthChange at 81) |
| 16 | `ai: { width: "var(--docs-action-pane-width, 520px)", heightFraction: 0.8 }` | `local` | fallback 520px (semantic.css:613 / 1192 declare the var 520px, so it never paints); nearest --ds-layout-inspector-width 360px; heightFraction in Stays local |
| 19 | `export const PANEL_TOP_INSET = 12;` | `--ds-space-3` | px: panel top inset (style top at 145); also JS height math at 116, so a var needs getComputedStyle there |
| 20 | `const PANEL_BOTTOM_GAP = 12;` | `--ds-space-3` | px: bottom gap, used only in JS height math (116); a var needs getComputedStyle |
| 24 | `const TRANSITION_MS = 260;` | `--ds-motion-duration-slow` | ms: 260ms panel open / resize / tab slide; used in template strings at 29, 153, 176, 179, 182, 188 |
| 25 | `const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";` | `--ds-motion-easing-emphasized` | used with TRANSITION_MS at 29, 153, 176, 179, 182, 188 |
| 32 | `const ANNOTATION_ACCENT = "var(--annotation-accent, #8b5cf6)";` | `local` | fallback; no equal token (--ds-color-annotation-accent is #7862b8 light / #8a7ab0 dark) |
| 33 | `const ANNOTATION_ACCENT_LIT = "var(--annotation-accent-lit, var(--annotation-accent, #8b5cf6))";` | `local` | fallback; no equal token (as line 32) |
| 80 | `) \|\| 520` | `local` | JS fallback px when --docs-action-pane-width does not parse; same 520px as line 16 |
| 108 | `setContentHeight(inner.offsetHeight + padding + header.offsetHeight + 2);` | `local` | JS height math: + 2px for the panel top + bottom 1px borders (2 x --ds-border-width-hairline, not one token) |
| 142 | `className="absolute z-30 flex flex-col overflow-hidden rounded-[var(--radius)] border"` | `--ds-z-panel` / `--ds-border-width-hairline` | in order: z-30 (z-index 30, floating glass panel), border (Tailwind 1px) |
| 146 | `right: "var(--docs-lab-panel-right, 24px)",` | `--ds-space-6` | fallback, and it paints: --docs-lab-panel-right has no stylesheet declaration; inset 24px |
| 155 | `backdropFilter: "blur(var(--docs-lab-glass-blur, 13px))",` | `local` | fallback 13px matches no token: --docs-lab-glass-blur declares 14px = --ds-blur-glass |
| 156 | `WebkitBackdropFilter: "blur(var(--docs-lab-glass-blur, 13px))",` | `local` | fallback 13px; as line 155 |
| 164 | `className="relative flex shrink-0 select-none border-b"` | `--ds-border-width-hairline` | border-b: Tailwind 1px bottom rule |
| 171 | `className="absolute bottom-0 h-px"` | `--ds-space-0` / `--ds-border-width-hairline` | in order: bottom-0 (inset 0), h-px (1px tab-indicator rule) |
| 173 | `` left: ai ? `${(1 - WIDE_TAB_FRACTION) * 100}%` : 0, `` | `--ds-space-0` | inset 0 for the edit tab; the percent branch is in Stays local |
| 175 | `background: ai ? ANNOTATION_ACCENT : "var(--docs-lab-selection-accent, var(--annotation-accent, #8b5cf6))",` | `local` | fallback; no equal token (as line 32) |
| 179 | `className="flex items-center justify-center gap-1.5 py-2 text-[10px] uppercase tracking-[0.14em] transition-all hover:text-foreground"` | `--ds-space-1-5` / `--ds-space-2` / `--ds-font-size-micro` / `--ds-letter-spacing-micro-wide` | edit tab, in order: gap-1.5 (0.375rem = 6px, rem->px), py-2 (0.5rem = 8px, rem->px), text-[10px], tracking-[0.14em] |
| 179 | `` transition: `width ${TRANSITION_MS}ms ${EASE}, color 150ms ease` `` | `--ds-motion-duration-base` / `--ds-motion-easing-standard` | edit tab color transition, in order: 150ms, ease (width part uses lines 24-25) |
| 180 | `<Pencil key="icon" size={12} aria-hidden style={fadeIn} />` | `--ds-space-3` | icon box 12px; lucide `size` sets SVG width/height attributes, so a var needs CSS width/height instead |
| 182 | `className="flex items-center justify-center gap-1.5 border-l py-2 text-[10px] uppercase tracking-[0.14em] transition-all hover:text-foreground"` | `--ds-space-1-5` / `--ds-border-width-hairline` / `--ds-space-2` / `--ds-font-size-micro` / `--ds-letter-spacing-micro-wide` | AI tab, in order: gap-1.5 (6px, rem->px), border-l (1px), py-2 (8px, rem->px), text-[10px], tracking-[0.14em] |
| 182 | `` transition: `width ${TRANSITION_MS}ms ${EASE}, color 150ms ease` `` | `--ds-motion-duration-base` / `--ds-motion-easing-standard` | AI tab color transition, in order: 150ms, ease |
| 183 | `className="h-[5px] w-[5px] rounded-full"` | `local` / `local` / `--ds-radius-pill` | busy dot, in order: 5px height, 5px width (off the grid: nearest --ds-space-1 4px / --ds-space-1-5 6px), rounded-full (Tailwind v4 calc(infinity * 1px): renders like 9999px) |
| 183 | `` animation: `docs-annotation-breathe ${busy ? "0.72s" : "2.6s"} ease-in-out infinite` `` | `local` / `local` / `local` | breathe, in order: 0.72s busy, 2.6s idle (no duration token near either), ease-in-out (not an easing token: ease / ease-out / emphasized only) |
| 184 | `<Sparkles key="icon" size={12} aria-hidden style={fadeIn} />` | `--ds-space-3` | icon box 12px; lucide `size` attribute, as line 180 |
| 188 | `className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 pt-2"` | `--ds-space-0` / `--ds-space-3` / `--ds-space-3` / `--ds-space-2` | scroller, in order: min-h-0, px-3 (0.75rem = 12px, rem->px), pb-3 (12px), pt-2 (0.5rem = 8px) |

#### Stays local

- Fractions and percentages: 16 heightFraction 0.8; 26 WIDE_TAB_FRACTION 0.75; 119 `${heightFraction * 100}%`; 149 maxWidth "92%"; 173-174 and 179, 182 tab `left` / `width` percents.
- Multipliers: 151 `scale(1)` / `scale(0.985)`.
- Opacities: 152 opacity 1 / 0; 191 keyframes `opacity: 0` -> `opacity: 1`.
- Keywords: 150 transformOrigin "top right"; 158 box-shadow fallback `none` (--docs-lab-panel-shadow is the shadow.glass seed); 179, 182 `uppercase`, `transition-all` (dead: the inline `transition` sets every transition longhand); 183 `infinite`; 188 scrollbarWidth "none"; 191 `display: none`.
- var() references with no literal fallback: 34 ANNOTATION_BORDER, 35 PANEL_BORDER, 129-130 tab colors, 142 `rounded-[var(--radius)]`, 154 background.

### themes/default/theme.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 4 | `"body": "Inter, ui-sans-serif, system-ui, sans-serif"` | `--ds-font-family-sans` | whole stack matches; equals stock; compileThemeCss writes it onto --font-tx02 in both theme blocks (Runtime layers 1) |
| 5 | `"heading": "Inter, ui-sans-serif, system-ui, sans-serif"` | `--ds-font-family-sans` | whole stack matches; equals stock; written onto --font-display and --style-heading-font (Runtime layers 1) |
| 6 | `"code": "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"` | `--ds-font-family-mono` | whole stack matches once the JSON escape is read; equals stock; written onto --docs-font-code (Runtime layers 1) |
| 12 | `"fadeOutMs": 80` | `local` | railDefaults = stock; 80ms: no duration token (nearest --ds-motion-duration-fast 100ms) |
| 13 | `"fadeInMs": 120` | `local` | railDefaults = stock; 120ms: no duration token (nearest --ds-motion-duration-fast 100ms / -base 150ms) |
| 27 | `"fontSize": 18` | `--ds-font-size-reading` | railDefaults = stock; px |
| 28 | `"lineHeight": 1.45` | `--ds-line-height-reading` | railDefaults = stock; unitless |
| 29 | `"letterSpacing": 0` | `--ds-letter-spacing-normal` | railDefaults = stock; em: 0em |
| 32 | `"contentWidth": 60` | `--ds-layout-lane-text` | railDefaults = stock; ch: 60ch |
| 33 | `"codeWidth": 88` | `--ds-layout-lane-code` | railDefaults = stock; ch: 88ch |
| 34 | `"wideWidth": 1100` | `--ds-layout-lane-wide` | railDefaults = stock; px: 1100px |
| 35 | `"contentMargin": 88` | `local` | railDefaults = stock; px: 88px is off every scale (nearest --ds-space-16 64px) |
| 36 | `"topPadding": 24` | `--ds-space-6` | railDefaults = stock; px |
| 37 | `"titlePadding": 20` | `--ds-space-5` | railDefaults = stock; px |
| 38 | `"bottomPadding": 24` | `--ds-space-6` | railDefaults = stock; px |
| 39 | `"radius": 2` | `--ds-radius-base` | railDefaults = stock; px (layout.radius -> --radius) |
| 47 | `"fontSize": 14` | `--ds-font-size-ui-lg` | railDefaults = stock; px (sidebar nav text) |
| 48 | `"padding": 4` | `--ds-space-1` | railDefaults = stock; px (sidebar row padding-y) |
| 51 | `"guideWidth": 1` | `--ds-border-width-hairline` | railDefaults = stock; px |
| 56 | `"radius": 2` | `--ds-radius-base` | railDefaults = stock; px (highlight.radius) |
| 57 | `"padding": 4` | `--ds-space-1` | railDefaults = stock; px (highlight.padding) |
| 60 | `"dropWidth": 3` | `--ds-border-width-rail` | railDefaults = stock; px (drop line) |
| 62 | `"dropRadius": 2` | `--ds-radius-base` | railDefaults = stock; px |
| 69 | `"discSize": 6` | `--ds-space-1-5` | railDefaults = stock; px |
| 70 | `"circleSize": 6` | `--ds-space-1-5` | railDefaults = stock; px |
| 71 | `"circleThickness": 1.5` | `--ds-border-width-ring` | railDefaults = stock; px |
| 72 | `"squareSize": 5` | `local` | railDefaults = stock; px: 5px off the grid (nearest --ds-space-1 4px / --ds-space-1-5 6px) |
| 73 | `"indent": 24` | `--ds-space-6` | railDefaults = stock; px |
| 76 | `"gap": 12` | `--ds-space-3` | railDefaults = stock; px (grip gap) |
| 77 | `"offsetY": 6` | `--ds-space-1-5` | railDefaults = stock; px |
| 78 | `"size": 18` | `local` | railDefaults = stock; px: 18px grip box off the grid (nearest --ds-space-4 16px / --ds-space-5 20px) |
| 80 | `"fadeMs": 100` | `--ds-motion-duration-fast` | railDefaults = stock; ms |
| 83 | `"width": 10` | `local` | railDefaults = stock; px: 10px scrollbar off the grid (nearest --ds-space-2 8px / --ds-space-3 12px) |
| 86 | `"padding": 0` | `--ds-space-0` | railDefaults = stock; px (scrollbar padding) |
| 89 | `"width": 48` | `local` | railDefaults = stock; rem: 48rem = 768px (rem->px), no layout token near it |
| 90 | `"durationMs": 300` | `local` | railDefaults = stock; ms: 300ms (nearest --ds-motion-duration-slow 260ms) |
| 91 | `"padding": 1.5` | `--ds-space-6` | railDefaults = stock; rem: 1.5rem = 24px (rem->px) |
| 93 | `"dividerWidth": 1` | `--ds-border-width-hairline` | railDefaults = stock; px |
| 99 | `"iconSize": 12` | `--ds-space-3` | railDefaults = stock; px (reference icon box) |
| 101 | `"iconGap": 2` | `--ds-space-0-5` | railDefaults = stock; px (icon-to-label gap) |
| 109 | `"actionPaneWidth": 520` | `local` | railDefaults = stock; px: 520px (nearest --ds-layout-inspector-width 360px) |
| 113 | `"width": "1120px"` | `local` | theme override, differs from stock (stock: no state-shape override, wide lane = 1100px = --ds-layout-lane-wide); emitted by blockLayoutOverrideCss (Runtime layers 3) |

#### Stays local

- Ids and keywords (all equal stock): 2 name; 8 dark false; 11 transition type "fade"; 15 accent "blue"; 17-19 colors null; 22-26 bodyFont "sans", headingFont "sans", codeFont "plex-mono", codePanels "dark", numberFont "body" (font ids resolve through FONT_STACKS, style-rail-settings.ts:596-599); 45 textColor null; 46 font "sans"; 49 guides true; 50 guideColor null; 55, 59, 65, 79, 84, 92, 97-98, 100, 105-107 null color picks; 94 dividerStyle "solid"; 102 iconPosition "before"; 118 enabled true; 122 blendMode "auto"; 129 components {}.
- Unitless multipliers: 40 borderStrength 1; 120 frequency 0.8; 121 contrast 1.3; 124-126 softening 1 / 0.8 / 0.8.
- Percent knobs: 41 backgroundTint 0; 42 sidebarTint 0; 114 columnSplit 48 (theme override, differs from stock: no override, component default 44%).
- Opacities: 52 guideOpacity 0.6; 58 dragOpacity 0.3; 61 dropOpacity 0.9; 66 opacity 0.12; 85 opacity 1; 108 washOpacity 0.08; 119 grain opacity 0.15.

### themes/docs-system-classic/theme.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 16 | `"fontSize": 16` | `local` | theme override, differs from stock (stock 18px); 16px: no font-size token |
| 17 | `"lineHeight": 1.5` | `local` | theme override, differs from stock (stock 1.45); equals --ds-line-height-ui by value |
| 18 | `"letterSpacing": 0.005` | `local` | theme override, differs from stock (stock 0em); 0.005em: no letter-spacing token |
| 21 | `"contentWidth": 88` | `local` | theme override, differs from stock (stock 60ch); 88ch equals --ds-layout-lane-code by value, but this is the text lane |
| 22 | `"contentMargin": 0` | `local` | theme override, differs from stock (stock 88px); 0px equals --ds-space-0 by value |
| 23 | `"topPadding": 88` | `local` | theme override, differs from stock (stock 24px); 88px off every scale |
| 24 | `"titlePadding": 50` | `local` | theme override, differs from stock (stock 20px); 50px off the grid |
| 25 | `"bottomPadding": 300` | `local` | theme override, differs from stock (stock 24px); 300px off every scale |
| 26 | `"radius": 4` | `local` | theme override, differs from stock (stock 2px = --ds-radius-base); no 4px radius token |
| 34 | `"fontSize": 15` | `local` | theme override, differs from stock (stock 14px = --ds-font-size-ui-lg); 15px: no font-size token |
| 35 | `"padding": 4` | `--ds-space-1` | equals stock; px (sidebar row padding-y) |
| 38 | `"guideWidth": 1.5` | `local` | theme override, differs from stock (stock 1px); equals --ds-border-width-ring by value |
| 43 | `"radius": 1` | `local` | theme override, differs from stock (stock 2px); 1px: no radius token |
| 44 | `"padding": 4` | `--ds-space-1` | equals stock; px (highlight.padding) |
| 46 | `"dropColor": "#bcdae7"` | `local` | theme override, differs from stock (stock null = theme blue); rail pick paints the same hex in both themes, no token |
| 47 | `"dropWidth": 6` | `local` | theme override, differs from stock (stock 3px = --ds-border-width-rail); 6px equals --ds-space-1-5 by value, but this is a stroke width |
| 49 | `"dropRadius": 1` | `local` | theme override, differs from stock (stock 2px); 1px: no radius token |
| 56 | `"discSize": 6` | `--ds-space-1-5` | equals stock; px |
| 57 | `"circleSize": 6` | `--ds-space-1-5` | equals stock; px |
| 58 | `"circleThickness": 1.5` | `--ds-border-width-ring` | equals stock; px |
| 59 | `"squareSize": 6` | `local` | theme override, differs from stock (stock 5px); 6px equals --ds-space-1-5 by value |
| 60 | `"indent": 24` | `--ds-space-6` | equals stock; px |
| 63 | `"gap": 12` | `--ds-space-3` | equals stock; px (grip gap) |
| 64 | `"offsetY": 2` | `local` | theme override, differs from stock (stock 6px); 2px equals --ds-space-0-5 by value |
| 65 | `"size": 20` | `local` | theme override, differs from stock (stock 18px); 20px equals --ds-space-5 by value |
| 67 | `"fadeMs": 100` | `--ds-motion-duration-fast` | equals stock; ms |
| 70 | `"width": 7` | `local` | theme override, differs from stock (stock 10px); 7px off the grid |
| 73 | `"padding": 6` | `local` | theme override, differs from stock (stock 0px); 6px equals --ds-space-1-5 by value |
| 76 | `"width": 50` | `local` | theme override, differs from stock (stock 48rem); rem: 50rem = 800px (rem->px) |
| 77 | `"durationMs": 300` | `local` | equals stock; ms: 300ms has no token (nearest --ds-motion-duration-slow 260ms) |
| 78 | `"padding": 3` | `local` | theme override, differs from stock (stock 1.5rem); rem: 3rem = 48px (rem->px), equals --ds-space-12 by value |
| 80 | `"dividerWidth": 2.5` | `local` | theme override, differs from stock (stock 1px); 2.5px: no border-width token |
| 84 | `"color": "#262626"` | `local` | theme override, differs from stock (stock null = theme navigation color); rail pick, same hex in both themes |
| 86 | `"iconSize": 18` | `local` | theme override, differs from stock (stock 12px); 18px off the grid |
| 87 | `"iconColor": "#9c9c9c"` | `local` | theme override, differs from stock (stock null = follows the reference text); rail pick, same hex in both themes |
| 88 | `"iconGap": 4` | `local` | theme override, differs from stock (stock 2px); 4px equals --ds-space-1 by value |

#### Stays local

- Ids and keywords: 2 name; 3 dark false; 5 accent "blue"; 7-9 colors null; 12-15 bodyFont "sans", headingFont "sans", codeFont "mono", numberFont "body". codeFont "mono" is a theme override that differs from stock ("plex-mono"): it resolves to FONT_STACKS.mono (style-rail-settings.ts:598, = --ds-font-family-mono-system stack) and is emitted onto --docs-font-code (Runtime layers 3). Also 32 textColor null; 33 font "sans"; 36 guides true; 37 guideColor null; 42, 52, 66, 71, 79, 85 null picks; 81 dividerStyle "solid"; 89 iconPosition "before"; 92 enabled true; 96 blendMode "auto"; 103 components {}.
- Unitless multipliers: 27 borderStrength 1; 94 frequency 1.1 (differs from stock 0.8); 95 contrast 1.2 (differs from stock 1.3); 98-100 softening 1 / 0.8 / 0.8.
- Percent knobs: 28 backgroundTint 0; 29 sidebarTint 10 (differs from stock 0: emits a --sidebar color-mix over var(--color-bg-gray)).
- Opacities: 39 guideOpacity 0.6; 45 dragOpacity 0.2 (differs from 0.3); 48 dropOpacity 0.7 (differs from 0.9); 53 opacity 0.12; 72 opacity 0.7 (differs from 1).
- Keys this file omits fall back to STOCK (setStyleRailBaseline normalizes against DEFAULT_STYLE_RAIL_SETTINGS; the theme has no `base`): no `fonts` block, codeWidth, wideWidth, codePanels, transition, annotate, blockLayout.
- Component files that are `{}` (no literals): callout, canvas, divider, editor-controls, file-tree, heading, image, inline-code, linking, list-item, paragraph, sequence, shell, video.

### themes/docs-system-classic/components/code.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|

#### Stays local

- 2 ruleOpacity "0.9" (opacity; theme override, differs from stock 0.5); 3 zebraOpacity "1" (opacity; equals stock, but compileThemeCss writes it verbatim into both theme blocks, so it is a literal copy).

### themes/docs-system-classic/components/interaction-surface.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 2 | `"rowPad": "8px"` | `local` | theme override, differs from stock (stock 5px); 8px equals --ds-space-2 by value |
| 3 | `"opGap": "14px"` | `local` | theme override, differs from stock; not a THEME_TOKEN_REGISTRY key: readThemeDefinition drops it (theme-folders.ts:2163), never renders |

#### Stays local

- None.

### themes/docs-system-classic/components/process-outline.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 2 | `"stroke": "1.5px"` | `--ds-border-width-ring` | equals stock; compileThemeCss writes it verbatim into both theme blocks (shadows the token: delete the key or write var(--ds-border-width-ring)) |
| 3 | `"arrowSize": "7px"` | `local` | theme override, differs from stock; not a THEME_TOKEN_REGISTRY key: readThemeDefinition drops it (theme-folders.ts:2163), never renders |
| 4 | `"rowGap": "9px"` | `local` | theme override, differs from stock (stock 4px); 9px off the grid |
| 5 | `"branchGap": "9px"` | `local` | theme override, differs from stock (stock 16px); 9px off the grid |
| 6 | `"rootGap": "14px"` | `local` | theme override, differs from stock (stock 12px); 14px off the grid |
| 7 | `"arrowGap": "8px"` | `local` | theme override, differs from stock (stock 4px); equals --ds-space-2 by value |
| 8 | `"rootTextSize": "13.5px"` | `--ds-font-size-ui-md` | equals stock; compileThemeCss writes it verbatim into both theme blocks (delete the key or write the var) |
| 9 | `"rootWeight": "650"` | `local` | theme override, differs from stock (stock 600); no 650 weight token |
| 10 | `"branchWeight": "600"` | `--ds-font-weight-semibold` | equals stock; compileThemeCss writes it verbatim into both theme blocks |
| 11 | `"stepWeight": "400"` | `--ds-font-weight-regular` | equals stock; compileThemeCss writes it verbatim into both theme blocks |
| 12 | `"emptyTextSize": "12px"` | `--ds-font-size-ui-xs` | equals stock; compileThemeCss writes it verbatim into both theme blocks |
| 13 | `"noteTextSize": "12px"` | `local` | theme override, differs from stock (stock 13.5px); equals --ds-font-size-ui-xs by value |
| 14 | `"noteLineHeight": "20px"` | `local` | theme override, differs from stock (stock 21px); 20px off the line-height scale |
| 15 | `"noteInset": "0px"` | `--ds-space-0` | equals stock; compileThemeCss writes it verbatim into both theme blocks |
| 16 | `"noteBorderWidth": "1px"` | `local` | theme override, differs from stock (stock 0px); equals --ds-border-width-hairline by value |
| 17 | `"noteRuleWidth": "1px"` | `local` | theme override, differs from stock (stock 0px); equals --ds-border-width-hairline by value |
| 18 | `"notePadY": "7px"` | `local` | theme override, differs from stock (stock 2px); 7px off the grid |
| 19 | `"notePadX": "12px"` | `local` | theme override, differs from stock (stock 0px); equals --ds-space-3 by value |
| 25 | `"traceTextSize": "10px"` | `local` | theme override, differs from stock (stock 12px); equals --ds-font-size-micro by value |
| 26 | `"lineHeight": "20px"` | `local` | theme override, differs from stock (stock 24px); 20px off the line-height scale |
| 27 | `"indent": "37px"` | `local` | theme override, differs from stock (stock 28px); 37px off the grid |
| 29 | `"noteBg": "#ffffff"` | `local` | theme override, differs from stock (stock: no note box); one string = the same white in both theme blocks, no token right in both themes |
| 33 | `"rail": "#8a8a8a"` | `local` | theme override, differs from stock; same gray in both theme blocks, no token |
| 34 | `"cycle1": "#8a8a8a"` | `local` | theme override, differs from stock (stock: depth 1 color); same gray in both theme blocks, no token |
| 35 | `"cycle2": "#8a8a8a"` | `local` | theme override, differs from stock (stock: depth 2 color); same gray in both theme blocks, no token |
| 36 | `"cycle3": "#8a8a8a"` | `local` | theme override, differs from stock (stock: depth 3 color); same gray in both theme blocks, no token |
| 37 | `"cycle4": "#8a8a8a"` | `local` | theme override, differs from stock (stock: depth 4 color); same gray in both theme blocks, no token |
| 38 | `"cycle5": "#8a8a8a"` | `local` | theme override, differs from stock (stock: depth 5 color); same gray in both theme blocks, no token |

#### Stays local

- Percent knobs: 20 noteAccent "0" (equals stock; still written literally by compileThemeCss).
- Dead unitless keys (not registry keys, dropped at load): 21 chipTint "0", 22 chipInkMix "0", 23 traceTint "0", 24 traceInkMix "0".
- var() references, no literal: 28 noteFg `var(--docs-process-outline-ink)`; 30 traceBg `var(--muted)` (also a dead key); 31 codeBg `var(--muted)`.
- Keywords: 32 keywordFg `currentColor`.

### themes/docs-system-classic/components/quote.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 2 | `"fg": "#383838"` | `local` | theme override, differs from stock; quote is not a THEME_TOKEN_REGISTRY file: readThemeDefinition skips the whole file (theme-folders.ts:2160), never renders |
| 3 | `"border": "#e88a4f"` | `local` | theme override, differs from stock; dead file, as line 2 |

#### Stays local

- None.

### themes/docs-system-classic/components/state-shape.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 2 | `"rowPad": "9px"` | `local` | theme override, differs from stock (stock 5px); 9px off the grid |

#### Stays local

- None.

### themes/docs-system-classic/components/structured-table.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 2 | `"headerRuleWidth": "1.5px"` | `local` | theme override, differs from stock (stock 1px); equals --ds-border-width-ring by value |
| 3 | `"cellPaddingY": "12px"` | `local` | theme override, differs from stock (stock 4px); equals --ds-space-3 by value |
| 5 | `"handleOffset": "16px"` | `local` | theme override, differs from stock (stock 12px); equals --ds-space-4 by value |
| 6 | `"selectionPadding": "4px"` | `local` | theme override, differs from stock (stock 3px); equals --ds-space-1 by value |

#### Stays local

- Opacities: 4 rowRuleOpacity "0.8" (theme override, differs from stock 1).

### themes/docs-system-classic/components/surfaces.json

| Line | Declaration (as written, trimmed) | -> var | Note |
|---|---|---|---|
| 2 | `"border": "#8f8f8f"` | `local` | theme override, differs from stock (stock: semantic.css --border); one string = the same gray in both theme blocks (--border, --input, --sidebar-border, --docs-border-default), no token |

#### Stays local

- None.

## Appendix: equivalence proof

How decision 2 was measured. The script loads `notion-palette.css`, `semantic.css` and `dist/css/tokens.css` into one Chromium page, paints each docs-system variable and its token as a background (or box-shadow), and compares the computed values: on the light page, on the dark page (`class="dark" data-theme="dark"`), through the unqualified and the pinned variable, and inside a dark code panel on the light page. Run it with bun from any folder; it uses the Playwright install in Codecaine Core.

Expected output: `pairs=180 checks=898 page-level mismatches=0`, followed by the 25 island lines that decision 1 explains.

```js
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = await import("/Users/Ford/workspace/codecaine/core/node_modules/playwright/index.mjs");
const THEME = "/Users/Ford/workspace/codecaine/core/docs-system/packages/docs-workbench/web/src/theme";
const DS = "/Users/Ford/workspace/design-system";
const css = readFileSync(`${THEME}/notion-palette.css`, "utf8") + "\n" + readFileSync(`${THEME}/semantic.css`, "utf8") + "\n" + readFileSync(`${DS}/dist/css/tokens.css`, "utf8");

const hues = ["gray","blue","teal","green","yellow","orange","red","violet","pink"];
const pairs = [
  ["--palette-page","color.surface.page"],["--palette-panel","color.surface.panel"],["--palette-sidebar","color.surface.sidebar"],
  ["--palette-ink","color.text.ink"],["--palette-text","color.text.body"],["--palette-muted","color.text.muted"],["--palette-faint","color.text.faint"],
  ["--palette-rule","color.border.default"],["--palette-rule-soft","color.border.subtle"],["--palette-chip","color.fill.chip"],
  ["--palette-link","color.link"],["--palette-accent","color.accent"],["--palette-glyph","color.text.on-solid"],["--palette-inset","color.surface.inset","dark"],
  ["--docs-sunken","color.surface.sunken"],["--docs-hover","color.fill.hover"],["--docs-guide","color.border.guide"],["--docs-border-strong","color.border.strong"],
  ["--docs-text-secondary","color.text.secondary"],["--docs-selection","color.selection"],["--docs-focus-ring","color.focus-ring"],
  ["--muted","color.fill.active"],["--accent","color.fill.accent"],["--palette-amber","color.amber.text"],
  ...hues.flatMap(h => [[`--palette-${h}`,`color.${h}.text`],[`--palette-${h}-solid`,`color.${h}.solid`],[`--palette-${h}-soft`,`color.${h}.soft`],[`--docs-c-${h}-line`,`color.${h}.line`]]),
  ...[["info","info"],["success","success"],["warning","warning"],["risk","danger"]].flatMap(([d,s]) => [[`--docs-tone-${d}`,`color.status.${s}.text`],[`--docs-tone-${d}-solid`,`color.status.${s}.solid`],[`--docs-tone-${d}-soft`,`color.status.${s}.soft`],[`--docs-tone-${d}-line`,`color.status.${s}.line`]]),
  ["--status-neutral","color.status.neutral.text"],["--status-neutral-fill","color.status.neutral.soft"],["--status-neutral-border","color.status.neutral.line"],
  ...[1,2,3,4,5,6].flatMap(n => [[`--docs-cat-${n}`,`color.category.${n}.text`],[`--docs-cat-${n}-soft`,`color.category.${n}.soft`]]),
  ...["add","del","mod"].flatMap(k => [[`--docs-diff-${k}`,`color.diff.${k}`],[`--docs-diff-${k}-bg`,`color.diff.${k}-bg`]]),
  ...["punctuation","keyword","control","function","type","key","string","number","boolean","null","comment","regex","tag","constant","selector"].map(r => [`--syntax-${r}`,`color.syntax.${r}`]),
  ["--docs-code-block-bg","color.code.bg"],["--docs-code-block-border","color.code.border"],["--docs-code-header-fg","color.code.header-fg"],
  ["--docs-code-gutter-fg","color.code.gutter-fg"],["--docs-code-gutter-bg","color.code.gutter-bg"],["--docs-inline-code-fg","color.code.chip.ink"],
  ["--docs-inline-code-string-fg","color.code.chip.string"],["--docs-inline-code-path-fg","color.code.chip.string"],["--docs-inline-code-type-fg","color.code.chip.type"],
  ["--docs-inline-code-call-fg","color.code.chip.call"],["--docs-inline-code-literal-fg","color.code.chip.literal"],["--docs-inline-code-keyword-fg","color.code.chip.keyword"],["--docs-inline-code-prop-fg","color.code.chip.prop"],
  ...["accent","accent-lit","accent-dim","active-bg","surface","text","muted","border","danger"].map(k => [`--annotation-${k}`,`color.annotation.${k}`]),
  ["--docs-annotation-wash","color.annotation.wash"],["--docs-annotation-add","color.annotation.add"],["--docs-annotation-add-bg","color.annotation.add-bg"],
  ["--docs-annotation-del","color.annotation.del"],["--docs-annotation-del-bg","color.annotation.del-bg"],
  ["--docs-lab-glass-bg","color.glass.bg"],["--docs-lab-panel-border","color.glass.border"],["--docs-lab-zone-border","color.glass.zone-border"],
  ["--docs-lab-panel-shadow","shadow.glass","both","boxShadow"],
  ["--color-text-default","color.notion.text.default"],["--color-text-navigation","color.notion.text.navigation"],["--color-bg-default","color.notion.bg.default"],["--color-bg-sidebar","color.notion.bg.sidebar"],
  ["--color-pill-default","color.notion.pill.default"],["--color-accent-blue","color.notion.accent.blue"],
  ...["gray","brown","orange","yellow","green","blue","purple","pink","red"].flatMap(h => [[`--color-text-${h}`,`color.notion.text.${h}`],[`--color-bg-${h}`,`color.notion.bg.${h}`],[`--color-pill-${h}`,`color.notion.pill.${h}`]]),
  ["--docs-process-outline-keyword-fg","color.syntax.control"],["--docs-process-outline-note-fg","color.syntax.comment"],
  ["--docs-viewer-callout-border","color.notion.pill.orange"],["--docs-code-lang-fg","color.notion.text.blue"],
];
const dsVar = (path, theme) => `--ds-${theme ? theme + "-" : ""}${path.replaceAll(".", "-")}`;
const probes = (prefix, theme) => pairs.map(([docs, path, only, prop = "backgroundColor"], i) => {
  const cssProp = prop === "boxShadow" ? "box-shadow" : "background-color";
  return `<i id="${prefix}d${i}" style="${cssProp}: var(${docs})"></i><i id="${prefix}u${i}" style="${cssProp}: var(${dsVar(path)})"></i><i id="${prefix}q${i}" style="${cssProp}: var(${dsVar(path, theme)})"></i>`;
}).join("");
const page = (theme) => `<!doctype html><html${theme === "dark" ? ' class="dark" data-theme="dark"' : ""}><head><style>${css}</style></head><body>${probes("p", theme)}
<div data-code-panels="dark"><div data-code-surface>${pairs.map(([docs, path, only, prop = "backgroundColor"], i) => `<i id="i${i}" style="${prop === "boxShadow" ? "box-shadow" : "background-color"}: var(${docs})"></i><i id="iq${i}" style="${prop === "boxShadow" ? "box-shadow" : "background-color"}: var(${dsVar(path, "dark")})"></i>`).join("")}</div></div></body></html>`;
const browser = await chromium.launch();
const tab = await browser.newPage();
const report = [];
let fails = 0, checks = 0;
for (const theme of ["light", "dark"]) {
  await tab.setContent(page(theme));
  for (let i = 0; i < pairs.length; i++) {
    const [docs, path, only, prop = "backgroundColor"] = pairs[i];
    if (only && only !== "both" && only !== theme) continue;
    const [d, u, q] = await tab.evaluate(([i, prop]) => ["d","u","q"].map(k => getComputedStyle(document.getElementById(`p${k}${i}`))[prop]), [i, prop]);
    checks += 2;
    if (d !== u || d !== q) { fails++; report.push(`${theme}: ${docs} -> ${path}: docs=${d} ds=${u} pinned=${q}`); }
  }
  if (theme === "light") {
    // Island: docs dark values on a light page vs pinned --ds-dark-*. Page/panel/rule/rule-soft are island-overridden by design.
    for (let i = 0; i < pairs.length; i++) {
      const [docs, path, only, prop = "backgroundColor"] = pairs[i];
      const [d, q] = await tab.evaluate(([i, prop]) => [getComputedStyle(document.getElementById(`i${i}`))[prop], getComputedStyle(document.getElementById(`iq${i}`))[prop]], [i, prop]);
      checks++;
      if (d !== q) report.push(`island: ${docs} -> ${dsVar(path, "dark")}: docs=${d} ds=${q}`);
    }
  }
}
await browser.close();
console.log(`pairs=${pairs.length} checks=${checks} page-level mismatches=${fails}`);
console.log(report.join("\n"));
```
