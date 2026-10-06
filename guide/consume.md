# Consume the package

How an app depends on `@codecaine-ai/design-system` and loads its CSS. Read it before you wire one app. Paths are relative to the workspace root (`/Users/Ford/workspace`, or the mirror `/Users/Ford/workspace-ds` during the rollout).

## 1. Pick the wiring

| The app | Wiring | Apps from [audit.md](audit.md) |
| --- | --- | --- |
| Is a Codecaine Core workspace member | `"workspace:*"`. Core's root `workspaces` already lists `../../design-system`. | docs-workbench, sequence studio, canvas studio, canvas-agent viewer, simple-research-kernel |
| Is in another bun repo | Add the design-system path to the repo's root `workspaces`, then `"workspace:*"`. | budget web, pen-plotter, gamecube, system-view |
| Already takes Core packages through `link:` | `"link:@codecaine-ai/design-system"` (section 3) | observatory |
| Uses npm and builds on this machine | `"file:<relative path to design-system>"`. npm symlinks a folder. | MainMenu |
| Builds in Docker, Vercel or Railway | The vendored tgz (section 5) | personal-site, skitzo, CircleSnakesWeb |

- **Never use a bun `file:` dependency on the folder.** bun snapshots the folder at install time, so a file the build adds or rewrites later stays missing or stale until the next `bun install`.
- Libraries (docs-viewer, annotations, viewer-shell, viewer-ui, prompt-kit UI) take no dependency. They read `var(--ds-*)` with fallbacks, and the host app loads the CSS.
- Every wiring except the tgz is a live symlink: `bun run build` in design-system reaches the app on its next reload or build.

## 2. bun workspace member

1. In the repo's root `package.json`, add the design-system folder to `workspaces`, relative to that file. Examples: `"../../design-system"` in `life/budget`, `apps/pen-plotter` and `harnesses/gamecube-decomp-harness`. `"../design-system"` in `system-view` (a single package: add a `workspaces` array to it).
2. In the app's `package.json`, add `"@codecaine-ai/design-system": "workspace:*"`.
3. Run `bun install` at the repo root.
4. Check: `ls -l node_modules/@codecaine-ai/design-system` (in the root or the app folder) shows a symlink to the design-system folder.

Core members skip step 1.

## 3. `link:` and `bun link`

- `"link:@codecaine-ai/design-system"` resolves through a link registry: bun's global folder, or the folder that `install.globalDir` in the app's `bunfig.toml` names. observatory sets `globalDir = "./.bun-links"`.
- A registration exists only on the machine, and in the registry, where `bun link` ran. A fresh clone or another machine needs the registration again.
- During the rollout, `run.env` sets `BUN_INSTALL_GLOBAL_DIR=/Users/Ford/workspace-ds/.bun-global`, so links stay out of the owner's registry. Workers never run `bun link`. Ask the managing agent when an app needs a registration.
- Prefer a workspace member (section 2) when the repo allows it. It needs no registration.

## 4. npm `file:` to the folder

1. In the app's `package.json`: `"@codecaine-ai/design-system": "file:<path>"`, relative to that file. MainMenu (`apps/MainMenu/apps/scene-engine`) uses `"file:../../../../design-system"`.
2. Run `npm install`.
3. Check: `node_modules/@codecaine-ai/design-system` is a symlink. An `.npmrc` with `install-links=true` makes npm copy the folder instead. Remove that setting.

## 5. Vendored tgz (Docker, Vercel, Railway)

These builds cannot see a folder outside the repo. The app commits a packed copy, the same way personal-site takes `vendor/codecaine-ai-docs-publish-0.1.0-proof.20.tgz`. A tgz is a snapshot: a token change reaches the app only through a repack (below).

### First wiring

1. In design-system, run `bun run pack --out <app>/vendor`. It refuses a stale build, packs, checks the tgz and prints two lines:

   ```text
   tgz: <app>/vendor/codecaine-ai-design-system-0.2.0.tgz
   tokens.css sha256: <hex>
   ```

   It never overwrites a tgz of the same name. If `vendor/` already holds the same bytes, it leaves the file and prints a third line, `unchanged: the same bytes were already at this path`. If it holds different bytes, it exits 1 and writes nothing: bump the version first (below).

