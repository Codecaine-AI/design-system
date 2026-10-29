# Tokens

Design tokens are the named values every app styles with: colors, spacing, radius, type, motion, z-index and layout sizes. `tokens/` is the only place a value is written. `bun run build` compiles it into CSS custom properties, a Tailwind v4 theme, JS and JSON. Everything below the reference marker is generated from `tokens/`.

## Tiers

| Tier | Where | What it holds |
| --- | --- | --- |
| 1. Base scales | `tokens/base/*.tokens.json` | Theme-independent: `space`, `control.height`, `radius`, `border.width`, `focus`, `blur`, `font`, `line-height`, `letter-spacing`, `motion`, `z`, `layout` (lanes and app-shell sizes). |
| 2. Theme colors | `tokens/themes/<theme>.tokens.json` | Literal values per theme: the neutral roles (`color.surface`, `color.text`, `color.border`, `color.fill.chip`, `color.accent`, `color.link`), the hue roster (`color.<hue>.*`, `color.amber.text`) and the chart series (`color.chart.series.*`). |
| 3. Derived roles | same theme files | Aliases and mixes over tier 2: `color.status`, `color.category`, `color.chart.diverging`, `color.diff`, `color.selection`, `color.focus-ring`, `color.fill.*`, `color.code`, `color.syntax`, `color.annotation`, `color.glass`, `shadow`. |
| Compat | same theme files | `color.notion.*`: docs-system's Notion palette (`--color-*`). CSS variables only, no Tailwind utilities. |

Both theme files hold exactly the same paths. The build fails if they differ. It also fails on any other `.json` file under `tokens/`, and on a key repeated inside one JSON object, which `JSON.parse` would silently drop.

## Naming

- A token path is dotted segments of lowercase letters, digits and single hyphens: `color.surface.page`, `space.1-5`.
- The CSS variable is `--ds-` plus the path joined with `-`: `color.surface.page` becomes `--ds-color-surface-page`. Two paths that produce the same variable fail the build.
- Every theme token produces three variables:
  - `--ds-<path>` follows the active theme (`data-theme` or the `.dark` class).
  - `--ds-light-<path>` and `--ds-dark-<path>` are pinned to one theme.
- Use a pinned variable only where a region must render one theme whatever the page does, for example a dark code panel on a light page.
- `{path}` in a value is an alias. It is emitted as `var()` between pinned variables (`--ds-light-color-fill-hover: color-mix(in srgb, var(--ds-light-color-text-ink) 6%, var(--ds-light-color-surface-panel))`).
- To restyle at runtime, override the pinned variable on `:root` (`--ds-light-color-surface-panel`). Everything derived from it follows. Overriding an unqualified `--ds-*` variable changes that one variable only.

## Value format

- Colors: lowercase `#rrggbb` or `#rrggbbaa`. Write `rgba()` only when the alpha is not exact in 8 bits (0.1, 0.5, 0.85), so the computed color stays bit-identical. The build rejects `rgba()` with an exact alpha such as 0.2 or 0.4, and suggests the hex.
- Derived colors: `color-mix(in srgb, {color.text.ink} 6%, {color.surface.panel})`.
- Dimensions carry a unit (`4px`, `13.5px`, `60ch`, `2.25rem`). Durations use `ms`. Easings are CSS (`ease`, `cubic-bezier(0.32, 0.72, 0, 1)`). Weights, line-height ratios and z-index are JSON numbers.
- Shadows are CSS `box-shadow` values: `none`, or comma-separated layers of 2 to 4 adjacent lengths (x, y, blur, spread; blur not negative), at most one color and an optional `inset`.
- Every token has `$type` and `$value`. Add a `$description` that says where the token is used.

## Rules

1. Apps style with semantic roles: `color.surface.*`, `color.text.*`, `color.border.*`, `color.fill.*`, `color.accent`, `color.link`, `color.focus-ring`, `color.selection`, `color.status.*`, `color.diff.*`, `color.code.*`, `color.syntax.*`.
2. `color.accent` is for fills, borders and focus rings. Text uses `color.link`: the light accent on the page is 4.34:1, under AA.
3. Hue tokens (`color.blue.*` and the rest) are for categorical color only: tags, series, block families, depth cycles. When order matters, use `color.category.1` to `color.category.6`.
4. A glyph on a hue or status `solid` uses that tile's `on-solid` (`color.yellow.on-solid`, `color.status.warning.on-solid`). It is white or ink, whichever meets 4.5:1 on that solid. `color.text.on-solid` fails on the light gray, yellow, orange and red solids. Light red reaches 4.26:1 with white and 3.87:1 with ink, so its tiles carry icons and large text only.
5. Never hard-code a color, size, radius, font, shadow, duration or z-index. If no token fits, add one here. In Tailwind that includes Tailwind's own scales (`bg-red-500`, `text-sm`, `shadow-md`); `tailwind-strict.css` removes them.
6. Add or change tokens only in `tokens/`. Never edit `dist/`.
7. Component-specific knobs (a callout's padding, a table's row rule) stay in the app and are built from these tokens. Add a token here only when two apps need the value, or when it is part of the shared look.
8. `color.notion.*` is compat for docs-system. New code never uses it.
9. Charts use `color.chart.*`. Assign `color.chart.series.1`, `.2`, ... in order and never cycle; a ninth series folds into "Other". Scatter and small-multiple charts use at most three series. Polarity (inflow and outflow, gain and loss) uses `color.chart.diverging.*`. Labels, values and legends use text tokens, never the series color. ECharts and canvas cannot read CSS variables: take the values from `flat[theme]` in the JS module (or `getComputedStyle`) and rebuild the chart options when the theme changes. SVG can use `var(--ds-color-chart-series-1)` directly. `test/contrast.test.ts` checks the palette in both themes: lightness band, chroma, color-vision separation of neighbors and 3:1 on page and panel. Page and panel only: on `color.surface.sunken`, light series 2, 4, 5 and 8 fall to 2.84 to 2.88:1, so a chart sits on page or panel, never on a sunken well.

## Changing a token

1. Edit the value in `tokens/base/*.tokens.json` or in both `tokens/themes/*.tokens.json`.
2. Run `bun run build`. It validates every file and rewrites `dist/` and the reference below.
3. Run `bun run test`.
4. Open `dist/guide/index.html` and check the change in light and dark.

`bun run check` exits 1 and lists the stale files when `dist/` no longer matches `tokens/`.

## Theming

- `tokens.css` declares custom properties, plus `color-scheme` in each theme block. It sets no other property, so importing it changes only the root's `color-scheme`: scrollbars, form controls and the default canvas follow the active theme.
- `:root` gets the light theme. Set `data-theme="dark"` or `class="dark"` on any element to switch it and everything inside it. `data-theme="light"` or `class="light"` switches a region back.
- Dark-first surfaces (tool chrome that is dark by default) import `tokens-dark-first.css` instead: the same variables, with dark on `:root`. `data-theme="light"` or `class="light"` switches a region back. Set `data-theme="dark"` on `<html>` too if the app uses Tailwind's `dark:`, which matches the attribute, not the default.
- On a dark-first surface, `dark:` still matches inside a light region, because the dark `<html>` is still its ancestor. A token utility under `dark:` (`dark:bg-panel`) is harmless: its `var(--ds-*)` value follows the nearest theme. A `dark:` utility whose value is not a design-system variable (`dark:hidden`, `dark:invert`, `dark:opacity-80`, `dark:bg-[#0d1117]`) also fires in the light region. Dark-first apps do not use those inside a light region. The shared `dark:` variant stays as it is, because changing it would change existing output.
- Fonts: import `fonts.css` before the tokens. It declares Inter and IBM Plex Mono from font files inside the package, byte-identical to `@codecaine-ai/text-measure`'s.
- Agent-viewer hosts (viewer-ui, viewer-shell, prompt-kit) also import `host-contract.css` (or `host-contract-dark-first.css`) after the tokens. It maps the unprefixed contract (`--background`, `--trace-user`, `--status-info-fill`, `--editor-bg`, ...) to these tokens in the format the libraries read, mostly RGB triplets for `rgb(var(--x) / <alpha>)`. The triplets are written at build time as `--ds-light-rgb-<path>` and `--ds-dark-rgb-<path>`.
- Tailwind v3 apps use `presets: [require("@codecaine-ai/design-system/tailwind-v3-preset")]`: the utility names of `tailwind.css`, without Tailwind's default palette and scales.
- Wiring per app (workspace, link, npm `file:`, vendored tgz, Vite settings): [consume.md](consume.md).
- Tailwind's `dark:` is redefined by `tailwind.css` to the same switch: `data-theme="dark"` or `.dark` on the element or an ancestor, not the OS setting. It still matches inside a light region nested in a dark one; the token utilities follow the nearest theme.
- Light and dark are one shared theme for Codecaine and Lascari AI. Add a theme by adding `tokens/themes/<name>.tokens.json` with the same paths.

## Reference

<!-- BEGIN GENERATED: token reference (scripts/build.ts) -->

88 base tokens and 206 theme tokens (light and dark), 706 CSS custom properties in total. Theme values show the authored value: `{path}` is an alias, emitted as `var()`.

### Base tokens

#### `space`

Spacing scale on a 4px grid, with half steps at 2px and 6px. Also used for fixed sizes (row heights, icon boxes), as Tailwind does.

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `space.0` | `--ds-space-0` | dimension | `0px` | No space. |
| `space.0-5` | `--ds-space-0-5` | dimension | `2px` | Hairline gaps: chip padding, icon-to-label gap. |
| `space.1` | `--ds-space-1` | dimension | `4px` | List item gap, table cell padding-y, tight row gaps. |
| `space.1-5` | `--ds-space-1-5` | dimension | `6px` | Panel header padding-y, small control padding. |
| `space.2` | `--ds-space-2` | dimension | `8px` | Panel padding-y, caption gap. |
| `space.3` | `--ds-space-3` | dimension | `12px` | Default inner padding of panels, code and tables. |
| `space.4` | `--ds-space-4` | dimension | `16px` | Card padding-x, indent step, icon box. |
| `space.5` | `--ds-space-5` | dimension | `20px` | Block margin (callout), title-to-content gap. |
| `space.6` | `--ds-space-6` | dimension | `24px` | Media block margin, page top and bottom padding. |
| `space.7` | `--ds-space-7` | dimension | `28px` | Row height of trees, tables and nav items. |
| `space.8` | `--ds-space-8` | dimension | `32px` | Panel header strip height. |
| `space.10` | `--ds-space-10` | dimension | `40px` | Heading margin-top, code gutter width. |
| `space.12` | `--ds-space-12` | dimension | `48px` | Large section gap. |
| `space.16` | `--ds-space-16` | dimension | `64px` | Page-level separation. |

#### `control.height`

Heights of buttons, inputs, selects and toggles. Aliases of the space steps.

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `control.height.sm` | `--ds-control-height-sm` | dimension | `{space.6}` | Small controls: inline row actions, icon buttons inside rows. |
| `control.height.md` | `--ds-control-height-md` | dimension | `{space.7}` | Default controls: buttons and inputs on a row, matching the 28px row height. |
| `control.height.lg` | `--ds-control-height-lg` | dimension | `{space.8}` | Large controls: header strip actions, the sidebar toggle. |

