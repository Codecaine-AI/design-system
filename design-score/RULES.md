# Design score rules

`rules/` holds one merged list of Jakub Krehel's design rules, deduplicated from two catalogs: the skills (248 rules) and the magazine (171 rules). Source catalogs: `knowledge-base/sessions/design-principle-verification-across-apps/outputs/`.

Sources: the rules paraphrase Jakub Krehel's agent skills (https://github.com/jakubkrehel/skills, MIT License, Copyright (c) 2026 Jakub Krehel) and his Interfaces Magazine issues (https://jakub.kr). Each rule is a one-sentence summary with its source ids in `sources`; no text is copied.

- One file per area: `rules/<area>.json`, each `{ "area", "rules": [...] }`. The areas are the six check areas (layout, typography, color, motion, interaction, accessibility), `writing` (copy rules) and `judge` (taste and process rules for the screenshot judge).
- A rule with a check takes its check's area from `scripts/design-score/checks.ts`. A `V-judge` rule is in `judge`.
- `decisions.json` holds Ford's decisions, the source catalogs and the dropped rules.
- `scripts/design-score/rules.ts` (`loadRules`) reads the folder.

- 303 rules. All 419 source ids are covered: 402 merge into a rule's `sources`, and 17 are dropped (mobile only).
- 13 new `ks-` rules cover "clunky": alignment, control heights, spacing and layout shift.
- Each rule has `id`, `area`, `title`, `rule`, `severity`, `layer`, `values`, `sources` and `check`. Some also have `notes`. Taste-only rules also have `taste: true`.
- `check` is the verifier check that decides the rule, or `null` when no check exists yet.

## Ford's decisions (`decisions` in decisions.json)

1. Desktop only. Mobile rules are dropped: 44px touch targets, 16px mobile inputs, 320px reflow, touch-only gestures.
2. Press scale passes anywhere from 0.95 to 0.98.
3. Hit target: under 24px fails, under 32px warns.
4. Reduced-motion rules are warnings only.

## Counts

| Layer | fail | warn | judge | human | Total |
| --- | --- | --- | --- | --- | --- |
| static | 17 | 78 | | | 95 |
| runtime | 28 | 80 | | | 108 |
| motion | 8 | 50 | | | 58 |
| visual | | | 26 | | 26 |
| human | | | | 16 | 16 |
| Total | 53 | 208 | 26 | 16 | 303 |

- `judge` means a model judge decides it from screenshots, or from extracted text for copy rules (the notes say which).
- `human` means taste or process. These rules are marked `taste: true` and never block a score.

## Areas

| Area | File | Rules |
| --- | --- | --- |
| layout | `rules/layout.json` | 43 |
| typography | `rules/typography.json` | 44 |
| color | `rules/color.json` | 38 |
| motion | `rules/motion.json` | 43 |
| interaction | `rules/interaction.json` | 28 |
| accessibility | `rules/accessibility.json` | 56 |
| writing | `rules/writing.json` | 19 |
| judge | `rules/judge.json` | 32 |

## Check map

105 rules have a check. 198 do not yet (88 static, 51 runtime, 43 motion, 16 human).