2. In the app's `package.json`, under `dependencies`: `"@codecaine-ai/design-system": "file:vendor/codecaine-ai-design-system-0.2.0.tgz"`. A Dockerfile that runs `npm ci --omit=dev` skips `devDependencies`.
3. Run `npm install` (or `bun install`) in the app. The lockfile records the tgz path and its `integrity` hash.
4. Make sure the build context holds `vendor/`. personal-site's Dockerfile copies it before the install:

   ```dockerfile
   COPY package*.json ./
   COPY vendor/ ./vendor/
   RUN npm ci
   ```

   Check that `.dockerignore` does not exclude `vendor/`. skitzo's Docker context is `apps/frontend`, so its `vendor/` goes there.
5. Commit `vendor/<name>.tgz`, `package.json` and the lockfile together.

### Repack after a token change

Never repack under the same file name: `bun run pack` refuses to overwrite a same-name tgz with different bytes. The lockfile pins the old bytes by `integrity`. Measured with npm 10.9 and bun 1.4, offline, after a repack that kept the name:

| Install | npm | bun |
| --- | --- | --- |
| On a machine that installed the old tgz (warm cache) | `npm install`, `npm ci`, even with `node_modules` deleted: exit 0, **old** tokens | `bun install`, `--frozen-lockfile`: exit 0, **old** tokens |
| On a clean machine (Docker, CI) | `npm ci`: `EINTEGRITY`, exit 1 | `bun install --frozen-lockfile`: `Integrity check failed for tarball`, exit 1 |

So a same-name repack looks fine locally and breaks the deployed build. These steps work for both package managers:

1. In design-system, bump the patch version in `package.json`. Every repack of a changed build bumps it: `0.2.0` to `0.2.1` on the next repack, then `0.2.2`. The tgz name follows the version. During the rollout, do not bump it yourself. Ask the managing agent.
2. Run `bun run build`, then `bun run pack --out <app>/vendor`.
3. Delete the old tgz from `<app>/vendor`, and change the dependency line to the new file name.
4. Run `npm install` (or `bun install`) in the app. The lockfile gets the new path and `integrity`.
5. Commit the new tgz, the deleted old one, `package.json` and the lockfile together.

After these steps, npm and bun install the new tokens, and a clean `npm ci` or `bun install --frozen-lockfile` with an empty cache passes.

- Packing an unchanged build produces identical bytes, even after a `touch` of its files. `bun run pack` then leaves the existing tgz in place and prints `unchanged`, so it is safe and needs no bump.
- npm only: `npm install "@codecaine-ai/design-system@file:vendor/<same name>.tgz"` also refreshes the lock entry. `bun add` with the same spec kept the old tokens.
- Deleting the whole lockfile also works, but it re-resolves every other dependency. Do not do it.

### Check a vendored copy

The conformance linter compares the sha256 of `package/dist/css/tokens.css` inside the vendored tgz with the current build's `dist/css/tokens.css`. `bun run pack` prints the hash of the copy it packed. By hand:

```sh
tar -xzOf vendor/codecaine-ai-design-system-0.2.1.tgz package/dist/css/tokens.css | shasum -a 256
shasum -a 256 <design-system>/dist/css/tokens.css
```

Scripts can import `tokensCssSha256(tgzPath)`, `readTgz(path)` and `tgzProblems(files)` from `scripts/pack.ts`.

## 6. Exports