#### `radius`

One corner radius app-wide. Every rounded surface uses radius.base; pills use radius.pill.

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `radius.none` | `--ds-radius-none` | dimension | `0px` | Square corners. |
| `radius.base` | `--ds-radius-base` | dimension | `2px` | The single corner radius for panels, controls, chips and highlights. Seed: docs-system --radius. |
| `radius.pill` | `--ds-radius-pill` | dimension | `9999px` | Fully round ends: toggles, sliders, dots, scrollbar thumbs. |

#### `border`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `border.width.none` | `--ds-border-width-none` | dimension | `0px` | No border (borderless chips, hidden column rules). |
| `border.width.hairline` | `--ds-border-width-hairline` | dimension | `1px` | Every frame, rule and divider. |
| `border.width.ring` | `--ds-border-width-ring` | dimension | `1.5px` | Linked-panel ring, outline strokes, list circle markers. |
| `border.width.focus` | `--ds-border-width-focus` | dimension | `2px` | Focus outline width. |
| `border.width.rail` | `--ds-border-width-rail` | dimension | `3px` | Accent rails: callout tone rule, linked-panel pin, drop line. |

#### `focus`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `focus.ring.offset` | `--ds-focus-ring-offset` | dimension | `2px` | Gap between a control and its focus outline. |

#### `font.family`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `font.family.sans` | `--ds-font-family-sans` | fontFamily | `Inter, ui-sans-serif, system-ui, sans-serif` | UI and reading text. Inter 400-700 ships in fonts.css (the text-measure faces). |
| `font.family.mono` | `--ds-font-family-mono` | fontFamily | `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` | Code, inline code chips, kbd. IBM Plex Mono 400-600 ships in fonts.css (the text-measure faces). |
| `font.family.serif` | `--ds-font-family-serif` | fontFamily | `ui-serif, Georgia, 'Times New Roman', serif` | Optional serif reading face (docs style rail font choice). |
| `font.family.mono-system` | `--ds-font-family-mono-system` | fontFamily | `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace` | Platform mono, no web font (docs style rail 'Mono' choice). |

#### `font.size`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `font.size.micro` | `--ds-font-size-micro` | dimension | `10px` | Smallest uppercase labels: panel tabs, nav group labels, counts. |
| `font.size.ui-2xs` | `--ds-font-size-ui-2xs` | dimension | `11px` | Uppercase section labels, compact selects. |
| `font.size.ui-xs` | `--ds-font-size-ui-xs` | dimension | `12px` | Panel header labels, line numbers, captions in chrome. |
| `font.size.ui-sm` | `--ds-font-size-ui-sm` | dimension | `13px` | Dense UI text: notes, field names. |
| `font.size.code` | `--ds-font-size-code` | dimension | `13px` | Code blocks and mono rows (>= 13px floor). |
| `font.size.ui-md` | `--ds-font-size-ui-md` | dimension | `13.5px` | Panel body text: table cells, descriptions, image captions. |
| `font.size.ui-lg` | `--ds-font-size-ui-lg` | dimension | `14px` | Navigation and app chrome text. |
| `font.size.reading` | `--ds-font-size-reading` | dimension | `18px` | Document body text. |
| `font.size.title` | `--ds-font-size-title` | dimension | `2.25rem` | Page title (36px at the 16px root). |

#### `font.weight`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `font.weight.regular` | `--ds-font-weight-regular` | fontWeight | `400` | Body and UI text. |
| `font.weight.medium` | `--ds-font-weight-medium` | fontWeight | `500` | Table headers, field names, selected nav items. |
| `font.weight.semibold` | `--ds-font-weight-semibold` | fontWeight | `600` | Headings, panel titles, uppercase labels. |
| `font.weight.bold` | `--ds-font-weight-bold` | fontWeight | `700` | Page title. |

#### `line-height`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `line-height.tight` | `--ds-line-height-tight` | number | `1.2` | Page title. |
| `line-height.ui` | `--ds-line-height-ui` | number | `1.5` | Default UI line height (Tailwind preflight html line-height). |
| `line-height.reading` | `--ds-line-height-reading` | number | `1.45` | Document body text and table cells. |
| `line-height.code` | `--ds-line-height-code` | dimension | `21px` | Code line box: drives row height, zebra period and annotation overlays (13px / 21px). |
| `line-height.row` | `--ds-line-height-row` | dimension | `28px` | Single-line list rows: file trees, outline rows. |

#### `letter-spacing`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `letter-spacing.normal` | `--ds-letter-spacing-normal` | dimension | `0em` | Reading text. |
| `letter-spacing.title` | `--ds-letter-spacing-title` | dimension | `-0.02em` | Page title. |
| `letter-spacing.micro` | `--ds-letter-spacing-micro` | dimension | `0.09em` | Uppercase micro and section labels. |
| `letter-spacing.micro-wide` | `--ds-letter-spacing-micro-wide` | dimension | `0.14em` | Uppercase panel tab labels. |

#### `motion.duration`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `motion.duration.fast` | `--ds-motion-duration-fast` | duration | `100ms` | Hover fills, grip fade. |
| `motion.duration.base` | `--ds-motion-duration-base` | duration | `150ms` | Toggles, color changes. |
| `motion.duration.slow` | `--ds-motion-duration-slow` | duration | `260ms` | Panel open, resize and tab slide (glass panel). |
| `motion.duration.enter` | `--ds-motion-duration-enter` | duration | `300ms` | Content entering: an enter fade, a stagger chunk, an icon cross-fade. |
| `motion.duration.large` | `--ds-motion-duration-large` | duration | `400ms` | Large surfaces: modals, drawers and full-height panels opening or closing. |

#### `motion.easing`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `motion.easing.standard` | `--ds-motion-easing-standard` | cubicBezier | `ease` | Default for small state changes. |
| `motion.easing.emphasized` | `--ds-motion-easing-emphasized` | cubicBezier | `cubic-bezier(0.32, 0.72, 0, 1)` | Panels entering, resizing or sliding. |
| `motion.easing.decelerate` | `--ds-motion-easing-decelerate` | cubicBezier | `ease-out` | Fades out of a highlight, hover hints appearing. |
| `motion.easing.out` | `--ds-motion-easing-out` | cubicBezier | `cubic-bezier(0, 0, 0.2, 1)` | Enter and exit: a fast start that settles quickly. Also press feedback with motion.scale.press. |
| `motion.easing.swap` | `--ds-motion-easing-swap` | cubicBezier | `cubic-bezier(0.2, 0, 0, 1)` | Icon cross-fades and state swaps without a motion library. |

#### `z`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `z.raised` | `--ds-z-raised` | number | `20` | Floating grips, docked rails above content. |
| `z.panel` | `--ds-z-panel` | number | `30` | Floating glass panels. |
| `z.overlay` | `--ds-z-overlay` | number | `40` | Drag overlays, drop indicators, tooltips over panels. |
| `z.popover` | `--ds-z-popover` | number | `50` | Menus and popovers. |
| `z.top` | `--ds-z-top` | number | `60` | Full-viewport effect layers (grain); never interactive. |

#### `blur`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `blur.glass` | `--ds-blur-glass` | dimension | `14px` | Backdrop blur behind glass panels. Seed: --docs-lab-glass-blur. |
| `blur.motion` | `--ds-blur-motion` | dimension | `4px` | filter: blur() on content entering or exiting and on an icon swap; animate it to 0. |

#### `layout.lane`

Content measures. Blocks cap themselves at a lane and stay left-anchored.

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `layout.lane.text` | `--ds-layout-lane-text` | dimension | `60ch` | Reading measure for prose. Resolve ch at the body font size, not on a larger heading. |
| `layout.lane.code` | `--ds-layout-lane-code` | dimension | `88ch` | Mono blocks: code, pseudocode, file trees. |
| `layout.lane.wide` | `--ds-layout-lane-wide` | dimension | `1100px` | Data-heavy blocks: tables, state shapes, outlines. |

#### `layout.content`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `layout.content.padding-x` | `--ds-layout-content-padding-x` | dimension | `40px` | Inline padding of the main content area. Budget app: main padding 42px, rounded to the 4px grid. |
| `layout.content.padding-top` | `--ds-layout-content-padding-top` | dimension | `32px` | Space between the topbar and the first content block. Budget app: main padding-top 34px. |
| `layout.content.padding-bottom` | `--ds-layout-content-padding-bottom` | dimension | `48px` | Space below the last content block. Budget app: main padding-bottom 48px. |

#### `layout.inspector`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `layout.inspector.width` | `--ds-layout-inspector-width` | dimension | `360px` | Right-hand inspector panel. Budget app: SidePeek --side-peek-width min(360px, 40vw). |

#### `layout.sidebar`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `layout.sidebar.width` | `--ds-layout-sidebar-width` | dimension | `220px` | Expanded sidebar width. Budget app: aside 218px, rounded to the 4px grid. |
| `layout.sidebar.width-collapsed` | `--ds-layout-sidebar-width-collapsed` | dimension | `68px` | Collapsed icon rail. Budget app: .sidebar-collapsed .main-sidebar 68px. Equals 2 x (padding-x + item-padding-x) + icon-size, so nav icons hold still while the sidebar collapses. |
| `layout.sidebar.padding-x` | `--ds-layout-sidebar-padding-x` | dimension | `12px` | Inline padding inside the sidebar, both states. Budget app: --sidebar-padding 12px (10px when collapsed, unified here). |
| `layout.sidebar.item-height` | `--ds-layout-sidebar-item-height` | dimension | `40px` | Primary nav row height. Budget app: 11px + 22px icon + 11px = 44px; with the 20px icon it rounds to 40px. |
| `layout.sidebar.item-padding-x` | `--ds-layout-sidebar-item-padding-x` | dimension | `12px` | Inline padding of a primary nav row. Budget app: nav a padding 11px 12px. |
| `layout.sidebar.icon-size` | `--ds-layout-sidebar-icon-size` | dimension | `20px` | Nav icon box. Budget app: .outline-icon 20px (22px in the sidebar), rounded to the 4px grid. |
| `layout.sidebar.subitem-height` | `--ds-layout-sidebar-subitem-height` | dimension | `28px` | Subnav row height. Budget app: subnav a padding 7px around a 12px line, about 29px. |
| `layout.sidebar.toggle-size` | `--ds-layout-sidebar-toggle-size` | dimension | `32px` | Square collapse toggle in the sidebar header. Budget app: .sidebar-toggle 32px. |
| `layout.sidebar.avatar-size` | `--ds-layout-sidebar-avatar-size` | dimension | `32px` | Footer account avatar. Budget app: .avatar 31px, rounded to the 4px grid. |

#### `layout.topbar`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `layout.topbar.height` | `--ds-layout-topbar-height` | dimension | `72px` | Topbar height. Budget app: .workspace-topbar and .sidebar-header 72px. The sidebar header and inspector header share it, so their bottom borders form one line. |
| `layout.topbar.padding-x` | `--ds-layout-topbar-padding-x` | dimension | `32px` | Inline padding of the topbar. Budget app: .workspace-topbar padding 0 32px. |

#### `motion.scale`

