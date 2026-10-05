# Design system rules for agents

`/Users/Ford/workspace/design-system` (`@codecaine-ai/design-system`) is the styling source of truth for every app in the workspace. These rules apply to UI work anywhere in the workspace, not only in this folder.

## Read first

1. [guide/tokens.md](guide/tokens.md): token tiers, names and the full reference.
2. [guide/layout.md](guide/layout.md): the app shell and content lanes.
3. [guide/code-structure.md](guide/code-structure.md): how UI code is organized.

## Rules

1. Style only with tokens: `var(--ds-*)` in CSS, the utilities from `tailwind.css`, or `cssVar()` in JS.
2. Never hard-code a color, size, spacing, radius, font, shadow, duration or z-index.
3. In Tailwind, never use Tailwind's own scales: the default palette (`bg-red-500`, `bg-white`, `text-black`), text sizes (`text-sm`), shadows (`shadow-md`), radius steps (`rounded-lg`; use `rounded` or `rounded-pill`), font weights (`font-light`, `font-normal`; use `font-regular`), or its line-height, tracking, blur and easing steps. New apps import `tailwind-strict.css` before `tailwind.css`, so these do not generate at all.
4. Use semantic roles: `color.surface`, `color.text`, `color.border`, `color.fill`, `color.accent`, `color.link`, `color.status`, `color.diff`, `color.code`. Use hue tokens (`color.blue.*` and the rest) only for categorical color.
5. Text never uses `color.accent`; use `color.link` (`text-link`). A glyph on a hue or status `solid` uses that tile's `on-solid` (`color.yellow.on-solid`, `color.status.warning.on-solid`), not `color.text.on-solid`.
6. Check light and dark (`data-theme="dark"`) before you finish.
7. Never edit `dist/`. Never copy token values into an app.
8. `color.notion.*` is compat for docs-system. New code never uses it.

## Add or change a token

1. Edit `tokens/base/*.tokens.json` for a theme-independent value. For a color or shadow, edit both `tokens/themes/light.tokens.json` and `tokens/themes/dark.tokens.json` with the same path.
2. Give every token `$type`, `$value` and a `$description` that says where it is used. Colors are lowercase hex; `{path}` is an alias.
3. Add a token only when the value is part of the shared look or two apps need it. A component's own knobs stay in the app, built from tokens.
4. Run the commands below, then open `dist/guide/index.html` and check light and dark.

## Commands

Run in `/Users/Ford/workspace/design-system`:

| Command | Use |
| --- | --- |
| `bun run build` | Validate tokens and regenerate `dist/` and `guide/tokens.md`. |
| `bun run check` | Exit 1 when `dist/` is stale. |
| `bun run test` | Run the tests. |
