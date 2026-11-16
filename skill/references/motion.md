# Motion

Rule ids, checks and tokens: see the key at the top of `layout-and-alignment.md`. Jakub's exact motion values map to the system's motion tokens as below. Where no token is close, the row says "none yet" and the fix is a new token, never a literal.

## Token Map

| Jakub's value | Use | Token |
| --- | --- | --- |
| 100ms | Hover fills, stagger step | `--ds-motion-duration-fast` |
| 150ms | Press, toggles, exits, color changes | `--ds-motion-duration-base` |
| 300ms | Enters, icon cross-fades, panels | `--ds-motion-duration-slow` (260ms) |
| `ease-out` | Enters, exits, press | `--ds-motion-easing-decelerate` |
| `cubic-bezier(0.2, 0, 0, 1)` | Panels, morphs | `--ds-motion-easing-emphasized` (the system's curve) |
| 4px blur, 12px travel | Enter and exit offsets | `--ds-space-1`, `--ds-space-3` |
| 0.95–0.98 press | Button press | `--ds-motion-scale-press` (0.96) |

## What Moves

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Name the exact properties. Never `transition: all` or `transition-all`. | — | — | `ui-no-transition-all` | `S-transition-all` fail |
| Durations and easings are tokens, never literals, in CSS and in Tailwind. | — | `--ds-motion-*` | `iface-project-idiom` | `S-motion-literal` fail |
| Animate only `transform`, `opacity` and `filter` (plus color for state). Never `width`, `height`, `top`, `left` or `margin`. Never animate to `height: auto`. | — | — | `05-composite-only-animation`, `12-no-animate-height-auto` | `M-layout-props` fail |
| Interactive state uses transitions, which reverse mid-way. Keyframes only for one-shot sequences. | — | — | `ui-transitions-for-state` | — |
| `will-change` names one animated property, only on elements that animate. | — | — | `ui-will-change-scoped` | — |

## How Long

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Frequent interactions (row and menu-item hover, keystrokes, tab switches) are instant, or a short fade of opacity or background. | ≤ 150ms | `fast`, `base` | `ui-high-frequency-instant` | `M-duration` fail |
| Menus opened many times a day do not animate open. Animate the close only, if at all. | 0ms open | — | `13-no-open-animation-frequent-menus` | `M-duration` fail over 300ms |
| Data swaps between tabs or chart series do not animate. | 0ms | — | `13-no-animate-data-tab-swap` | `M-duration` fail |
| Enters are longer than exits. Exits are smaller: fade, 4px blur, −12px travel, never the full height. | enter `slow`, exit `base` | `slow`, `base`, `decelerate` | `ui-exit-subtle` | `M-duration` fail |
| Stagger only infrequent staged entrances, in chunks (title, text, actions). | 100ms apart | `fast` | `ui-stagger-entrances` | `M-duration` fail |

## Where From

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Popovers, menus and tooltips scale from their trigger, not the center. | `transform-origin` at trigger | — | `17-transform-origin-trigger` | — |
| An overlay starts near full size. | from scale ≥ 0.95 | — | `17-scale-inverse-to-size` | — |
| Springs have no bounce. | bounce 0 | — | `ui-bounce-zero` | `S-motion-literal` fail |
| State swaps (icons, toggles, tabs) do not animate on first render. Nothing animates on page load unless it is a planned entrance. | `initial={false}` | — | `ui-no-state-animation-on-mount` | — |
| Transitions are off during a theme switch. | — | — | `ui-theme-switch-no-transitions` | — |

## Reduced Motion

Warn only, by the user's decision.

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Under `prefers-reduced-motion: reduce`, movement, scale and blur become an opacity fade. Keep the fade, do not remove all feedback. | fade only | `fast` | `ui-reduced-motion-runtime` | `M-reduced-motion` warn |
| Gate motion in, do not undo it: `motion-safe:` or `@media (prefers-reduced-motion: no-preference)`. | — | — | `a11y-reduced-motion-gate` | `M-reduced-motion` warn |
| Every animated change leaves a static cue: color, icon or label. Motion is never the only signal. | — | — | `ui-motion-not-only-cue` | `V-judge` (trigger) |

Review new motion at 0.1× speed (CDP `Animation.setPlaybackRate`) before calling it done (`11-slow-motion-review`).

---

Adapted from Jakub Krehel's skills (`better-ui`, `better-accessibility`) and Interfaces Magazine issues 05, 09, 11, 13, 17, 19 and 20. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
