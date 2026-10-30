# Migration audit

This audit plans the move of every on-device UI onto `@codecaine-ai/design-system`. It checks each surface against the three standards:

1. **Tokens.** Every color and size comes from the package. See [tokens.md](tokens.md).
2. **Layout.** Apps you click around in use the app shell. See [layout.md](layout.md).
3. **Code structure.** UI code is in vertical slices. See [code-structure.md](code-structure.md).

Snapshot: 2026-10-05. Literal counts come from [`scripts/scan-literals.ts`](../scripts/scan-literals.ts). The commands are in [Reproduce the counts](#reproduce-the-counts). docs-system's token migration was in progress during the scan, so its counts are a baseline only.

## How to read the numbers

- **Hard literals** break the token standard: hex, `rgb()`, `hsl()`, `oklch()`, Tailwind arbitrary values (`text-[11px]`, `bg-[#fff]`), px font sizes, `border-radius` and `font-family` declarations.
- **Soft signals** are close to the standard and still need work: Tailwind default-palette classes (`bg-zinc-900`), named colors, `bg-[var(--x)]` classes and px spacing.
- Color literals split three ways:
  - **definitions** (`--x: #fff`, shadcn `--x: 222 47% 11%`, JSON themes): alias or delete one file
  - **var() fallbacks** (`var(--x, #fff)`): already behind a token
  - **inline** literals: one edit per site
- **Tokens hours** = wiring + engine bridge + extras + definitions ÷ 90 + (fallbacks + `[var()]` classes) ÷ 150 + (inline colors + arbitrary values + px font sizes + radii + families + palette classes + named colors) ÷ 60 + QA (0.5h per 3 screens per theme mode).
- **Shell hours** come from a score against [layout.md](layout.md):
  - 3/3 = 0–1h
  - 2/3 = 2–4h
  - 1/3 = 4–8h
  - 0/3 = 6–12h
- **Slices hours** = 0.2h per component file moved + 1–2h per file over 400 lines + about 1h per route slice.
- Hours are agent-assisted work plus human visual QA. They are effort, not calendar time.
- Not included:
  - docs-system's own token migration (another worker owns it)
  - canvas's FigJam preset and its 10 categorical inks (data colors that stay canvas-owned)

## 1. Summary

| Surface | Stack | Tokens: hard literals → h | Shell: score → h | Structure → h | Total h |
| --- | --- | --- | --- | --- | --- |
| **Wave 0: package prerequisites** | | | | | **16** |
| **Wave 1: Core, near the docs look** | | | | | **173.5** |
| docs-workbench | React 19, Vite 7, TW4, Electron, bun | 311, migrating now | 2/3 → 3 | 10 files >400 → 23 | 26 |
| docs-viewer (library) | React 19 lib, host TW4 | 633 (329 are fallbacks or defs), migrating now | N/A | 12 >400 → 43 optional | 0 (+43) |
| docs-publish | Bun.build, TW4 CSS | 29, migrating now | N/A | flat → 2 optional | 0 (+2) |
| annotations (library) | React 19 lib, injected CSS | 39 → 3 | N/A | 2 >400 → 6 optional | 3 (+6) |
| sequence renderer | TS → SVG | 6 → 2 | N/A | N/A | 2 |
| sequence studio | React 19, Vite 7, plain CSS | 60 → 2 | 1/3 → 4 | 2 >400 → 6 | 12 |
| canvas studio | React 19, Vite 7, TW4, Electron | 94 → 4.5 | 1/3 → 5 | 5 >400 → 13 | 22.5 |
| canvas renderer theme + chrome | TS theme objects, SVG | 313 → 12.5 | N/A | keep as is | 12.5 |
| viewer-shell (library) | React 19 lib, runtime styleVars | 175 → 6.5 | rail → inspector 1.5 | 3 >400 → 7 optional | 8 (+7) |
| viewer-ui (library) | React 19 lib, host TW | 147 → 4 | N/A | 8 >400 → 22 optional | 4 (+22) |
| prompt-kit UI (library) | React 19 lib, inline + host TW | 251 → 10 | N/A | 15 >400 → 35 optional | 10 (+35) |
| canvas-agent viewer | React 19, Vite 7, TW4 | 93 → 2.5 | 1/3 → 4 | flat → 4 | 10.5 |
| simple-research-kernel | React 19, Vite 5, TW3 | 133 → 5.5 | 1/3 → 4.5 | 1 >400 → 4.5 | 14.5 |
| observatory | React 19, Vite 7, TW4, link: | 261 → 8.5 | 2/3 → 2.5 | 1 >400 → 5.5 | 16.5 |
| system-view | Electron 37, plain CSS | 37 → 4 | 1/3 → 3 | 2 >400 → 4 | 11 |
| variator | React 19, Bun.build, plain CSS | 159 → 5.5 | 2/3 → 3 | 1528-line main.tsx → 11 | 19.5 |
| docs-mcp home page | inline HTML | 27 → 1.5 | N/A | N/A | 1.5 |
| **Wave 2: Lascari AI, personal site, personal apps** | | | | | **111.5** |
| personal-site content pages | Vite 7 MPA, vanilla TS, npm | 263 → 7.5 | N/A (site) | → 1 | 8.5 |
| agent-skills manager | vanilla JS, Python server | 116 → 4.5 | 2/3 → 3 | N/A | 7.5 |
| Slidev template | Slidev 51, Vue 3, UnoCSS | 203 + 262 palette classes → 13 | N/A | N/A | 13 |
| budget web | React 19, Vite 8, plain CSS, TW3 kernel view | 1,757 → 41 | 2/3 → 3 | `Named/Named.tsx` → 15 | 59 |
| pen-plotter desktop | Electron 44, plain CSS, canvas | 183 → 5.5 | 1/3 → 4 | 6 >400 → 14 | 23.5 |
| **Wave 3: dark-only creative apps** | | | | | **145** |
| MainMenu authoring app | Next 15, TW4, Electron 30, npm | 779 → 22 | 1/3 → 5 | 10 >400 → 24 | 51 |
| skitzo | Next 16, TW4, Clerk, npm | 751 → 19 | 1/3 → 4.5 | 6 >400 → 16 | 39.5 |
| gamecube-decomp-harness | React 19, Vite 8, TW4, link: | 1,087 → 23 | 3/3 → 3 | 7 >400 → 23 | 49 |
| CircleSnakesWeb panels | Three.js, Vite 7, TW4, npm | 90 → 4 | N/A (canvas) | sliced → 1.5 | 5.5 |
| **Later: after a decision or when the app is active again** | | | | | **242.5** |
| Spectre frontend | React 19, Vite 7, TW4, shadcn, JSON themes | 474 → 18.5 | 2/3 → 6 | 22 >400 → 65 | 89.5 |
| x-replier | Next 14, TW3, shadcn, Clerk, npm | 115 + 191 palette → 14.5 | 2/3 → 3 | 5 >400 → 16 | 33.5 |
| x-writer | Next 14, TW3, shadcn, Clerk, npm | 146 + 244 palette → 15.5 | 2/3 → 3 | 4 >400 → 13 | 31.5 |
| font-pipe web | Next 15, TW3, bun | 15 + 136 palette → 8 | 0/3 → 6 | flat → 9 | 23 |
| font-effects web | vanilla JS, Vite 5, npm | 159 → 4 | N/A | 2 >400 → 3.5 | 7.5 |
| token-burner dashboard | vanilla TS, raw CSS | 139 → 7 | 1/3 → 7 | 1 >400 → 8 | 22 |
| ai-age | Next 15, TW4, npm | 318 → 9.5 | 1/3 → 6 | 3 >400 → 9 | 24.5 |
| sotto / V07 (native) | SwiftUI | Swift palette → 7.5 | N/A | N/A | 7.5 |
| sotto archive viewer | vanilla HTML/JS | 69 → 2 | N/A | N/A | 2 |
| CircleSnakesWeb docs | VitePress 2 | 0 → 1.5 | N/A | N/A | 1.5 |
| **Total** | | **315.5h tokens** | **84h shell** | **289h slices** | **688.5 (+115 optional)** |

The skipped surfaces are listed in [Skip](#skip).

### Key findings

1. **The layout reference has the biggest token debt in the workspace.**
   - budget web has 1,757 hard literals: 603 distinct hex values, 24 px font sizes and 19 radii. It is light only.
   - 155 of its 199 `src` files are untracked in git, and 28 more are modified.
   - Its shell breaks rules in the standard it seeded:
     - collapse is not persisted
     - there is no inspector
     - folders use `Named/Named.tsx`, not `index.tsx`
   - gamecube-decomp-harness has the most complete shell (3/3): a persisted icon rail and a resizable, persisted inspector.
2. **Runtime theme engines drive the cost, not literal counts.** Each engine needs about 3h of bridge work and an owner decision on user knobs:
   - Spectre: JSON engine, 233 variables, 3 themes, a theme editor and a grain overlay
   - viewer-shell: `styleVars()` writes colors inline, which overrides `--ds-*`
   - prompt-kit: style engine with saved hex colors
   - canvas: TS presets that need resolved hex for SVG and resvg, because they cannot read CSS variables
   - gamecube: effect engine
3. **Core can reach the package; most other repos cannot yet.**
   - Core is wired: `codecaine/core/package.json` lists `design-system` (the folder inside Core) in its workspaces, so Core packages depend on it with `workspace:*`, a live symlink.
   - Other bun repos need the same wiring: the design-system path in the root `workspaces` plus `workspace:*`, or `bun link`.
   - Do not use a bun `file:` dependency. bun materializes it at install time, so new or regenerated token files stay stale until `bun install` runs again. That breaks "change a token once". npm's `file:` for a directory is a symlink and stays live.
   - The package is `private`. Five apps build in Docker, Vercel or Railway contexts that cannot see a path outside the repo: personal-site, skitzo, CircleSnakesWeb, x-replier and x-writer.
   - Three Electron apps must bundle its CSS and fonts: MainMenu, canvas studio and pen-plotter.
   - It ships no `@font-face` (see "Known gaps" in [layout.md](layout.md)).
4. **Copies already drift.**
   - personal-site `src/site/palette.css` is byte-identical to docs-system's `notion-palette.css`.
   - personal-site's landing is the CircleSnakesWeb engine: same files, 297 vs 298 literals.
   - sequence studio copies canvas studio's Spectre palette.
   - observatory's `light-theme.css` is hand-copied.
   - system-view and the skills manager carry stale old-Notion palettes.
   - The agent-viewer host-token contract is copied by hand into every host. That includes a client app (kurate) that links Core's viewer-ui live.
5. **Ten surfaces are dark-only, and six still run Tailwind v3.**
   - Dark-only: MainMenu, skitzo, gamecube, CircleSnakesWeb, CircleSnakesUnity, codecaine-site, observatory chrome, the prompt-kit editor, x-replier and the docs-mcp home page. canvas-agent is dark by default.
   - Tailwind v3: the budget kernel view, simple-research-kernel, font-pipe web, x-replier, x-writer and the autohdr viewer.
   - Non-web targets: Unity USS, SwiftUI, UnoCSS (Slidev) and the pi TUI.

## 2. Migration waves

| Wave | Scope | Tokens h | Shell h | Slices h | Total h |
| --- | --- | --- | --- | --- | --- |
| 0 | Package prerequisites | 16 | | | 16 |
| 1 | Core surfaces near the docs look | 72 | 30.5 | 71 (+115 library slicing, decision 5) | 173.5 |
| 2 | Lascari AI, personal site, personal apps near the docs look | 71.5 | 10 | 30 | 111.5 |
| 3 | Dark-only creative apps | 68 | 12.5 | 64.5 | 145 |
| Later | Spectre, dormant apps, native | 88 | 31 | 123.5 | 242.5 |
| **Waves 0–3** | | **227.5** | **53** | **165.5** | **446** |

A tokens-only pass through waves 0–3 is 227.5h. Changes from the brief:

- **Wave 2 now holds the personal apps that already look like docs: budget and pen-plotter.** budget is the layout donor, not a Core surface. It needs dark mode before it matches.
- **Wave 3 adds gamecube-decomp-harness.** It is dark-only, and its look sits closest to MainMenu and skitzo.
- **Spectre moves to Later.** Its look is the farthest from docs-system, so it waits on decision 1.

### Wave 0: package prerequisites (design-system side)

| # | Item | Why | h | Needed by |
| --- | --- | --- | --- | --- |
| 1 | Consumer recipe. Core already resolves the package (`workspace:*`). Document the wiring for other repos: bun = the design-system path in the root `workspaces` plus `workspace:*`, or `bun link`, never `file:`; npm = `file:` to the directory (a symlink). Add the Vite settings (`server.fs.allow`, `@source`, `optimizeDeps.exclude`). | A bun `file:` dependency goes stale; Vite blocks files outside the project root. | 0.5 | Waves 1, 2 |
| 2 | Ship fonts and `color-scheme`: `@font-face` for Inter and IBM Plex Mono, sourced from `@codecaine-ai/text-measure` so canvas measurement does not drift. | [layout.md](layout.md) "Known gaps"; pen-plotter's CSP blocks remote fonts. | 1.5 | Wave 1 |
| 3 | One alias sheet for the agent-viewer host contract (about 60 names: shadcn, `trace-*`, `status-*`, `agentprism-*`, `syntax-*`, `editor-*`) mapped to `--ds-*`. | It replaces hand-copied contracts in budget, gamecube and kurate. | 3 | Wave 1 |
| 4 | Pack-and-vendor flow (`npm pack` to `vendor/*.tgz` plus a `file:` dep), the same as docs-publish. | Docker, Vercel and Railway builds cannot see `../codecaine/core/design-system`. | 2 | Waves 2, 3 |
| 5 | Tailwind v3 preset (decision 3). | Six v3 surfaces. | 3 | Waves 1, 2 |
| 6 | Data-viz palette tokens. | ECharts in budget, token-burner charts. | 2 | Wave 2 |
| 7 | Dark-first variant (decision 2). | Ten dark-only surfaces. | 4 | Wave 3 |

### Wave 1: Core surfaces near the docs look (173.5h)

1. Do prerequisites 1–3.
2. Migrate the small leaves: sequence renderer, docs-mcp home page, annotations.
3. Migrate viewer-shell and viewer-ui together. Five hosts use them: canvas-agent, simple-research-kernel, observatory, budget and gamecube.
4. Migrate the hosts: canvas-agent viewer, simple-research-kernel, observatory. Commit observatory's work in progress first.
5. Migrate canvas studio, the canvas renderer and sequence studio together. They share the copied Spectre palette.
6. Migrate system-view and variator after docs-workbench's tokens land, because both read docs-workbench variables. Initialize git in system-view first.
7. Migrate prompt-kit UI last. It needs a light editor palette designed first.
8. Do the shell work: docs-workbench, canvas studio, sequence studio, observatory, canvas-agent, simple-research-kernel, system-view and variator.

### Wave 2: Lascari AI, personal site, personal apps (111.5h)

1. Do prerequisites 4 and 6. Rebuild docs-publish and republish its tgz for personal-site.
2. Migrate personal-site content pages: delete the `palette.css` copy and load `tokens.css`.
3. Migrate the agent-skills manager and the Slidev template (template and new decks only).
4. Migrate budget web: commit first, then run the sweep, then adopt `templates/react-app-shell`. It is 41h of tokens, the largest single item. A codemod over `scan-literals --json --hits` with nearest-token mapping could cut the sweep by about half.
5. Migrate pen-plotter after its 10 open worktrees merge.

### Wave 3: dark-only creative apps (145h)

1. Do prerequisite 7 (dark-first variant). Settle the exemption list first (decision 2).
2. Migrate gamecube, MainMenu (authoring chrome only), skitzo (app screens only, not the landing hero) and the CircleSnakesWeb playground panels.

### Each wave is done when

- `bun scripts/scan-literals.ts <scan dirs> --fail-above <n>` passes, with `n` at the agreed floor: 0, plus documented exceptions such as data colors.
- Light and dark screenshots are checked. Dark-first surfaces check dark only.
- The shell checklist in [layout.md](layout.md) passes for apps that adopt the shell.

## 3. Decisions for you

### 1. Spectre: keep its look or adopt the design system?

Spectre has its own look: TX-02 mono body text, Bank Gothic display, warm cream paper, 6–8px radius, a grain overlay, a live theme editor and a FigJam theme.

| Option | Cost | Trade-off |
| --- | --- | --- |
| **A. Bridge (recommended)**: point its JSON palette and semantic leaves at `var(--ds-*)`; swap fonts to Inter and Plex; radius 2px; keep the engine and the editor | 18.5h tokens | One look. The editor keeps working. The font swap is the largest visual change. |
| B. Replace the engine with a static alias sheet; drop the editor, FigJam and grain | about 12h + QA | Less code. Needs status and domain tokens in the design system first. |
| C. Keep Spectre distinct | about 3h for embeds | Embedded Core UI still repaints through Spectre's variables. |

### 2. Which looks stay distinct, and how do dark-only apps fit?

- **Recommended exemptions** (product looks):
  - codecaine-site scenes
  - MainMenu rendered scenes and exports
  - the CircleSnakes landing, which is also personal-site's landing
  - skitzo's landing hero and serif display
  - sotto's brand palette
  - CircleSnakesUnity
- **Recommended mode rule**: add a dark-first variant (same tokens, dark by default, dark-only QA) for tool chrome in MainMenu, skitzo, gamecube, the CircleSnakes panels and the docs-mcp home page. Cost: 4h in wave 0.
- **Alternative**: require light and dark everywhere. This adds about 15h of light palettes and QA in wave 3.

### 3. Tailwind v3 apps: preset or upgrade?

Six surfaces run v3: the budget kernel view, simple-research-kernel, font-pipe web, x-replier, x-writer and the autohdr viewer.

- **Recommended**: ship a v3 preset once (3h).
  - It keeps budget and simple-research-kernel on agent-kernel's shared v3 config.
  - The `bg-[#hex]` and palette classes still need the sweep.
- **Alternative**: upgrade each to v4 (about 3–4h each).
  - Do this only for x-replier and x-writer if they become active.
  - x-writer already contains v4-only syntax that does nothing today.
- **Either way**, map shadcn's `--radius-sm/-md` to the design-system radius. `calc(var(--radius) - 4px)` falls to 0 or below at 2px.

### 4. Runtime style engines and user knobs

Six surfaces let users retune colors at runtime: viewer-shell (color pickers, grain, Copy CSS), the prompt-kit style rail, the docs-workbench Style Rail, the Spectre theme editor, the gamecube effect engine and the canvas Style rail.

- **Recommended now**: keep the engines, but seed them from design-system tokens.
  - Expose only non-color knobs (density, size, grain).
  - Bump their localStorage keys so stale hex values do not survive.
  - About 3h per engine; already in the hours above.
- **Later**: remove the color knobs (about 2–3k lines deleted).
  - Needs a change to agent-kernel's viewer-model doc ("rail knobs, not code forks").

### 5. Does the vertical-slice standard apply to embeddable libraries?

- **Recommended**: exempt the libraries and require only "no file over 400 lines" in them. Six libraries would cost 115h to restructure:

  | Library | h |
  | --- | --- |
  | docs-viewer | 43 |
  | prompt-kit UI | 35 |
  | viewer-ui | 22 |
  | viewer-shell | 7 |
  | annotations | 6 |
  | docs-publish | 2 |

- They already use feature folders and public export maps. Moving files breaks host `@source` globs and docs-publish's relative imports.
- **Alternative**: apply the full standard (+115h).
- Two related points for [code-structure.md](code-structure.md):
  - The reference uses `Named/Named.tsx` (13 folders) and no `index.tsx`. Pick one.
  - Measure files by bytes as well as lines. Dense files hide: budget's `ReviewContent.tsx` is 205 lines and 18.5 KB; variator's `main.tsx` is 1,528 lines and 74 KB.

## 4. Surfaces

Paths are relative to `/Users/Ford/workspace`. "Literals" lists the hard count first, with soft signals in brackets.

### Wave 1

#### docs-workbench

| | |
| --- | --- |
| Path | `codecaine/core/docs-system/packages/docs-workbench` (`web/src`, `web/*.html`, `electron/`) |
| Stack | React 19.2, Vite 7.3, Tailwind 4.3 (`@tailwindcss/vite`). Runs as a browser SPA (`docs-cli serve`), a static export and Electron 37. bun, with the Core and docs-system lockfiles. |
| Theme | Light and dark. `.dark` plus `data-theme` on `<html>`, set from the Style Rail and cached in `docs-viewer-theme`. Palette in `web/src/theme/{notion-palette.css, semantic.css, read-surface.css, theme-folders.ts}` plus runtime JSON themes in `docs-system/themes/`. Inter and IBM Plex Mono, 2px. This is the target look. |
| Literals | 311 hard (baseline before the token work). Colors: 262 definitions, 20 inline. 127 distinct hex. |
| Shell | 2/3. `web/src/shell/App.tsx`. Fixed `w-72` tree sidebar: no collapse, toggle, rail or persistence. A 44px DocPage header (breadcrumb, save, undo, AI toggle) instead of a shell topbar. Lanes exist (60ch, 88ch, 1100px). Three right panels: Style Rail (collapsible, persisted), DocPeekPanel and DocLab. |
| Structure | Role folders (`shell/`, `pages/`, `lab/`, `theme/`, `data/`, `lib/`). No `_components`. 48 files. 10 over 400 lines: `theme-folders.ts` 2298, `style-rail-panes.tsx` 1804, `DocPage.tsx` 1545, `semantic.css` 1367, `style-rail-settings.ts` 1271. |
| Consume via | Already wired: `@codecaine-ai/design-system` is a `workspace:*` dependency through Core. Add the package path to `spaSourceRoots` in `src/spa.ts`, or `serve` keeps a stale build. docs-system's standalone workspace does not list the package, so a standalone docs-system install cannot resolve it. |
| Hours | Tokens: other worker. Shell 3. Slices 23 (18–28). **26** |
| Risks | Three right panels, one inspector slot. Static and locked hosts must persist nothing. The deep tree has no icons for the rail. `style-rail.test.tsx` (5,355 lines) breaks on splits. |
| Wave | 1. Shell and structure after the tokens land. |

#### docs-viewer

| | |
| --- | --- |
| Path | `codecaine/core/docs-system/packages/docs-viewer/src`. Exclude `editor/menus/vendor/blocksuite`. |
| Stack | React 19 peer library, TipTap 3.27, radix, cva. No own build: hosts bundle it and compile its classes through `@source`. |
| Theme | Follows the host (`.dark`, `[data-theme]`, dark code-panel island). No palette of its own. Four sheets in `src/styles`. |
| Literals | 633 hard. Colors: 219 var() fallbacks, 110 definitions, 13 inline. 263 arbitrary values (`text-[12px]` ×25). [325 `[var()]` classes] |
| Shell | N/A (embeddable). DocPeekPanel and GlassPanel go in a host's inspector. |
| Structure | Per-block feature folders, kebab-case files, no `index.tsx`. 179 files. 12 over 400 lines: `doc-targeting-layer.tsx` 1663, `convert.ts` 882, `SlashMenu.tsx` 835, `editor-node-view.tsx` 823, `DocEditor.tsx` 760. |
| Consume via | Host CSS only. Keep literal fallbacks: the viewer must render without the host stylesheet. |
| Hours | Tokens: other worker. Slices 43, optional (decision 5). **0 (+43)** |
| Risks | docs-publish imports `../../docs-viewer/src` by relative path. Host `@source` globs change when files move. GlassPanel is forked in prompt-kit. |
| Wave | 1 for tokens. Defer slicing. |

#### docs-publish

| | |
| --- | --- |
| Path | `codecaine/core/docs-system/packages/docs-publish/src` |
| Stack | React 19 server render plus Bun.build bundles. CSS is built by Vite 7.3 and Tailwind 4.3 borrowed from docs-workbench. Output is packed as a tgz that personal-site vendors. |
| Theme | Set by the host. Imports the workbench theme. A few literals in `editor.css` and `styles.css`. |
| Literals | 29 hard (22 definitions). |
| Shell | N/A |
| Structure | Flat `src/`, 15 files, none over 400 lines. |
| Consume via | Build-time `@import` into `styles.css` and `editor.css`, so `dist/styles/docs.css` carries the tokens. |
| Hours | Tokens: other worker. Rebuild and republish 1h, counted in wave 2. Slices 2, optional. **0 (+2)** |
| Risks | `docs.css` declares tokens on `:root`; deduplicate them if personal-site also loads `tokens.css`. Every token change means rebuild, `npm pack` and a version bump in personal-site. |
| Wave | 1 |

#### annotations

| | |
| --- | --- |
| Path | `codecaine/core/annotations/src/react`. A submodule copy also lives in `docs-system/external/annotations`. |
| Stack | React 19 peer library. The load-bearing CSS is an injected `TARGETING_CSS` string. Host Tailwind compiles the utilities. |
| Theme | Light and dark through `prefers-color-scheme`, not `.dark`. Six `--annotation-*` tokens (indigo `#6366f1`); docs-workbench overrides them to violet. Radius `var(--radius, 6px)`. |
| Literals | 39 hard (30 in `useTargeting.tsx`). |
| Shell | N/A |
| Structure | Flat, 13 files. 2 over 400 lines: `useTargeting.tsx` 945, `AnnotationPanel.tsx` 481. |
| Consume via | `--ds-*` names inside the `TARGETING_CSS` fallback chains. No JS dependency, because the repo must typecheck on its own. |
| Hours | Tokens 3 (includes the switch to `.dark`). Slices 6, optional. **3 (+6)** |
| Risks | The Core copy and the docs-system submodule copy drift. Vite pre-bundling freezes styles in hosts. |
| Wave | 1 |

#### sequence renderer

| | |
| --- | --- |
| Path | `codecaine/core/sequence/packages/sequence/src` (`theme.ts`, `render/`, `text.ts`) |
| Stack | TypeScript that emits SVG markup strings. |
| Theme | `SEQUENCE_THEME_DEFAULTS` holds 6 hex values (accent `#C77D2E`, cream participants). Every SVG attribute is `var(--seq-*, #fallback)`, so host CSS can retheme it. Light only. Inter. 4px participants. |
| Literals | 6 hard |
| Shell / Structure | N/A (library) |
| Consume via | A host alias sheet maps `--seq-*` to `--ds-*`; docs-system already does this in `sequence-embed.css`. Also write design-system values into the defaults for `<img>`, PDF and resvg exports. |
| Hours | Tokens 2 (includes a dark `--seq-*` set). **2** |
| Risks | Changing the defaults restyles every diagram in the docs. Two alias layers (`--docs-sequence-*` and `--ds-*`) must not fight. |
| Wave | 1, with docs-system |

#### sequence studio

| | |
| --- | --- |
| Path | `codecaine/core/sequence/packages/studio/src` |
| Stack | React 19, Vite 7.3, plain CSS variables, bun (Core). Runs on `:3998`. |
| Theme | Light only. 14 `:root` properties copied from canvas studio's Spectre palette. Inter and SF Mono. 6–8px. |
| Literals | 60 hard. Colors: 12 definitions, 22 inline. 22 px font sizes. |
| Shell | 1/3. `EditorPage.tsx`: topbar with back, title and Style toggle. A Program pane (an editor, not navigation). A persisted right Style rail. The gallery is a standalone page. |
| Structure | Flat, 8 files. 2 over 400 lines: `index.css` 751, `StyleRail.tsx` 702. |
| Consume via | `workspace:*` plus `@import`. |
| Hours | Tokens 2. Shell 4. Slices 6. **12** |
| Risks | It copies canvas studio's palette, so migrate both together. |
| Wave | 1 |

#### canvas studio

| | |
| --- | --- |
| Path | `codecaine/core/canvas/packages/studio` (`src/`, `index.html`) |
| Stack | React 19.2, Vite 7.3, Tailwind 4.3 (`@tailwindcss/postcss`), shadcn token names, cva, radix. bun. Runs on `:3999` and in Electron 43. |
| Theme | Chrome is light only; the board can be schematic-dark. `src/index.css` holds 18 `:root` and 23 `@theme` entries, a snapshot of Spectre's warm "spectre-light" (paper `#f5f3ef`, black primary). system-ui chrome. Radius 0.5rem, floating chrome 12–16px. |
| Literals | 94 hard (33 arbitrary values, 21 radii, 31 colors). [26 palette classes] |
| Shell | 1/3 for the board list, gallery and evals pages (centered pages). N/A for the full-bleed editor (floating TopBar; Inspector, Style and AI panels). |
| Structure | Feature folders (`agent/`, `dev/`, `project/`, `style/`), no `_components`. 30 files. 5 over 400 lines: `App.tsx` 1297, `use-agent-session.ts` 713, `index.css` 605, `StyleRail.tsx` 593, `EvalsPage.tsx` 560. |
| Consume via | `workspace:*`. Replace the `:root` and `@theme` block with `@codecaine-ai/design-system/tailwind.css`. Add `fs.allow`, `optimizeDeps` and `dedupe` to `vite.config.ts`. |
| Hours | Tokens 4.5. Shell 5. Slices 13. **22.5** |
| Risks | shadcn radius steps (`calc(var(--radius) - 4px)`) reach 0 or below at 2px. Tailwind 4 `dark:` follows the OS until `@custom-variant dark` is set. The `/view` header hard-codes `bg-white/95`. The Electron build must bundle the package CSS and fonts. |
| Wave | 1 |

#### canvas renderer theme and editor chrome

| | |
| --- | --- |
| Path | `codecaine/core/canvas/packages/canvas/src` (`theme/`, `stage/`, `ui/`, `objects/`, `connectors/`) |
| Stack | TypeScript library. DOM and SVG with inline styles. The static SVG renderer runs in Node; agents rasterize it with resvg. |
| Theme | `theme/canvas-style.ts`: `CANVAS_THEME_PRESETS` (figjam, schematic-light default, schematic-dark; about 46 tokens each). `palette.ts`: the FigJam role table with 10 inks. OKLab mixing in `color-math.ts`. Saved overrides in `canvases/canvas-style.json`. It writes about 47 `--canvas-*` variables as output only. `normalizeColor` accepts only `#RRGGBB` or `rgba()`, so it cannot take `var()`. |
| Literals | 313 hard (243 colors, 140 of them in `palette.ts` and `canvas-style.ts`) |
| Shell / Structure | N/A. Leave the structure as it is. |
| Consume via | JS tokens with resolved hex per mode, from a Node-safe module (the package's `dist/js`). |
| Hours | Tokens 12.5 (3h engine bridge, 1.5h golden tests). **12.5** |
| Risks | Golden tests and about 4 MB of DOM baselines break. Text measurement is pinned to Inter 3.19 and Plex Mono 2.5, so the package must source its fonts from text-measure. Changing the default preset restyles every board and docs embed. The FigJam preset and the inks stay canvas-owned. |
| Wave | 1 (schematic neutrals and editor chrome only) |

#### agent-kernel viewer-shell

| | |
| --- | --- |
| Path | `codecaine/core/agent-kernel/packages/viewer-shell/src` |
| Stack | React 19 library shipped as TS source. `style-system.css` plus runtime `styleVars()`. |
| Theme | Light "doc paper" and dark "Instrument Telemetry". `style/style-settings.ts` holds about 90 colors as `[r, g, b]` tuples. Grain is on by default. Settings live in per-host localStorage (`simpleResearchStyleSettings.v1`, `canvasAgentViewerStyle.v1`, `observatory.viewerStyle.v1`). |
| Literals | 175 hard (82 tuple definitions, 77 arbitrary values) |
| Shell | N/A (embeddable). Its right style rail (52px strip, persisted) maps to the inspector slot: 1.5h. |
| Structure | 12 files. 3 over 400 lines: `style-settings.ts` 1012, `StyleSettingsPanel.tsx` 808, `KernelTraceWorkspace.tsx` 454. |
| Consume via | A CSS-variable contract (prerequisite 3), with no JS dependency. Seed the engine from tokens. |
| Hours | Tokens 6.5. Shell 1.5. Slices 7, optional. **8 (+7)** |
| Risks | `styleVars` writes inline colors that override `--ds-*` until removed. Stale per-host colors survive unless the keys are bumped. The emitter writes hex or triplets depending on the host. Pickers and grain are a documented choice (decision 4). |
| Wave | 1, before its hosts |

#### agent-kernel viewer-ui

| | |
| --- | --- |
| Path | `codecaine/core/agent-kernel/packages/viewer-ui/src`. Exclude `trace-viewer/icons/nucleo-src`. |
| Stack | React 19 library. Host Tailwind (a v3 config, or v4 `@theme inline` plus `@source`) and `trace-viewer.css`. |
| Theme | Reads a host contract of about 60 variables, mostly RGB triplets. The names are in `trace-viewer/theme/index.ts`. A fixed px type scale through arbitrary values. |
| Literals | 147 hard (140 arbitrary values such as `text-[11px]`) |
| Shell | N/A |
| Structure | 82 files. Partial folders: `AgentCatalogViewer/index.tsx`, `SpanCard/SpanCard.tsx`. 8 over 400 lines: `DetailShell.tsx` 962, `prompt-lab-session-controller.ts` 775, `SpanCard.tsx` 610, `AgentPromptLabContainer.tsx` 584, `DocFigure.tsx` 462. |
| Consume via | Keep the contract. The package ships the alias sheet (prerequisite 3). |
| Hours | Tokens 4. Slices 22, optional. **4 (+22)** |
| Risks | Changes reach 5 hosts live, including the kurate client app through `link:`. The px type scale is load-bearing (the corner-cap glyph). Tests assert classes (`contract-conformance.test.tsx`, 1,106 lines). |
| Wave | 1, with viewer-shell |

#### prompt-kit UI

| | |
| --- | --- |
| Path | `codecaine/core/prompt-kit/packages/prompt-kit/src/ui`. The 16 HTML mockups in `explorations/` (1,477 hard) are not migrated. |
| Stack | React 19 library. Host Tailwind, about 112 inline style sites and injected `<style>` blocks. The editor-surface rules ship in viewer-ui. |
| Theme | Effectively dark-only editor (`#1E1E1E`, purple syntax) with no light palette. `style/prompt-style-settings.ts` (localStorage `agentKernel.promptEditorStyle.v2`) and `surface/editor-surface.ts` (about 30 variables with hex fallbacks). SF Mono, JetBrains Mono, Plex. Mixed radii. |
| Literals | 251 hard. Colors: 56 fallbacks, 41 inline. 142 arbitrary values. |
| Shell | N/A. The lab draws its own header and right rail. |
| Structure | Inverted: very large `index.tsx` files. 81 UI files. 15 over 400 lines: `editor/buffer/index.tsx` 2437, `lab/index.tsx` 2266, `list-item-steps.ts` 1034, `drag-controller.tsx` 998, `PromptStyleRail.tsx` 667. |
| Consume via | `var(--ds-*)` with fallbacks; hosts compile. |
| Hours | Tokens 10 (3h engine bridge, 1.5h light editor palette). Slices 35, optional. **10 (+35)** |
| Risks | Must move with viewer-ui. Hosts mix Tailwind v4 and v3.4. Saved settings keep old hex values. |
| Wave | 1, last |

#### canvas-agent viewer

| | |
| --- | --- |
| Path | `codecaine/core/canvas/packages/canvas-agent/src/viewer` and `src/viewer-extension` |
| Stack | React 19, Vite 7.3, Tailwind 4.3, bun (Core). Runs on `:4830`. |
| Theme | Dark by default (green `#54d693`); light through `data-theme`. `agent-theme.css` holds 101 properties and `index.css` 23. Bank Gothic display. |
| Literals | 93 hard (67 definitions) |
| Shell | 1/3. Fixed `w-56` sidebar with no collapse, no topbar, right style rail. |
| Structure | 20 UI files, flat. None over 400 lines. |
| Consume via | `workspace:*` plus `@source` |
| Hours | Tokens 2.5. Shell 4. Slices 4. **10.5** |
| Risks | Dark by default is deliberate. The viewer extension renders inside observatory. Vendored copies in `docs-system/external` and budget drift. |
| Wave | 1, after viewer-shell and viewer-ui |

#### simple-research-kernel example

| | |
| --- | --- |
| Path | `codecaine/core/agent-kernel/examples/simple-research-kernel/src` and `tailwind.config.cjs` |
| Stack | React 19, Vite 5.4, Tailwind 3.4, bun (Core). Runs on `:5174`. |
| Theme | Light by default, dark through the style rail (persisted). `src/styles.css` holds 146 RGB-triplet properties for 2 themes. TX-02, Bank Gothic and JetBrains Mono are named but never loaded. |
| Literals | 133 hard (114 definitions) |
| Shell | 1/3. `_layouts/ResearchKernelLayout.tsx`: fixed 280px sidebar, no topbar, right style rail. |
| Structure | `_components/` with flat files. 17 UI files. 1 over 400 lines (the server store, 665). |
| Consume via | `workspace:*` plus the v3 preset (decision 3) |
| Hours | Tokens 5.5. Shell 4.5. Slices 4.5. **14.5** |
| Risks | budget's Tailwind config spreads this config, so changes ripple into budget's kernel view. |
| Wave | 1 |

#### observatory

| | |
| --- | --- |
| Path | `codecaine/core/observatory/src/ui`. Exclude `readability/`, an untracked comparison page; delete it. |
| Stack | React 19, Vite 7.3, Tailwind 4.3, bun (own lockfile). Uses `link:` through a repo-local `.bun-links` registry and is deliberately not a Core member. |
| Theme | The chrome is dark-only (`App.tsx` forces dark). The prompt editor toggles light and dark. `index.css` holds 120 properties, plus an untracked, hand-copied `light-theme.css` with 120 more. TX-02, JetBrains Mono and Bank Gothic are local only. Grain is on. |
| Literals | 261 hard (182 definitions, 76 arbitrary values) |
| Shell | 2/3. The sidebar collapses (`w-64` to `w-12`) with a toggle in its header, but has no icon rail and does not persist. The topbar has a title and actions. |
| Structure | 14 UI files, flat. 1 over 400 lines (`ProjectSidebar.tsx` 425). |
| Consume via | `link:` through its `.bun-links` registry (a live symlink, the way it takes prompt-kit), plus `@source`. Not a bun `file:` dependency: it goes stale until `bun install` runs again. |
| Hours | Tokens 8.5 (includes a light chrome). Shell 2.5. Slices 5.5. **16.5** |
| Risks | Uncommitted work in `App.tsx`, `index.css`, `AgentPage.tsx` and `router.ts`: commit first. Colors come from 4 sources. The sidebar UX question is still open in `docs/.drafts`. |
| Wave | 1 |

#### system-view

| | |
| --- | --- |
| Path | `system-view/src/renderer`. The bridge is in `src/main/theme-bridge.ts` and `src/shared/ipc.ts`. |
| Stack | Electron 37, electron-vite 5, Vite 7, React 19, one plain CSS file (133 lines), bun. |
| Theme | Follows the embedded docs-workbench through a bridge that reads 21 tokens with `getComputedStyle`: 11 shadcn colors, `--color-accent-blue`, `--radius`, 2 font variables and 7 `--docs-sidebar-*` knobs. The fallback palette on `.app-shell` is stale old-Notion (`#37352f`), 0.5rem, system-ui. |
| Literals | 37 hard (23 definitions) |
| Shell | 1/3. A resizable tree sidebar (200–600px, width persisted). No collapse, rail or topbar. The right side is a native WebContentsView. |
| Structure | 15 files. 2 over 400 lines: `App.tsx` 786 (7 inline icons), `lock-in.ts` 435. |
| Consume via | It is a single bun package: add `"workspaces": ["../codecaine/core/design-system"]` to its `package.json` and depend on `workspace:*` (a live symlink), or use `bun link`. Then import the CSS in `renderer/src/main.tsx`. Update `THEME_TOKEN_NAMES` when docs-workbench moves to `--ds-*`. |
| Hours | Tokens 4 (includes `git init`). Shell 3. Slices 4. **11** |
| Risks | No version control: the workspace repo ignores this folder. The bridge silently falls back when docs-workbench renames variables. `viewer.setBounds` clamps the sidebar to at least 200px. |
| Wave | 1, right after docs-workbench's tokens |

#### variator

| | |
| --- | --- |
| Path | `codecaine/tools/variator/src/web` and `src/preview`. Skip `.variator/`, `scripts/` and `src/server`. |
| Stack | React 19.3, Bun.build, plain CSS, bun. Runs on `:4888`. Tailwind 4.3 only compiles the preview renderers. |
| Theme | Pinned light. `web/docs-light.css` imports docs-workbench's `theme/index.css` by relative path. system-ui and Space Grotesk. About 25 radius declarations from 4 to 10px. |
| Literals | 159 hard (122 px font sizes, 31 radii, 1 hex) |
| Shell | 2/3. A 76px tool rail plus a Workspace rail (not persisted). A topbar with no actions. A right feedback panel. |
| Structure | 12 UI files. `main.tsx` is 1,528 lines and 74 KB with about 20 views in one component. `style.css` 1160, `preview/index.ts` 500. |
| Consume via | Point the relative `@import` in `docs-light.css` at the package (read by path, so it stays live), or add a `workspaces` entry or `bun link`. Not a bun `file:` dependency. |
| Hours | Tokens 5.5. Shell 3. Slices 11. **19.5** |
| Risks | The relative import into docs-system internals breaks when docs-system moves its theme. Pixel checks against frozen fixtures go stale. The dense `main.tsx` has no UI tests. |
| Wave | 1, after docs-system |

#### docs-mcp home page

| | |
| --- | --- |
| Path | `codecaine/core/docs-system/packages/docs-mcp/src/background/home.ts` (served at `/`) |
| Stack and theme | Inline HTML and CSS. Dark-only (`#101315`, accent `#a8d3bd`), system-ui, 7–10px. |
| Literals | 27 hard |
| Hours | Tokens 1.5. **1.5** |
| Wave | 1 |

### Wave 2

#### personal-site content pages

| | |
| --- | --- |
| Path | `lascari-ai/personal-site`: `src/site`, the root HTML pages (`index.html`, `about/`, `services/`, `resume/`, `testimonials/`) and `scripts/{site,resume,blog}-pages.mjs`. Exclude the generated `blog/` and `public/blog/`, plus `dist/`, `vendor/`, `content/legacy-site` and `content/writing/docs-theme`. |
| Stack | Vanilla TS and static HTML. Vite 7.3 multi-page with custom plugins. Plain CSS (Tailwind 4.3 only on the landing). npm. Docker on Railway. The blog is built through the vendored `@codecaine-ai/docs-publish` tgz. |
| Theme | Light and dark. `theme-init.js` runs before paint; the toggle stores `personal-site:theme`. `src/site/palette.css` is byte-identical to docs-system's `notion-palette.css` (80 properties). Also 10 `--site-*` and 16 `--blog-*` variables. system-ui: Inter is named but never loaded. 6px buttons, 8px cards. |
| Literals | 263 hard (162 definitions, which are the palette copy; 69 px font sizes; 18 radii) |
| Shell | N/A (a site; [layout.md](layout.md) exempts it) |
| Structure | Vanilla `_components` partials. No UI file over 400 lines. |
| Consume via | Vendored tgz through `file:vendor/<name>.tgz` (prerequisite 4), the same as docs-publish. A tarball is a versioned snapshot on purpose: a token change needs a repack and a version bump. The Railway Docker context cannot see `../../codecaine/core/design-system`. |
| Hours | Tokens 7.5. Slices 1. **8.5** (plus 1h to republish docs-publish) |
| Risks | Blog styling only moves when docs-publish migrates. The palette copy drifts from docs-system today. |
| Wave | 2 |

#### agent-skills manager

| | |
| --- | --- |
| Path | `lascari-ai/agent-skills/manager/web`. Exclude `web/vendor`. |
| Stack | Vanilla JS, one dense CSS file (8 lines, 14.6 KB) and static HTML. Python 3.11 stdlib server with a fixed route whitelist. No package manager. Runs on `:4318`. |
| Theme | Light and dark (◐ button, `data-theme`, key `skill-theme`). About 28 properties that claim to follow `notion-palette.css` but are stale (`#37352F`, old dark `#2F3437`). System font. 4–10px. |
| Literals | 116 hard (30 definitions, 64 px font sizes, 17 radii) |
| Shell | 2/3. A fixed 224px sidebar and a topbar with breadcrumb and Refresh. No collapse, rail or persistence. The reader is a full overlay. |
| Structure | 4 dense files. Slices N/A. |
| Consume via | Copy the built CSS into `web/vendor/` and add the route to the whitelist in `server.py`. |
| Hours | Tokens 4.5. Shell 3. **7.5** |
| Risks | Every package update needs a copy step. Offsets are hard-coded to 224, 190 and 61px. |
| Wave | 2 |

#### Slidev template

| | |
| --- | --- |
| Path | `learning/lascari-ai-learning/presentations/SlidevTemplate` (`styles/`, `setup/`, `components/`, `slide-templates/`). Nine decks copy it byte for byte. `slidev-theme-starter` is an unmodified scaffold. |
| Stack | Slidev 51, Vue 3.5, UnoCSS (Windi-compatible), npm |
| Theme | Light only ("Scientific": ivory `#F0EEE6`, ink `#141413`, teal, orange, red). 29 variables plus 10 Windi colors. Styrene (trial license) and Fira Code. Large radii. |
| Literals | Template: 203 hard [262 palette classes]. All decks: 2,109 hard [3,901 palette classes]. Scanned with `--ext +md`. |
| Shell / Structure | N/A |
| Consume via | A shared Slidev theme package whose `layout.css` maps `--background`, `--foreground` and `--primary` to `--ds-*`, plus an Uno preset. |
| Hours | Tokens 13, for the template only. Retheming the 8 delivered decks would add about 25h; not recommended. **13** |
| Risks | Styrene is a trial license. PDF export must be rechecked. |
| Wave | 2 (template and new decks) |

#### budget web

| | |
| --- | --- |
| Path | `life/budget/apps/web/src`. Exclude `shared/category-icons` and `shared/payment-icons` (vendored Lucide SVGs). |
| Stack | React 19.2, react-router 7, Vite 8.1. 31 plain CSS files with global element selectors, some written on one line. Tailwind 3.4 only for the embedded kernel view (`#kernel-view`, preflight off). ECharts. bun, plus a stale `package-lock.json`. |
| Theme | Light only, with no palette file. Colors are spread over `styles.css`, `shared/sidebar.css`, `budget-types.ts` (18 hex) and 3 ECharts palettes. `kernel.css` declares 49 RGB-triplet host tokens with the doc-paper values (54 declarations), then overrides 5 of them with budget's lavender grays. Inter through a Google Fonts `@import` (weights 450 and 550). 19 distinct radii. |
| Literals | 1,757 hard: 1,008 inline colors (603 distinct hex), 516 px font sizes (24 sizes), 161 radii. [990 px spacing] |
| Shell | 2/3, and the source of [layout.md](layout.md). It has the sidebar, the header toggle, a 68px rail and a sticky 72px topbar with the title and Refresh. Gaps: collapse is not persisted (`useState` at `AppLayout.tsx:29`); no inspector (`SidePeek.tsx` is unused and a modal opens instead); no lanes; `AppLayout` is tied to the budget domain; the same subnav rule is copied for 7 subnavs (accounts, activity, budget, classification, config, merchant, overview). |
| Structure | `pages/<13 slices>/{page.tsx, _components/, model.ts, *.css}`. Folder-per-component only as `Named/Named.tsx` (13 folders), no `index.tsx`. 23 flat `_components`. 146 files. 2 over 400 lines: `TransactionLedger.tsx` 939, `transactions.css` 588. About 6 more are dense: `ReviewContent.tsx` is 205 lines and 18.5 KB. |
| Consume via | Add `../../codecaine/core/design-system` to the root `workspaces` in `life/budget/package.json` and depend on `workspace:*` from `apps/web`: a live symlink, the same wiring Core uses. `bun link` also works. If budget must build from a clean clone, use a 4th submodule at `packages/design-system` instead (pinned; bump it to pick up token changes). Not a bun `file:` dependency. `@import` in `src/styles.css`. |
| Hours | Tokens 41: a 29h sweep, 6.5h QA (dark mode is new) and 4h for the v3 kernel view and ECharts. Shell 3: adopt `templates/react-app-shell` for persistence, the inspector and lanes. Slices 15 (+2.6 if `index.tsx` is mandatory). **59** |
| Risks | 155 of 199 `src` files are untracked: commit first. Tests import deep paths, and 2 tests read source as text. The kernel view is pinned to budget's own agent-kernel submodule, 10 commits behind Core. ECharts needs JS tokens for dark mode. |
| Wave | 2 |

#### pen-plotter desktop

| | |
| --- | --- |
| Path | `apps/pen-plotter/apps/desktop/src/renderer` |
| Stack | Electron 44.5, electron-vite 5, Vite 7.3, React 19.3. One plain CSS file and canvas 2D. bun workspace. |
| Theme | Light only. `styles.css` `:root` holds 11 variables (page `#f4f3f0`, accent `#2f6fdf`). About 35 canvas colors in `Preview.tsx`. The PensPanel `PALETTE` is ink data; keep it. system-ui and SF Mono. 8px panels. |
| Literals | 183 hard (109 inline colors, 36 px font sizes, 20 radii) |
| Shell | 1/3. A 3-column grid: settings stack, preview, plot inspector. No topbar. |
| Structure | 21 flat renderer files (20 in `src/` plus `index.html`). 6 over 400 lines; the UI ones are `styles.css` 963, `Preview.tsx` 754, `PlotPanel.tsx` 493, `DrawMode.tsx` 410. |
| Consume via | Add `../../codecaine/core/design-system` to the root `workspaces` in `apps/pen-plotter/package.json` and depend on `workspace:*` from `apps/desktop` (a live symlink), or use `bun link`. Not a bun `file:` dependency. Then `@import`. The CSP (`default-src 'self'`) needs local fonts (prerequisite 2). |
| Hours | Tokens 5.5. Shell 4. Slices 14. **23.5** |
| Risks | The most active repo, with 10 open worktrees in `apps/pen-plotter-worktrees`. Canvas colors encode machine state. Run QA on the mock board, never during a live plot. |
| Wave | 2, after the worktrees merge |

### Wave 3

#### MainMenu authoring app

| | |
| --- | --- |
| Path | `apps/MainMenu/apps/scene-engine/app`. Exclude `_engine/renderer`, `_engine/export` and `api`: they are the product runtime. |
| Stack | Next 15.5 (App Router, standalone), React 19.2, Zustand, Tailwind 4.2 (no `@theme`), npm. Runs in the browser and in Electron 30.5. |
| Theme | Dark-only (`html.dark` hard-coded). `globals.css` holds 21 variables plus an `!important` layer that repaints arbitrary classes (`.bg-\[\#1a1a1a\]` becomes `var(--unity-panel)`). 4px. |
| Literals | 779 hard (615 arbitrary values, 120 colors). [287 palette classes] |
| Shell | 1/3. A fixed 236px sidebar and a 34px breadcrumb bar with no title or actions. `/editor` has its own grid: hierarchy, canvas, inspector. |
| Structure | Flat `_components`, no `index.tsx`. 166 files, 39 components. 10 over 400 lines: `MainMenuConfigEditor.tsx` 2291, `ScreenWorkspace.tsx` 845, `extraction-helper.css` 776, `LayerForm.tsx` 602. |
| Consume via | npm `file:../../../../codecaine/core/design-system` (npm links a directory, so it stays live) plus `@import` in `globals.css`. The package CSS and fonts must survive `prepare-next-runtime.mjs` for Electron. |
| Hours | Tokens 22. Shell 5. Slices 24. **51** |
| Risks | The arbitrary classes and the `!important` layer must go together. Editor work is uncommitted. `workspace.catalog.json` points at a stale codecaine-site path. |
| Wave | 3 (dark-first variant) |

#### skitzo

| | |
| --- | --- |
| Path | `experiments/skitzo/apps/frontend/src` (`app/`, `components/`) |
| Stack | Next 16.1 (Turbopack), React 19.2, Tailwind 4.1 (`@theme inline`), Clerk 6. npm and bun lockfiles. Docker. |
| Theme | Dark-only. `globals.css` `@theme` holds 9 colors and 3 fonts, plus about 25 raw hex values. Outfit, IBM Plex Mono and Cormorant Garamond. 2–4px. Brass accent. |
| Literals | 751 hard (643 arbitrary values such as `text-[#hex]`). [95 palette classes] |
| Shell | 1/3. A fixed 200px sidebar and per-page headers. |
| Structure | Route-colocated flat files, no `_components`. 45 files. 6 over 400 lines: `InterviewChat.tsx` 757, `interview/actions.ts` 741, `globals.css` 632. |
| Consume via | Vendored tgz. The Docker context is `apps/frontend`. |
| Hours | Tokens 19 (includes a 1.5h Clerk appearance bridge). Shell 4.5. Slices 16. **39.5** |
| Risks | Dormant since 2026-04-08. MDXEditor overrides target hashed class names. The landing hero and serif display are brand (decision 2). |
| Wave | 3 |

#### gamecube-decomp-harness

| | |
| --- | --- |
| Path | `harnesses/gamecube-decomp-harness/apps/frontend/src`. Exclude `src/icons/assets`. `games/`, `.claude/` and `analysis/` HTML is generated or tooling. |
| Stack | React 19.2, Vite 8, Tailwind 4.3, bun workspaces. Links Core's agent-kernel and prompt-kit through `link:`. |
| Theme | Dark-only. `styles.css` `@theme` holds 58 tokens (cold slate, neon), plus about 60 host tokens copied from observatory. A third palette, kb-lab, is in `knowledge/browser.css`. An effect engine (`lib/styleSettings.ts`). TX-02 everywhere. 0–2px. |
| Literals | 1,087 hard. Colors: 203 definitions, 275 inline, 264 distinct hex. 408 arbitrary values, 153 px font sizes. |
| Shell | 3/3, the best in the workspace. Header toggle, 52px icon rail, persisted. A right DetailsRail inspector (collapsible, resizable 400–860px, persisted). A PageHeader topbar, though some pages build their own. |
| Structure | Mixed: 25 `index.tsx` folders and 15 flat files. 129 files. 7 over 400 lines: `styles.css` 1653, `sync/index.tsx` 657. The dense `knowledge/browser.tsx` is 128 lines and 29.8 KB. |
| Consume via | Add `../../codecaine/core/design-system` to the root `workspaces` and depend on `workspace:*` (a live symlink), or `link:@codecaine-ai/design-system` the way it takes prompt-kit. Not a bun `file:` dependency. Then `@import` and `@source`. |
| Hours | Tokens 23. Shell 3. Slices 23. **49** |
| Risks | Three dark palettes coexist. TX-02 is licensed and part of the app's identity. The table rhythm is a fixed 32/64px. bun link registrations are per machine. |
| Wave | 3. Lift its rail and inspector persistence into the shell template sooner. |

#### CircleSnakesWeb playground panels

| | |
| --- | --- |
| Path | `apps/circle-snakes/CircleSnakesWeb/src/ui` and `src/app`. Exclude `landing/`, `logo-lab/` and `loading*`. |
| Stack | TS 6, Three.js 0.184, Vite 7.3, Tailwind 4.3 (class strings in `src/ui/shared/styles.ts`), npm. Deployed on Railway. |
| Theme | Dark-only glass panels (`neutral-900/75`, `teal-400`). Inter is declared but never loaded. 5–6px. |
| Literals | Panels: 90 hard [73 palette classes]. The whole app is 298, including the landing. |
| Shell | N/A (full-bleed WebGL; exempt in [layout.md](layout.md)) |
| Structure | Already sliced (`_components` DOM builders). The engine files are out of scope. |
| Consume via | Vendored tgz or a CSS `@import`. Railway builds only this repo. |
| Hours | Tokens 4. Slices 1.5. **5.5** |
| Risks | A large uncommitted tree. The landing is product art and exists twice: here and in personal-site. |
| Wave | 3 |

### Later

#### Spectre frontend

| | |
| --- | --- |
| Path | `experiments/spectre/apps/frontend` (`src/`, `index.html`). Skip `packages/*` (submodule copies of Core), `.spectre/` and `.worktrees/`. |
| Stack | React 19.2, TanStack Router 1.139, React Query 5, Vite 7.3, Tailwind 4, shadcn new-york (10 primitives), bun (Spectre root workspace). |
| Theme | A JSON engine: `src/theme/themes/{spectre-light, spectre-dark, spectre-figjam}.json` emit 233 variables. They are resolved in the browser and injected as `<style id="spectre-theme-vars">`. `ThemeEditorModal` saves overrides and a grain overlay. A guard test forbids literals outside the theme JSON. TX-02 body, Bank Gothic display, Inter only in the canvas. `rounded-md` 6px. |
| Literals | 474 hard: 306 in TSX (301 arbitrary values, `text-[11px]` ×72) and 168 in the theme JSON (122 distinct hex). Inline colors: 0. |
| Shell | 2/3. `components/layout/AppShell.tsx`: collapsible sidebar (`w-56` to `w-14`), icon rail, persisted (`spectre-sidebar-collapsed`). The toggle sits in its own row, not the header. The topbar only shows below `lg`; pages render their own h1 in 5 styles. No lanes, no inspector. |
| Structure | Next-style route folders. 12 `_components` folders, all flat, no `index.tsx`. 273 files. 22 over 400 lines: `term-draw/draw-state.ts` 2569, `projects-api.ts` 1130, `ThemeEditorModal.tsx` 982, `DocsActionPane.tsx` 965, `DocsTab.tsx` 841. |
| Consume via | Add the package as a submodule at `packages/design-system` plus a workspaces entry, then `workspace:*`. It is pinned like Spectre's Core submodules, and it builds in Docker. For local work, a `../../codecaine/core/design-system` workspaces entry is the live alternative. `.dark` works, because the package supports `.dark`. |
| Hours | Tokens 18.5 (option A). Shell 6. Slices 65. **89.5** |
| Risks | The TX-02-to-Inter swap is the biggest visual change. The theme editor, FigJam theme and grain conflict with one look. Embedded Core UI repaints through Spectre's variables. |
| Wave | Later, after decision 1. Option A tokens can follow wave 1. |

#### x-replier

| | |
| --- | --- |
| Path | `apps/x-replier/X-Replier-Frontend` (`app/`, `components/`; `components/ui` holds 42 shadcn files) |
| Stack | Next 14.2, React 18.3, Tailwind 3.4, shadcn new-york/slate, next-themes, Clerk, npm, Vercel |
| Theme | Dark in practice: `:root` and `.dark` hold the same dark zinc values. 19 shadcn HSL triplets. 8 `--sidebar-*` variables are used but never defined. Inter, plus a leftover Roboto import. 8px. |
| Literals | 115 hard (38 HSL-triplet definitions, 74 arbitrary values) [191 palette classes] |
| Shell | 2/3. The shadcn sidebar collapses to an icon rail. The cookie is written but never read, so state is lost. The toggle is duplicated in 6 route headers. |
| Structure | `app/<route>/_components`: 11 `index.tsx` folders and 34 flat files. Layer folders for actions, queries and stores. 187 files. 5 over 400 lines. |
| Hours | Tokens 14.5. Shell 3. Slices 16. **33.5** |
| Risks | Dormant since 2025-04. `@apply text-tertiary` is undefined, so verify the build first. Clerk's sign-in renders light on a dark app. |
| Wave | Later |

#### x-writer

| | |
| --- | --- |
| Path | `apps/x-writer-main/x-writer/X-Writer-Frontend` (`app/`, `components/`, `lib/`) |
| Stack | Next 14.2, React 18.3, Tailwind 3.4, shadcn (its `components.json` points at a missing config), next-themes, Clerk, npm, Vercel |
| Theme | Light and dark (shadcn slate) through `theme-switch.tsx`. The same 19 variables as x-replier. Inter. 8px. |
| Literals | 146 hard (90 arbitrary values, 45 HSL definitions) [244 palette classes] |
| Shell | 2/3. A floating sidebar that collapses to an icon rail. Not persisted: the cookie names differ (`sidebar_state` vs `sidebar:state`). The toggle is in the topbar. |
| Structure | Mostly vertical: `app/(auth)/<slice>/{(pages), _actions, _components, _hooks, _queries}`. 14 `index.tsx` folders and about 47 flat files. 4 over 400 lines. |
| Hours | Tokens 15.5. Shell 3. Slices 13. **31.5** |
| Risks | Dormant since 2025-10. v4-only syntax (`px-0!`, `@container/main`) does nothing in this v3 app today and changes on upgrade. |
| Wave | Later |

#### font-pipe web

| | |
| --- | --- |
| Path | `experiments/font-pipe/apps/web/src` |
| Stack | Next 15.5, React 19.2, Tailwind 3.4, bun workspace |
| Theme | Broken: the body is hard-coded dark (`bg-neutral-950`) while components use light utilities. No palette file. |
| Literals | 15 hard [136 palette classes] |
| Shell | 0/3. A bare layout with centered pages and a PhaseStepper. |
| Structure | 11 flat components, 27 files, none over 400 lines |
| Hours | Tokens 8. Shell 6. Slices 9. **23** |
| Wave | Later (prototype) |

#### font-effects web

| | |
| --- | --- |
| Path | `experiments/font-pipe/apps/font-creation/font-effects/web` (`src/`, `index.html`, `composer/index.html`) |
| Stack | Vanilla JS, Vite 5.4, Tailwind 4.2 (imported, mostly unused), plain CSS, npm inside a bun repo |
| Theme | Light control panel beside a neutral gray stage (`#858384`). The stage is functional; keep it. Avenir Next. |
| Literals | 159 hard (153 in `styles.css`) |
| Shell | N/A (a stage and a 760px control panel) |
| Structure | 17 files. `styles.css` is 1,335 lines; `vite.config.js` (505) holds a dev API. |
| Hours | Tokens 4. Slices 3.5. **7.5** |
| Wave | Later |

#### token-burner dashboard

| | |
| --- | --- |
| Path | `codecaine/utilities/token-burner/src/web` |
| Stack | Vanilla TS that builds `innerHTML` strings. Bun.build at server start. Raw CSS. bun. |
| Theme | Light only, copied from CodexLB. 35 oklch tokens in `style.css`. Chart colors in `dashboard.ts`. Inter. 6–12px plus shadows. |
| Literals | 139 hard (37 oklch, 57 px font sizes) |
| Shell | 1/3. Seven tabs in a top bar, a layout the user asked for (`HANDOFF.md`). |
| Structure | 4 files. `style.css` is 922 lines. |
| Hours | Tokens 7. Shell 7. Slices 8. **22** |
| Risks | The standard shell overrides an explicit layout request, so it needs approval. Most of the code is uncommitted. |
| Wave | Later |

#### ai-age

| | |
| --- | --- |
| Path | `experiments/ai-age/apps/frontend` (`app/`, `components/`, `contexts/`, `lib/`) |
| Stack | Next 15.3, React 19, Tailwind 4.2, npm |
| Theme | Light only. Warm sepia, Georgia/Palatino serif, 14–22px radii. |
| Literals | 318 hard (297 arbitrary values) |
| Shell | 1/3. A fixed 320px list sidebar. |
| Structure | 7 flat components, 23 files, 3 over 400 lines |
| Hours | Tokens 9.5. Shell 6. Slices 9. **24.5** |
| Wave | Later or skip. Dormant since 2026-03-21, and the look may be intentional. |

#### sotto / V07 (native macOS)

| | |
| --- | --- |
| Path | `codecaine/utilities/sotto/Sources/V07` (`Views/`, `V07App.swift`) |
| Stack | SwiftUI (macOS 14+) with AppKit bridges, built with SwiftPM |
| Theme | Light, dark and high contrast, following macOS. `V07Palette` holds 14 adaptive tokens in `Views/V07Theme.swift`. SF fonts. |
| Literals | Not scanned (Swift) |
| Consume via | A generated `DSTokens.swift` that `V07Palette` aliases. SwiftPM cannot depend on a bun package. |
| Hours | Tokens 5, plus 2.5 to build a Swift emitter in the package. **7.5** |
| Risks | The palette is the product brand. Glass and high-contrast variants have no design-system equivalent. |
| Wave | Later, only if the package ships a Swift emitter |

#### Small later items

| Surface | Path | Notes | h |
| --- | --- | --- | --- |
| sotto archive viewer | `codecaine/utilities/sotto/scripts/archive` | Vanilla HTML/JS served by `viewer.py`. Light only. 69 hard. | 2 |
| CircleSnakesWeb docs | `apps/circle-snakes/CircleSnakesWeb/docs` | VitePress default theme, 0 literals. Add a `.vitepress/theme` CSS mapping. | 1.5 |

### Skip

| Surface | Why | Hard literals |
| --- | --- | --- |
| codecaine-site (`codecaine/general/codecaine-site`) | The arcade look (Impact, FolkPro, yellow on black) is the product | 706 |
| personal-site landing (`lascari-ai/personal-site/src/{ui,app,render}`) | The CircleSnakes engine, product art; exempt in [layout.md](layout.md) | 297 |
| CircleSnakesUnity | Unity UI Toolkit (USS). Dormant since 2024-12 and replaced by the web port | 57 |
| autohdr data viewer (`experiments/hackathons/autohdr/.../apps/viewer`) | Hackathon tool in a client org, Tailwind v3 | 327 |
| Slidev delivered decks | Archival talks; only the template migrates | 2,109 |
| X Pro (`apps/x-writer-main/X Pro`) | Stock Streamlit, dormant | n/a |
| agent-kernel TUI (`packages/tui`) | Terminal UI; pi owns the palette | 0 |
| docs-style report, pen-plotter ink-flow report | Generated or one-off documents | 122, 367 |
| observatory `readability/` | Untracked comparison page; delete it | 56 |
| No UI | viewer-core, reference-capture, phone-kit, HouseHunter, WisprSync, SimpleInterviewAgent (empty folders), ContentCreationPipeline, mw2-color-palette, life/email, life/system, skills, core-brand (markdown only), Spectre `apps/shared` | n/a |

## Reproduce the counts

The scanner skips build output, vendored code, submodules, tests and generated files on its own. `--json` adds per-file counts, `--hits` adds `file:line` for every hit, and `--fail-above <n>` turns a run into a CI ratchet.

```sh
cd /Users/Ford/workspace/codebases/codecaine/core/design-system
W=/Users/Ford/workspace; C=$W/codecaine/core; A=$W/apps
scan() { bun scripts/scan-literals.ts "$@"; }

# Wave 1
scan $C/docs-system/packages/docs-workbench/web/src $C/docs-system/packages/docs-workbench/web/index.html $C/docs-system/packages/docs-workbench/web/playground.html $C/docs-system/packages/docs-workbench/electron
scan $C/docs-system/packages/docs-viewer/src --exclude vendor
scan $C/docs-system/packages/docs-publish/src
scan $C/annotations/src/react
scan $C/sequence/packages/sequence/src/theme.ts $C/sequence/packages/sequence/src/render $C/sequence/packages/sequence/src/text.ts
scan $C/sequence/packages/studio/src
scan $C/canvas/packages/studio/src $C/canvas/packages/studio/index.html
scan $C/canvas/packages/canvas/src/{theme,stage,ui,objects,connectors}
scan $C/agent-kernel/packages/viewer-shell/src
scan $C/agent-kernel/packages/viewer-ui/src --exclude nucleo-src
scan $C/prompt-kit/packages/prompt-kit/src/ui
scan $C/canvas/packages/canvas-agent/src/viewer $C/canvas/packages/canvas-agent/src/viewer-extension
scan $C/agent-kernel/examples/simple-research-kernel/src $C/agent-kernel/examples/simple-research-kernel/tailwind.config.cjs --exclude agent-catalog --exclude server.ts --exclude simple-research-kernel-store.ts
scan $C/observatory/src/ui --exclude readability
scan $W/system-view/src/renderer
scan $W/codecaine/tools/variator/src/web $W/codecaine/tools/variator/src/preview
scan $C/docs-system/packages/docs-mcp/src/background/home.ts

# Wave 2
P=$W/lascari-ai/personal-site
scan $P/src/site $P/index.html $P/about $P/services $P/resume $P/testimonials $P/scripts/site-pages.mjs $P/scripts/resume-pages.mjs $P/scripts/blog-pages.mjs
scan $W/lascari-ai/agent-skills/manager/web
SL=$W/learning/lascari-ai-learning/presentations/SlidevTemplate
scan $SL/styles $SL/setup $SL/components $SL/slide-templates $SL/index.md --ext +md
scan $W/life/budget/apps/web/src --exclude category-icons --exclude payment-icons
scan $A/pen-plotter/apps/desktop/src/renderer

# Wave 3
MM=$A/MainMenu/apps/scene-engine/app
scan $MM/_components $MM/editor $MM/projects $MM/asset-library $MM/upload $MM/scenes $MM/page.tsx $MM/layout.tsx $MM/globals.css $MM/extraction-helper.css
scan $W/experiments/skitzo/apps/frontend/src/app $W/experiments/skitzo/apps/frontend/src/components
scan $W/harnesses/gamecube-decomp-harness/apps/frontend/src --exclude assets
scan $A/circle-snakes/CircleSnakesWeb/src/ui $A/circle-snakes/CircleSnakesWeb/src/app --exclude landing --exclude logo-lab --exclude loading.css --exclude loading-screen.ts

# Later
scan $W/experiments/spectre/apps/frontend/src $W/experiments/spectre/apps/frontend/index.html
scan $W/experiments/spectre/apps/frontend/src/theme/themes --ext json
scan $A/x-replier/X-Replier-Frontend/app $A/x-replier/X-Replier-Frontend/components
scan $A/x-writer-main/x-writer/X-Writer-Frontend/{app,components,lib}
scan $W/experiments/font-pipe/apps/web/src
scan $W/experiments/font-pipe/apps/font-creation/font-effects/web/src $W/experiments/font-pipe/apps/font-creation/font-effects/web/index.html $W/experiments/font-pipe/apps/font-creation/font-effects/web/composer/index.html
scan $W/codecaine/utilities/token-burner/src/web
scan $W/experiments/ai-age/apps/frontend/{app,components,contexts,lib}
scan $W/codecaine/utilities/sotto/scripts/archive
```

### What the scanner does not see

- **TS palette objects** count as inline literals. Example: canvas's `palette.ts`.
- **Numeric `[r, g, b]` tuples** count only in files with 6 or more of them, when one of their keys names a color (`background`, `border`, `fill`, `selectionColor`).
- **Swift, C# and Python** are not scanned.
- **Widths, heights and other sizes** are not counted. Spacing shows up only as the soft `pxSpacing` signal.
- **Tailwind default-palette classes** are a soft signal. The hour formula still counts them, because the standard bans them.
