# Ecosystem

What the design system covers, which apps consume it and how, and what the first rollout shipped. To move a new app onto the package, read [migrate.md](migrate.md).

## Scope

The design system is the shared UI for one ecosystem:

1. The Codecaine apps and libraries (Core: docs-system, canvas, sequence, agent-kernel, prompt-kit, annotations, observatory, and the tools around them).
2. The owner's personal apps: budget and the like.

Sites with their own custom look stay outside it. personal-site is excluded: it keeps its own UI (owner decision, 2026-10-07). Product looks inside an in-scope app also stay as they are: game scenes and exports, landing heroes, brand pages.

Every app in scope has an entry in [`apps.json`](../apps.json), the app registry. The tools (`lint:apps`, `verify:apps`, `test:apps`, `snapshot`, `use:app`) read it. The commands are in [AGENTS.md](../AGENTS.md).

## Consumers

Every entry in `apps.json`. Paths are relative to the workspace root. Consume is the registry's `consume.via`, sometimes with a short note. Shell is the registry's `shell`: the app renders the app shell from [layout.md](layout.md) (pass 2), or n/a.

Status as of 2026-10-07. For current status run `bun run progress`.

| App | Path | Package | Consume | Status | Shell |
| --- | --- | --- | --- | --- | --- |
| sequence-renderer | `codecaine/core/sequence/packages/sequence` | `@codecaine-ai/sequence` | workspace (JS tokens) | Migrated: pass 1 (2, 3 n/a) | n/a |
| sequence-studio | `codecaine/core/sequence/packages/studio` | `@codecaine-ai/sequence-studio` | workspace | Migrated: passes 1, 2, 3 | Shell |
| docs-workbench | `codecaine/core/docs-system/packages/docs-workbench` | `@codecaine-ai/docs-workbench` | workspace | Migrated: passes 1, 2, 3 | Shell |
| canvas-studio | `codecaine/core/canvas/packages/studio` | `@codecaine-ai/studio` | workspace | Migrated: passes 1, 2, 3 | Shell |
| canvas-renderer | `codecaine/core/canvas/packages/canvas` | `@codecaine-ai/canvas` | workspace (JS tokens) | Migrated: pass 1 (2, 3 n/a) | n/a |
| canvas-agent | `codecaine/core/canvas/packages/canvas-agent` | `@codecaine-ai/canvas-agent` | workspace | Migrated: passes 1, 2, 3 | Shell |
| docs-mcp-home | `codecaine/core/docs-system/packages/docs-mcp` | `@codecaine-ai/docs-mcp` | workspace (files served at a URL prefix) | Migrated: pass 1 (2, 3 n/a) | n/a |
| docs-viewer | `codecaine/core/docs-system/packages/docs-viewer` | `@codecaine-ai/docs-viewer` | host-css library | Migrated: pass 1 (2, 3 n/a) | n/a |
| docs-publish | `codecaine/core/docs-system/packages/docs-publish` | `@codecaine-ai/docs-publish` | relative-import (build time) | Migrated: pass 1 (2, 3 n/a) | n/a |
| viewer-shell | `codecaine/core/agent-kernel/packages/viewer-shell` | `@codecaine-ai/agent-kernel-viewer-shell` | host-css library | Migrated: pass 1 (2, 3 n/a) | n/a |
| viewer-ui | `codecaine/core/agent-kernel/packages/viewer-ui` | `@codecaine-ai/agent-kernel-viewer-ui` | host-css library | Migrated: pass 1 (2, 3 n/a) | n/a |
| simple-research-kernel | `codecaine/core/agent-kernel/examples/simple-research-kernel` | `@codecaine-ai/agent-kernel-example-simple-research-kernel` | workspace (Tailwind v3 preset) | Migrated: passes 1, 2, 3 | Shell |
| prompt-kit-ui | `codecaine/core/prompt-kit/packages/prompt-kit` | `@codecaine-ai/prompt-kit` | host-css library | Migrated: pass 1 (2, 3 n/a) | n/a |
| token-gateway | `codecaine/utilities/token-gateway` | `token-gateway` | workspace | Pending: run mode none. The dashboard needs the gateway wrapper, a pinned CPA binary and the mock upstream. | Shell |
| agent-skills-manager | `infrastructure/agent-config/manager` | none (vanilla JS) | copy | Migrated: passes 1, 2 (3 n/a) | Shell |
| skitzo | `experiments/skitzo/apps/frontend` | `frontend` | vendor-tgz | Migrated: passes 1, 2, 3 | Shell |
| personal-site | `lascari-ai/personal-site` | `lascari-personal-site` | vendor-tgz | Excluded: out of scope. Its migration branch is not merged. | n/a |
| annotations | `codecaine/core/annotations` | `@codecaine-ai/annotations` | host-css library | Pending: uncommitted `package.json` version line | n/a |
| observatory | `codecaine/core/observatory` | `@codecaine-ai/observatory` | link | Pending: uncommitted `package.json`, 4 UI files and 3 untracked items | Shell |
| variator | `codecaine/tools/variator` | `variator` | relative-import | Pending: run mode none. The review UI landed in Codecaine-AI/variator#1, so re-assess the run profile. | Shell |
| slidev-template | `learning/lascari-ai-learning/presentations/SlidevTemplate` | `slidev` | relative-import | Pending: uncommitted `components/MotionCanvas.vue` and a description file | n/a |
| budget | `life/budget/apps/web` | `@personal-budget/web` | workspace | Pending: 83 uncommitted files in `apps/web/src` and staged submodules | Shell |
| pen-plotter | `apps/pen-plotter/apps/desktop` | `@pen-plotter/desktop` | workspace | Pending: uncommitted `SetupPanel.tsx` and 12 open worktrees to merge. Commits have landed since, so re-assess. | Shell |
| mainmenu | `apps/MainMenu/apps/scene-engine` | `scene-engine` | npm-file | Pending: uncommitted editor work in `app/editor/_components` | Shell |
| gamecube | `harnesses/gamecube-decomp-harness/apps/frontend` | `@decomp-orchestrator/frontend` | link | Pending: uncommitted `styles.css`, `vite.config.ts` and root `package.json` | Shell |
| circlesnakes-panels | `games/circle-snakes/web` | `circle-snakes-web` | vendor-tgz | Pending: 42 uncommitted entries in `src/ui`, `src/app` and `vite.config.ts` | n/a |

