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
- **Layout** (`css/layout.css`, [docs/30-guide/20-layout](docs/30-guide/20-layout)): the app shell (sidebar, topbar, inspector, content lanes).
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
docs/                             Docs System pages, including the Guide section (docs/30-guide)
templates/                        starter app shell
templates/app-shell-demo.html     static demo of the app shell
skill/SKILL.md                    the design-system agent skill (source of truth; infrastructure/agent-config registers it)
test/                             bun test
verification/docs-system/         screenshot harness and mapping.md for the docs-system migration
```

`dist/` is committed. The package has no dependencies, so a read-only mount (Docker) works without an install or a build step.

## Use it

CSS, Tailwind v4, Tailwind v3, JS and TypeScript, and JSON: [docs/30-guide/40-consume](docs/30-guide/40-consume), section Use It.

### Install

[docs/30-guide/40-consume](docs/30-guide/40-consume) is the full recipe, including the vendored tgz for apps that build in Docker, Vercel or Railway (`bun run pack --out ../<app>/vendor`, relative to this folder) and the Vite settings.

| Where | How |
| --- | --- |
| Inside Codecaine Core | Core's `workspaces` already lists this folder (`design-system`: it sits inside Core). Add `"@codecaine-ai/design-system": "workspace:*"` to the app, then run `bun install` at the Core root. |
| Another bun app | Add this folder's relative path to the root `workspaces` and depend on `"workspace:*"`, or run `bun link` here and `bun link @codecaine-ai/design-system` in the app. Both are live symlinks. |
| An npm app | `"@codecaine-ai/design-system": "file:<relative path to this folder>"`. npm symlinks a `file:` folder, so it stays live. |
| No package manager | Import by path, relative to the stylesheet. From `codebases/<group>/<app>/src/index.css`: `@import "../../../codecaine/core/design-system/dist/css/tokens.css";` |

Do not use `file:` with bun. Bun snapshots the folder at install time (bun 1.4 links each file that exists then; older versions copy them), so a file added later, such as a new `dist/` output, is missing until `bun install` runs again.

## Change a token

How to change a token and check it: [docs/30-guide/10-tokens](docs/30-guide/10-tokens), section Change a Token.

## Theming

Light, dark, pinned values and dark-first surfaces: [docs/30-guide/10-tokens](docs/30-guide/10-tokens), section Theming.

## Commands

| Command | What it does |
| --- | --- |
| `bun run build` | Validate `tokens/`, then write `dist/`, including the token reference table in `dist/guide/tokens.md`. |
| `bun run check` | Rebuild in memory. Exit 1 and list the stale files when `dist/` is out of date. Core's doctor runs this. |
| `bun run test` | Run the test suite. |

The build fails on an unresolved alias, an alias cycle, a missing `$type` or `$value`, a light/dark key mismatch, a duplicate path, a key repeated in one JSON object, two paths producing one CSS variable, an invalid color or shadow, or a `.json` file under `tokens/` that is not `tokens/base/*.tokens.json` or `tokens/themes/*.tokens.json`. It ignores dotfiles such as `.DS_Store`.

`bun test` with no path runs only `test/` (`bunfig.toml`), not the template app.

## Consumers

Which apps consume the package, how, and their status: [docs/30-guide/60-ecosystem](docs/30-guide/60-ecosystem). To move a new app onto it: [docs/30-guide/50-migrate](docs/30-guide/50-migrate).

Agents doing UI work: read [AGENTS.md](AGENTS.md) and the `design-system` skill.