| Token | CSS variable | Type | Value | Description |
| --- | --- | --- | --- | --- |
| `motion.scale.press` | `--ds-motion-scale-press` | number | `0.96` | Press feedback: a button or toggle scales to this on :active, transform only, over duration.base. Drop the scale under prefers-reduced-motion and keep the color change. |

### Theme tokens

#### `color.surface`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.surface.page` | `--ds-color-surface-page` | `#fdfdfd` | `#0d1117` | Page background: warm paper off-white (1% below white so the grain overlay can brighten). Seed: --palette-page. |
| `color.surface.panel` | `--ds-color-surface-panel` | `#f8f8f7` | `#151b23` | Panels, cards, tables, trees. Seed: --palette-panel. |
| `color.surface.sidebar` | `--ds-color-surface-sidebar` | `#f9f9f9` | `#010409` | Sidebar surface, a step deeper than the page. Seed: --palette-sidebar. |
| `color.surface.sunken` | `--ds-color-surface-sunken` | `color-mix(in srgb, {color.text.ink} 5%, {color.surface.panel})` | `color-mix(in srgb, {color.text.ink} 5%, {color.surface.panel})` | Recessed well inside a panel. Seed: --docs-sunken. |
| `color.surface.inset` | `--ds-color-surface-inset` | `{color.surface.sidebar}` | `{color.surface.sidebar}` | Surface that sits below the page (Primer canvas-inset). Seed: --palette-inset (dark only in docs-system). |

#### `color.text`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.text.ink` | `--ds-color-text-ink` | `#1f1f1f` | `#f0f6fc` | Titles, headings, strong text, field names. Seed: --palette-ink. |
| `color.text.body` | `--ds-color-text-body` | `#2a2a2a` | `#d1d9e0` | Body text (AA). Seed: --palette-text. |
| `color.text.secondary` | `--ds-color-text-secondary` | `color-mix(in srgb, {color.text.body} 84%, transparent)` | `color-mix(in srgb, {color.text.body} 84%, transparent)` | Body text one step quieter. Seed: --docs-text-secondary. |
| `color.text.muted` | `--ds-color-text-muted` | `#666562` | `#9198a1` | Secondary text, >= 4.5:1 on page and panel. Seed: --palette-muted. |
| `color.text.faint` | `--ds-color-text-faint` | `#9b9a97` | `#656c76` | Guides, gutters, placeholders. Not for text. Seed: --palette-faint. |
| `color.text.on-solid` | `--ds-color-text-on-solid` | `#ffffff` | `#0d1117` | Default glyph on a solid fill. On a hue or status solid use its own on-solid (color.yellow.on-solid): this one is under 4.5:1 on the light gray, yellow, orange and red solids. Seed: --palette-glyph. |

#### `color.border`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.border.default` | `--ds-color-border-default` | `#e6e5e3` | `#3d444d` | Frames, rules, dividers, inputs. Seed: --palette-rule. |
| `color.border.subtle` | `--ds-color-border-subtle` | `#efeeec` | `#262c36` | Row rules and inner separators. Seed: --palette-rule-soft. |
| `color.border.strong` | `--ds-color-border-strong` | `color-mix(in srgb, {color.border.default} 70%, {color.text.faint} 30%)` | `color-mix(in srgb, {color.border.default} 70%, {color.text.faint} 30%)` | Header rules that must read over a default rule. Seed: --docs-border-strong. |
| `color.border.guide` | `--ds-color-border-guide` | `color-mix(in srgb, {color.text.faint} 45%, {color.border.default})` | `color-mix(in srgb, {color.text.faint} 45%, {color.border.default})` | Tree indent guides. Seed: --docs-guide. |
| `color.border.image` | `--ds-color-border-image` | `#0000001a` | `#ffffff1a` | Outline on images and media: pure black at 10%, never a tinted neutral. Inset it with border.width.hairline and a negative hairline offset. |

#### `color.fill`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.fill.chip` | `--ds-color-fill-chip` | `#ebebe9` | `#21262d` | Inline code chips and neutral tags. Seed: --palette-chip. |
| `color.fill.hover` | `--ds-color-fill-hover` | `color-mix(in srgb, {color.text.ink} 6%, {color.surface.panel})` | `color-mix(in srgb, {color.text.ink} 6%, {color.surface.panel})` | Hover background of rows (tables, trees, disclosures, media buttons). Seed: --docs-hover. |
| `color.fill.active` | `--ds-color-fill-active` | `{color.gray.soft}` | `{color.gray.soft}` | Selected or active row (sidebar selection), pressed toggles, button hover. Seed: --muted. |
| `color.fill.accent` | `--ds-color-fill-accent` | `{color.blue.soft}` | `{color.blue.soft}` | Accent wash behind an active tab or accent button; pair with color.blue.text. Seed: --accent. |

#### `color.accent`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.accent` | `--ds-color-accent` | `#0078df` | `#4493f8` | Interactive accent: selection outlines, drop indicators, toggles. Fills, borders and focus only: text uses color.link (light accent is 4.34:1 on the page, under AA). Seed: --palette-accent. |

#### `color.link`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.link` | `--ds-color-link` | `#245a81` | `#4493f8` | Links and doc references. Seed: --palette-link. |

#### `color.focus-ring`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.focus-ring` | `--ds-color-focus-ring` | `{color.accent}` | `{color.accent}` | Focus outline, >= 3:1 on page, panel and sidebar. Seed: --docs-focus-ring. |

#### `color.selection`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.selection` | `--ds-color-selection` | `color-mix(in srgb, {color.accent} 18%, transparent)` | `color-mix(in srgb, {color.accent} 30%, transparent)` | Text selection; selected text keeps its own color. Seed: --docs-selection. |

#### `color.gray`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.gray.text` | `--ds-color-gray-text` | `#666562` | `#9198a1` | Text-safe gray (>= 4.5:1 on page, panel and gray.soft). |
| `color.gray.solid` | `--ds-color-gray-solid` | `#9b9a97` | `#656c76` | Gray tile or fill. |
| `color.gray.on-solid` | `--ds-color-gray-on-solid` | `{color.text.ink}` | `#ffffff` | Glyph on gray.solid. Light: ink, 5.86:1. Dark: white, 5.30:1. |
| `color.gray.soft` | `--ds-color-gray-soft` | `#ebeced` | `color-mix(in srgb, {color.gray.solid} 13%, {color.surface.panel})` | Opaque pale gray tint. |
| `color.gray.line` | `--ds-color-gray-line` | `color-mix(in srgb, {color.gray.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.gray.solid} 50%, {color.surface.panel})` | Gray hairline over a panel. |

#### `color.blue`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.blue.text` | `--ds-color-blue-text` | `#0b6e99` | `#4493f8` | Text-safe blue. |
| `color.blue.solid` | `--ds-color-blue-solid` | `#0b6e99` | `#4493f8` | Blue tile or fill. |
| `color.blue.on-solid` | `--ds-color-blue-on-solid` | `{color.text.on-solid}` | `{color.text.on-solid}` | Glyph on blue.solid. Light: white, 5.67:1. Dark: near-black, 6.11:1. |
| `color.blue.soft` | `--ds-color-blue-soft` | `#ddebf1` | `color-mix(in srgb, {color.blue.solid} 13%, {color.surface.panel})` | Opaque pale blue tint. |
| `color.blue.line` | `--ds-color-blue-line` | `color-mix(in srgb, {color.blue.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.blue.solid} 50%, {color.surface.panel})` | Blue hairline over a panel. |

#### `color.teal`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.teal.text` | `--ds-color-teal-text` | `#0d7164` | `#39c5cf` | Text-safe teal. |
| `color.teal.solid` | `--ds-color-teal-solid` | `#0f7b6c` | `#39c5cf` | Teal tile or fill. |
| `color.teal.on-solid` | `--ds-color-teal-on-solid` | `{color.text.on-solid}` | `{color.text.on-solid}` | Glyph on teal.solid. Light: white, 5.16:1. Dark: near-black, 9.07:1. |
| `color.teal.soft` | `--ds-color-teal-soft` | `#ddedea` | `color-mix(in srgb, {color.teal.solid} 13%, {color.surface.panel})` | Opaque pale teal tint. |
| `color.teal.line` | `--ds-color-teal-line` | `color-mix(in srgb, {color.teal.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.teal.solid} 50%, {color.surface.panel})` | Teal hairline over a panel. |

#### `color.green`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.green.text` | `--ds-color-green-text` | `#26744f` | `#3fb950` | Text-safe green. |
| `color.green.solid` | `--ds-color-green-solid` | `#287c55` | `#3fb950` | Green tile or fill. |
| `color.green.on-solid` | `--ds-color-green-on-solid` | `{color.text.on-solid}` | `{color.text.on-solid}` | Glyph on green.solid. Light: white, 5.12:1. Dark: near-black, 7.45:1. |
| `color.green.soft` | `--ds-color-green-soft` | `#e2efe6` | `color-mix(in srgb, {color.green.solid} 13%, {color.surface.panel})` | Opaque pale green tint. |
| `color.green.line` | `--ds-color-green-line` | `color-mix(in srgb, {color.green.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.green.solid} 50%, {color.surface.panel})` | Green hairline over a panel. |

#### `color.yellow`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.yellow.text` | `--ds-color-yellow-text` | `#805f01` | `#d29922` | Text-safe yellow (reads olive at body size; warnings use amber.text). |
| `color.yellow.solid` | `--ds-color-yellow-solid` | `#dfab01` | `#d29922` | Yellow tile or fill. |
| `color.yellow.on-solid` | `--ds-color-yellow-on-solid` | `{color.text.ink}` | `{color.text.on-solid}` | Glyph on yellow.solid. Light: ink, 7.82:1. Dark: near-black, 7.50:1. |
| `color.yellow.soft` | `--ds-color-yellow-soft` | `#fbf3db` | `color-mix(in srgb, {color.yellow.solid} 13%, {color.surface.panel})` | Opaque pale yellow tint. |
| `color.yellow.line` | `--ds-color-yellow-line` | `color-mix(in srgb, {color.yellow.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.yellow.solid} 50%, {color.surface.panel})` | Yellow hairline over a panel. |

#### `color.orange`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.orange.text` | `--ds-color-orange-text` | `#9d530d` | `#dd7330` | Text-safe orange. |
| `color.orange.solid` | `--ds-color-orange-solid` | `#d9730d` | `#db6d28` | Orange tile or fill. |
| `color.orange.on-solid` | `--ds-color-orange-on-solid` | `{color.text.ink}` | `{color.text.on-solid}` | Glyph on orange.solid. Light: ink, 5.03:1. Dark: near-black, 5.61:1. |
| `color.orange.soft` | `--ds-color-orange-soft` | `#faebdd` | `color-mix(in srgb, {color.orange.solid} 13%, {color.surface.panel})` | Opaque pale orange tint. |
| `color.orange.line` | `--ds-color-orange-line` | `color-mix(in srgb, {color.orange.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.orange.solid} 50%, {color.surface.panel})` | Orange hairline over a panel. |

