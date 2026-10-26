# @codecaine-ai/design-system

One design system for every on-device app in the workspace, Codecaine and Lascari AI alike: one look, one layout, light and dark. Every color, size, radius, font and timing is a token. Restyling every app means changing a token once.

```css
@import "@codecaine-ai/design-system/tokens.css";
.card {
  background: var(--ds-color-surface-panel);
  border: var(--ds-border-width-hairline) solid var(--ds-color-border-default);
  border-radius: var(--ds-radius-base);
  padding: var(--ds-space-3);
}
```

## What and why

- **Tokens** (`tokens/`): DTCG-shaped JSON, compiled by `scripts/build.ts` into CSS custom properties, a Tailwind v4 theme, JS and JSON.
- **Layout** (`css/layout.css`, `guide/layout.md`): the app shell (sidebar, topbar, inspector, content lanes).
- **Style guide** (`dist/guide/index.html`): every token rendered, light and dark side by side.
- **Seed look:** docs-system exactly as it renders today. Values were copied from its CSS and checked in Chromium: all 180 docs-system color variables compute to the same value as their tokens, in light and in dark.

Before this package, every app carried its own palette, so one design change meant edits in many places. Now apps read `--ds-*` variables, and the values live in one folder.

## Folder layout

```text
tokens/base/*.tokens.json         theme-independent scales: space, radius, borders, type, motion, z, layout
tokens/themes/light.tokens.json   colors and shadows, light
tokens/themes/dark.tokens.json    colors and shadows, dark (same paths as light)
scripts/build.ts                  validator and compiler (bun, zero dependencies)
dist/css/tokens.css               generated: custom properties, and color-scheme per theme block
dist/css/tokens-dark-first.css    generated: the same with dark on :root, for dark-first surfaces
dist/css/host-contract.css        generated: the agent-viewer host contract (--background, --trace-*, ...) mapped to tokens
dist/css/host-contract-dark-first.css  generated: the same with dark on :root
dist/tailwind/preset-v3.cjs       generated: Tailwind v3 preset with the tailwind.css utility names
dist/tailwind/theme.css           generated: Tailwind v4 @theme and the dark: variant
dist/tailwind/strict.css          generated: optional reset of Tailwind's default palette, type and shadow scales
dist/js/index.js, index.d.ts      generated: resolved values and cssVar()
dist/json/*.json                  generated: base, light, dark (flat) and tokens.json (nested)
dist/guide/index.html             generated: visual style guide
css/layout.css                    app-shell layout
css/fonts.css                     @font-face for Inter and IBM Plex Mono
fonts/                            the woff2 files (byte-identical to @codecaine-ai/text-measure's) and their OFL licenses
scripts/pack.ts                   `bun run pack`: a tgz for apps that vendor the package
scripts/test-apps.ts              `bun run test:apps <app>`: an app's safe tests under its run profile and the sandbox
guide/                            tokens.md, layout.md, consume.md, code-structure.md, ecosystem.md, migrate.md, audit.md, app-shell-demo.html
templates/                        starter app shell
skill/SKILL.md                    the design-system agent skill (source of truth; lascari-ai/agent-skills registers it)
test/                             bun test
verification/docs-system/         screenshot harness and mapping.md for the docs-system migration
```

`dist/` is committed. The package has no dependencies, so a read-only mount (Docker) works without an install or a build step.

## Use it

### CSS

```css
@import "@codecaine-ai/design-system/fonts.css"; /* Inter and IBM Plex Mono, shipped in the package */
@import "@codecaine-ai/design-system/tokens.css"; /* or tokens-dark-first.css on a dark-first surface */
@import "@codecaine-ai/design-system/layout.css"; /* optional: the app shell */
```

The font files are byte-identical to `@codecaine-ai/text-measure`'s, so browser text matches canvas measurement. Agent-viewer hosts (viewer-ui, viewer-shell, prompt-kit) add `@codecaine-ai/design-system/host-contract.css` after the tokens.

### Tailwind v4

```css
@import "tailwindcss";
@import "@codecaine-ai/design-system/tokens.css";
@import "@codecaine-ai/design-system/tailwind-strict.css"; /* new apps: before tailwind.css */
@import "@codecaine-ai/design-system/tailwind.css";
```

- **New apps import `tailwind-strict.css`**, before `tailwind.css`. It clears Tailwind's default palette (`bg-red-500`, `bg-white`), text sizes (`text-sm`), shadows (`shadow-lg`), and its radius, font, line-height, tracking, blur and easing steps, so only the utilities below generate. Imported after `tailwind.css`, it would clear the design-system utilities too.
- **`dark:` follows the theme**, not the OS: `tailwind.css` redefines it as `data-theme="dark"` or `.dark` on the element or an ancestor.

| Need | Utilities |
| --- | --- |
| Surfaces and fills | `bg-page` `bg-panel` `bg-sidebar` `bg-sunken` `bg-chip` `bg-hover` `bg-active` `bg-accent-soft` |
| Text | `text-ink` `text-body` `text-secondary` `text-muted` `text-faint` |
| Borders | `border-rule` `border-rule-subtle` `border-rule-strong` `border-guide` |
| Accent and status | `text-link` `bg-accent` `border-accent` `ring-focus` `text-danger` `bg-danger-soft` `border-info-line` |
| Hues (categorical only) | `text-blue` `bg-blue-soft` `bg-blue-solid` `text-blue-on-solid` `border-blue-line` (gray, blue, teal, green, yellow, orange, red, violet, pink) |
| Spacing and radius | `p-1` is 4px, `gap-3` is 12px; every `rounded-*` step is the one 2px radius; `rounded-pill` |
| Type | `font-sans` `font-mono` `font-medium` `text-ui-xs` `text-ui-sm` `text-ui-md` `text-reading` `text-title` `leading-reading` `tracking-micro` |
| Effects and motion | `shadow-glass` `backdrop-blur-glass` `ease-emphasized` `z-popover` |
| Layout | `max-w-lane-text` `w-sidebar` `h-topbar` `px-content-x` `w-inspector` |

