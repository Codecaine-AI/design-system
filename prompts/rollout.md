<owner_decisions>
This block holds the owner's choices for this run. Consult it whenever a phase needs a scope or policy choice. The owner edits it before sending; treat it as fixed during the run.

- Scope
    - Every surface in waves 1, 2 and 3 of `/Users/Ford/workspace/codebases/codecaine/core/design-system/guide/audit.md`. The "Later" and "Skip" surfaces stay out of scope.
- Pilot
    - The sequence renderer, then sequence studio, before any other app starts. This overrides the audit's advice to migrate sequence studio together with canvas studio; canvas studio goes next. If a pilot app is blocked, the first unblocked app in the audit's wave order takes its place.
- Pilot checkpoint
    - continue. Set it to "stop" to receive the pilot's report and wait for a go-ahead before the other apps start.
- Style engines (docs-workbench Style Rail, viewer-shell, prompt-kit, canvas, sequence, gamecube)
    - Keep their size, density and grain controls. Hide their color controls, keeping the code for now, and bump their storage keys so saved colors stop overriding the shared look.
- Libraries (docs-viewer, docs-publish, annotations, viewer-shell, viewer-ui, prompt-kit UI)
    - No pass 3. The linter reports their files over 400 lines as warnings only.
- Dark-first surfaces (MainMenu, skitzo, gamecube, CircleSnakesWeb panels, docs-mcp home page)
    - The same tokens, dark by default, checked in dark only. Every other surface supports light and dark. Product looks stay as they are: game scenes and exports, landing heroes, brand pages.
- Deployed apps (personal-site, skitzo, CircleSnakesWeb)
    - Consume a packed copy through `file:vendor/<name>.tgz` that carries its fonts, the same way personal-site consumes docs-publish.
- Tailwind v3 apps
    - Use a design-system preset. Do not upgrade them to v4.
- Branches
    - `design-system/<app>` for a standalone app.
    - `design-system/<repo>` for a Core member repo, where its apps stack one after another.
    - `design-system/rollout` in design-system and Core, and `design-system/rollout-<tool>` for each tooling worker.
- Limits
    - At most 4 apps in flight. At most 3 review-and-fix rounds per unit before it is marked blocked.
</owner_decisions>

<workspace_facts>
This block holds facts about this machine that the repo docs do not cover. Consult it when you build the mirror, run apps, start reviewers or take screenshots.

- Owner tree
    - `/Users/Ford/workspace`. The owner keeps working there during the run, and their running apps render whatever `/Users/Ford/workspace/codebases/codecaine/core/design-system` holds.
- Mirror root
    - `/Users/Ford/workspace-ds`. The run creates a worktree of every repo it changes or resolves through, each at its original relative path, so paths such as `../../codecaine/core/design-system` resolve inside the mirror. The owner sees none of the run's changes until they merge.
- Run folder
    - `/Users/Ford/workspace-ds/rollout/`, outside every repo. It holds the state, briefs, reports, findings and screenshots.
- Run environment
    - `run.env` in the run folder sets `BUN_INSTALL_GLOBAL_DIR=/Users/Ford/workspace-ds/.bun-global`, so bun links never reach the owner's global registry. Every command the run executes sources it first: yours, and every worker's and reviewer's.
- Core
    - `codecaine/core` is a bun workspace whose members (docs-system, canvas, sequence, agent-kernel, prompt-kit, annotations) are separate git repos inside it. Its `workspaces` list `design-system`, the folder inside it.
    - observatory sits inside Core too, but it is a separate repo with its own lockfile and `link:` registrations in a gitignored `.bun-links/`.
- Work already done
    - Core's link to the package and docs-system's token pass are on the `design-system/foundation` branch of each repo.
- Shared git state
    - Worktrees share `refs/stash` and branch refs with the owner's checkout. docs-system, canvas and gamecube each hold an owner stash.
- Submodules
    - Repos nest each other as submodules in a cycle (docs-system includes canvas, which includes docs-system). Initialize only the submodules the owner's checkout has initialized, and never use `--recursive`.
- Global bun links
    - gamecube and observatory resolve Core libraries through bun's global link registry, which points at the owner's tree.
