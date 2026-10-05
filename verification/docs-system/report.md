# docs-system migration report

docs-system now takes every palette and design value from `@codecaine-ai/design-system`. The migration renders identically: all 30 screenshots have 0 changed pixels.

- **Date:** 2026-10-05
- **Baseline:** docs-system commit `2efb0c1`, no changes under `packages/` (BEFORE set in `before/`)
- **Harness:** see [README.md](README.md). Raw results: `baseline/` (checks before), `after-checks/` (checks after), `diff-before-vs-after/report.json`.

## Results

| Check | Before | After |
| --- | --- | --- |
| Screenshots (30 views, light and dark) | 30/30 identical across two runs | 30/30 identical, 0 changed pixels, max channel delta 0 |
| Gate A: after `bun install`, before any CSS edit | — | 30/30 identical |
| docs-system tests (run alone) | 3130 pass, 81 fail, 1 error | 3131 pass, 80 fail, 0 errors. No new failures. |
| docs-system typecheck | 2 errors in `docs-server/src/agent-tools.ts` | The same 2 errors |
| `build:web`, `build:web:static` | — | Both pass. The built CSS defines all 613 `--ds-*` vars and uses 412; none undefined. |
| Core `bun run doctor` | Exit 1 (install freshness) | Exit 0, including the new design-system check |
| docs-publish | — | `docs.css` and `editor.css` define every `--ds-*` var they use. Two published pages render byte-identical, light and dark. 11/11 tests pass. |
| Hard-coded literals (`scripts/scan-literals.ts`) | Touched files 348; all docs-system packages 1175 | 62; 889 |

The capture logs match too: the same 26 console errors before and after (the deliberately dead kernel port), and no blocked writes.

## Propagation test

The light `color.blue.text` was temporarily set to `#ff00ff`. In the callout view, light changed 506 px: exactly the info callout's rail, icon and label. Dark stayed identical. See `compare-before-vs-propagation/docs-callout-tones-light.png`. After the revert, `bun run check` passed and the final run was 30/30 identical.

## Files changed

### Codecaine Core (5 files)

- **`package.json`:** `../../design-system` added to the workspaces.
- **`bun.lock`:** only the design-system entries changed. docs-publish's version field also synced from proof.13 to proof.20, the version its manifest already had. No dependency versions moved.
- **`docker-compose.yml`:** a read-only mount of the design-system folder at `/design-system`. `docker compose config` validates it.
- **`scripts/doctor.ts`:** a new check that the design-system folder exists and its `dist/` is current, with fix hints.
- **`scripts/bootstrap.ts`:** prints a hint and skips `bun install` when the design-system folder is missing.

### docs-system (22 modified, 3 new)

- **Wiring:**
  - `docs-workbench/package.json` depends on the package.
  - `web/vite.config.ts` adds the folder to `server.fs.allow`.
  - The new `web/src/theme/tokens.css` imports the package's `tokens.css`, and `theme/index.css` loads it first.
- **CSS:**
  - Palette literals use pinned vars: `--ds-light-*` in light blocks and `--ds-dark-*` in dark blocks, 149 in `notion-palette.css`. Pinned names keep dark code panels dark inside a light page.
  - Design values use base vars, 352 in `semantic.css`. The role formulas are unchanged.
  - Also changed: `read-surface.css`, `style-rail.css`, `index.css`, `sequence-embed.css`, `export-dialog.css`, and the four docs-viewer style files.
- **TS:**
  - The new `theme/design-tokens.ts` reads token values in code.
  - Style-rail stock values, font stacks and lane fallbacks come from tokens.
  - 144 theme-registry defaults in `theme-folders.ts` come from tokens.
  - `Sidebar.tsx` fallbacks use tokens.
- **Tests:** stylesheet assertions resolve `var(--ds-*)` to the token value through the new `__tests__/ds-tokens.ts`, so they check the same values.
- **`docs-publish/src/editor.css`:** imports the token layer, because it bundles `sequence-embed.css`.
- **`CLAUDE.md`:** points agents at the design system.

### design-system

- The README consumers row now lists docs-system.

## What stayed local (62 literals in touched files)

- **Unused:** `--palette-nav`.
- **Fixed by design:** the code panel's white edge mixes and the sequence diagram's own default colors.
- **Effects and one-offs:** the grain overlay's white, the export dialog's 20px heading and its `#c33` error red.
- **Fallbacks:** `code.css` fallbacks for pages without the docs styles, and the draft editor's fallback colors in `editor.css`.
- **Pinned by a test:** `list-markers.css:11`, which a docs-viewer test checks word for word.

`after-checks/scan-literals.json` lists every remaining literal by file and line.

## Settings that hide token changes

The user's saved docs settings override some tokens in their own view. Pixels match today because the saved values equal the defaults, but later token changes to these values will not show in that view until the settings are cleared.

**Global theme** (`~/.local/state/codecaine-docs/themes/global/`):

| Setting | Tokens it hides |
| --- | --- |
| Colors: page `#fdfdfd`, sidebar `#f9f9f9`, text `#2a2a2a` | Page surface, sidebar surface, body text, and the ink of the page title and bold text (light page) |
| Reading size 16px / line height 1.6 | Reading size and line height (tokens: 18px / 1.45) |
| Block widths: file tree 1100px, table 860px, code 920px | The lane widths for those blocks |
| `components/surfaces.json`: radius 2px | The corner radius everywhere |
| `components/structured-table.json`: 13px text, weight 500, rule widths | Table text size, weight and rules |

**Code theme** (`cursor-dark-plus`): all 15 syntax roles and the panel colors. Its border `#303031` and header text `#C6C6C6` differ from the tokens (`#3c3c3c`, `#cccccc`).

## Open items

1. **Saved settings:** clear the 3 color picks and the 2px radius in the Global theme so token changes reach the user's own view.
2. **Reading size:** choose between 18px / 1.45 and 16px / 1.6.
3. **Not yet migrated:** docs-viewer components (607 literals, including the glass panel's motion), docs-model's copied layout numbers, the default theme's font stacks, and `pdf-document.tsx`.
4. **Standalone docs-system install:** docs-system's own workspace list does not include the design system, so `bun install` at docs-system's root cannot resolve the package. text-measure already has the same gap.
5. **Test timing:** the export tests rebuild `dist-static` when web sources are newer, which takes about 5.3s against a 5s timeout. Run `bun run build:web:static` before the suite.
