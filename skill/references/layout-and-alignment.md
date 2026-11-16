# Layout and Alignment

How to read the tables: **Rule id** is a `rules[].id` in the design-system catalog, `design-score/rules/<area>.json`. Its `sources` list the Interfaces Magazine and Jakub's skills ids behind each rule. **Check** is the `design:score` check that decides it, with `fail` or `warn`. `—` means no check yet: apply it by hand and say so in a review. `V-judge` is not run yet: the scorer marks it n/a, so a `V-judge` row is a by-eye check, and `Not verified` until you inspect the rendered page. **Token** is the design-system value to use. Never write the raw number.

## Edges and Spacing

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Content lines up on a few shared edges. An edge 1–3px off its neighbour is a near miss, not a choice. | Equal, or clearly apart | — | `layout-shared-edges` | `R-align-near-miss` fail |
| Every margin, padding and gap is a spacing step. | 4px grid, half steps 2px and 6px | `--ds-space-*` | `layout-group-gap-ratio`, `ks-gap-grid` | `R-spacing-grid` warn |
| The gap between groups is at least twice the gap inside a group. | ≥ 2× | `--ds-space-*` | `layout-group-gap-ratio` | `R-spacing-grid` warn |
| One spacing step per nesting level. | — | `--ds-space-*` | `layout-shared-edges` | `R-align-near-miss` warn |
| Space carries structure first. Add a separator only where space cannot, as a hairline. | 1px | `--ds-border-width-hairline`, `--ds-color-border-subtle` | `layout-separators-last` | `V-judge` |

## Sizes and Radius

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Controls in one row share one height, from the scale. | 28px rows, 32px strips | `--ds-space-7`, `--ds-space-8` | `layout-controls-distinct` | `R-control-height` fail |
| Nested rounded surfaces with an even inset: outer radius = inner radius + padding + border. Past 24px of padding, treat them as separate surfaces. | ≤ 24px inset | `--ds-radius-base`, `--ds-radius-pill` | `ui-concentric-radius` | `R-concentric-radius` warn |
| Boxes that hold text use `min-height`, never a fixed `height`. | — | — | `layout-min-height-not-height` | `R-text-clip` fail |
| Grid tracks and flex children that hold long content can shrink: `minmax(0, 1fr)`, `min-width: 0`. | — | — | `layout-minmax-0` | `R-text-clip` fail |
| Width is `100%`, never `100vw`. Nothing scrolls sideways at desktop widths. | 1280 and 1440px | — | `layout-no-page-h-scroll`, `break-container` | `R-h-scroll` fail, `R-text-clip` fail |

## Hierarchy and Polish

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| The most important content sits top and leading. Identity leads, metadata and actions trail. | — | — | `layout-importance-order` | `V-judge` |
| One primary action per view. More than 3 secondary actions go in a menu. | 1 filled, ≤ 3 visible | — | `layout-secondary-actions-in-menu`, `color-one-filled-action` | `V-judge` |
| A control never looks like static text, and a badge never looks like the button beside it. | — | — | `layout-controls-distinct`, `layout-static-not-control-shaped` | `V-judge` |
| A button with an icon and text takes 2px less padding on the icon side. | −2px | `--ds-space-0-5` | `ui-optical-icon-padding` | `R-spacing-grid` warn |
| Asymmetric glyphs (play, star) are aligned by eye, fixed in the SVG. | — | — | `ui-optical-asymmetric-glyphs` | `V-judge` |
| Visual order matches DOM order. No `order`, `row-reverse` or grid placement to reorder. | — | — | `layout-dom-order-matches-visual` | — |

## Left Out

Desktop only, so these are dropped: 320px reflow, `dvh` for mobile panes, safe-area insets, inset full-width mobile buttons. The app shell, lanes and sidebar sizes are owned by the `design-system` skill (`docs/30-guide/20-layout` in the design-system repo).

---

Adapted from Jakub Krehel's skills (`better-layout`, `better-ui`) and Interfaces Magazine. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
