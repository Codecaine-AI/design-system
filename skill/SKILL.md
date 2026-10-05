---
name: design-system
description: Workspace styling and UI-structure standards. Use for any UI work in /Users/Ford/workspace, including CSS, Tailwind, colors, spacing, type, radius, light and dark themes, app layout or sidebars, new pages or components, component folder structure, restyling an app, or moving an app onto the shared tokens.
metadata:
  version: "0.1.0"
---

# Design System

`/Users/Ford/workspace/design-system` (`@codecaine-ai/design-system`) is the one source of truth for how every Codecaine and Lascari AI app looks and is laid out. Read its `AGENTS.md` before UI work.

## Style UI

1. Style only with tokens: `var(--ds-*)` in CSS, the utilities from `@codecaine-ai/design-system/tailwind.css` (Tailwind v4), or `cssVar()` and `tokens` from `@codecaine-ai/design-system` in JS. With `tailwind.css`, `dark:` follows `data-theme`, not the OS.
2. Use the semantic roles (surface, text, border, fill, accent, link, status). Use hue tokens only for categorical color. Text uses `link`, never `accent`. `guide/tokens.md` lists every token.
3. Never hard-code a color, size, spacing, radius, font, shadow, duration or z-index. Never copy token values into an app. In Tailwind, never use Tailwind's own scales (`bg-red-500`, `text-sm`, `shadow-md`, `rounded-lg`). New apps import `tailwind-strict.css` before `tailwind.css`, so those utilities don't generate at all.
4. Check light and dark: set `data-theme="dark"` on `<html>`.
5. Scan the folders you touched with `bun /Users/Ford/workspace/design-system/scripts/scan-literals.ts <dir>`. A new hard-coded literal is a bug.

## Build a New App or Screen

1. Use the app shell in `guide/layout.md`: a collapsible left sidebar (`⌘\` toggles it and the state persists), a topbar with the page title and actions, content in lanes, and an optional inspector. Start from `templates/react-app-shell/` for React, or from the markup in `guide/layout.md`.
2. Organize code by vertical slice, as `guide/code-structure.md` describes. Every component is a folder, `_components/<Name>/index.tsx`. Its parts go in its own `_components/`. Keep breaking components down. Move shared code up to the nearest common ancestor.

## Change the Look

1. Edit `tokens/`. Never edit `dist/`.
2. In `/Users/Ford/workspace/design-system`, run `bun run build`, `bun run check` and `bun run test`.
3. Open `dist/guide/index.html` and check light and dark. Every connected app picks up the change.

## Connect an App

- **Inside Codecaine Core:** add `"@codecaine-ai/design-system": "workspace:*"` to the package, then run `bun install` at the Core root. Core's `workspaces` already lists `../../design-system`, so the link is live.
- **Another local bun app:** add the relative path to the root `workspaces` and depend on `workspace:*`, or use `bun link`. That gives a live link. Avoid a bun `file:` dependency: bun links it file by file at install time, so files added later (new outputs) are missing until someone reruns `bun install`.
- **npm apps:** use a `file:` dependency, which npm links live, or `@import` the CSS by relative path.
- **Apps built on Vercel, Railway or Docker:** vendor a packed copy. Run `bun run pack --out <app>/vendor` in design-system and depend on `file:vendor/<tgz name>`. Repack after a token change.
- **Load order:** `@codecaine-ai/design-system/fonts.css`, then `tokens.css` (`tokens-dark-first.css` on a dark-first surface), then `layout.css`. Agent-viewer hosts add `host-contract.css` after the tokens. For Tailwind v4, `tailwind-strict.css` comes before `tailwind.css`; Tailwind v3 apps use the `tailwind-v3-preset` export as a preset.
- `guide/consume.md` has the full recipe, including the Vite settings.

## Move an Existing App

`guide/audit.md` lists every app with its gaps, effort and migration wave. Move tokens first, then the shell, then the code structure, one app per change. Prove each change with before and after screenshots. `verification/docs-system/` has a harness you can reuse.