- Libraries (docs-viewer, docs-publish, viewer-shell, viewer-ui, prompt-kit-ui, annotations) have no pass 3. Libraries and leaf renderers have no pass 2: they render inside a host's shell. Each n/a pass carries its reason in the registry entry.
- Every pending app is blocked by uncommitted work in its repo. The action is to commit that work. The pending apps are the next batch.
- Dark-first surfaces (skitzo, docs-mcp-home, mainmenu, gamecube, circlesnakes-panels) use the same tokens, dark by default, and are checked in dark only. Every other entry supports light and dark.

## How a token change reaches each app

A token change is a `bun run build` in design-system (see [Change a token](../README.md#change-a-token)). How far it travels depends on the consume type.

| Consume | Apps | Gets the change |
| --- | --- | --- |
| workspace | Core members, budget, pen-plotter | Live symlink. The next reload or build reads the new `dist/`. |
| link | observatory, gamecube | Live symlink through a bun link registry. The registration exists only on the machine and in the registry where `bun link` ran. |
| npm-file | mainmenu | Live symlink, unless an `.npmrc` sets `install-links=true`. |
| relative-import | variator, slidev-template | Read by path, so live on the next reload or build. |
| relative-import (build time) | docs-publish | Compiled into `dist/styles/docs.css` at build time. Published pages change only after a docs-publish rebuild. |
| vendor-tgz | skitzo, circlesnakes-panels | A snapshot. Needs a version bump, a repack and a new lockfile entry: [consume.md §5](consume.md#repack-after-a-token-change). |
| copy | agent-skills-manager | A snapshot. Copy the built `tokens.css`, `layout.css` and `fonts.css` with its fonts into `web/vendor/design-system/` again. The linter checks the copy by the hash of `tokens.css`. |
| host-css library | docs-viewer, viewer-shell, viewer-ui, prompt-kit-ui, annotations | Through the host. The host must load `tokens.css` before the library's CSS, and gets the change through its own consume type. |

`bun run verify:apps --propagate --root <dir>` proves the live path: it rebuilds with a sentinel page color and checks that live-linked apps paint it. It refuses `/Users/Ford/workspace`, so run it against a mirror.

personal-site takes docs-publish as a vendored tgz for its article pages. A future docs-publish repack into the site brings design-system tokens into those pages, unless the site keeps its current tgz.

### Hosts that link libraries live

viewer-ui, viewer-shell and prompt-kit-ui read `var(--ds-*)` without px or hex fallbacks. `host-contract.css` alone does not define the size, radius, motion, z and selection-width tokens viewer-ui reads. Every host must load `tokens.css` first ([consume.md §7](consume.md#agent-viewer-hosts)).

Two hosts link these libraries live, outside a workspace:

| Host | How it links | Without `tokens.css` |
| --- | --- | --- |
| gamecube | bun link registry (global links), the way it takes prompt-kit | Boxed message cards lose their inset under the corner cap. The detail modal's z-index falls to auto. Selection rings lose their widths. |
| kurate (a client app, not in `apps.json`) | `link:` to Core's viewer-ui | Text falls to 16px. Card text sits under the corner cap. The detail modal's z-index falls to auto. |

Once kurate loads `tokens.css`, its scrollbars and form controls also follow the theme: `tokens.css` sets `color-scheme` in each theme block.

## Rollout record

The first rollout shipped on 2026-10-07. Each repo's `origin/main` was fast-forwarded to the commit below (design-system has no remote: its local `main`).

| Repo | Commit on `main` | Apps |
| --- | --- | --- |
| `design-system` | `227a8f1` | The package, the tools and `apps.json`. No remote: local `main` only. |
| `codecaine/core` | `cbe266d` | Core's doctor runs `lint:apps` (warn only). |
| `codecaine/core/docs-system` | `0ad8b5e` | docs-mcp-home, docs-viewer, docs-publish, docs-workbench |
| `codecaine/core/sequence` | `14cc2b7` | sequence-renderer, sequence-studio |
| `codecaine/core/canvas` | `66e7546a` | canvas-studio, canvas-renderer, canvas-agent |
| `codecaine/core/agent-kernel` | `96a37c2` | viewer-shell, viewer-ui, simple-research-kernel |
| `codecaine/core/prompt-kit` | `5f447dd` | prompt-kit-ui |
| `lascari-ai/agent-skills` | `3bf833a` | agent-skills-manager |
| `experiments/skitzo` | `a83c7d7` | skitzo |

Not rolled out:

1. system-view. It was not under git, and its migrated copy lived only in the rollout mirror. `apps.json` no longer lists it.
2. personal-site. Out of scope.
3. The 9 pending apps in the [Consumers](#consumers) table.

No existing token value changed in the rollout. It added `color.chart.*` and the `color-scheme` property.

### Open merge-gate consequences

canvas, agent-kernel and prompt-kit shipped before every app that depends on them was migrated. Until the pending apps below finish pass 1, these hold:

1. canvas-agent loads `tailwind-strict.css`, so it no longer generates the Tailwind default classes annotations uses on `/config`. An annotated prompt panel loses its 12px and 14px text sizes, its shadows and the white text of the destructive badge. This holds until annotations pass 1 maps those classes to tokens.
2. budget keeps its `packages/agent-kernel` submodule at or before `081dfb6` until budget depends on the package and its kernel view loads `fonts.css`, `tokens.css` and `host-contract.css`. A later submodule fails budget's Tailwind build on the preset `require`, or renders the kernel view with unset variables.
3. gamecube and kurate lose the values in [Hosts that link libraries live](#hosts-that-link-libraries-live) until they load `tokens.css`.
