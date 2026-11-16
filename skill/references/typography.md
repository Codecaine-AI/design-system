# Typography

Rule ids, checks and tokens: see the key at the top of `layout-and-alignment.md`. Families, sizes, weights and line heights come only from the type tokens. A raw `font-size`, `line-height` or `font-family` is a `scan-literals` failure before it is a design one.

## Size, Weight and Measure

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Use the type scale and nothing else. Each size goes with its line height and weight. | — | `--ds-font-size-*` | `typo-small-type-scale`, `ks-no-size-literals` | `scan-literals` |
| No text below the floor. | 12px | `--ds-font-size-ui-xs` and up | `typo-size-floors` | `R-min-font` fail |
| Below 18px, weight 400 or heavier. | ≥ 400 | `--ds-font-weight-regular` | `typo-weight-floor` | `R-min-font` warn |
| Long-form text stays within the reading measure. | 60–75ch | `--ds-layout-lane-text` (60ch) | `typo-measure` | `R-line-length` warn |
| At most three families. UI uses sans and mono. | ≤ 3 | `--ds-font-family-sans`, `--ds-font-family-mono` | `typo-few-fonts` | — |

## Line Height and Tracking

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Line height is unitless and set by role. | headings 1.2, UI 1.5, reading 1.45 | `--ds-line-height-tight`, `-ui`, `-reading` | `typo-unitless-line-height`, `typo-line-height-by-role` | — |
| Text that wraps to 3 or more lines has line height ≥ 1.4. | ≥ 1.4 | `--ds-line-height-ui`, `-reading` | `typo-wrapping-text-leading` | — |
| Large headings are tightened, small uppercase labels opened up, body stays at 0. Always in `em`. | −0.02em, 0.09em, 0 | `--ds-letter-spacing-title`, `-micro`, `-normal` | `typo-letter-spacing-by-size`, `typo-letter-spacing-em` | — |
| Store text in natural case. Uppercase comes from `text-transform`. | — | — | `typo-natural-case` | — |

## Numbers

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Timers, counters, prices, IDs and numeric table columns use tabular figures. Prose numbers stay proportional. | `font-variant-numeric: tabular-nums` | — | `typo-tabular-nums` | `R-tabular-nums` warn |
| Use the property, never `font-feature-settings: "tnum"`. | — | — | `typo-properties-over-raw-tags` | — |
| Numbers in tables align to the end, text to the start. | `text-align: end` | — | `layout-numbers-align-end` | `R-tabular-nums` warn |

## Wrapping and Overflow

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Headings and short descriptions wrap with balance. Paragraphs use `pretty`, never `balance`. | `text-wrap: balance` / `pretty` | — | `typo-balance-headings`, `typo-pretty-body`, `typo-no-balance-on-paragraphs` | — |
| Long URLs, IDs and paths break instead of escaping their box. | `overflow-wrap: break-word` | — | `typo-break-long-strings` | `R-text-clip` fail |
| Truncated text always has a way to the full value (expand, detail view or a keyboard tooltip). A hover-only `title` is not enough. | — | — | `layout-truncation-way-back` | `R-text-clip` fail (trigger) |
| Labels and badges stay on one line. | `white-space: nowrap` | — | `typo-nowrap-labels` | `R-text-clip` fail |
| Interface text is never justified. | `text-align: start` | — | `typo-no-justify` | — |

## Details

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Typographic punctuation: `…`, en dash in ranges, curly quotes. Code keeps straight quotes. | — | — | `typo-smart-punctuation` | `V-judge` |
| Font smoothing is set once on the root, never per component. | antialiased | — | `typo-font-smoothing-root` | — |
| Load every weight you use, so the browser never fakes bold. | — | — | `typo-load-used-faces` | `verify:apps` fonts |
| Content text stays selectable. `user-select: none` only on control chrome. | — | — | `typo-selectable-text` | — |

## Left Out

Desktop only: the 16px input rule for iOS is dropped. Font choice and loading are owned by the `design-system` skill.

---

Adapted from Jakub Krehel's skills (`better-typography`) and Interfaces Magazine issues 09, 14 and 15. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
