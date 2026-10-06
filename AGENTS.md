# Design system rules for agents

`/Users/Ford/workspace/design-system` (`@codecaine-ai/design-system`) is the styling source of truth for every app in the workspace. These rules apply to UI work anywhere in the workspace, not only in this folder.

## Read first

1. [guide/tokens.md](guide/tokens.md): token tiers, names and the full reference.
2. [guide/layout.md](guide/layout.md): the app shell and content lanes.
3. [guide/code-structure.md](guide/code-structure.md): how UI code is organized.
4. [guide/consume.md](guide/consume.md): how an app depends on the package and the order it loads the CSS (fonts, tokens, layout).

## Rules

1. Style only with tokens: `var(--ds-*)` in CSS, the utilities from `tailwind.css` (or the `tailwind-v3-preset` in a Tailwind v3 app), or `cssVar()` in JS. Charts use `color.chart.*`.
2. Never hard-code a color, size, spacing, radius, font, shadow, duration or z-index.
3. In Tailwind, never use Tailwind's own scales: the default palette (`bg-red-500`, `bg-white`, `text-black`), text sizes (`text-sm`), shadows (`shadow-md`), radius steps (`rounded-lg`; use `rounded` or `rounded-pill`), font weights (`font-light`, `font-normal`; use `font-regular`), or its line-height, tracking, blur and easing steps. New apps import `tailwind-strict.css` before `tailwind.css`, so these do not generate at all.
4. Use semantic roles: `color.surface`, `color.text`, `color.border`, `color.fill`, `color.accent`, `color.link`, `color.status`, `color.diff`, `color.code`. Use hue tokens (`color.blue.*` and the rest) only for categorical color.
5. Text never uses `color.accent`; use `color.link` (`text-link`). A glyph on a hue or status `solid` uses that tile's `on-solid` (`color.yellow.on-solid`, `color.status.warning.on-solid`), not `color.text.on-solid`.
6. Check light and dark (`data-theme="dark"`) before you finish.
7. Never edit `dist/`. Never copy token values into an app.
8. `color.notion.*` is compat for docs-system. New code never uses it.

## Add or change a token

1. Edit `tokens/base/*.tokens.json` for a theme-independent value. For a color or shadow, edit both `tokens/themes/light.tokens.json` and `tokens/themes/dark.tokens.json` with the same path.
2. Give every token `$type`, `$value` and a `$description` that says where it is used. Colors are lowercase hex; `{path}` is an alias.
3. Add a token only when the value is part of the shared look or two apps need it. A component's own knobs stay in the app, built from tokens.
4. Run the commands below, then open `dist/guide/index.html` and check light and dark.

## Check an app

