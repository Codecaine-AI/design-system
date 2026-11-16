# Interaction and States

Rule ids, checks and tokens: see the key at the top of `layout-and-alignment.md`. Keyboard paths, names and dialogs are in `accessibility.md`. Timing values are in `motion.md`.

## Press and Hover

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| A pressed button scales down a little, with an opt-out variant where motion would distract. | 0.95–0.98, `base`, `decelerate` | `--ds-motion-scale-press` | `ui-press-scale` | `M-press-scale` fail outside the range |
| A disabled button never scales. | — | — | `ui-press-scale-not-disabled` | `M-press-scale` fail |
| Press feedback also fires on keyboard activation (Enter, Space). | — | — | `08-tap-keyboard-parity` | `M-press-scale` warn |
| Hover-only styling sits behind `@media (hover: hover) and (pointer: fine)` (Tailwind v4 `hover:` already does this). | — | — | `ui-hover-capable-only` | `S-hover-unguarded` warn |
| A card's hover uses the same shadow, a step darker, and transitions only `box-shadow`. | — | `--ds-color-fill-hover` | `09-shadow-hover-darker` | — |

## Focus and Hit Areas

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Style focus with `:focus-visible`, not bare `:focus`. | — | — | `a11y-focus-visible-selector` | `S-outline-none` |
| Never remove the outline without a replacement ring in the same rule set. | — | — | `a11y-no-outline-none-without-replacement` | `S-outline-none` fail |
| Every keyboard-reachable control shows the system ring. | 2px, 2px offset | `--ds-border-width-focus`, `--ds-color-focus-ring`, `--ds-focus-ring-offset` | `a11y-visible-focus-indicator` | `R-focus-visible` fail (trigger) |
| Every target is big enough. Extend a small visual with a pseudo-element. | fail < 24px, warn < 32px | — | `a11y-hit-target` | `R-hit-target` |
| Extended hit areas never overlap, and adjacent list or menu items leave no dead gap. | 0px gap | — | `a11y-hit-areas-no-overlap`, `16-no-dead-zones` | `R-hit-target` warn |

## Every State

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Check empty, loading, error, disabled, selected and long-text states, not just the default. The verifier visits the pages and states listed in the app's `design-score/apps/<id>.json`. | — | — | `iface-cover-all-states` | per-state runs |
| A new variant covers hover, focus, active, disabled, loading and selected. | — | — | `review-variant-states-complete` | — |
| Loading and error states do not shift layout. | 0px shift | — | `break-states` | `R-state-shift` fail |
| Lists hold at 0, 1, the usual count and 10× the usual count. Text holds empty, one word, several sentences and a 60-character unbreakable string. | — | — | `break-quantity`, `break-content-length` | `R-text-clip` |
| Copy feedback swaps the icon and keeps the label, so the button keeps its width. | 0px width change | — | `20-copy-feedback-keeps-width` | — |

## Actions and Overlays

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| A destructive action either acts and offers undo (frequent, reversible) or confirms first (irreversible, bulk, affects others). | — | `--ds-color-status-danger-*` | `copy-undo-or-confirm` | `V-judge` (trigger) |
| A destructive confirm focuses the least destructive button on open. | — | — | `a11y-destructive-dialog-focus-safe` | — |
| While submitting, show a spinner beside the label and set `aria-disabled`, not `disabled`. | — | — | `a11y-pending-submit` | — |
| Once one tooltip shows, neighbours show at once for a short window. One app-wide tooltip provider. | skip delay | — | `20-tooltip-skip-delay` | — |
| Decorative layers (glows, scrims, `::after` overlays) never catch clicks. | `pointer-events: none` | — | `a11y-decorative-layers-pass-through` | `R-hit-target` |
| Off-screen or collapsed content shows a cue: a peeking item, scroll fade or disclosure. | — | — | `layout-hidden-content-cue` | `V-judge` (trigger) |

---

Adapted from Jakub Krehel's skills (`better-ui`, `better-accessibility`, `break`, `state-machine`) and Interfaces Magazine issues 08, 09, 16, 19 and 20. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
