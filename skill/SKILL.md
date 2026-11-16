---
name: design-system
description: "Workspace UI standards: the shared tokens, the app shell and code structure, plus Jakub Krehel's principles for how a screen should feel, with a scorer that verifies every page. Use this skill for any UI work in /Users/Ford/workspace: CSS, Tailwind, colors, spacing, type, radius, light and dark themes, layout, sidebars, new pages or components, restyling an app or moving it onto the shared tokens. Also use it to polish or review a design, for \"make it feel better\", \"why does this feel clunky\", alignment, motion, states or copy fixes, and \"verify the design\" or \"is the design done\". For real app examples, use design-references. For PR screenshots, use ui-proof."
metadata:
  version: "0.2.0"
  origin: "The principles part is adapted from jakubkrehel/skills (MIT, see LICENSE-jakub-krehel) and Interfaces Magazine"
---

# Design System

`/Users/Ford/workspace/codebases/codecaine/core/design-system` (`@codecaine-ai/design-system`) is the one source of truth for how every Codecaine and Lascari AI app looks and is laid out. Read its `AGENTS.md` before UI work.

## Style UI

1. Style only with tokens: `var(--ds-*)` in CSS, the utilities from `@codecaine-ai/design-system/tailwind.css` (Tailwind v4), or `cssVar()` and `tokens` from `@codecaine-ai/design-system` in JS. With `tailwind.css`, `dark:` follows `data-theme`, not the OS.
2. Use the semantic roles (surface, text, border, fill, accent, link, status). Use hue tokens only for categorical color. Text uses `link`, never `accent`. `dist/guide/tokens.md` lists every token, and the docs page `docs/30-guide/10-tokens` gives the rules.
3. Never hard-code a color, size, spacing, radius, font, shadow, duration or z-index. Never copy token values into an app. In Tailwind, never use Tailwind's own scales (`bg-red-500`, `text-sm`, `shadow-md`, `rounded-lg`). New apps import `tailwind-strict.css` before `tailwind.css`, so those utilities don't generate at all.
4. Check light and dark: set `data-theme="dark"` on `<html>`.
5. Scan the folders you touched with `bun /Users/Ford/workspace/codebases/codecaine/core/design-system/scripts/scan-literals.ts <dir>`. A new hard-coded literal is a bug.

## Build a New App or Screen