#### `color.red`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.red.text` | `--ds-color-red-text` | `#c62121` | `#f85b53` | Text-safe red. |
| `color.red.solid` | `--ds-color-red-solid` | `#e03e3e` | `#f85149` | Red tile or fill. |
| `color.red.on-solid` | `--ds-color-red-on-solid` | `{color.text.on-solid}` | `{color.text.on-solid}` | Glyph on red.solid. Light: white, 4.26:1, the better glyph (ink is 3.87:1) but under AA for small text, so icons and large text only. Dark: near-black, 5.65:1. |
| `color.red.soft` | `--ds-color-red-soft` | `#fbe4e4` | `color-mix(in srgb, {color.red.solid} 13%, {color.surface.panel})` | Opaque pale red tint. |
| `color.red.line` | `--ds-color-red-line` | `color-mix(in srgb, {color.red.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.red.solid} 50%, {color.surface.panel})` | Red hairline over a panel. |

#### `color.violet`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.violet.text` | `--ds-color-violet-text` | `#6940a5` | `#ab7df8` | Text-safe violet. |
| `color.violet.solid` | `--ds-color-violet-solid` | `#6940a5` | `#ab7df8` | Violet tile or fill. |
| `color.violet.on-solid` | `--ds-color-violet-on-solid` | `{color.text.on-solid}` | `{color.text.on-solid}` | Glyph on violet.solid. Light: white, 7.30:1. Dark: near-black, 6.33:1. |
| `color.violet.soft` | `--ds-color-violet-soft` | `#eae4f2` | `color-mix(in srgb, {color.violet.solid} 13%, {color.surface.panel})` | Opaque pale violet tint. |
| `color.violet.line` | `--ds-color-violet-line` | `color-mix(in srgb, {color.violet.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.violet.solid} 50%, {color.surface.panel})` | Violet hairline over a panel. |

#### `color.pink`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.pink.text` | `--ds-color-pink-text` | `#ad1a72` | `#dd69a6` | Text-safe pink. |
| `color.pink.solid` | `--ds-color-pink-solid` | `#ad1a72` | `#db61a2` | Pink tile or fill. |
| `color.pink.on-solid` | `--ds-color-pink-on-solid` | `{color.text.on-solid}` | `{color.text.on-solid}` | Glyph on pink.solid. Light: white, 6.63:1. Dark: near-black, 5.63:1. |
| `color.pink.soft` | `--ds-color-pink-soft` | `#f4dfeb` | `color-mix(in srgb, {color.pink.solid} 13%, {color.surface.panel})` | Opaque pale pink tint. |
| `color.pink.line` | `--ds-color-pink-line` | `color-mix(in srgb, {color.pink.solid} 45%, {color.surface.panel})` | `color-mix(in srgb, {color.pink.solid} 50%, {color.surface.panel})` | Pink hairline over a panel. |

#### `color.amber`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.amber.text` | `--ds-color-amber-text` | `#9a5b00` | `#d29922` | Warning text: a clear amber (5.3:1 on the page) where yellow.text reads olive. Seed: --palette-amber. |

#### `color.status`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.status.info.text` | `--ds-color-status-info-text` | `{color.blue.text}` | `{color.blue.text}` | Info text, icon and rail. |
| `color.status.info.solid` | `--ds-color-status-info-solid` | `{color.blue.solid}` | `{color.blue.solid}` | Info tile. |
| `color.status.info.on-solid` | `--ds-color-status-info-on-solid` | `{color.blue.on-solid}` | `{color.blue.on-solid}` | Glyph on the info tile. |
| `color.status.info.soft` | `--ds-color-status-info-soft` | `{color.blue.soft}` | `{color.blue.soft}` | Info fill. |
| `color.status.info.line` | `--ds-color-status-info-line` | `{color.blue.line}` | `{color.blue.line}` | Info border. |
| `color.status.success.text` | `--ds-color-status-success-text` | `{color.green.text}` | `{color.green.text}` | Success text, icon and rail. |
| `color.status.success.solid` | `--ds-color-status-success-solid` | `{color.green.solid}` | `{color.green.solid}` | Success tile. |
| `color.status.success.on-solid` | `--ds-color-status-success-on-solid` | `{color.green.on-solid}` | `{color.green.on-solid}` | Glyph on the success tile. |
| `color.status.success.soft` | `--ds-color-status-success-soft` | `{color.green.soft}` | `{color.green.soft}` | Success fill. |
| `color.status.success.line` | `--ds-color-status-success-line` | `{color.green.line}` | `{color.green.line}` | Success border. |
| `color.status.warning.text` | `--ds-color-status-warning-text` | `{color.amber.text}` | `{color.amber.text}` | Warning text, icon and rail (amber, not olive yellow). |
| `color.status.warning.solid` | `--ds-color-status-warning-solid` | `{color.yellow.solid}` | `{color.yellow.solid}` | Warning tile. |
| `color.status.warning.on-solid` | `--ds-color-status-warning-on-solid` | `{color.yellow.on-solid}` | `{color.yellow.on-solid}` | Glyph on the warning tile. |
| `color.status.warning.soft` | `--ds-color-status-warning-soft` | `{color.yellow.soft}` | `{color.yellow.soft}` | Warning fill. |
| `color.status.warning.line` | `--ds-color-status-warning-line` | `{color.yellow.line}` | `{color.yellow.line}` | Warning border. |
| `color.status.danger.text` | `--ds-color-status-danger-text` | `{color.red.text}` | `{color.red.text}` | Danger and error text, icon and rail. |
| `color.status.danger.solid` | `--ds-color-status-danger-solid` | `{color.red.solid}` | `{color.red.solid}` | Danger tile. |
| `color.status.danger.on-solid` | `--ds-color-status-danger-on-solid` | `{color.red.on-solid}` | `{color.red.on-solid}` | Glyph on the danger tile. |
| `color.status.danger.soft` | `--ds-color-status-danger-soft` | `{color.red.soft}` | `{color.red.soft}` | Danger fill. |
| `color.status.danger.line` | `--ds-color-status-danger-line` | `{color.red.line}` | `{color.red.line}` | Danger border. |
| `color.status.neutral.text` | `--ds-color-status-neutral-text` | `{color.gray.text}` | `{color.gray.text}` | Neutral status text. |
| `color.status.neutral.solid` | `--ds-color-status-neutral-solid` | `{color.gray.solid}` | `{color.gray.solid}` | Neutral tile. |
| `color.status.neutral.on-solid` | `--ds-color-status-neutral-on-solid` | `{color.gray.on-solid}` | `{color.gray.on-solid}` | Glyph on the neutral tile. |
| `color.status.neutral.soft` | `--ds-color-status-neutral-soft` | `{color.gray.soft}` | `{color.gray.soft}` | Neutral fill. |
| `color.status.neutral.line` | `--ds-color-status-neutral-line` | `{color.gray.line}` | `{color.gray.line}` | Neutral border. |

#### `color.category`

Categorical roster for series, tags and depth cycles, in this order.

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.category.1.text` | `--ds-color-category-1-text` | `{color.blue.text}` | `{color.blue.text}` | Category 1 (blue). |
| `color.category.1.soft` | `--ds-color-category-1-soft` | `{color.blue.soft}` | `{color.blue.soft}` | Category 1 fill. |
| `color.category.2.text` | `--ds-color-category-2-text` | `{color.teal.text}` | `{color.teal.text}` | Category 2 (teal). |
| `color.category.2.soft` | `--ds-color-category-2-soft` | `{color.teal.soft}` | `{color.teal.soft}` | Category 2 fill. |
| `color.category.3.text` | `--ds-color-category-3-text` | `{color.green.text}` | `{color.green.text}` | Category 3 (green). |
| `color.category.3.soft` | `--ds-color-category-3-soft` | `{color.green.soft}` | `{color.green.soft}` | Category 3 fill. |
| `color.category.4.text` | `--ds-color-category-4-text` | `{color.yellow.text}` | `{color.yellow.text}` | Category 4 (yellow). |
| `color.category.4.soft` | `--ds-color-category-4-soft` | `{color.yellow.soft}` | `{color.yellow.soft}` | Category 4 fill. |
| `color.category.5.text` | `--ds-color-category-5-text` | `{color.violet.text}` | `{color.violet.text}` | Category 5 (violet). |
| `color.category.5.soft` | `--ds-color-category-5-soft` | `{color.violet.soft}` | `{color.violet.soft}` | Category 5 fill. |
| `color.category.6.text` | `--ds-color-category-6-text` | `{color.pink.text}` | `{color.pink.text}` | Category 6 (pink). |
| `color.category.6.soft` | `--ds-color-category-6-soft` | `{color.pink.soft}` | `{color.pink.soft}` | Category 6 fill. |

#### `color.chart`

Data-viz palette for charts (ECharts, SVG, canvas). series.1 to series.8 are categorical: assign them in order and never cycle; a ninth series folds into Other. Scatter, bubble and small-multiple charts use at most series.1 to series.3. Each theme passes the dataviz checks: OKLCH lightness in band, chroma >= 0.1, adjacent series apart under protanopia and deuteranopia (OKLab dE >= 8) and normal vision (dE >= 15), and >= 3:1 on page and panel. Not on surface.sunken: light series 2, 4, 5 and 8 fall to 2.84-2.88:1 there, so a chart sits on page or panel. Text never takes a series color: labels and values use color.text.*, gridlines color.border.subtle, axes color.border.strong.

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.chart.series.1` | `--ds-color-chart-series-1` | `#088bd9` | `#0891e3` | Series 1 (blue). A single-series chart uses this slot. |
| `color.chart.series.2` | `--ds-color-chart-series-2` | `#dd6d07` | `#dd6d07` | Series 2 (orange). |
| `color.chart.series.3` | `--ds-color-chart-series-3` | `#c84e90` | `#c84e90` | Series 3 (pink). |
| `color.chart.series.4` | `--ds-color-chart-series-4` | `#b48509` | `#b48509` | Series 4 (yellow). |
| `color.chart.series.5` | `--ds-color-chart-series-5` | `#0d9c97` | `#0ea29d` | Series 5 (teal). |
| `color.chart.series.6` | `--ds-color-chart-series-6` | `#d44e48` | `#d44e48` | Series 6 (red). |
| `color.chart.series.7` | `--ds-color-chart-series-7` | `#976bde` | `#976bde` | Series 7 (violet). |
| `color.chart.series.8` | `--ds-color-chart-series-8` | `#09a253` | `#09a655` | Series 8 (green). |
| `color.chart.diverging.positive` | `--ds-color-chart-diverging-positive` | `{color.chart.series.1}` | `{color.chart.series.1}` | Diverging positive pole (blue): inflow, gain, above the baseline. |
| `color.chart.diverging.midpoint` | `--ds-color-chart-diverging-midpoint` | `{color.gray.line}` | `{color.gray.line}` | Diverging neutral midpoint (gray): zero, no change. |
| `color.chart.diverging.negative` | `--ds-color-chart-diverging-negative` | `{color.chart.series.6}` | `{color.chart.series.6}` | Diverging negative pole (red): outflow, loss, below the baseline. |