| Check | Rules | Rule ids |
| --- | --- | --- |
| `S-color-literal` | 2 | `color-no-literals`, `ui-icon-currentcolor` |
| `S-transition-all` | 1 | `ui-no-transition-all` |
| `S-motion-literal` | 2 | `ks-motion-tokens`, `ui-bounce-zero` |
| `S-hover-unguarded` | 1 | `ui-hover-capable-only` |
| `S-outline-none` | 1 | `a11y-no-outline-none-without-replacement` |
| `R-axe` | 17 | `a11y-no-redundant-role`, `a11y-no-aria-label-on-generic`, `a11y-aria-refs-resolve`, `a11y-no-positive-tabindex`, `a11y-custom-dialog-semantics`, `a11y-input-has-label`, `a11y-autocomplete-tokens`, `a11y-icon-button-name`, `a11y-label-in-name`, `a11y-aria-hidden-not-focusable`, `a11y-img-alt-present`, `a11y-svg-semantics`, `a11y-one-main`, `a11y-skip-link`, `a11y-heading-outline`, `a11y-landmarks-labelled`, `typo-lang-dir` |
| `R-contrast` | 5 | `a11y-text-contrast`, `a11y-non-text-contrast`, `a11y-focus-ring-contrast`, `color-apca-secondary`, `color-placeholder-disabled-legible` |
| `R-focus-visible` | 1 | `a11y-visible-focus-indicator` |
| `R-hit-target` | 3 | `a11y-hit-target`, `a11y-hit-areas-no-overlap`, `16-no-dead-zones` |
| `R-tabular-nums` | 2 | `typo-tabular-nums`, `layout-numbers-align-end` |
| `R-concentric-radius` | 2 | `ui-concentric-radius`, `16-focus-ring-concentric` |
| `R-align-near-miss` | 5 | `ks-align-near-miss`, `ks-handle-first-line`, `ks-baseline-align`, `ks-icon-optical-center`, `layout-shared-edges` |
| `R-text-clip` | 8 | `a11y-text-resize-200`, `layout-min-height-not-height`, `layout-minmax-0`, `layout-text-growth`, `typo-break-long-strings`, `typo-nowrap-labels`, `break-content-length`, `break-container` |
| `R-h-scroll` | 1 | `layout-no-page-h-scroll` |
| `R-min-font` | 2 | `typo-size-floors`, `typo-weight-floor` |
| `R-line-length` | 1 | `typo-measure` |
| `R-spacing-grid` | 6 | `ks-gap-grid`, `ks-repeated-padding`, `ks-indent-step`, `layout-group-gap-ratio`, `layout-control-clearance`, `ui-optical-icon-padding` |
| `R-state-shift` | 2 | `ks-no-state-shift`, `break-states` |
| `R-control-height` | 2 | `ks-row-control-height`, `ks-control-height-scale` |
| `M-duration` | 7 | `ui-high-frequency-instant`, `13-no-open-animation-frequent-menus`, `13-no-animate-data-tab-swap`, `17-duration-by-size`, `17-easing-by-purpose`, `ui-exit-subtle`, `ui-stagger-entrances` |
| `M-layout-props` | 2 | `05-composite-only-animation`, `03-animate-gradient-cheaply` |
| `M-press-scale` | 3 | `ui-press-scale`, `ui-press-scale-not-disabled`, `08-tap-keyboard-parity` |
| `M-reduced-motion` | 3 | `a11y-reduced-motion-gate`, `ui-reduced-motion-runtime`, `12-loader-linear-infinite` |
| `V-judge` | 26 | Every `layer: visual` rule |

Notes on the map:

- `M-duration` also reads easing from the same `getAnimations()` record.
- `R-tabular-nums` also checks numeric cell alignment, because it scans the same cells.
- `ks-no-size-literals` has no check id. `lint:apps` (scan-literals) already gates it.
- `R-state-shift` diffs layout boxes before and after hover, focus, tab selection and opening a popup. It decides `ks-no-state-shift`, and the layout-shift part of `break-states` (loading, error and disabled states are not exercised yet).
- Every finding in a scorecard carries `rules`: the ids of the rules here whose `check` is its check.
- Each check belongs to one area (layout, typography, color, motion, interaction, accessibility). The scorecard has a sub-score per area.

## The clunky rules (`ks-`)

| Rule | Severity | Check | Threshold |
| --- | --- | --- | --- |
| `ks-align-near-miss` | fail | `R-align-near-miss` | Related edges or centers off by 1-3px |
| `ks-handle-first-line` | fail | `R-align-near-miss` | Handle or row icon center more than 1px off the first text line's center |
| `ks-baseline-align` | fail | `R-align-near-miss` | Baselines in one row more than 1px apart |
| `ks-icon-optical-center` | warn | `R-align-near-miss` | Icon more than 0.5px off center in its box |
| `ks-row-control-height` | fail | `R-control-height` | Controls in one row differ in height |
| `ks-control-height-scale` | warn | `R-control-height` | Off the 4px grid, or more than 4 distinct heights |
| `ks-gap-grid` | warn | `R-spacing-grid` | Gap not on the DS space scale |
| `ks-repeated-padding` | fail | `R-spacing-grid` | Repeated items of one kind differ in padding |
| `ks-indent-step` | warn | `R-spacing-grid` | Nesting levels not one constant step |
| `ks-no-state-shift` | fail | `R-state-shift` | A state change moves or resizes a neighbour by 1px or more |
| `ks-icon-size-consistent` | warn | none yet | Icons of one role differ in size |
| `ks-motion-tokens` | fail | `S-motion-literal` | ms or cubic-bezier literal |
| `ks-no-size-literals` | fail | none (`lint:apps`) | Size, space, radius or font literal |

