# Migrate an app

How to move one app onto `@codecaine-ai/design-system`. Check first that the app is in scope: [ecosystem.md](ecosystem.md#scope). The commands run in the design-system folder and are listed in [AGENTS.md](../AGENTS.md#commands).

An app moves in up to three passes. Each pass ends at its gates and two reviews.

| Pass | Standard | Done when |
| --- | --- | --- |
| 1, tokens | [tokens.md](tokens.md), wired per [consume.md](consume.md) | No hard literal above the floor, every `--ds-*` name exists, light and dark render from the tokens |
| 2, shell | [layout.md](layout.md) | The app renders the shell and passes the layout checklist |
| 3, slices | [code-structure.md](code-structure.md) | The code follows the folder standard, with 0 changed pixels |

Libraries have no pass 3. Libraries, embeds and apps without an app shell have no pass 2. The registry entry says which passes apply.

## 1. Add the registry entry

1. Add the app to `apps.json`. Copy the entry of an app with the same consume type and run mode, then change every field. The types and their comments are in `scripts/lib/registry.ts`.
2. Run `bun run registry:check`. Fix every line it prints.

The fields that decide what the tools check:

| Field | What to set |
| --- | --- |
| `id`, `name`, `kind`, `repo`, `root` | `kind` is `app`, `library` or `site`. `repo` and `root` are workspace-relative. |
| `consume` | `via` is `workspace`, `link`, `npm-file`, `vendor-tgz`, `host-css`, `relative-import` or `copy` ([consume.md §1](consume.md#1-pick-the-wiring)). `detail` says how, in one paragraph. |
| `entryStylesheet` | The file that loads the package CSS. The wiring check reads its imports. |
| `theme.rule` | `light-dark`, or `dark-first` for a dark-by-default surface. |
| `scan` | The paths the literal scanner reads, and what it excludes. |
| `literalFloor` and `allowlist` | The floor is the hard literals allowed after pass 1: 0 plus the documented exceptions. Each kept literal has a row with its reason in `apps/allowlists/<id>.json`. |
| `shell`, `folderStandard`, `passes`, `checks`, `gates` | Each item is `{ "required": true }` or `{ "required": false, "reason": "..." }`. A waived pass, check or gate always states its reason. |
| `run` and `runProfile` | How the app starts (`mode` is `browser`, `electron`, `static` or `none`) and how it is isolated: env, removed env, fixtures, flags, ports. Ports sit in the app's block of ten in 47000-47999 and never on an owner port. |
| `routes` | Every view to capture: `path`, `waitFor`, view-only `steps`, `masks`. A route that cannot be made stable sets `gating: false` with a `reason`. |
| `verify` | `probes` cover the page, panel, text and border roles. A role the app has no element for goes in `waivedRoles` with a reason. `darkSwitch` says how to reach dark. A light-dark app that boots dark sets `lightSwitch` (a stored value). An app that saves its theme on a server sets `lightSteps` instead. |
| `tests` | `safe` commands the tools may run, `unsafe` commands with the reason they are unsafe, and `baselines` from the first run. |
| `exceptions` | Every deviation from the standards, and every baseline change, with its reason. |

## 2. Record the baseline

Before any change to the app:

1. Run `bun run lint:apps <app>`. Record the hard-literal count.
2. Run `bun run test:apps <app>`. Record the result in `tests.baselines`. Failures that already exist are not regressions. The baseline changes later only with a reason in `exceptions`.
3. Unless the run mode is `none`, capture every route twice: `bun run snapshot --app <id> --set before`, then the same with another set name.
4. Run `bun run snapshot:diff --app <id> --a <set> --b <set> --exact` on the two sets. A route whose captures differ gets a fixture or a mask, or becomes non-gating with a reason.

## 3. Pass 1: tokens

1. Wire the package the way the entry's `consume` says ([consume.md](consume.md)). Load the CSS in order: fonts, tokens, host contract (agent-viewer hosts only), layout (shell apps only) ([consume.md §7](consume.md#7-load-order)).
2. Run `bun run codemod:literals --app <id> propose`.
3. Review the mapping by role against [tokens.md](tokens.md). Mark each row you accept `"approve": "yes"`. Rows the codemod flags have no ready replacement: decide each by role.
4. Run `bun run codemod:literals --app <id> apply --table <mapping.json>`.
5. Fix the remaining literals by hand until the app is at its floor. The scanner does not count values in JS or TS objects (renderer defaults, font stacks, sizes in TS). Take those from the package's JS tokens anyway.
6. An app with a style engine keeps its size, density and grain controls. It hides its color controls and bumps its storage keys, so saved colors stop overriding the shared look.
7. Run the gates ([section 6](#6-gates-for-every-pass)) with `--pass 1`.

Pass 1 removes hard literals. Soft px spacing (gaps, paddings, bar heights) moves to space and size tokens in pass 2 for an app with a shell pass. An app without one converts it in pass 1 wherever a token has the same value.

## 4. Pass 2: shell

1. Adopt [`templates/react-app-shell/`](../templates/react-app-shell/) or the markup in [layout.md](layout.md#markup).
2. The theme toggle sets `data-theme` on `<html>`, saves it, and reads the attribute as the source of truth. Light is the default unless the entry is `dark-first`.
3. Add an `end` nav section only when the app has tools or settings pages.
4. Pass the [checklist for a new app](layout.md#checklist-for-a-new-app).
5. Run the gates with `--pass 2`.

## 5. Pass 3: slices

1. Capture a before set on the current tree.
2. Move components into `_components/<Name>/index.tsx` and split files over 400 lines ([code-structure.md](code-structure.md#migrating-a-flat-app)).
3. Keep class names and markup. Registry selectors use them. Keep CSS rules byte-identical when you split a stylesheet.
4. Capture an after set on the same design-system commit as the before set.
5. Run `bun run snapshot:diff --app <id> --a <before> --b <after> --exact`. It must report 0 changed pixels outside masks.
6. Run the gates with `--pass 3`.

## 6. Gates for every pass

Run each gate the entry marks required. A gate marked n/a states its reason in the entry.

| Gate | Command |
| --- | --- |
| `lint` | `bun run lint:apps --pass <n> <app>`, then `bun run lint:apps <app>` with no `--pass`, so every check the entry requires runs |
| `verify` | `bun run verify:apps --pass <n> <app>` (run mode `none` gets a static check) |
| `tests` | `bun run test:apps <app>`. It exits 1 on a failure the baseline does not list. |
| `snapshot` and `pixelDiff` | `bun run snapshot --app <id> --set <name>` twice, then `bun run snapshot:diff --app <id> --a <set> --b <set> --exact`. Pass 3 also diffs before against after (section 5). |

Then:

1. Run `bun run use:app --app <id>`. It visits every route in each theme, runs the route steps and toggles the sidebar. It must exit 0.
2. For passes 1 and 2, run `bun run snapshot:sheet --app <id> --a <before> --b <after>` and look at every route in both themes.
3. Commit the pass in the app's repo, following its commit conventions.

Screenshots and results go to `--out-dir`, never into a git checkout.

## 7. Review and accept

1. Get two independent reviews of the pass. Nobody reviews their own work.
2. Fix what the reviewers find, then run the gates again.
3. Accept the pass when both reviews accept. A finding ruled not blocking is recorded with the reason.

After three review-and-fix rounds without acceptance, stop and mark the pass blocked, with the reason.

## Rules

1. Style only with tokens: `var(--ds-*)`, the Tailwind theme or preset, or `cssVar()`. Never hard-code a color, size, spacing, radius, font, shadow, duration or z-index.
2. Never copy token values into an app, and never edit `dist/`. A value with no equal token stays as written, with an allowlist row and its reason.
3. Check light and dark. A dark-first surface is checked in dark only.
4. Never run an app, its tests or its screenshots outside its run profile. `verify:apps`, `snapshot`, `test:apps` and `use:app` start and stop it under the profile ([AGENTS.md](../AGENTS.md#check-an-app), rule 6). Run an app's tests only through `test:apps`.
5. Send no request that changes state. Use only navigation and view controls: never submit, save, delete, sync or send. Your own browser scripts abort every non-GET request at the browser context before any click or key press.