#### `color.diff`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.diff.add` | `--ds-color-diff-add` | `{color.green.text}` | `{color.green.text}` | Added: sign, name and marker. |
| `color.diff.add-bg` | `--ds-color-diff-add-bg` | `color-mix(in srgb, {color.green.solid} 8%, {color.surface.panel})` | `color-mix(in srgb, {color.green.solid} 8%, {color.surface.panel})` | Added row tint (opaque; muted and syntax text keep 4.5:1 on it). |
| `color.diff.del` | `--ds-color-diff-del` | `{color.red.text}` | `{color.red.text}` | Removed: sign, name and marker. |
| `color.diff.del-bg` | `--ds-color-diff-del-bg` | `color-mix(in srgb, {color.red.solid} 8%, {color.surface.panel})` | `color-mix(in srgb, {color.red.solid} 8%, {color.surface.panel})` | Removed row tint. |
| `color.diff.mod` | `--ds-color-diff-mod` | `{color.yellow.text}` | `{color.yellow.text}` | Modified or renamed: sign, name and marker. |
| `color.diff.mod-bg` | `--ds-color-diff-mod-bg` | `color-mix(in srgb, {color.yellow.solid} 9%, {color.surface.panel})` | `color-mix(in srgb, {color.yellow.solid} 7%, {color.surface.panel})` | Modified row tint. |

#### `color.syntax`

Code token colors inside code panels: VS Code Light+ in light, Dark+ in dark.

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.syntax.punctuation` | `--ds-color-syntax-punctuation` | `#000000` | `#d4d4d4` | Punctuation and plain code text. |
| `color.syntax.keyword` | `--ds-color-syntax-keyword` | `#0000ff` | `#569cd6` | Declaration keywords (const, function, class). |
| `color.syntax.control` | `--ds-color-syntax-control` | `#af00db` | `#c586c0` | Control-flow keywords (if, return, import, await). |
| `color.syntax.function` | `--ds-color-syntax-function` | `#795e26` | `#dcdcaa` | Function and method names. |
| `color.syntax.type` | `--ds-color-syntax-type` | `#267f99` | `#4ec9b0` | Types and classes. |
| `color.syntax.key` | `--ds-color-syntax-key` | `#001080` | `#9cdcfe` | Properties, object keys, variables. |
| `color.syntax.string` | `--ds-color-syntax-string` | `#a31515` | `#ce9178` | Strings. |
| `color.syntax.number` | `--ds-color-syntax-number` | `#098658` | `#b5cea8` | Numbers. |
| `color.syntax.boolean` | `--ds-color-syntax-boolean` | `#0000ff` | `#569cd6` | true / false. |
| `color.syntax.null` | `--ds-color-syntax-null` | `#0000ff` | `#569cd6` | null / undefined / None. |
| `color.syntax.comment` | `--ds-color-syntax-comment` | `#008000` | `#6a9955` | Comments. |
| `color.syntax.regex` | `--ds-color-syntax-regex` | `#811f3f` | `#d16969` | Regular expressions. |
| `color.syntax.tag` | `--ds-color-syntax-tag` | `#800000` | `#569cd6` | Markup tag names. |
| `color.syntax.constant` | `--ds-color-syntax-constant` | `#0070c1` | `#4fc1ff` | UPPER_CASE constants and entities. |
| `color.syntax.selector` | `--ds-color-syntax-selector` | `#800000` | `#d7ba7d` | CSS selectors. |

#### `color.code`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.code.bg` | `--ds-color-code-bg` | `color-mix(in srgb, {color.gray.soft} 30%, transparent)` | `#1e1e1e` | Code panel background when code panels follow the light page. |
| `color.code.border` | `--ds-color-code-border` | `{color.border.default}` | `#3c3c3c` | Code panel frame. |
| `color.code.header-fg` | `--ds-color-code-header-fg` | `{color.text.muted}` | `#cccccc` | Code panel header strip text (language label). |
| `color.code.gutter-fg` | `--ds-color-code-gutter-fg` | `color-mix(in srgb, {color.text.faint} 65%, {color.text.muted})` | `#858585` | Line numbers (>= 3:1). |
| `color.code.gutter-bg` | `--ds-color-code-gutter-bg` | `color-mix(in srgb, {color.gray.soft} 30%, {color.surface.page})` | `{color.code.bg}` | Opaque sticky gutter, equal to the panel composited over the page. |
| `color.code.chip.ink` | `--ds-color-code-chip-ink` | `{color.text.ink}` | `#d4d4d4` | Inline code chip text. |
| `color.code.chip.string` | `--ds-color-code-chip-string` | `{color.syntax.string}` | `{color.syntax.string}` | Typed chip: paths and strings. |
| `color.code.chip.type` | `--ds-color-code-chip-type` | `#22728a` | `{color.syntax.type}` | Typed chip: types (Light+ type darkened 10% for 4.5:1 on the chip fill). |
| `color.code.chip.call` | `--ds-color-code-chip-call` | `{color.syntax.function}` | `{color.syntax.function}` | Typed chip: calls. |
| `color.code.chip.literal` | `--ds-color-code-chip-literal` | `#08794f` | `{color.syntax.number}` | Typed chip: number literals (Light+ number darkened 10% for 4.5:1 on the chip fill). |
| `color.code.chip.keyword` | `--ds-color-code-chip-keyword` | `{color.syntax.keyword}` | `{color.syntax.keyword}` | Typed chip: keyword literals. |
| `color.code.chip.prop` | `--ds-color-code-chip-prop` | `{color.syntax.key}` | `{color.syntax.key}` | Typed chip: properties. |

#### `color.annotation`

The annotate / AI layer keeps its own violet identity, distinct from the app accent.

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.annotation.accent` | `--ds-color-annotation-accent` | `#7862b8` | `#8a7ab0` | Targeting ring, composer accent, AI panel tabs. |
| `color.annotation.accent-lit` | `--ds-color-annotation-accent-lit` | `#5b4699` | `#ad9dd0` | Active AI tab label. |
| `color.annotation.accent-dim` | `--ds-color-annotation-accent-dim` | `#9488bd` | `#7a6d98` | Inactive annotation marks. |
| `color.annotation.active-bg` | `--ds-color-annotation-active-bg` | `rgba(120, 98, 184, 0.1)` | `rgba(138, 122, 176, 0.16)` | Active annotation wash. |
| `color.annotation.surface` | `--ds-color-annotation-surface` | `#ffffff` | `#1c1c20` | Annotation popover surface. |
| `color.annotation.text` | `--ds-color-annotation-text` | `#18181b` | `#e4e4e7` | Annotation popover text. |
| `color.annotation.muted` | `--ds-color-annotation-muted` | `#71717a` | `#a1a1aa` | Annotation popover secondary text. |
| `color.annotation.border` | `--ds-color-annotation-border` | `rgba(120, 98, 184, 0.38)` | `rgba(173, 157, 208, 0.3)` | Annotation panel and popover edge. |
| `color.annotation.danger` | `--ds-color-annotation-danger` | `#dc2626` | `#f87171` | Destructive annotation actions. |
| `color.annotation.wash` | `--ds-color-annotation-wash` | `color-mix(in srgb, {color.annotation.accent} 8%, transparent)` | `color-mix(in srgb, {color.annotation.accent} 8%, transparent)` | Ambient annotate-mode wash. |
| `color.annotation.add` | `--ds-color-annotation-add` | `{color.notion.text.green}` | `{color.notion.text.green}` | Staged addition. |
| `color.annotation.add-bg` | `--ds-color-annotation-add-bg` | `color-mix(in srgb, {color.notion.text.green} 14%, transparent)` | `color-mix(in srgb, {color.notion.text.green} 18%, transparent)` | Staged addition wash. |
| `color.annotation.del` | `--ds-color-annotation-del` | `{color.notion.text.red}` | `{color.notion.text.red}` | Staged deletion. |
| `color.annotation.del-bg` | `--ds-color-annotation-del-bg` | `color-mix(in srgb, {color.notion.text.red} 14%, transparent)` | `color-mix(in srgb, {color.notion.text.red} 18%, transparent)` | Staged deletion wash. |

#### `color.glass`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.glass.bg` | `--ds-color-glass-bg` | `rgba(255, 255, 255, 0.85)` | `rgba(24, 24, 24, 0.72)` | Glass panel fill (blurred backdrop shows through). |
| `color.glass.border` | `--ds-color-glass-border` | `rgba(28, 22, 54, 0.14)` | `rgba(255, 255, 255, 0.12)` | Glass panel edge: violet-tinted so it separates from the warm page. |
| `color.glass.zone-border` | `--ds-color-glass-zone-border` | `rgba(28, 22, 54, 0.09)` | `rgba(255, 255, 255, 0.08)` | Dividers between zones inside a glass panel. |

#### `color.backdrop`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.backdrop` | `--ds-color-backdrop` | `#00000066` | `#00000066` | Modal dialog backdrop. |

#### `color.notion`