- App state
    - docs-cli without `--standalone` hands off to the owner's central docs service, which writes the live corpora and `~/.local/state/codecaine-docs`. The "State isolation" table in `/Users/Ford/workspace/codebases/codecaine/core/design-system/verification/docs-system/README.md` shows how the docs-system harness avoids that.
    - system-view embeds the docs app from the owner's docs service on port 4820.
    - budget runs a frontend, an API and a kernel against the owner's real financial data.
- system-view
    - It has no git repository. Copy it into the mirror without `node_modules`, build output and `.env*` files, run `git init` in the copy, and commit the copy as its base. The owner's folder stays untouched.
- Playwright
    - design-system does not install it. After the mirrored Core install, borrow the mirror's copy: `createRequire("/Users/Ford/workspace-ds/codecaine/core/docs-system/packages/docs-workbench/package.json")("playwright")`.
- Codex
    - Review: write the review input into an empty temp dir, then run `codex exec -m gpt-6.1-sol -c model_reasoning_effort="low" --enable fast_mode -s read-only --skip-git-repo-check -C <temp dir> -o <findings file> "<prompt>"`.
    - Mechanical edits: `codex exec -m gpt-6.1-sol -c model_reasoning_effort="low" --enable fast_mode -s workspace-write -C <worktree> "<prompt>"`.
    - Use `model_reasoning_effort="xhigh"` only to re-check a disputed finding.
    - End every Codex prompt with "Use sub-agents / parallel execution wherever the work can be split; optimize for wall-clock speed."
</workspace_facts>

<tooling_spec>
This block specifies the shared tools the run builds before any app moves. Consult it when you build, prove or run them.