1. Use the app shell in the docs page `docs/30-guide/20-layout`: a collapsible left sidebar (`⌘\` toggles it and the state persists), a topbar with the page title and actions, content in lanes, and an optional inspector. Start from `templates/react-app-shell/` for React, or from the markup in `docs/30-guide/20-layout`.
2. Organize code by vertical slice, as the docs page `docs/30-guide/30-code-structure` describes. Every component is a folder, `_components/<Name>/index.tsx`. Its parts go in its own `_components/`. Keep breaking components down. Move shared code up to the nearest common ancestor.

## Change the Look

1. Edit `tokens/`. Never edit `dist/`.
2. In `/Users/Ford/workspace/codebases/codecaine/core/design-system`, run `bun run build`, `bun run check` and `bun run test`.
3. Open `dist/guide/index.html` and check light and dark. Every connected app picks up the change.

## Connect an App

- **Inside Codecaine Core:** add `"@codecaine-ai/design-system": "workspace:*"` to the package, then run `bun install` at the Core root. Core's `workspaces` already lists `design-system` (the folder sits inside Core), so the link is live.
- **Another local bun app:** add the relative path to the root `workspaces` and depend on `workspace:*`, or use `bun link`. That gives a live link. Avoid a bun `file:` dependency: bun links it file by file at install time, so files added later (new outputs) are missing until someone reruns `bun install`.
- **npm apps:** use a `file:` dependency, which npm links live, or `@import` the CSS by relative path.
- **Apps built on Vercel, Railway or Docker:** vendor a packed copy. Run `bun run pack --out ../<app>/vendor` in design-system (`--out` is relative to the design-system folder) and depend on `file:vendor/<tgz name>`. Repack after a token change.
- **Load order:** `@codecaine-ai/design-system/fonts.css`, then `tokens.css` (`tokens-dark-first.css` on a dark-first surface), then `layout.css`. Agent-viewer hosts add `host-contract.css` after the tokens. For Tailwind v4, `tailwind-strict.css` comes before `tailwind.css`; Tailwind v3 apps use the `tailwind-v3-preset` export as a preset.
- The docs page `docs/30-guide/40-consume` has the full recipe, including the Vite settings.

## Check an App

Run these in `/Users/Ford/workspace/codebases/codecaine/core/design-system`. `--root` defaults to the workspace that holds it: `/Users/Ford/workspace/codebases`, three levels up.

1. Find the app's entry in `apps.json`: repo, wiring, entry stylesheet, scan paths, literal floor, run profile and routes. After you change an entry, run `bun run registry:check`.
2. Run `bun run lint:apps <app>` (add `--pass <n>` to check one migration pass). It prints one line per violation and exits 0 when the app is wired and conformant.
3. Run `bun run verify:apps <app>`. It starts the app under its run profile and proves in a browser that it renders from the tokens in light and dark.
4. Run `bun run test:apps <app>` for the app's tests (add `--commands typecheck,build` for those; a command the entry does not set is skipped). It runs them under the run profile and the sandbox, fails on a write into the app's own checkout, and compares the results with the baselines in `apps.json`. Never run an app's tests or commands directly.
5. Run `bun run use:app --app <app>` to use the app under its run profile. It visits every route in each theme, runs the route's steps, toggles the sidebar and hovers buttons and links. It clicks only the registry's route steps, which the managing agent reviews, and the sidebar toggle. A guard checks each click and key press as a second line of defence: it refuses a submit control, anything in a form, a control whose label names a write, and any key but Tab, Escape, the arrows, PageUp/PageDown, Home/End and a plain Enter or Space. It exits 1 on a console error, a failed or blocked request, a refused step, or a change to the app's checkout, and prints the path of its JSON log.
6. Never start the app outside its run profile. `verify:apps`, `snapshot`, `test:apps` and `use:app` start and stop it for you.
7. The app passes when every gate its `apps.json` entry marks required passes: lint, verify, tests, snapshot and pixel diff.
8. `bun run progress` writes one page with every app's status and literal count.

## Move an Existing App

`apps.json` holds each app's registry entry, and `bun run progress` reports each app's pass status. The migration waves are finished. Move tokens first, then the shell, then the code structure, one app per change:

1. Capture the before state: `bun run snapshot --app <id> --set before`.
2. Run `bun run codemod:literals --app <id> propose`, mark the rows you accept `"approve": "yes"`, then run `bun run codemod:literals apply --table <mapping.json>`.
3. Wire the CSS (`docs/30-guide/40-consume`) and fix what is left until `lint:apps --pass <n>` and `verify:apps --pass <n>` both pass, and `test:apps <id>` shows no failure beyond the baseline.
4. Run `bun run snapshot --app <id> --set after`, then `bun run snapshot:sheet --app <id> --a before --b after` (and `snapshot:diff` with the same flags) to prove the change.

## Judge How It Feels

These rules say how a screen should feel: alignment, spacing, type, color, motion, states and copy. They never set a value. Every number maps to a `--ds-*` token. When a rule needs a value no token has, stop and propose a token in `tokens/`. Never hard-code it. Desktop only, with no mobile or touch rules.

### Pick a Mode

1. **Build**: you are writing or changing UI. Apply the rules as you go.
2. **Review**: someone asks you to look at a diff, PR or page. Report, do not edit.
3. **Verify**: someone asks "is it done", "verify the design" or "make it better". Run the scorer and climb.

A build ends in verify. Never say "design done" without a fresh scorecard.

A Stop hook enforces this. When a turn edits UI source (tsx, jsx, css, html, svelte, vue) and runs no `design:score --app` after the edit, the hook asks once for a fresh scorecard. Answer with a run, or say why the app cannot be scored and mark the design `Not verified`.

### Rules by Area

Each file lists rules with their rule id, verifier check id and token. Read the files for the area you touch.

| Area | File |
| --- | --- |
| Alignment, spacing, grouping | `references/layout-and-alignment.md` |
| Type, measure, numbers | `references/typography.md` |
| Color roles, contrast | `references/color-and-contrast.md` |
| Motion | `references/motion.md` |
| Hover, press, focus, states | `references/interaction-and-states.md` |
| Names, keyboard, focus | `references/accessibility.md` |
| Labels, errors, empty states | `references/writing.md` |
| The verify loop | `references/hill-climb.md` |

### Build Mode

1. Read the Style UI rules above and the reference files for what you touch.
2. Prefer the cheaper fix, in this order: delete, use the native element, reuse a token or component, correct a value, add something new.
3. Cover every state, not just the default: empty, loading, error, long text, disabled.
4. Never introduce a trigger (list below).
5. Finish in verify mode.

### Review Mode

Read only. Edit only when asked to fix the findings.

1. State the scope: app, pages, states, and the diff range for a PR.
2. For a diff, grep the removed lines for lost signals: `aria-*`, `alt`, `label`, `:focus-visible`, `outline`, `prefers-reduced-motion`, `tabular-nums`.
3. Run what can run: `bun scripts/scan-literals.ts <path>`, `bun run lint:apps <id>` and `bun run design:score --app <id>`, in the design-system checkout. Inspect the rendered page when the claim is about rendering.
4. Write one findings table, ranked by severity, then by reach. Cap it at 15. One root cause is one row with every location.
5. End with a verdict: `Block` if any HIGH remains, else `Approve`.

Findings table columns: Severity, Area, Location (`file:line`), Before, After, Why.

**Not verified.** A check you could not run is `Not verified`, never a finding and never `Clear`. A rendering claim backed only by source is `Not verified`. `Approve` covers only what you inspected, so name every area you skipped in the verdict line.

**Severity.**

- HIGH: blocks a task, hides content, misleads, risks data loss, or is a trigger.
- MEDIUM: hurts reading, speed or consistency.
- LOW: isolated polish.

**Triggers** are HIGH on sight, however small the surface:

1. A control with no accessible name, or no visible focus ring.
2. A path that works by pointer but not by keyboard.
3. Text or control contrast below its WCAG 2 ratio, or meaning carried by color alone.
4. Content clipped or cut off with no way to see all of it.
5. A destructive action with no confirm or undo, or an error with no way to recover.

The full list of 13 is in `references/accessibility.md`.

### Verify Mode

The loop and its stop rules are in `references/hill-climb.md`. In short:

1. Score the app: `bun run design:score --app <id> --label base`, then `--quick --label base-quick`, in `~/workspace/codebases/codecaine/core/design-system`. Save the run folder path. An app with no `design-score/apps/<id>.json` cannot be scored yet: say so, and report verify as `Not verified`.
2. Fix the worst failing check: the most fail pages.
3. Rerun with `--quick` on the same pages as `base-quick`, and compare it with `base-quick`. Keep the change only if the score rises and no other check fails that passed before. Otherwise revert it.
4. Stop at the target score, the cost cap, or three tries with no gain.
5. Finish with a full `--label after` run, and report its path and the `bun run design:score --compare <app>/base <app>/after` output.
6. Capture the Before and After screens and a recording for the PR with the `ui-proof` skill.

Never game the score: no edits to the page list, rules, thresholds or allowlists, and no hiding elements to dodge a check.

### Report "Design Done"

A done message has all four, or it is not done:

1. The scorecard path, newer than your last UI edit.
2. The before and after scores, from `--compare`.
3. Any HIGH still open, for the user.
4. The checks that did not run, marked `Not verified`. `V-judge` never runs yet, so each `V-judge` rule is `Not verified` unless you inspected it by eye.
