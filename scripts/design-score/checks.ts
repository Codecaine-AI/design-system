/**
 * The design:score check catalog. Ids are stable: design-score/rules.json maps Jakub Krehel's rules to them.
 */
import type { CheckDef } from "./types";

export const CHECKS: CheckDef[] = [
  // static: source files, no browser
  { id: "S-color-literal", layer: "static", title: "Color literals", rule: "scan-literals color hits (hex, rgb, hsl, oklch, other color functions, Tailwind arbitrary colors). Inline use fails; a literal in a custom-property definition warns; var() fallbacks are ignored.", area: "color" },
  { id: "S-transition-all", layer: "static", title: "transition: all", rule: "CSS `transition: all`, `transition-property: all`, a transition shorthand that names no property, or the Tailwind class `transition-all`. Fails.", area: "motion" },
  { id: "S-motion-literal", layer: "static", title: "Motion literals", rule: "A literal duration (ms/s, not 0) or cubic-bezier()/steps() easing in a transition or animation declaration, or a Tailwind duration-*/delay-*/ease-[...] class, instead of the motion tokens. Rules inside @media (prefers-reduced-motion) are ignored. Fails.", area: "motion" },
  { id: "S-hover-unguarded", layer: "static", title: "Hover outside (hover: hover)", rule: "A CSS :hover rule outside @media (hover: hover). Tailwind v4 `hover:` is already guarded. Warns.", area: "interaction" },
  { id: "S-outline-none", layer: "static", title: "outline: none without a replacement", rule: "CSS outline none/0 in a file with no :focus-visible rule for the same class, or a Tailwind outline-none class string with no focus-visible: utility. Fails.", area: "interaction" },
  // runtime: page x theme x viewport
  { id: "R-axe", layer: "runtime", title: "axe-core", rule: "axe-core violations for wcag2a/2aa/21a/21aa/22aa (color-contrast and target-size are left to R-contrast and R-hit-target). Fails.", area: "accessibility" },
  { id: "R-contrast", layer: "runtime", title: "Text contrast", rule: "Computed text color against the painted background under it (elementsFromPoint, alpha composited). Below 4.5:1, or 3:1 for 24px+ or 18.66px+ bold text, fails. Text over images or gradients is skipped.", area: "color" },
  { id: "R-focus-visible", layer: "runtime", title: "Focus visible", rule: "Tab through the first 30 focusables. Each must change pixels around itself when focused (outline, ring, shadow). No visible change fails.", area: "accessibility" },
  { id: "R-hit-target", layer: "runtime", title: "Hit target size", rule: "Interactive targets under 24px in either dimension fail (warn when no other target is within the 24px circle, WCAG 2.5.8's spacing exception); under 32px warns. Inline text links are exempt.", area: "interaction" },
  { id: "R-tabular-nums", layer: "runtime", title: "Tabular numbers", rule: "A purely numeric text (2+ digits) in a proportional font without font-variant-numeric: tabular-nums. Warns.", area: "typography" },
  { id: "R-concentric-radius", layer: "runtime", title: "Concentric radius", rule: "A rounded child inset evenly into a rounded parent's corner: the parent radius should be the child radius plus the inset (within 2px or 25%). Radii under 4px are not checked. Warns.", area: "layout" },
  { id: "R-align-near-miss", layer: "runtime", title: "Alignment near misses", rule: "Neighboring elements in one column whose left edges (or right edges, for right-aligned text) differ by 1-3px, neighbors in one row whose vertical centers differ by 1-3px, and a drag handle whose center misses its row's first text line. Handle misses and text-column misses fail; the rest warn.", area: "layout" },
  { id: "R-text-clip", layer: "runtime", title: "Clipped text", rule: "A text element with overflow hidden/clip whose content is wider than its box without text-overflow: ellipsis, or taller by 2px+ without line-clamp. Fails.", area: "typography" },
  { id: "R-h-scroll", layer: "runtime", title: "Horizontal scroll", rule: "The document, or the main content area, scrolls sideways. Fails.", area: "layout" },
  { id: "R-min-font", layer: "runtime", title: "Minimum font size", rule: "Visible text under 12px fails; uppercase labels of 10-11.99px warn.", area: "typography" },
  { id: "R-line-length", layer: "runtime", title: "Line length", rule: "Wrapped prose (2+ lines) whose line holds more than 80 average characters. Warns.", area: "typography" },
  { id: "R-spacing-grid", layer: "runtime", title: "Spacing grid", rule: "Padding or gap that is not a multiple of 4px or a space token (2px, 6px), counting the border (7px padding + 1px border is on the grid). Warns.", area: "layout" },
  { id: "R-state-shift", layer: "runtime", title: "State shift", rule: "Hovering, focusing, selecting (tabs) or opening (aria-haspopup, config shift.open) a control must not move or resize its neighbours or itself: the layout box of each visible element near it, read before and after with transitions off, changes by 1px or more (client rect and layout box both). A page's shiftWatch elements are compared across the page's own actions. Fails. First theme, first viewport.", area: "interaction" },
  { id: "R-control-height", layer: "runtime", title: "Control heights in a row", rule: "Buttons, inputs and selects with a visible box, side by side in one row (gap 16px or less), whose heights differ by 1px or more. Fails.", area: "layout" },
  // motion
  { id: "M-duration", layer: "motion", title: "Motion durations", rule: "Durations of transitions and animations seen while hovering/pressing controls (max 200ms), opening menus/popovers (300ms) and dialogs or large panels (450ms). Longer fails.", area: "motion" },
  { id: "M-layout-props", layer: "motion", title: "Animating layout properties", rule: "A transition or animation seen running on width, height, top/left/right/bottom, margin, padding, gap or grid tracks fails; one only declared in computed style warns.", area: "motion" },
  { id: "M-press-scale", layer: "motion", title: "Press scale", rule: "A control that scales on :active must scale to 0.95-0.98. Below 0.95 fails; 0.98-1 warns. Controls without a press scale are not judged.", area: "interaction" },
  { id: "M-reduced-motion", layer: "motion", title: "Reduced motion", rule: "With prefers-reduced-motion: reduce, any transform/translate/scale/rotate or position animation still running while hovering or reaching the page state. Warns.", area: "motion" },
  // judge
  { id: "V-judge", layer: "judge", title: "Vision judge", rule: "Not run in this version: the state screenshots are captured for it." },
];

export const CHECK_IDS = CHECKS.map((check) => check.id);
export const STATIC_IDS = CHECKS.filter((c) => c.layer === "static").map((c) => c.id);