Compat: the Notion palette (--color-* in docs-system). Feeds docs-system's style-rail accent families and a few legacy consumers. New UI uses the hue and role tokens.

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `color.notion.text.default` | `--ds-color-notion-text-default` | `{color.text.body}` | `{color.text.body}` | Seed: --color-text-default. |
| `color.notion.text.navigation` | `--ds-color-notion-text-navigation` | `{color.link}` | `{color.link}` | Seed: --color-text-navigation. |
| `color.notion.text.gray` | `--ds-color-notion-text-gray` | `#9b9a97` | `#9198a1` | Seed: --color-text-gray. |
| `color.notion.text.brown` | `--ds-color-notion-text-brown` | `#64473a` | `#937264` | Seed: --color-text-brown. |
| `color.notion.text.orange` | `--ds-color-notion-text-orange` | `#d9730d` | `#dd7330` | Seed: --color-text-orange. |
| `color.notion.text.yellow` | `--ds-color-notion-text-yellow` | `#dfab01` | `#d29922` | Seed: --color-text-yellow. |
| `color.notion.text.green` | `--ds-color-notion-text-green` | `#0f7b6c` | `#3fb950` | Seed: --color-text-green. |
| `color.notion.text.blue` | `--ds-color-notion-text-blue` | `#0b6e99` | `#4493f8` | Seed: --color-text-blue (highlight, drag-select and drop-line color). |
| `color.notion.text.purple` | `--ds-color-notion-text-purple` | `#6940a5` | `#ab7df8` | Seed: --color-text-purple. |
| `color.notion.text.pink` | `--ds-color-notion-text-pink` | `#ad1a72` | `#dd69a6` | Seed: --color-text-pink. |
| `color.notion.text.red` | `--ds-color-notion-text-red` | `#e03e3e` | `#f85b53` | Seed: --color-text-red. |
| `color.notion.bg.default` | `--ds-color-notion-bg-default` | `{color.surface.page}` | `{color.surface.page}` | Seed: --color-bg-default. |
| `color.notion.bg.sidebar` | `--ds-color-notion-bg-sidebar` | `{color.surface.sidebar}` | `{color.surface.sidebar}` | Seed: --color-bg-sidebar. |
| `color.notion.bg.gray` | `--ds-color-notion-bg-gray` | `#ebeced` | `#1f252e` | Seed: --color-bg-gray. |
| `color.notion.bg.brown` | `--ds-color-notion-bg-brown` | `#e9e5e3` | `#434040` | Seed: --color-bg-brown. |
| `color.notion.bg.orange` | `--ds-color-notion-bg-orange` | `#faebdd` | `#2f2624` | Seed: --color-bg-orange. |
| `color.notion.bg.yellow` | `--ds-color-notion-bg-yellow` | `#fbf3db` | `#2e2b23` | Seed: --color-bg-yellow. |
| `color.notion.bg.green` | `--ds-color-notion-bg-green` | `#ddedea` | `#1a3029` | Seed: --color-bg-green. |
| `color.notion.bg.blue` | `--ds-color-notion-bg-blue` | `#ddebf1` | `#1b2b3f` | Seed: --color-bg-blue (block highlight and changed-flash fill). |
| `color.notion.bg.purple` | `--ds-color-notion-bg-purple` | `#eae4f2` | `#29283f` | Seed: --color-bg-purple. |
| `color.notion.bg.pink` | `--ds-color-notion-bg-pink` | `#f4dfeb` | `#2f2434` | Seed: --color-bg-pink. |
| `color.notion.bg.red` | `--ds-color-notion-bg-red` | `#fbe4e4` | `#332228` | Seed: --color-bg-red. |
| `color.notion.pill.default` | `--ds-color-notion-pill-default` | `rgba(206, 205, 202, 0.5)` | `rgba(101, 108, 118, 0.5)` | Seed: --color-pill-default (style-rail border-strength base). |
| `color.notion.pill.gray` | `--ds-color-notion-pill-gray` | `#9b9a9766` | `#656c7666` | Seed: --color-pill-gray, rgba(155,154,151,0.4). |
| `color.notion.pill.brown` | `--ds-color-notion-pill-brown` | `#8c2e0033` | `rgba(147, 114, 100, 0.5)` | Seed: --color-pill-brown, rgba(140,46,0,0.2). |
| `color.notion.pill.orange` | `--ds-color-notion-pill-orange` | `#f55d0033` | `#db6d2866` | Seed: --color-pill-orange, rgba(245,93,0,0.2) (quote border). |
| `color.notion.pill.yellow` | `--ds-color-notion-pill-yellow` | `#e9a80033` | `#d2992266` | Seed: --color-pill-yellow, rgba(233,168,0,0.2). |
| `color.notion.pill.green` | `--ds-color-notion-pill-green` | `#00876b33` | `#3fb95066` | Seed: --color-pill-green, rgba(0,135,107,0.2). |
| `color.notion.pill.blue` | `--ds-color-notion-pill-blue` | `#0078df33` | `#4493f866` | Seed: --color-pill-blue, rgba(0,120,223,0.2). |
| `color.notion.pill.purple` | `--ds-color-notion-pill-purple` | `#6724de33` | `#ab7df866` | Seed: --color-pill-purple, rgba(103,36,222,0.2). |
| `color.notion.pill.pink` | `--ds-color-notion-pill-pink` | `#dd008133` | `#db61a266` | Seed: --color-pill-pink, rgba(221,0,129,0.2). |
| `color.notion.pill.red` | `--ds-color-notion-pill-red` | `#ff001a33` | `#f8514966` | Seed: --color-pill-red, rgba(255,0,26,0.2). |
| `color.notion.accent.blue` | `--ds-color-notion-accent-blue` | `{color.accent}` | `{color.accent}` | Seed: --color-accent-blue, rgb(0,120,223). |

#### `shadow`

| Token | CSS variable | Light | Dark | Description |
| --- | --- | --- | --- | --- |
| `shadow.glass` | `--ds-shadow-glass` | `0 10px 32px rgba(30, 22, 60, 0.12), 0 1px 3px rgba(0, 0, 0, 0.07)` | `0 10px 32px rgba(0, 0, 0, 0.5)` | Glass panel lift: separates the panel from the warm page. Seed: --docs-lab-panel-shadow. |
| `shadow.dialog` | `--ds-shadow-dialog` | `0 20px 80px #00000044` | `0 20px 80px #00000044` | Modal dialog lift. Seed: export dialog box-shadow #0004. |
| `shadow.card` | `--ds-shadow-card` | `0 0 0 1px #0000000f, 0 1px 2px -1px #0000000f, 0 2px 4px 0 #0000000a` | `0 0 0 1px #ffffff14` | Layered card edge in place of a border, where a hairline fights an image or a colored backdrop. Borders stay the default. |
| `shadow.card-hover` | `--ds-shadow-card-hover` | `0 0 0 1px #00000014, 0 1px 2px -1px #00000014, 0 2px 4px 0 #0000000f` | `0 0 0 1px #ffffff1f` | shadow.card on hover: the same layers a step stronger. Transition box-shadow only. |

### Tailwind utilities

Keys written by `dist/tailwind/theme.css`. Each reads the token's `--ds-*` variable, so utilities follow `data-theme`.

`theme.css` also redefines `dark:` as `[data-theme="dark"]` or `.dark` on the element or an ancestor, instead of the OS setting. `dist/tailwind/strict.css` (`@codecaine-ai/design-system/tailwind-strict.css`, imported before `tailwind.css`) clears Tailwind's default palette, type, radius, shadow, blur and easing scales, so only the utilities below remain.

