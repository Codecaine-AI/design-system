# Accessibility

Rule ids, checks and tokens: see the key at the top of `layout-and-alignment.md`. The bar is WCAG 2.2 AA. Focus rings and hit areas are in `interaction-and-states.md`, contrast in `color-and-contrast.md`, reduced motion in `motion.md`.

## The 13 Triggers

Each is HIGH on sight in a review, whatever the surface, except number 4. The check that decides it is in brackets.

1. A control with no accessible name (`R-axe`).
2. A keyboard-reachable control with no visible focus ring (`R-focus-visible`).
3. A control or path that works by pointer but not by keyboard (—).
4. Motion or autoplay that ignores `prefers-reduced-motion` (`M-reduced-motion`). the user made this warn only, so report it as MEDIUM, never HIGH.
5. Content or a control clipped, overlapped or unreachable at 200% zoom (`R-text-clip`, `R-h-scroll`).
6. Text or control contrast below its WCAG 2 ratio (`R-contrast`).
7. State or meaning carried by color alone (`V-judge`).
8. A destructive action with no confirm, undo or distinct look (`V-judge`).
9. Truncated content with no way to the full value (`R-text-clip`).
10. Content behind a scroll edge or disclosure with no visible cue (`V-judge`).
11. An error that names no way to recover (`V-judge`).
12. A semantic color used against its meaning (`V-judge`).
13. A state change carried only by motion (`V-judge`).

Jakub's list also has 320px reflow. It is dropped because the user's apps are desktop only.

## Semantics

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Actions are `<button>`, navigation is `<a href>`. Never a `div` or `span` with `onClick`. | — | — | `a11y-native-controls` | `R-axe` |
| Every control has a name. The visible label is in the name, at its start. | — | — | `a11y-icon-button-name`, `a11y-label-in-name` | `R-axe` fail (trigger) |
| Every input has a real `<label>`. A placeholder is never the label. | — | — | `a11y-input-has-label` | `R-axe` fail |
| `aria-*` references resolve. `aria-hidden` is never on or above a focusable element. No redundant roles. | — | — | `a11y-aria-refs-resolve`, `a11y-aria-hidden-not-focusable`, `a11y-no-redundant-role` | `R-axe` fail |
| One `<main>`, headings in order, decorative SVG `aria-hidden`, every `<img>` has `alt`. | — | — | `a11y-one-main`, `a11y-heading-outline`, `a11y-svg-semantics`, `a11y-img-alt-present` | `R-axe` |

## Keyboard

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| Every pointer path has a keyboard path. | — | — | `a11y-keyboard-path-for-pointer` | — |
| No positive `tabindex`. | 0 or −1 only | — | `a11y-no-positive-tabindex` | `R-axe` |
| Composite widgets (tabs, menus, toolbars) take one Tab stop and move with the arrow keys, Home and End. | — | — | `a11y-roving-tabindex`, `a11y-apg-arrow-keys` | — |
| Dialogs trap focus, make the background inert, and return focus to the trigger. Escape closes the newest overlay. | — | — | `a11y-dialog-focus-trap-restore`, `a11y-escape-closes-overlays` | — |
| Shortcuts ignore typing in fields, and a single key never deletes. | — | — | `16-shortcuts-ignore-fields`, `16-shortcut-sequences` | — |

## Focus Placement and Announcements

| Rule | Value | Token | Rule id | Check |
| --- | --- | --- | --- | --- |
| On a route change, update `document.title` (most specific first) and move focus to the new `<h1>` or `<main>`. | — | — | `a11y-spa-route-focus-and-title`, `a11y-title-specific-first` | — |
| A focused element or anchor target is never hidden under the sticky topbar. | `scroll-margin-block-start` | `--ds-layout-topbar-height` | `a11y-focus-not-obscured`, `a11y-scroll-offset-sticky` | — |
| Status messages (saved, copied) go to a polite live region that exists before the message. `assertive` only for urgent errors. | — | — | `a11y-live-region-status`, `a11y-assertive-only-urgent` | — |
| Never move focus to a toast. A toast with an action or error stays until dismissed; others last ≥ 5s and pause on hover. | ≥ 5s | — | `a11y-no-focus-to-toast`, `a11y-toasts-persist-when-actionable` | — |
| Errors set `aria-invalid` and point `aria-describedby` at inline text. Focus moves to the first bad field. Validate on submit, never by disabling submit. | — | — | `a11y-errors-announce`, `a11y-validate-on-submit` | — |

## Left Out

Desktop only: 44px touch targets, 320px reflow, 16px inputs, `touch-action` and the viewport-zoom meta rules are dropped. Hit targets follow the user's thresholds instead (fail under 24px, warn under 32px).

---

Adapted from Jakub Krehel's skills (`better-accessibility`, `better-interface`) and Interfaces Magazine issue 16. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