- **Text in the accent color is `text-link`.** `accent` is for fills, borders and focus rings: the light `accent` on the page is 4.34:1, under AA for text.
- **A glyph on a solid tile is that tile's `on-solid`**: `bg-yellow-solid text-yellow-on-solid`, `bg-warning-solid text-warning-on-solid`. It is white or ink, whichever meets 4.5:1 on that solid. `text-on-solid` is white in light and fails on the light gray, yellow, orange and red solids. Light red tops out at 4.26:1 (white; ink is 3.87:1), so its tiles carry icons and large text only.
- The full list is in [guide/tokens.md](guide/tokens.md#tailwind-utilities). There is no `bg-muted`: muted is a text color (`text-muted`); the neutral fill is `bg-active`.

### Tailwind v3

```js
// tailwind.config.cjs
module.exports = {
  presets: [require("@codecaine-ai/design-system/tailwind-v3-preset")],
  content: ["./src/**/*.{ts,tsx}"],
};
```

The preset has the same utility names as `tailwind.css`, removes Tailwind's default palette, type, radius, shadow, blur and easing scales, and points `dark:` at `data-theme="dark"` or `.dark`. Import `fonts.css` and `tokens.css` in the entry stylesheet.

### JS and TypeScript

```ts
import { tokens, flat, cssVar } from "@codecaine-ai/design-system";

tokens.light.color.surface.page; // "#fdfdfd"
flat.base["space.3"]; // "12px"
cssVar("color.text.muted"); // "var(--ds-color-text-muted)"
cssVar("color.code.bg", "dark"); // "var(--ds-dark-color-code-bg)", pinned to dark
```

Use `cssVar()` in inline styles. A raw value from `tokens` does not switch with the theme.

### JSON

`@codecaine-ai/design-system/json/base.json`, `light.json` and `dark.json` map dotted paths to resolved values. `tokens.json` holds the same values nested.

### Install

[guide/consume.md](guide/consume.md) is the full recipe, including the vendored tgz for apps that build in Docker, Vercel or Railway (`bun run pack --out ../<app>/vendor`, relative to this folder) and the Vite settings.

| Where | How |
| --- | --- |
| Inside Codecaine Core | Core's `workspaces` already lists this folder (`design-system`: it sits inside Core). Add `"@codecaine-ai/design-system": "workspace:*"` to the app, then run `bun install` at the Core root. |
| Another bun app | Add this folder's relative path to the root `workspaces` and depend on `"workspace:*"`, or run `bun link` here and `bun link @codecaine-ai/design-system` in the app. Both are live symlinks. |
| An npm app | `"@codecaine-ai/design-system": "file:<relative path to this folder>"`. npm symlinks a `file:` folder, so it stays live. |
| No package manager | Import by path, relative to the stylesheet. From `codebases/<group>/<app>/src/index.css`: `@import "../../../codecaine/core/design-system/dist/css/tokens.css";` |

Do not use `file:` with bun. Bun snapshots the folder at install time (bun 1.4 links each file that exists then; older versions copy them), so a file added later, such as a new `dist/` output, is missing until `bun install` runs again.

## Change a token

1. Edit the value in `tokens/base/*.tokens.json`, or in both `tokens/themes/*.tokens.json` for a color.
2. Run `bun run build`. It validates every file, then rewrites `dist/` and the reference table in `guide/tokens.md`.
3. Run `bun run test`.
4. Open `dist/guide/index.html` and check light and dark.
5. Commit `tokens/` and `dist/` together.

A linked app (`workspace:*`, `bun link` or npm `file:`) reads the new `dist/` directly: the change shows on its next reload or build, and nothing in the app needs editing. A bun `file:` snapshot misses new files until `bun install` runs again.

## Theming

- `:root` gets the light theme.
- `data-theme="dark"` or `class="dark"` on any element switches it and everything inside. `data-theme="light"` or `class="light"` switches a region back.
- `--ds-light-*` and `--ds-dark-*` pin a value to one theme, for a region that must not follow the page.
- Tailwind's `dark:` matches `data-theme="dark"` or `.dark` on any ancestor. Inside a light region nested in a dark one it still applies, so style such a region with the token utilities, which follow the nearest theme.
- `tokens.css` sets `color-scheme` in each theme block and no other property, so scrollbars and form controls follow the theme.
- `tokens-dark-first.css` puts dark on `:root`; `data-theme="light"` or `class="light"` switches a region back.

## Commands

| Command | What it does |
| --- | --- |
| `bun run build` | Validate `tokens/`, write `dist/` and the reference in `guide/tokens.md`. |
| `bun run check` | Rebuild in memory. Exit 1 and list the stale files when `dist/` is out of date. Core's doctor runs this. |
| `bun run test` | Run the test suite. |

The build fails on an unresolved alias, an alias cycle, a missing `$type` or `$value`, a light/dark key mismatch, a duplicate path, a key repeated in one JSON object, two paths producing one CSS variable, an invalid color or shadow, or a `.json` file under `tokens/` that is not `tokens/base/*.tokens.json` or `tokens/themes/*.tokens.json`. It ignores dotfiles such as `.DS_Store`.

`bun test` with no path runs only `test/` (`bunfig.toml`), not the template app.

## Consumers

Which apps consume the package, how, and their status: [guide/ecosystem.md](guide/ecosystem.md). To move a new app onto it: [guide/migrate.md](guide/migrate.md).

Agents doing UI work: read [AGENTS.md](AGENTS.md).