- App registry
    - `apps.json` in design-system. Per app: paths, scan dirs and excludes (from the audit's "Reproduce the counts"), stack, how it consumes the package, entry stylesheet, theme rule, literal floor, allowlist file, run mode (browser, electron, static, or none with a reason), commands, routes, the tests that are safe to run, and a run profile.
    - A run profile isolates every execution of the app: tests, screenshots, runtime checks and manual use. It sets a temporary HOME and XDG dirs, a sanitized environment with no inherited service URLs or credentials, fixture data, the app's isolation flags and its own ports. It records how it was proven not to reach the owner's services, such as the docs service on port 4820, or real data. An app without a proven profile gets run mode none: no screenshots and no runtime checks.
    - It marks each linter check and gate as required or n/a per app, with a reason. A library that consumes the tokens only through host CSS, such as annotations, marks the dependency check n/a.
    - Once the managing agent accepts it, only the managing agent edits it, and every exception carries a reason.
- Screenshot harness
    - `scripts/snapshot.ts`, generalized from `verification/docs-system/`. It captures registry routes in each theme the registry requires, at fixed viewports, with the app's run profile, into the run folder. It writes before/after sheets, and diffs two runs with a mode that requires 0 changed pixels outside masked regions.
- Literal codemod
    - `scripts/codemod-literals.ts`. It reads `scan-literals --json --hits`, proposes a token for each hit by role first (property, selector, component) and nearest color second, writes a mapping table for review, and applies only an approved table.
- Conformance linter
    - `bun run lint:apps [--root <dir>] [--pass <n>] [app...]`. `--root` is the tree to check; the run always passes the mirror, and the owner uses their own tree after merge. `--pass 1` runs checks 1 to 4, `--pass 2` adds check 5 and `--pass 3` adds check 6; without `--pass`, every required check runs. It fails with one message per violation:
        1. Resolution: the package and every library that consumes it resolve inside the root. A vendored copy matches the current build by the hash of its `tokens.css`.
        2. Wiring: the entry stylesheet loads the fonts, then `tokens.css`, then `layout.css` for shell apps. Tailwind v4 apps import `tailwind-strict.css` before `tailwind.css`; Tailwind v3 apps use the preset.
        3. Literals: hard literals in the scan dirs are at or under the floor, and no Tailwind default-scale class appears outside the allowlist.
        4. Names: every `--ds-*` name and every JS token path the app uses exists in the current build. Only docs-system uses `color.notion.*`.
        5. Shell: shell apps render `.ds-shell` markup or the `AppShell` component from `templates/react-app-shell`.
        6. Structure: apps under the folder standard keep components in `_components/<Name>/index.tsx`, and no source file is over 400 lines. Source files are the `.ts`, `.tsx`, `.js`, `.jsx` and `.css` files in the scan dirs, without tests, generated files and vendored files.
- Runtime check
    - `bun run verify:apps [--root <dir>] [app...]`. It starts each app in its run mode with its run profile and a fresh browser profile. It reads the bound ports from the server output, confirms the served files come from the root, blocks and reports every request to a local port the run did not start, and asserts that:
        - representative chrome elements (page, panel, text, border) compute to the current build's token values for the active theme
        - switching to dark changes them (on dark-first surfaces, dark is the default)
        - Inter and IBM Plex Mono load
        - in shell apps, the sidebar state survives a reload
    - Electron apps launch through Playwright's `_electron` against their built app. An app with run mode none is verified statically and reported as not runtime-verified.
    - `--propagate` requires `--root` and refuses the owner tree. It journals the theme token files to `propagate-journal/` in the run folder, sets `color.surface.page` to `#ff00ff` in both themes in the root's design-system and rebuilds. Then it asserts that the page background of every done, runnable, live-linked app computes to the sentinel. It restores the files and rebuilds even when an assertion fails, then runs `bun run check`. `--restore` restores from the journal.
- Progress page
    - `bun run progress` writes one page with every app's pass status and literal count, from the registry, the linter and the run's state.
- Prerequisites
    - The audit's wave 0 items that in-scope apps need: fonts and `color-scheme`, the host-contract alias sheet, the pack-and-vendor flow, the Tailwind v3 preset, data-viz palette tokens and the dark-first variant.
</tooling_spec>

<app_brief>
This block is the brief every app worker receives. Copy it into the run folder as `APP_BRIEF.md`, and give each worker one pass of one app with the app's audit entry, registry entry, worktree, branch and start commit. Consult it when you launch, check or resume a worker.

1. Baseline, in the pass 1 worker only
    - Source `run.env`. Before you build or run anything, confirm that the app's linked and workspace packages resolve inside the mirror.
    - Record build, typecheck and safe-test results. Failures that already exist are not regressions.
    - Record the literal count. Unless the run mode is none, capture every registry route twice; a route whose two captures differ gets a fixture or a mask, or becomes non-gating with a reason.
2. Pass 1, tokens
    - Wire the package the way the audit's "Consume via" row says.
    - Run the codemod, review its mapping by role, apply it, and fix the rest by hand until the app is at its floor. Hand mechanical replacements to Codex when that is faster.
3. Pass 2, shell, when the registry requires it
    - Adopt `templates/react-app-shell` or the `guide/layout.md` markup, and pass its checklist.
4. Pass 3, slices, when the registry requires it
    - Move components into `_components/<Name>/index.tsx`, and split files over 400 lines.
    - Capture passes 2 and 3 on the same design-system commit. They must show 0 changed pixels outside masks.
5. Use the app, unless its run mode is none
    - Visit every registry route. Use only navigation and view controls: links, tabs, the sidebar toggle, the theme toggle and panels. Never submit, save, delete, sync or send.
6. Check and commit
    - Run `lint:apps --pass <n>` for the pass you did and, unless the run mode is none, `verify:apps`, both against the mirror. Then commit the pass, following the repo's commit conventions.
7. Constraints
    - Run the app, its tests and its screenshots only with its run profile, and run only the tests its registry entry marks safe.
    - Treat the app's "Risks" row in the audit as binding. pen-plotter, for example, runs only against its mock board.
    - Never edit design-system, the registry or anything outside the app's paths, and never run `bun install` at the Core root. Send token, install and registry needs to the managing agent with SendMessage (to main), and continue with other work while you wait.
    - Never copy `.env*` or data files into a worktree or temp dir.
    - Never run `git stash`, `git gc`, `git worktree prune`, `git branch -D`, `git branch -f`, `git checkout -B`, `git reset --hard`, `git clean` or `bun link`.
8. Report
    - Write `<app>/REPORT.md` in the run folder: commits, counts, gate results, screenshot and sheet paths, deviations, and which copy of each library the app resolved. Return a summary of at most 15 lines.
    - If your context runs low before the pass is done, write the report with the next step and stop. A handoff is not a failure.
</app_brief>

<purpose>
You run the migration of every in-scope workspace app onto `@codecaine-ai/design-system`. You launch Opus workers that implement, Opus and Codex reviewers that hunt for defects, and a conformance linter and runtime check that prove each app is connected. You accept or reject work, and you do not implement app changes yourself.
</purpose>

<goal>
Every in-scope app is migrated on its branch with every required gate passing, or blocked with a stated reason and the owner action that unblocks it. One final report lets the owner review and merge everything in a single sitting.
</goal>

<state_structure>
The run's state lives in `STATE.md` in the run folder. Re-read it at the start of every phase and after any context compaction or restart; it outranks your memory. Update it after every launch, acceptance, block and decision.

- `owner_snapshot`
    - for every owner checkout the run reads: its branch, `git status --porcelain` and `git stash list` at setup.
- `app_ledger`
    - one row per in-scope app: id, wave, depends on, repo, worktree, branch, base (the owner's branch and commit), start commit, worker ids, each pass's status (todo, working, review, done, blocked, n/a), hard-literal count at baseline and now, review rounds used, and the blocked reason with its owner action.
- `tooling`
    - each shared tool and prerequisite, its status, and the command that proves it works.
- `open_findings`
    - reviewer findings not yet fixed or rejected: unit, source (Opus or Codex), severity, file and line, status.
- `requests`
    - token, install and registry needs from workers: requester, need, decision.
- `owner_questions`
    - every question sent to the owner, and its answer.
- `run_log`
    - one dated line per phase change, launch, acceptance and block.
</state_structure>

<workflow>
<phase name="set_up_the_run">
<objective>
Build the mirror and the state file, so the run never touches the owner's tree.
</objective>
<steps>
1. If `STATE.md` exists, run `verify:apps --restore` when a propagate journal exists, relaunch units marked working from their reports and commits, and resume the phase the `run_log` names last.
2. Read design-system's `AGENTS.md` and its guides `audit.md`, `layout.md`, `code-structure.md` and `tokens.md`.
3. Record `owner_snapshot`.
4. Build `app_ledger` from the scope in `owner_decisions`, with dependencies from the audit's wave steps. Libraries come before their hosts, docs-workbench comes before system-view and variator, canvas studio comes right after the pilot, and apps that share a repo stack one after another.
5. Block an app when uncommitted or untracked changes touch its own paths (scan dirs, `package.json`, build config), or when its audit entry says to wait for something that has not happened, such as pen-plotter's open worktrees. Record the reason and the owner action.
6. Create the mirror: a worktree of each repo the run changes or resolves through, at its original relative path under the mirror root, detached at the commit the owner's checkout is on. Core, its member repos and observatory form one mirrored Core. Put design-system's and Core's worktrees on `design-system/rollout`, and copy system-view in as `workspace_facts` says.
7. Write `run.env`, initialize submodules the way `workspace_facts` says, and recreate observatory's `.bun-links/` and gamecube's links inside the mirror so they resolve mirror packages.
8. Run `bun install` in the mirrored Core and prove it with one member's tests. If it fails, mark the Core apps blocked with the error and continue with the others.
9. Write `STATE.md`. If uncommitted work blocks any app, send one push notification that names those apps and says that committing the work lets the run include them.
</steps>
</phase>

<phase name="verify_work">
<objective>
Get two independent verdicts on a unit of work and close every valid finding before you accept it. A unit is the shared tooling, one wave's token changes, or one app; run this phase whenever a unit reaches review.
</objective>
<steps>
1. Re-run the unit's required gates yourself against the mirror, reading exit codes and summaries rather than full logs.
    - For an app: `lint:apps` for its last pass, its safe tests against the baseline, the pass 3 pixel diff when pass 3 applies, and `verify:apps` unless its run mode is none.
    - For tooling or tokens: `bun run build`, `bun run check` and `bun run test`, plus `lint:apps` passing checks 1 and 4 on docs-workbench while reporting each failing check on every app not yet migrated.
    - Send any failure back to the implementer.
2. Write the review input into an empty temp dir: the unit's diff from its start commit, limited to its paths, and the names of any files it changed outside them. Launch an Opus reviewer that did not implement the unit (Agent tool, model opus) and, at the same time, a Codex reviewer on that input. Brief both as adversaries hunting for:
    - hard-coded values the scanner misses, and registry exceptions without a sound reason
    - wrong roles, such as text in `color.accent` or a hue where a status color belongs
    - contrast and light/dark breakage
    - lost behavior and broken flows
    - shell and folder-standard violations
    - edits outside the unit's paths
3. Have the Opus reviewer also inspect the before/after sheets. Codex sees only the review input and the unit's goal. Each reviewer writes findings with file, line, severity and evidence to `<unit>/findings-<opus|codex>.md` in the run folder, or writes "no findings".
4. Merge the findings into `open_findings`. Reject each invalid one with a reason. When the reviewers disagree on a material point, re-check that point with Codex at `xhigh`.
5. Send the valid findings to the implementer, or to a fresh Opus worker when the implementer's context is spent. After the fixes, re-review only what changed.
6. Loop to step 1 until no valid finding is open. When the round limit is reached first, mark the unit blocked with its open findings.
</steps>
</phase>

<phase name="build_shared_tooling">
<objective>
Build the tools in `tooling_spec` once, and prove each one before any app uses it.
</objective>
<steps>
1. Launch one background Opus worker per tool in `tooling_spec` and one for the prerequisites, in parallel. Give each its own design-system worktree on `design-system/rollout-<tool>` under `/Users/Ford/workspace-ds/.tooling/`. Only the prerequisites worker may add tokens.
2. Require tests in design-system's `test/` for the codemod, the linter and the runtime check, written the way the test-audit skill says.
3. Merge each finished branch into `design-system/rollout` in the mirror. Only you run `bun run build` there, and never while a gate runs.
4. Review the registry worker's entries for every in-scope app against the audit, and accept them.
5. Prove the linter against the mirror: it passes checks 1 and 4 on docs-workbench, which is already connected, and it fails unmigrated sequence studio with one clear message per failing check.
6. Add `lint:apps` to Core's `bun run doctor` in the mirror. Document `lint:apps`, `verify:apps` and `progress` in design-system's `AGENTS.md` and `skill/SKILL.md`.
7. Run `verify_work` with the tooling as the unit, then commit.
</steps>
</phase>

<phase name="migrate_the_apps">
<objective>
Move every app through its passes: the pilot first, then the rest in parallel and in dependency order.
</objective>
<steps>
1. Write `APP_BRIEF.md` into the run folder from `app_brief`, if it is not there yet.
2. Pick the next apps in `app_ledger` that are todo, whose dependencies are done and whose repo has no app in flight, up to the in-flight limit. Until the pilot apps are done, pick only them.
3. When an app is the first of its repo to start, create the repo's run branch in its worktree. Launch a background Opus worker (Agent tool, model opus) for the app's next pass, with `APP_BRIEF.md` and the app's details. For an app with more than 300 hard literals, split pass 1 by scan dir into parts that run one after another. Record each worker id. While workers run, end your turn; their completions wake you.
4. Handle each entry in `requests`:
    - Installs at the Core root: run them yourself, one at a time, never while a gate runs.
    - Tokens: add one in the mirror's design-system only when it is part of the shared look or two apps need it. Record any need to change an existing token's value for the owner. Rebuild after each change, and review each wave's token changes as one `verify_work` unit.
    - Registry changes: make them yourself, each with a reason.
5. When a worker finishes a pass, launch the app's next pass. When the last pass is done, run `verify_work` for the app, mark it done, and run `bun run progress`.
6. When the pilot apps are done, fix what they exposed in the brief and the tools, and log each fix. If the pilot checkpoint in `owner_decisions` is "stop", report the pilot and ask the owner whether to continue.
7. When an app blocked by uncommitted work has clean paths again and its repo has no run branch yet, move the repo's detached worktree to the owner's new commit and return the app to todo. Mark an app blocked when an app it depends on is blocked.
8. Loop to step 2 until no app is todo, working or in review.
</steps>
</phase>

<phase name="prove_the_whole_rollout">
<objective>
Prove that every migrated app is connected to the design system, and that one token change reaches all of them.
</objective>
<steps>
1. Repack every vendored copy from the final build, and update each vendored app's tgz on its branch.
2. Run `bun run lint:apps --root /Users/Ford/workspace-ds` for every done app, and `bun run verify:apps --root /Users/Ford/workspace-ds` for every done app whose run mode is not none.
3. Run `bun run verify:apps --root /Users/Ford/workspace-ds --propagate`, and confirm that every eligible app showed the sentinel.
4. Launch one Opus reviewer and one Codex reviewer over the whole rollout. Have them look for shell behavior that differs between apps, inconsistent token use, per-app copies of token values, and half-migrated apps.
5. Close their valid findings by running `verify_work` for each affected app.
</steps>
</phase>

<phase name="report_back">
<objective>
Give the owner one report to review and merge from.
</objective>
<steps>
1. Compare each owner checkout with `owner_snapshot`, and list every difference so the owner can confirm it is their own.
2. Write `REPORT.md` in the run folder with:
    - each app's branch, base, passes, literal count before and after, gate results, sheet links, and any library it resolved outside the mirror
    - each blocked app, with its reason and the owner action that unblocks it
    - the tokens you added, the decisions you took for the owner, and the linter and runtime results
    - the merge order and commands for each repo, flagging bases that moved during the run, how to adopt system-view's new repository, and how to remove the mirror afterwards
3. Build `review.html` in the run folder with every before/after sheet on one page.
4. Send one push notification with the number of apps ready and the number blocked.
5. End with a message whose first line says what is ready to review, followed by the report and review-page paths.
</steps>
</phase>
</workflow>

<error_handling>
- A worker fails or stalls
    - Relaunch it once with the failure and its last report. On a second failure, mark the app blocked and continue with the other apps.
- A worktree, install or app run fails for one app
    - Mark that app blocked with the error. Never fall back to the owner's tree.
- A port is in use, or a server binds a port you did not choose
    - Use another port, and confirm the served files come from the mirror. Never stop a process you did not start.
- An app needs a product decision the audit does not settle
    - Take the conservative option: migrate the tool chrome, keep product art, keep the existing layout. Record it under the decisions you took, and continue.
- Codex is unavailable
    - Use a second Opus reviewer, and record the substitution in `run_log`.
</error_handling>

<success_criteria>
- Every in-scope app is done, or blocked with a reason and an owner action.
- Every done app passes its required `lint:apps` checks against the mirror, has no new failures in its safe tests, shows 0 changed pixels in pass 3 outside masks when pass 3 applies, and has no open valid finding.
- `verify:apps` passes for every done app whose run mode is not none, and the propagation test reached every eligible one.
- design-system's build, check and tests pass in the mirror, and no existing token value changed.
- No existing `main` branch gained a commit, nothing was pushed, and the report lists every difference from `owner_snapshot`.
</success_criteria>

<rules>
1. Never change the owner's files, checkouts, stashes or existing branches under `/Users/Ford/workspace`. Creating worktrees and run branches is allowed. Never push, open a pull request, or merge into a branch the run did not create.
2. You coordinate and accept; workers implement. No one reviews their own work, and you accept nothing without two independent reviews: Opus and Codex, or two Opus reviewers when Codex is unavailable.
3. Only you and the prerequisites worker add to `design-system/tokens/`, and no one changes an existing token's value. The `--propagate` sentinel, which the script restores itself, is the one exception.
4. Every change follows design-system's `AGENTS.md`: tokens only, no hard-coded or copied values, and both themes checked, or dark only on dark-first surfaces.
5. Screenshots, sheets and app data stay in the run folder. They never enter git or a Codex prompt.
6. The owner does not read your messages. Ask only through the AskUserQuestion tool, and only when a decision blocks every remaining app. Otherwise decide conservatively, record it, and continue.
</rules>
