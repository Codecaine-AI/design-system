---
name: design-system
description: Workspace styling and UI-structure standards. Use for any UI work in /Users/Ford/workspace, including CSS, Tailwind, colors, spacing, type, radius, light and dark themes, app layout or sidebars, new pages or components, component folder structure, restyling an app, or moving an app onto the shared tokens.
metadata:
  version: "0.1.0"
---

# Design System

`/Users/Ford/workspace/codebases/design-system` (`@codecaine-ai/design-system`) is the one source of truth for how every Codecaine and Lascari AI app looks and is laid out. Read its `AGENTS.md` before UI work.

## Style UI

1. Style only with tokens: `var(--ds-*)` in CSS, the utilities from `@codecaine-ai/design-system/tailwind.css` (Tailwind v4), or `cssVar()` and `tokens` from `@codecaine-ai/design-system` in JS. With `tailwind.css`, `dark:` follows `data-theme`, not the OS.
2. Use the semantic roles (surface, text, border, fill, accent, link, status). Use hue tokens only for categorical color. Text uses `link`, never `accent`. `guide/tokens.md` lists every token.
3. Never hard-code a color, size, spacing, radius, font, shadow, duration or z-index. Never copy token values into an app. In Tailwind, never use Tailwind's own scales (`bg-red-500`, `text-sm`, `shadow-md`, `rounded-lg`). New apps import `tailwind-strict.css` before `tailwind.css`, so those utilities don't generate at all.
4. Check light and dark: set `data-theme="dark"` on `<html>`.
5. Scan the folders you touched with `bun /Users/Ford/workspace/codebases/design-system/scripts/scan-literals.ts <dir>`. A new hard-coded literal is a bug.

## Build a New App or Screen

1. Use the app shell in `guide/layout.md`: a collapsible left sidebar (`⌘\` toggles it and the state persists), a topbar with the page title and actions, content in lanes, and an optional inspector. Start from `templates/react-app-shell/` for React, or from the markup in `guide/layout.md`.
2. Organize code by vertical slice, as `guide/code-structure.md` describes. Every component is a folder, `_components/<Name>/index.tsx`. Its parts go in its own `_components/`. Keep breaking components down. Move shared code up to the nearest common ancestor.

## Change the Look

1. Edit `tokens/`. Never edit `dist/`.
2. In `/Users/Ford/workspace/codebases/design-system`, run `bun run build`, `bun run check` and `bun run test`.
3. Open `dist/guide/index.html` and check light and dark. Every connected app picks up the change.

## Connect an App

- **Inside Codecaine Core:** add `"@codecaine-ai/design-system": "workspace:*"` to the package, then run `bun install` at the Core root. Core's `workspaces` already lists `../../design-system`, so the link is live.
- **Another local bun app:** add the relative path to the root `workspaces` and depend on `workspace:*`, or use `bun link`. That gives a live link. Avoid a bun `file:` dependency: bun links it file by file at install time, so files added later (new outputs) are missing until someone reruns `bun install`.
- **npm apps:** use a `file:` dependency, which npm links live, or `@import` the CSS by relative path.
- **Apps built on Vercel, Railway or Docker:** vendor a packed copy. Run `bun run pack --out ../<app>/vendor` in design-system (`--out` is relative to the design-system folder) and depend on `file:vendor/<tgz name>`. Repack after a token change.
- **Load order:** `@codecaine-ai/design-system/fonts.css`, then `tokens.css` (`tokens-dark-first.css` on a dark-first surface), then `layout.css`. Agent-viewer hosts add `host-contract.css` after the tokens. For Tailwind v4, `tailwind-strict.css` comes before `tailwind.css`; Tailwind v3 apps use the `tailwind-v3-preset` export as a preset.
- `guide/consume.md` has the full recipe, including the Vite settings.

## Check an App

Run these in `/Users/Ford/workspace/codebases/design-system`. `--root` defaults to the workspace that holds it.

1. Find the app's entry in `apps.json`: repo, wiring, entry stylesheet, scan paths, literal floor, run profile and routes. After you change an entry, run `bun run registry:check`.
2. Run `bun run lint:apps <app>` (add `--pass <n>` to check one migration pass). It prints one line per violation and exits 0 when the app is wired and conformant.
3. Run `bun run verify:apps <app>`. It starts the app under its run profile and proves in a browser that it renders from the tokens in light and dark.
4. Run `bun run test:apps <app>` for the app's tests (add `--commands typecheck,build` for those; a command the entry does not set is skipped). It runs them under the run profile and the sandbox, fails on a write into the app's own checkout, and compares the results with the baselines in `apps.json`. Never run an app's tests or commands directly.
5. Run `bun run use:app --app <app>` to use the app under its run profile. It visits every route in each theme, runs the route's steps, toggles the sidebar and hovers buttons and links. It clicks only the registry's route steps, which the managing agent reviews, and the sidebar toggle. A guard checks each click and key press as a second line of defence: it refuses a submit control, anything in a form, a control whose label names a write, and any key but Tab, Escape, the arrows, PageUp/PageDown, Home/End and a plain Enter or Space. It exits 1 on a console error, a failed or blocked request, a refused step, or a change to the app's checkout, and prints the path of its JSON log.
6. Never start the app outside its run profile. `verify:apps`, `snapshot`, `test:apps` and `use:app` start and stop it for you.
7. The app passes when every gate its `apps.json` entry marks required passes: lint, verify, tests, snapshot and pixel diff.
8. `bun run progress` writes one page with every app's status and literal count.

## Move an Existing App

`guide/audit.md` lists every app with its gaps, effort and migration wave, and `apps.json` holds its registry entry. Move tokens first, then the shell, then the code structure, one app per change:

1. Capture the before state: `bun run snapshot --app <id> --set before`.
2. Run `bun run codemod:literals --app <id> propose`, mark the rows you accept `"approve": "yes"`, then run `bun run codemod:literals apply --table <mapping.json>`.
3. Wire the CSS (`guide/consume.md`) and fix what is left until `lint:apps --pass <n>` and `verify:apps --pass <n>` both pass, and `test:apps <id>` shows no failure beyond the baseline.
4. Run `bun run snapshot --app <id> --set after`, then `bun run snapshot:sheet --app <id> --a before --b after` (and `snapshot:diff` with the same flags) to prove the change.