| Theme key | Token | Example utilities |
| --- | --- | --- |
| `--color-accent` | `color.accent` | `bg-accent`, `text-accent`, `border-accent` |
| `--color-amber` | `color.amber.text` | `bg-amber`, `text-amber`, `border-amber` |
| `--color-annotation` | `color.annotation.accent` | `bg-annotation`, `text-annotation`, `border-annotation` |
| `--color-annotation-accent-dim` | `color.annotation.accent-dim` | `bg-annotation-accent-dim`, `text-annotation-accent-dim`, `border-annotation-accent-dim` |
| `--color-annotation-accent-lit` | `color.annotation.accent-lit` | `bg-annotation-accent-lit`, `text-annotation-accent-lit`, `border-annotation-accent-lit` |
| `--color-annotation-active-bg` | `color.annotation.active-bg` | `bg-annotation-active-bg`, `text-annotation-active-bg`, `border-annotation-active-bg` |
| `--color-annotation-add` | `color.annotation.add` | `bg-annotation-add`, `text-annotation-add`, `border-annotation-add` |
| `--color-annotation-add-bg` | `color.annotation.add-bg` | `bg-annotation-add-bg`, `text-annotation-add-bg`, `border-annotation-add-bg` |
| `--color-annotation-border` | `color.annotation.border` | `bg-annotation-border`, `text-annotation-border`, `border-annotation-border` |
| `--color-annotation-danger` | `color.annotation.danger` | `bg-annotation-danger`, `text-annotation-danger`, `border-annotation-danger` |
| `--color-annotation-del` | `color.annotation.del` | `bg-annotation-del`, `text-annotation-del`, `border-annotation-del` |
| `--color-annotation-del-bg` | `color.annotation.del-bg` | `bg-annotation-del-bg`, `text-annotation-del-bg`, `border-annotation-del-bg` |
| `--color-annotation-muted` | `color.annotation.muted` | `bg-annotation-muted`, `text-annotation-muted`, `border-annotation-muted` |
| `--color-annotation-surface` | `color.annotation.surface` | `bg-annotation-surface`, `text-annotation-surface`, `border-annotation-surface` |
| `--color-annotation-text` | `color.annotation.text` | `bg-annotation-text`, `text-annotation-text`, `border-annotation-text` |
| `--color-annotation-wash` | `color.annotation.wash` | `bg-annotation-wash`, `text-annotation-wash`, `border-annotation-wash` |
| `--color-backdrop` | `color.backdrop` | `bg-backdrop`, `text-backdrop`, `border-backdrop` |
| `--color-blue-line` | `color.blue.line` | `bg-blue-line`, `text-blue-line`, `border-blue-line` |
| `--color-blue-on-solid` | `color.blue.on-solid` | `bg-blue-on-solid`, `text-blue-on-solid`, `border-blue-on-solid` |
| `--color-blue-soft` | `color.blue.soft` | `bg-blue-soft`, `text-blue-soft`, `border-blue-soft` |
| `--color-blue-solid` | `color.blue.solid` | `bg-blue-solid`, `text-blue-solid`, `border-blue-solid` |
| `--color-blue` | `color.blue.text` | `bg-blue`, `text-blue`, `border-blue` |
| `--border-color-rule` | `color.border.default` | `border-rule` |
| `--border-color-guide` | `color.border.guide` | `border-guide` |
| `--border-color-rule-image` | `color.border.image` | `border-rule-image` |
| `--border-color-rule-strong` | `color.border.strong` | `border-rule-strong` |
| `--border-color-rule-subtle` | `color.border.subtle` | `border-rule-subtle` |
| `--color-cat-1-soft` | `color.category.1.soft` | `bg-cat-1-soft`, `text-cat-1-soft`, `border-cat-1-soft` |
| `--color-cat-1` | `color.category.1.text` | `bg-cat-1`, `text-cat-1`, `border-cat-1` |
| `--color-cat-2-soft` | `color.category.2.soft` | `bg-cat-2-soft`, `text-cat-2-soft`, `border-cat-2-soft` |
| `--color-cat-2` | `color.category.2.text` | `bg-cat-2`, `text-cat-2`, `border-cat-2` |
| `--color-cat-3-soft` | `color.category.3.soft` | `bg-cat-3-soft`, `text-cat-3-soft`, `border-cat-3-soft` |
| `--color-cat-3` | `color.category.3.text` | `bg-cat-3`, `text-cat-3`, `border-cat-3` |
| `--color-cat-4-soft` | `color.category.4.soft` | `bg-cat-4-soft`, `text-cat-4-soft`, `border-cat-4-soft` |
| `--color-cat-4` | `color.category.4.text` | `bg-cat-4`, `text-cat-4`, `border-cat-4` |
| `--color-cat-5-soft` | `color.category.5.soft` | `bg-cat-5-soft`, `text-cat-5-soft`, `border-cat-5-soft` |
| `--color-cat-5` | `color.category.5.text` | `bg-cat-5`, `text-cat-5`, `border-cat-5` |
| `--color-cat-6-soft` | `color.category.6.soft` | `bg-cat-6-soft`, `text-cat-6-soft`, `border-cat-6-soft` |
| `--color-cat-6` | `color.category.6.text` | `bg-cat-6`, `text-cat-6`, `border-cat-6` |
| `--color-chart-diverging-midpoint` | `color.chart.diverging.midpoint` | `bg-chart-diverging-midpoint`, `text-chart-diverging-midpoint`, `border-chart-diverging-midpoint` |
| `--color-chart-diverging-negative` | `color.chart.diverging.negative` | `bg-chart-diverging-negative`, `text-chart-diverging-negative`, `border-chart-diverging-negative` |
| `--color-chart-diverging-positive` | `color.chart.diverging.positive` | `bg-chart-diverging-positive`, `text-chart-diverging-positive`, `border-chart-diverging-positive` |
| `--color-chart-series-1` | `color.chart.series.1` | `bg-chart-series-1`, `text-chart-series-1`, `border-chart-series-1` |
| `--color-chart-series-2` | `color.chart.series.2` | `bg-chart-series-2`, `text-chart-series-2`, `border-chart-series-2` |
| `--color-chart-series-3` | `color.chart.series.3` | `bg-chart-series-3`, `text-chart-series-3`, `border-chart-series-3` |
| `--color-chart-series-4` | `color.chart.series.4` | `bg-chart-series-4`, `text-chart-series-4`, `border-chart-series-4` |
| `--color-chart-series-5` | `color.chart.series.5` | `bg-chart-series-5`, `text-chart-series-5`, `border-chart-series-5` |
| `--color-chart-series-6` | `color.chart.series.6` | `bg-chart-series-6`, `text-chart-series-6`, `border-chart-series-6` |
| `--color-chart-series-7` | `color.chart.series.7` | `bg-chart-series-7`, `text-chart-series-7`, `border-chart-series-7` |
| `--color-chart-series-8` | `color.chart.series.8` | `bg-chart-series-8`, `text-chart-series-8`, `border-chart-series-8` |
| `--color-code-bg` | `color.code.bg` | `bg-code-bg`, `text-code-bg`, `border-code-bg` |
| `--color-code-border` | `color.code.border` | `bg-code-border`, `text-code-border`, `border-code-border` |
| `--color-code-chip-call` | `color.code.chip.call` | `bg-code-chip-call`, `text-code-chip-call`, `border-code-chip-call` |
| `--color-code-chip-ink` | `color.code.chip.ink` | `bg-code-chip-ink`, `text-code-chip-ink`, `border-code-chip-ink` |
| `--color-code-chip-keyword` | `color.code.chip.keyword` | `bg-code-chip-keyword`, `text-code-chip-keyword`, `border-code-chip-keyword` |
| `--color-code-chip-literal` | `color.code.chip.literal` | `bg-code-chip-literal`, `text-code-chip-literal`, `border-code-chip-literal` |
| `--color-code-chip-prop` | `color.code.chip.prop` | `bg-code-chip-prop`, `text-code-chip-prop`, `border-code-chip-prop` |
| `--color-code-chip-string` | `color.code.chip.string` | `bg-code-chip-string`, `text-code-chip-string`, `border-code-chip-string` |
| `--color-code-chip-type` | `color.code.chip.type` | `bg-code-chip-type`, `text-code-chip-type`, `border-code-chip-type` |
| `--color-code-gutter-bg` | `color.code.gutter-bg` | `bg-code-gutter-bg`, `text-code-gutter-bg`, `border-code-gutter-bg` |
| `--color-code-gutter-fg` | `color.code.gutter-fg` | `bg-code-gutter-fg`, `text-code-gutter-fg`, `border-code-gutter-fg` |
| `--color-code-header-fg` | `color.code.header-fg` | `bg-code-header-fg`, `text-code-header-fg`, `border-code-header-fg` |
| `--color-diff-add` | `color.diff.add` | `bg-diff-add`, `text-diff-add`, `border-diff-add` |
| `--color-diff-add-bg` | `color.diff.add-bg` | `bg-diff-add-bg`, `text-diff-add-bg`, `border-diff-add-bg` |
| `--color-diff-del` | `color.diff.del` | `bg-diff-del`, `text-diff-del`, `border-diff-del` |
| `--color-diff-del-bg` | `color.diff.del-bg` | `bg-diff-del-bg`, `text-diff-del-bg`, `border-diff-del-bg` |
| `--color-diff-mod` | `color.diff.mod` | `bg-diff-mod`, `text-diff-mod`, `border-diff-mod` |
| `--color-diff-mod-bg` | `color.diff.mod-bg` | `bg-diff-mod-bg`, `text-diff-mod-bg`, `border-diff-mod-bg` |
| `--background-color-accent-soft` | `color.fill.accent` | `bg-accent-soft` |
| `--background-color-active` | `color.fill.active` | `bg-active` |
| `--background-color-chip` | `color.fill.chip` | `bg-chip` |
| `--background-color-hover` | `color.fill.hover` | `bg-hover` |
| `--color-focus` | `color.focus-ring` | `bg-focus`, `text-focus`, `border-focus` |
| `--color-glass` | `color.glass.bg` | `bg-glass`, `text-glass`, `border-glass` |
| `--color-glass-border` | `color.glass.border` | `bg-glass-border`, `text-glass-border`, `border-glass-border` |
| `--color-glass-zone-border` | `color.glass.zone-border` | `bg-glass-zone-border`, `text-glass-zone-border`, `border-glass-zone-border` |
| `--color-gray-line` | `color.gray.line` | `bg-gray-line`, `text-gray-line`, `border-gray-line` |
| `--color-gray-on-solid` | `color.gray.on-solid` | `bg-gray-on-solid`, `text-gray-on-solid`, `border-gray-on-solid` |
| `--color-gray-soft` | `color.gray.soft` | `bg-gray-soft`, `text-gray-soft`, `border-gray-soft` |
| `--color-gray-solid` | `color.gray.solid` | `bg-gray-solid`, `text-gray-solid`, `border-gray-solid` |
| `--color-gray` | `color.gray.text` | `bg-gray`, `text-gray`, `border-gray` |
| `--color-green-line` | `color.green.line` | `bg-green-line`, `text-green-line`, `border-green-line` |
| `--color-green-on-solid` | `color.green.on-solid` | `bg-green-on-solid`, `text-green-on-solid`, `border-green-on-solid` |
| `--color-green-soft` | `color.green.soft` | `bg-green-soft`, `text-green-soft`, `border-green-soft` |
| `--color-green-solid` | `color.green.solid` | `bg-green-solid`, `text-green-solid`, `border-green-solid` |
| `--color-green` | `color.green.text` | `bg-green`, `text-green`, `border-green` |
| `--color-link` | `color.link` | `bg-link`, `text-link`, `border-link` |
| `--color-orange-line` | `color.orange.line` | `bg-orange-line`, `text-orange-line`, `border-orange-line` |
| `--color-orange-on-solid` | `color.orange.on-solid` | `bg-orange-on-solid`, `text-orange-on-solid`, `border-orange-on-solid` |
| `--color-orange-soft` | `color.orange.soft` | `bg-orange-soft`, `text-orange-soft`, `border-orange-soft` |
| `--color-orange-solid` | `color.orange.solid` | `bg-orange-solid`, `text-orange-solid`, `border-orange-solid` |
| `--color-orange` | `color.orange.text` | `bg-orange`, `text-orange`, `border-orange` |
| `--color-pink-line` | `color.pink.line` | `bg-pink-line`, `text-pink-line`, `border-pink-line` |
| `--color-pink-on-solid` | `color.pink.on-solid` | `bg-pink-on-solid`, `text-pink-on-solid`, `border-pink-on-solid` |
| `--color-pink-soft` | `color.pink.soft` | `bg-pink-soft`, `text-pink-soft`, `border-pink-soft` |
| `--color-pink-solid` | `color.pink.solid` | `bg-pink-solid`, `text-pink-solid`, `border-pink-solid` |
| `--color-pink` | `color.pink.text` | `bg-pink`, `text-pink`, `border-pink` |
| `--color-red-line` | `color.red.line` | `bg-red-line`, `text-red-line`, `border-red-line` |
| `--color-red-on-solid` | `color.red.on-solid` | `bg-red-on-solid`, `text-red-on-solid`, `border-red-on-solid` |
| `--color-red-soft` | `color.red.soft` | `bg-red-soft`, `text-red-soft`, `border-red-soft` |
| `--color-red-solid` | `color.red.solid` | `bg-red-solid`, `text-red-solid`, `border-red-solid` |
| `--color-red` | `color.red.text` | `bg-red`, `text-red`, `border-red` |
| `--color-selection` | `color.selection` | `bg-selection`, `text-selection`, `border-selection` |
| `--color-danger-line` | `color.status.danger.line` | `bg-danger-line`, `text-danger-line`, `border-danger-line` |
| `--color-danger-on-solid` | `color.status.danger.on-solid` | `bg-danger-on-solid`, `text-danger-on-solid`, `border-danger-on-solid` |
| `--color-danger-soft` | `color.status.danger.soft` | `bg-danger-soft`, `text-danger-soft`, `border-danger-soft` |
| `--color-danger-solid` | `color.status.danger.solid` | `bg-danger-solid`, `text-danger-solid`, `border-danger-solid` |
| `--color-danger` | `color.status.danger.text` | `bg-danger`, `text-danger`, `border-danger` |
| `--color-info-line` | `color.status.info.line` | `bg-info-line`, `text-info-line`, `border-info-line` |
| `--color-info-on-solid` | `color.status.info.on-solid` | `bg-info-on-solid`, `text-info-on-solid`, `border-info-on-solid` |
| `--color-info-soft` | `color.status.info.soft` | `bg-info-soft`, `text-info-soft`, `border-info-soft` |
| `--color-info-solid` | `color.status.info.solid` | `bg-info-solid`, `text-info-solid`, `border-info-solid` |
| `--color-info` | `color.status.info.text` | `bg-info`, `text-info`, `border-info` |
| `--color-neutral-line` | `color.status.neutral.line` | `bg-neutral-line`, `text-neutral-line`, `border-neutral-line` |
| `--color-neutral-on-solid` | `color.status.neutral.on-solid` | `bg-neutral-on-solid`, `text-neutral-on-solid`, `border-neutral-on-solid` |
| `--color-neutral-soft` | `color.status.neutral.soft` | `bg-neutral-soft`, `text-neutral-soft`, `border-neutral-soft` |
| `--color-neutral-solid` | `color.status.neutral.solid` | `bg-neutral-solid`, `text-neutral-solid`, `border-neutral-solid` |
| `--color-neutral` | `color.status.neutral.text` | `bg-neutral`, `text-neutral`, `border-neutral` |
| `--color-success-line` | `color.status.success.line` | `bg-success-line`, `text-success-line`, `border-success-line` |
| `--color-success-on-solid` | `color.status.success.on-solid` | `bg-success-on-solid`, `text-success-on-solid`, `border-success-on-solid` |
| `--color-success-soft` | `color.status.success.soft` | `bg-success-soft`, `text-success-soft`, `border-success-soft` |
| `--color-success-solid` | `color.status.success.solid` | `bg-success-solid`, `text-success-solid`, `border-success-solid` |
| `--color-success` | `color.status.success.text` | `bg-success`, `text-success`, `border-success` |
| `--color-warning-line` | `color.status.warning.line` | `bg-warning-line`, `text-warning-line`, `border-warning-line` |
| `--color-warning-on-solid` | `color.status.warning.on-solid` | `bg-warning-on-solid`, `text-warning-on-solid`, `border-warning-on-solid` |
| `--color-warning-soft` | `color.status.warning.soft` | `bg-warning-soft`, `text-warning-soft`, `border-warning-soft` |
| `--color-warning-solid` | `color.status.warning.solid` | `bg-warning-solid`, `text-warning-solid`, `border-warning-solid` |
| `--color-warning` | `color.status.warning.text` | `bg-warning`, `text-warning`, `border-warning` |
| `--background-color-inset` | `color.surface.inset` | `bg-inset` |
| `--background-color-page` | `color.surface.page` | `bg-page` |
| `--background-color-panel` | `color.surface.panel` | `bg-panel` |
| `--background-color-sidebar` | `color.surface.sidebar` | `bg-sidebar` |
| `--background-color-sunken` | `color.surface.sunken` | `bg-sunken` |
| `--color-syntax-boolean` | `color.syntax.boolean` | `bg-syntax-boolean`, `text-syntax-boolean`, `border-syntax-boolean` |
| `--color-syntax-comment` | `color.syntax.comment` | `bg-syntax-comment`, `text-syntax-comment`, `border-syntax-comment` |
| `--color-syntax-constant` | `color.syntax.constant` | `bg-syntax-constant`, `text-syntax-constant`, `border-syntax-constant` |
| `--color-syntax-control` | `color.syntax.control` | `bg-syntax-control`, `text-syntax-control`, `border-syntax-control` |
| `--color-syntax-function` | `color.syntax.function` | `bg-syntax-function`, `text-syntax-function`, `border-syntax-function` |
| `--color-syntax-key` | `color.syntax.key` | `bg-syntax-key`, `text-syntax-key`, `border-syntax-key` |
| `--color-syntax-keyword` | `color.syntax.keyword` | `bg-syntax-keyword`, `text-syntax-keyword`, `border-syntax-keyword` |
| `--color-syntax-null` | `color.syntax.null` | `bg-syntax-null`, `text-syntax-null`, `border-syntax-null` |
| `--color-syntax-number` | `color.syntax.number` | `bg-syntax-number`, `text-syntax-number`, `border-syntax-number` |
| `--color-syntax-punctuation` | `color.syntax.punctuation` | `bg-syntax-punctuation`, `text-syntax-punctuation`, `border-syntax-punctuation` |
| `--color-syntax-regex` | `color.syntax.regex` | `bg-syntax-regex`, `text-syntax-regex`, `border-syntax-regex` |
| `--color-syntax-selector` | `color.syntax.selector` | `bg-syntax-selector`, `text-syntax-selector`, `border-syntax-selector` |
| `--color-syntax-string` | `color.syntax.string` | `bg-syntax-string`, `text-syntax-string`, `border-syntax-string` |
| `--color-syntax-tag` | `color.syntax.tag` | `bg-syntax-tag`, `text-syntax-tag`, `border-syntax-tag` |
| `--color-syntax-type` | `color.syntax.type` | `bg-syntax-type`, `text-syntax-type`, `border-syntax-type` |
| `--color-teal-line` | `color.teal.line` | `bg-teal-line`, `text-teal-line`, `border-teal-line` |
| `--color-teal-on-solid` | `color.teal.on-solid` | `bg-teal-on-solid`, `text-teal-on-solid`, `border-teal-on-solid` |
| `--color-teal-soft` | `color.teal.soft` | `bg-teal-soft`, `text-teal-soft`, `border-teal-soft` |
| `--color-teal-solid` | `color.teal.solid` | `bg-teal-solid`, `text-teal-solid`, `border-teal-solid` |
| `--color-teal` | `color.teal.text` | `bg-teal`, `text-teal`, `border-teal` |
| `--text-color-body` | `color.text.body` | `text-body` |
| `--text-color-faint` | `color.text.faint` | `text-faint` |
| `--text-color-ink` | `color.text.ink` | `text-ink` |
| `--text-color-muted` | `color.text.muted` | `text-muted` |
| `--text-color-on-solid` | `color.text.on-solid` | `text-on-solid` |
| `--text-color-secondary` | `color.text.secondary` | `text-secondary` |
| `--color-violet-line` | `color.violet.line` | `bg-violet-line`, `text-violet-line`, `border-violet-line` |
| `--color-violet-on-solid` | `color.violet.on-solid` | `bg-violet-on-solid`, `text-violet-on-solid`, `border-violet-on-solid` |
| `--color-violet-soft` | `color.violet.soft` | `bg-violet-soft`, `text-violet-soft`, `border-violet-soft` |
| `--color-violet-solid` | `color.violet.solid` | `bg-violet-solid`, `text-violet-solid`, `border-violet-solid` |
| `--color-violet` | `color.violet.text` | `bg-violet`, `text-violet`, `border-violet` |
| `--color-yellow-line` | `color.yellow.line` | `bg-yellow-line`, `text-yellow-line`, `border-yellow-line` |
| `--color-yellow-on-solid` | `color.yellow.on-solid` | `bg-yellow-on-solid`, `text-yellow-on-solid`, `border-yellow-on-solid` |
| `--color-yellow-soft` | `color.yellow.soft` | `bg-yellow-soft`, `text-yellow-soft`, `border-yellow-soft` |
| `--color-yellow-solid` | `color.yellow.solid` | `bg-yellow-solid`, `text-yellow-solid`, `border-yellow-solid` |
| `--color-yellow` | `color.yellow.text` | `bg-yellow`, `text-yellow`, `border-yellow` |
| `--shadow-card` | `shadow.card` | `shadow-card` |
| `--shadow-card-hover` | `shadow.card-hover` | `shadow-card-hover` |
| `--shadow-dialog` | `shadow.dialog` | `shadow-dialog` |
| `--shadow-glass` | `shadow.glass` | `shadow-glass` |
| `--blur-glass` | `blur.glass` | `blur-glass`, `backdrop-blur-glass` |
| `--blur-motion` | `blur.motion` | `blur-motion`, `backdrop-blur-motion` |
| `--border-width-focus` | `border.width.focus` | `border-focus` |
| `--border-width-hairline` | `border.width.hairline` | `border-hairline` |
| `--border-width-rail` | `border.width.rail` | `border-rail` |
| `--border-width-ring` | `border.width.ring` | `border-ring` |
| `--height-control-lg` | `control.height.lg` | `h-control-lg` |
| `--height-control-md` | `control.height.md` | `h-control-md` |
| `--height-control-sm` | `control.height.sm` | `h-control-sm` |
| `--outline-offset-focus` | `focus.ring.offset` | `outline-offset-focus` |
| `--font-mono` | `font.family.mono` | `font-mono` |
| `--font-mono-system` | `font.family.mono-system` | `font-mono-system` |
| `--font-sans` | `font.family.sans` | `font-sans` |
| `--font-serif` | `font.family.serif` | `font-serif` |
| `--text-code` | `font.size.code` | `text-code` |
| `--text-micro` | `font.size.micro` | `text-micro` |
| `--text-reading` | `font.size.reading` | `text-reading` |
| `--text-title` | `font.size.title` | `text-title` |
| `--text-ui-2xs` | `font.size.ui-2xs` | `text-ui-2xs` |
| `--text-ui-lg` | `font.size.ui-lg` | `text-ui-lg` |
| `--text-ui-md` | `font.size.ui-md` | `text-ui-md` |
| `--text-ui-sm` | `font.size.ui-sm` | `text-ui-sm` |
| `--text-ui-xs` | `font.size.ui-xs` | `text-ui-xs` |
| `--font-weight-bold` | `font.weight.bold` | `font-bold` |
| `--font-weight-medium` | `font.weight.medium` | `font-medium` |
| `--font-weight-regular` | `font.weight.regular` | `font-regular` |
| `--font-weight-semibold` | `font.weight.semibold` | `font-semibold` |
| `--padding-content-bottom` | `layout.content.padding-bottom` | `pb-content-bottom` |
| `--padding-content-top` | `layout.content.padding-top` | `pt-content-top` |
| `--padding-content-x` | `layout.content.padding-x` | `px-content-x` |
| `--container-inspector` | `layout.inspector.width` | `w-inspector`, `max-w-inspector` |
| `--container-lane-code` | `layout.lane.code` | `max-w-lane-code` |
| `--container-lane-text` | `layout.lane.text` | `max-w-lane-text` |
| `--container-lane-wide` | `layout.lane.wide` | `max-w-lane-wide` |
| `--size-sidebar-avatar` | `layout.sidebar.avatar-size` | `size-sidebar-avatar` |
| `--size-sidebar-icon` | `layout.sidebar.icon-size` | `size-sidebar-icon` |
| `--height-sidebar-item` | `layout.sidebar.item-height` | `h-sidebar-item` |
| `--padding-sidebar-item-x` | `layout.sidebar.item-padding-x` | `px-sidebar-item-x` |
| `--padding-sidebar-x` | `layout.sidebar.padding-x` | `px-sidebar-x` |
| `--height-sidebar-subitem` | `layout.sidebar.subitem-height` | `h-sidebar-subitem` |
| `--size-sidebar-toggle` | `layout.sidebar.toggle-size` | `size-sidebar-toggle` |
| `--container-sidebar` | `layout.sidebar.width` | `w-sidebar`, `max-w-sidebar` |
| `--container-sidebar-collapsed` | `layout.sidebar.width-collapsed` | `w-sidebar-collapsed`, `max-w-sidebar-collapsed` |
| `--height-topbar` | `layout.topbar.height` | `h-topbar` |
| `--padding-topbar-x` | `layout.topbar.padding-x` | `px-topbar-x` |
| `--tracking-micro` | `letter-spacing.micro` | `tracking-micro` |
| `--tracking-micro-wide` | `letter-spacing.micro-wide` | `tracking-micro-wide` |
| `--tracking-normal` | `letter-spacing.normal` | `tracking-normal` |
| `--tracking-title` | `letter-spacing.title` | `tracking-title` |
| `--leading-code` | `line-height.code` | `leading-code` |
| `--leading-reading` | `line-height.reading` | `leading-reading` |
| `--leading-row` | `line-height.row` | `leading-row` |
| `--leading-title` | `line-height.tight` | `leading-title` |
| `--leading-ui` | `line-height.ui` | `leading-ui` |
| `--ease-decelerate` | `motion.easing.decelerate` | `ease-decelerate` |
| `--ease-emphasized` | `motion.easing.emphasized` | `ease-emphasized` |
| `--ease-out` | `motion.easing.out` | `ease-out` |
| `--ease-standard` | `motion.easing.standard` | `ease-standard` |
| `--ease-swap` | `motion.easing.swap` | `ease-swap` |
| `--radius-xs` | `radius.base` | `rounded-xs` |
| `--radius-sm` | `radius.base` | `rounded-sm` |
| `--radius-md` | `radius.base` | `rounded-md` |
| `--radius-lg` | `radius.base` | `rounded-lg` |
| `--radius-xl` | `radius.base` | `rounded-xl` |
| `--radius-2xl` | `radius.base` | `rounded-2xl` |
| `--radius-3xl` | `radius.base` | `rounded-3xl` |
| `--radius-4xl` | `radius.base` | `rounded-4xl` |
| `--radius-pill` | `radius.pill` | `rounded-pill` |
| `--spacing` | `space.1` | `p-1`, `gap-2`, `w-7` |
| `--z-index-overlay` | `z.overlay` | `z-overlay` |
| `--z-index-panel` | `z.panel` | `z-panel` |
| `--z-index-popover` | `z.popover` | `z-popover` |
| `--z-index-raised` | `z.raised` | `z-raised` |
| `--z-index-top` | `z.top` | `z-top` |
| `--text-reading--line-height` | `line-height.reading` | `text-reading` |
| `--text-code--line-height` | `line-height.code` | `text-code` |
| `--text-title--line-height` | `line-height.tight` | `text-title` |
| `--text-title--letter-spacing` | `letter-spacing.title` | `text-title` |
| `--text-title--font-weight` | `font.weight.bold` | `text-title` |

<!-- END GENERATED: token reference -->