1. `apps.json` describes every app: its repo, how it consumes the package, its entry stylesheet, scan paths, literal floor, allowlist, run profile and routes. Change an entry, then run `bun run registry:check`.
2. `bun run lint:apps <app>` proves the app is wired and conformant: the package resolves inside the workspace, the entry stylesheet loads the CSS in order, no literal sits outside the allowlist, every `--ds-*` name exists, the app uses the shell and the code follows the folder structure.
3. `bun run verify:apps <app>` proves the app renders from the tokens in a real browser: token probes in light and dark, the fonts, the sidebar state, served files and blocked requests.
4. `bun run test:apps <app>` runs the app's safe tests (`tests.safe`) under its run profile, inside the sandbox, with a write check around each command, and compares each result with the baseline in `tests.baselines`. Add `--commands typecheck,build` to run those commands the same way. A named command the entry does not set is skipped, with the line `commands.<name>: not set in apps.json (skipped)`. It exits 1 on a failure the baseline does not list, fewer tests than the baseline ran, a baseline without `cmd` or for another command, a write into the app's own checkout (build caches such as `node_modules/.vite` and `*.tsbuildinfo` excepted), or a timeout. Run an app's tests and commands only through it. Baselines change only through the managing agent, with a reason in the entry's `exceptions`.
5. `bun run use:app --app <app>` uses the app in a browser under its run profile, the way a person would. It visits every route in each theme, runs the route's steps, toggles the sidebar and back, and hovers up to 30 buttons and links. It never clicks a submit control, anything in a form, or a control named like a write (save, delete, remove, send, submit, sync, publish, deploy). It records that step as refused. It exits 1 on a console error, a failed request, an unexpected blocked request, an isolation problem, or a failed or refused step.
6. Never run an app outside its run profile (temp `HOME` and `TMPDIR`, cleaned environment, the macOS `sandbox-exec` profile: network only to the ports in its block on loopback (a test command: its block and the ephemeral ports 49152-65535, minus every port already listening when it starts and the owner's ports; a named command such as typecheck or build: no port), writes only in the app's own checkout and the run's temp dir, reads under your home only in `--root` and the runtimes, no `.env` reads). `verify:apps`, `snapshot`, `test:apps` and `use:app` start and stop it under the profile. After a crashed tool, `bun scripts/lib/app-runner.ts --cleanup --out-dir <dir>` stops exactly the processes its runs recorded.
   Electron runs are refused by default: an Electron launch writes `~/Library/Preferences/com.github.Electron.plist` through cfprefsd, which neither the sandbox nor `CFFIXED_USER_HOME` stops. A run needs `DS_ALLOW_ELECTRON=1`; the Electron tests also need `DS_TEST_ELECTRON=1` (`DS_TEST_ELECTRON` alone no longer runs them). Set neither unless the owner asks.
7. An app passes when every gate its registry entry marks required passes: `lint` (`lint:apps`), `verify` (`verify:apps`), `tests` (`test:apps`), `snapshot` and `pixelDiff` (`snapshot`, then `snapshot:diff --exact`). A gate marked n/a states its reason in the entry. Screenshots and results go to `--out-dir` (default `$DS_RUN`, else `<tmpdir>/ds-rollout`), never into a git checkout.

## Commands

Run in `/Users/Ford/workspace/design-system`. `--root` is the workspace to check. It defaults to the folder that holds this checkout. `app...` defaults to every app in `apps.json` (`test:apps` needs at least one app).

| Command | Use |
| --- | --- |
| `bun run build` | Validate tokens and regenerate `dist/` and `guide/tokens.md`. |
| `bun run check` | Exit 1 when `dist/` is stale. |
| `bun run test` | Run the tests. |
| `bun run registry:check [--root <dir>]` | Check `apps.json` against the workspace: paths, ports, allowlists, fixtures. |
| `bun run lint:apps [--root <dir>] [--pass <n>] [app...]` | Static conformance: resolution, wiring, literals, names (pass 1), shell (pass 2), structure (pass 3). One line per violation. `--json` for scripts. |
| `bun run verify:apps [--root <dir>] [--pass <n>] [app...]` | Runtime check in a browser under each app's run profile. Run mode `none` gets a static check. The probes must cover page, panel, text and border. `--propagate --root <dir>` rebuilds with a sentinel page color and checks that live-linked apps paint it. `--restore --root <dir>` undoes an interrupted propagate. Both refuse `/Users/Ford/workspace`. |
| `bun run test:apps [--root <dir>] [--commands typecheck,build] [--no-tests] [--timeout <s>] [--json] app...` | Run an app's safe tests, and the named commands it sets (one it does not set is skipped), under its run profile and the sandbox, with a write check. Compares each result with `tests.baselines`. Writes `report.json` and one log per command under `--out-dir`. |
| `bun run use:app --app <id> [--root <dir>] [--out-dir <dir>]` | Use an app under its run profile: every route in each theme, its steps, the sidebar toggle and hovers. Never clicks a submit control, anything in a form, or a control named like a write. Writes a JSON log and screenshots to `<out-dir>/<app>/use-app/`. Exits 1 on a console error, a failed or unexpected blocked request, an isolation problem, or a failed or refused step. Run mode `none` exits 0 with nothing to run. |
| `bun run snapshot`, `snapshot:diff`, `snapshot:sheet` | Screenshot an app's routes in each theme (`--app <id> --set <name>`), pixel-diff two sets (`--a <set> --b <set>`), write a before/after sheet. `--exact` exits 1 on a changed pixel, a missing or unstable shot, a partial set without `--only`, or a set from two trees. |
| `bun run codemod:literals --app <id> propose` | Propose a token for every hard-coded literal in a mapping table. `apply --table <mapping.json>` changes only rows marked `"approve": "yes"`. |
| `bun run progress [--root <dir>]` | Write `progress.html` and `progress.md`: every app's pass status and literal count. "Literals removed" needs `--baseline-lint <lint:apps --json report>` from before the apps moved. |
| `bun run pack [--out <dir>]` | Pack a tgz for a vendored app (`--out ../<app>/vendor`, relative to this folder). Prints its path and its `tokens.css` sha256. Never overwrites a same-name tgz with different content (compared file by file after extraction): every repack of a changed build bumps the patch version first. A checkout outside `/Users/Ford/workspace` (the rollout mirror) refuses every destination inside it. Runs npm inside the sandbox, and refuses an `npm` or `node` found first on `PATH` in a folder you can write that is not `~/.nvm`. |