| Import | File | Use |
| --- | --- | --- |
| `@codecaine-ai/design-system` | `dist/js/index.js` (+ `.d.ts`) | JS tokens: `tokens`, `flat`, `cssVar()` |
| `@codecaine-ai/design-system/fonts.css` | `css/fonts.css` | `@font-face` for Inter and IBM Plex Mono. Load it first. |
| `@codecaine-ai/design-system/fonts/*` | `fonts/*` | The woff2 files and their OFL licenses. `fonts.css` references them. |
| `@codecaine-ai/design-system/tokens.css` | `dist/css/tokens.css` | `--ds-*` custom properties. Light on `:root`. |
| `@codecaine-ai/design-system/tokens-dark-first.css` | `dist/css/tokens-dark-first.css` | The same tokens, dark on `:root`. For dark-first surfaces. |
| `@codecaine-ai/design-system/layout.css` | `css/layout.css` | The app shell (`.ds-shell`, sidebar, topbar, inspector) |
| `@codecaine-ai/design-system/host-contract.css` | `dist/css/host-contract.css` | The agent-viewer host contract (shadcn, `trace-*`, `status-*` and the rest) mapped to `--ds-*` |
| `@codecaine-ai/design-system/host-contract-dark-first.css` | `dist/css/host-contract-dark-first.css` | The same contract, dark on `:root` |
| `@codecaine-ai/design-system/tailwind.css` | `dist/tailwind/theme.css` | Tailwind v4 theme: the utility names |
| `@codecaine-ai/design-system/tailwind-strict.css` | `dist/tailwind/strict.css` | Tailwind v4: removes Tailwind's default palette and scales |
| `@codecaine-ai/design-system/tailwind-v3-preset` | `dist/tailwind/preset-v3.cjs` | Tailwind v3 preset (`require` only) |
| `@codecaine-ai/design-system/json/*` | `dist/json/*` | `base.json`, `light.json`, `dark.json`, `tokens.json` |

## 7. Load order

The linter's wiring check reads the app's entry stylesheet. Put the imports there, in this order:

1. `fonts.css`
2. `tokens.css`, or `tokens-dark-first.css` on a dark-first surface (MainMenu, skitzo, gamecube, CircleSnakesWeb panels, the docs-mcp home page)
3. `host-contract.css` (or `host-contract-dark-first.css`), only in a host of the agent viewer
4. `layout.css`, only in an app with the shell

On a dark-first surface, set `data-theme="dark"` on `<html>` if the app uses Tailwind's `dark:`. `dark:` then also matches inside a `data-theme="light"` region, because the dark `<html>` is still an ancestor. Token utilities (`dark:bg-panel`) follow the nearest theme and stay correct. Do not use a `dark:` utility whose value is not `var(--ds-*)` (`dark:hidden`, `dark:invert`, `dark:bg-[#0d1117]`) inside a light region. See Theming in [tokens.md](tokens.md).

### Plain CSS

```css
@import "@codecaine-ai/design-system/fonts.css";
@import "@codecaine-ai/design-system/tokens.css";
@import "@codecaine-ai/design-system/layout.css"; /* shell apps */
```

### Tailwind v4

```css
@import "tailwindcss";
@import "@codecaine-ai/design-system/fonts.css";
@import "@codecaine-ai/design-system/tokens.css";
@import "@codecaine-ai/design-system/tailwind-strict.css"; /* before tailwind.css */
@import "@codecaine-ai/design-system/tailwind.css";
@import "@codecaine-ai/design-system/layout.css"; /* shell apps */
```

`tailwind-strict.css` after `tailwind.css` would remove the design-system utilities too.

### Tailwind v3

`tailwind.config.cjs` (or `.js`):

```js
module.exports = {
  presets: [require("@codecaine-ai/design-system/tailwind-v3-preset")],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
};
```

The entry stylesheet, with every `@import` before the `@tailwind` lines:

```css
@import "@codecaine-ai/design-system/fonts.css";
@import "@codecaine-ai/design-system/tokens.css";
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### Agent-viewer hosts

A host of viewer-ui, viewer-shell or prompt-kit (simple-research-kernel, observatory, canvas-agent, budget's kernel view, gamecube) loads `host-contract.css` and deletes its hand-copied contract block. The sheet writes the contract in the format the libraries read:

| Names | Format | Tailwind v4 `@theme inline` | Tailwind v3 `colors` |
| --- | --- | --- | --- |
| shadcn names, `trace-*`, `status-*`, `syntax-*`, `agentprism-*`, `tree-caret`, `tree-connector`, `selection-color`, `zebra-color` | RGB triplet (`253 253 253`) | `--color-background: rgb(var(--background));` | `background: "rgb(var(--background) / <alpha-value>)"` |
| `editor-*` | color | `--color-editor-bg: var(--editor-bg);` | `"editor-bg": "var(--editor-bg)"` |
| `radius` | length | `--radius-sm: var(--radius);` (also `-md`, `-lg`) | `borderRadius: { sm: "var(--radius)" }` |

- v4 hosts (observatory, gamecube) map the shadcn names as `var(--background)` today, because their copies hold hex values. Switch those lines to `rgb(var(--background))`.
- `--editor-bg` and `--editor-gutter-bg` are always opaque (the build fails otherwise): viewer-ui paints its sticky line-number gutter with them, and code scrolls under it.
- Do not keep `calc(var(--radius) - 4px)`: the radius is 2px, so it falls to 0 or below.
- Non-color knobs (`--band-*-opacity`, `--selection-width`, `--zebra-opacity`, `--research-*`) are not in the sheet. Keep their defaults in the host or in the viewer-shell style engine.

## 8. Vite

Checked against Vite 5.4 and `@tailwindcss/vite` 4.3, as installed in Core.

### `server.fs.allow`

Vite resolves a symlink to its real path. With `workspace:*`, `link:` or npm `file:`, that path is outside the app's root, and the dev server answers 403 for the font files (the CSS itself still loads). Allow the package folder. Setting `allow` replaces Vite's default, so keep the workspace root in the list:

```ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const designSystem = dirname(createRequire(import.meta.url).resolve("@codecaine-ai/design-system/package.json"));

export default defineConfig({
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), designSystem] } },
});
```

With a vendored tgz the package sits in the app's `node_modules`, inside the root. It needs no change. `vite build` is not affected.

### `optimizeDeps.exclude`

Vite does not pre-bundle a linked package whose real path is outside `node_modules`. It never pre-bundles CSS. This holds for every linked workspace package, so most apps need no `exclude`. Add `optimizeDeps: { exclude: ["@codecaine-ai/design-system"] }` only when all three are true:

1. The app imports the JS tokens (`import { cssVar } from "@codecaine-ai/design-system"`).
2. The package resolves to a path inside `node_modules`, for example with `resolve.preserveSymlinks: true`.
3. Token changes must show without a dev-server restart.

### `resolve.dedupe`

design-system has no dependencies, so it never needs this. A linked library with its own `node_modules/react` (viewer-ui, prompt-kit) gives the app two copies of React. Add `resolve: { dedupe: ["react", "react-dom"] }`. Vite then resolves those names from the app's root.

### Tailwind v4 `@source`

Tailwind scans the Vite root for class names. It skips `node_modules` and files that `.gitignore` lists. design-system ships CSS, not class names, so it needs no `@source`. A linked library whose TS source uses Tailwind classes needs one line in the entry stylesheet, with the path relative to that stylesheet:

```css
@source "../node_modules/@agent-kernel/viewer-ui/src"; /* from src/styles.css */
```

A package under `node_modules`, a symlink included, is scanned only through an explicit `@source`. An explicit `@source` follows the symlink.

### Fonts

`fonts.css` names its files as `url("../fonts/...")`, inside the package. Vite and `@tailwindcss/vite` resolve these URLs from the folder of `fonts.css`, not from the app's stylesheet. `vite build` emits each woff2 (49 to 106 KB, above the 4 KB `assetsInlineLimit`) as a hashed file such as `dist/assets/Inter-Regular-<hash>.woff2`. The fonts come from the app's own origin, so a CSP of `default-src 'self'` allows them. Do not copy the font files into `public/`.

## 9. Electron and Next standalone

- **pen-plotter** (Electron, Vite renderer). The CSP in `apps/pen-plotter/apps/desktop/src/renderer/index.html` is `default-src 'self'; ... img-src 'self' data:` with no `font-src`, so `default-src 'self'` governs fonts. The emitted font files load. Keep `assetsInlineLimit` below the font sizes: a `data:` font would be blocked.
- **MainMenu** (Next 15 standalone in Electron). `apps/MainMenu/apps/scene-engine/desktop/scripts/prepare-next-runtime.mjs` copies `.next/standalone` and `.next/static` into `desktop/dist-next/runtime` and deletes `runtime/public`. CSS and fonts imported in `globals.css` compile into `.next/static`, so they survive. Fonts placed in `public/` would not. After wiring, run `next build` and the prepare script once, then check that `desktop/dist-next/runtime/.next/static` holds the woff2 files.