## Dropped (mobile only)

| Id | Why |
| --- | --- |
| `a11y-reflow-320` | 320px reflow |
| `a11y-no-zoom-block` | Viewport-meta pinch zoom |
| `a11y-touch-action-scoped` | touch-action |
| `typo-input-16px-mobile`, `15-ios-input-16px` | 16px mobile inputs |
| `ui-tap-highlight` | Tap highlight |
| `layout-dvh-not-vh`, `20-dvh-not-vh` | dvh only differs on mobile |
| `layout-safe-area-viewport-fit` | Notch safe areas |
| `layout-inset-buttons` | Mobile 16px button inset |
| `07-swipe-container-overflow-clip`, `07-axis-locked-drag`, `07-constraints-low-elastic`, `07-no-momentum-swipe`, `07-snap-threshold`, `07-progressive-action-reveal`, `07-swipe-actions-keyboard` | Swipe rows |

Kept with the mobile part removed: `a11y-hit-target` (drops 44/40), `a11y-input-type` (drops inputmode), `break-container` (320px kept as a container width, not a viewport) and `ui-hover-capable-only` (warn, for touch laptops).

## Conflicts resolved

1. **Press scale.** The skill says exactly 0.96. The magazine says 0.95-0.98. Ford's 0.95-0.98 wins. Duration: the skill's 150ms is shorter than the magazine's 200ms, so 150ms wins.
2. **Hit target.** The skill says 24px (AA). The magazine says 32px on desktop and 44px on mobile. Ford's rule: fail under 24px, warn under 32px.
3. **Reduced motion and press.** Drop the press scale under reduce and keep the color change as the press feedback. Every reduced-motion rule warns.
4. **Spring bounce.** The magazine allows a subtle bounce. The skill says 0. 0 is stricter and wins.
5. **Exit motion.** The magazine slides to -70%. The skill moves a fixed 12px over 150ms with a 4px blur. The skill wins. A 0.99 exit scale (issue 17) is also allowed.
6. **Stagger values.** For product UI, the skill's values win: 100ms, 300ms, 4px blur, 12px. Issue 09's 800ms hero values are noted as an exception.
7. **Image outline opacity.** The skill and issue 09 say 10%. Issue 19 says 8%. 10% wins.
8. **Disabled Continue.** Issue 12 keeps Continue disabled until there is input. The skill says never natively disable submit. The skill wins: use `aria-disabled` with a guard in the handler.
9. **text-wrap on long-form.** Issue 15 bans both balance and pretty. The skill bans balance only. The skill wins.
10. **font-synthesis.** Issue 14 suggests `font-synthesis: none`. The skill forbids it globally. The skill wins.
11. **Truncation.** Issue 15 accepts any tooltip. The skill rejects a hover-only `title`. The skill wins.
12. **Icon-side padding.** The skill says about 2px less. Issue 09 shows 4px less (20 vs 24). Both pass (2-4px).
13. **Height animation.** Issue 05 says never animate height. Issue 12 says morph a container's height between steps. A measured container morph warns and never fails.
14. **Borders vs shadows.** Jakub prefers shadows. The DS frames everything with hairline borders. The DS wins: `ui-shadow-for-depth` is a judge rule, used only where a border fights an image or colored backdrop.
15. **Concentric radius vs the DS's single 2px radius.** The check skips pairs where both radii are `radius.base`. It runs when either radius is above 4px.
16. **Gradient space.** The skill calls it taste. The magazine states it as a rule. It is kept as a warn, with oklab as the default.

## Where the DS breaks a rule today

Token-level details are in `outputs/token-proposals.md`.

- `line-height.reading` is 1.45. The body floor is 1.5.
- `letter-spacing.micro` is 0.09em and `micro-wide` is 0.14em. Jakub uses 0.05em on uppercase labels.
- `font.size.micro` (10px) and `ui-2xs` (11px) are under the 12px floor, so they warn.
- The `motion.duration` steps are 100, 150 and 260ms. Jakub's size bands are 150, 250 and 350-450ms.
- There is no image-outline, card-shadow or control-height token. `motion.scale.press` (0.96) is the press scale.
- Knowledge System icons are PNG masks, so `ui-icons-svg-not-raster` warns.
