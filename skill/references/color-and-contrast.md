# Color and Contrast

Rule ids, checks and tokens: see the key at the top of `layout-and-alignment.md`. Ramps, gamut and dark-palette rules belong to the token files, so the `design-system` skill owns them. This file covers how apps use color.

## Tokens and Roles

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| No color literals in app code: no hex, `rgb()`, `hsl()`, `oklch()`, named color or Tailwind palette class. | — | `--ds-color-*` | `color-no-literals` | `S-color-literal` fail |
| Components use semantic roles, never hue tokens. Hue tokens are for categorical color only. | — | `surface`, `text`, `border`, `fill`, `status` roles | `color-no-primitives-in-components` | `lint:apps` names |
| Use a token only in its role: no border token as text color, no text token as a background. | — | — | `color-token-in-role` | — |
| Text links use `link`, never `accent`. | — | `--ds-color-link` | design-system rule | — |
| One filled accent action per view. Peers stay neutral. | 1 | `--ds-color-fill-accent` | `color-one-filled-action` | `V-judge` |

## Contrast

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Body and control text meets WCAG 2 AA against the background it actually renders on, in light and dark. | 4.5:1 | text roles | `a11y-text-contrast` | `R-contrast` fail (trigger) |
| Large text (≥ 24px, or ≥ 18.67px bold). | 3:1 | — | `a11y-text-contrast` | `R-contrast` fail |
| Control edges, focus rings, icons and meaningful graphics. | 3:1 | `--ds-color-border-strong`, `--ds-color-focus-ring` | `a11y-non-text-contrast`, `a11y-focus-ring-contrast` | `R-contrast` fail |
| Text on a translucent surface is measured as rendered, not as the token. | — | — | `a11y-text-contrast` | `R-contrast` fail |
| APCA is a second opinion next to WCAG 2, never a gate. `R-contrast` measures WCAG 2 only. | body Lc 75, labels Lc 60 | — | `color-apca-secondary` | `R-contrast` (WCAG 2 only) |

Never report a contrast value you did not measure. Use `R-contrast` output or the `palette` CLI on a screenshot.

## Meaning

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| State and meaning are never carried by color alone. Pair the color with an icon, text or underline. | — | — | `a11y-color-not-only-cue` | `V-judge` (trigger) |
| A semantic color is never used against its meaning, such as the danger hue on a safe action. | — | `--ds-color-status-*` | `color-semantic-not-against-meaning` | `V-judge` (trigger) |
| One hue has one meaning across the app, and appears wherever that meaning does. | ±15° hue | — | `color-one-meaning` | — |

## Surfaces

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Content images (not logos or transparent art) get a 1px outline inset by 1px: black at 10% in light, white at 10% in dark. Never a tinted neutral. | 1px, 10% | none yet: propose `--ds-color-image-outline` | `ui-image-outline` | — |
| A border that only adds depth becomes the system shadow. Borders stay on dividers, inputs, table cells and selected states. Applies only if the system keeps shadows. | — | `--ds-shadow-dialog`, `--ds-shadow-glass` | `ui-shadow-for-depth` | `V-judge` |
| A shadow ring keeps `border: 1px solid transparent`, so forced-colors mode still draws an edge. | 1px | `--ds-border-width-hairline` | `ui-shadow-ring-keeps-border` | — |

---

Adapted from Jakub Krehel's skills (`better-colors`, `better-accessibility`, `better-ui`) and Interfaces Magazine issues 02, 09 and 19. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
