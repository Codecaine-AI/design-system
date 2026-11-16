# Hill-Climb

How verify mode raises an app's design score one proven step at a time. The idea: an agent improves its work against a check that runs without a human. The check is `design:score`.

Run every command in the design-system checkout, `~/workspace/codebases/codecaine/core/design-system`. The app must answer at its base URL: `--base-url`, else the config's `baseUrl`. The scorer starts the app itself only when the config names a `registryApp` from `apps.json`. Run `bun run design:score --help` for every flag.

## What the Score Is

1. The scorer visits the pages, states, themes and viewports listed in the app's config, `design-score/apps/<id>.json`. `--list-pages` prints them. Never edit the config to raise a score.
2. Each check gives pass, warn, fail or n/a per page. The check ids are listed in each reference file.
3. A page score is the mean over its applicable checks of pass 1, warn 0.5 and fail 0, times 100. The app score is the mean of the page scores. Each area gets the same formula over its own checks.
4. `V-judge` is not run yet: it is n/a on every page. Check its rules by eye on the state screenshots, and report them `Not verified` otherwise.

## The Loop

1. **Baseline.** Run `bun run design:score --app <id> --label base`, then `--quick --label base-quick`. A quick run scores one theme at one viewport, so it scores higher: compare quick runs only with quick runs. If the app's lint, verify or tests fail before you start, stop and report that first.
2. **Pick.** Take the worst failing check: the most fail pages in the report's Checks table, then the cheapest fix (delete, native element, existing token, correct value, add). Ignore warns while any fail remains.
3. **Fix.** One root cause per step. Make the smallest change that fixes it, in the shared component or token if the same failure is on many pages. Use tokens only.
4. **Rerun.** Run `bun run design:score --app <id> --quick --label fix-<n>`, then `bun run design:score --compare <app>/base-quick <app>/fix-<n>`. Score the same pages as the baseline: `--pages <touched pages>` is for a fast look while you work, never for the keep-or-revert decision.
5. **Keep or revert.** Start each step from a tree with no other uncommitted edits, so `git diff` holds this step alone. Keep the change only if all three hold. Otherwise save the step with `git diff > step-<n>.patch`, reverse it with `git apply -R step-<n>.patch`, and pick the next check:
   - the overall score went up
   - no check that passed before now fails or warns, on any page or theme
   - `bun scripts/scan-literals.ts <app source dir>`, `bun run lint:apps <id>` and the app's tests still pass
6. **Commit the step** (locally, if the task allows commits) with the check id in the message. The kept run becomes the new quick baseline.
7. Go back to step 2.
8. **Finish.** After the last kept step, run a full `--label after` run and `--compare <app>/base <app>/after`. Only the full run counts.

## Stop Rules

Stop at the first of these:

1. **Target.** The target score is reached and no fail is left on any HIGH check. Default target: 90 overall, unless the user sets one.
2. **Cost cap.** 10 kept-or-reverted steps, or about 45 minutes, or the token budget the user gave, whichever comes first.
3. **Stuck.** Three steps in a row with no kept change.
4. **Needs the user.** The fix needs a new or changed token in the design system's `tokens/` (it changes every app), a product or copy decision, or a check you believe is wrong. Stop and ask. Do not work around it.

## Never Game the Score

1. Never edit the page list, states, rules, thresholds, `ignore`, `skip` or `motionAllow` to raise the score.
2. Never hide, `aria-hidden`, shrink or remove content to dodge a check.
3. Never add an ignore comment or a literal-floor bump.
4. Never call a check you could not run a pass. It is `Not verified`.

## What Counts as Evidence

Only a scorecard counts. Your own summary does not.

1. The run folder, `.design-score/<app>/<timestamp>-<label>/` with `scorecard.json` and `report.html`, written after your last UI edit. An older scorecard is stale.
2. The `--compare` output between the first `before` and the last kept run.
3. The screenshots and check output the scorecard links for each changed page and state.
4. A list of checks that did not run, marked `Not verified`, including every `V-judge` rule you did not inspect by eye.

## Comparing Runs

`bun run design:score --compare <a> <b>` takes two run folders, `<app>/<label>`, `<app>/latest` or `<app>/previous`. It prints both app scores and the delta (`knowledge-system: 78.6 → 85.3 (+6.7)`) and the path of an HTML compare page. The page shows:

1. Area and check scores for A and B, and the change, with fail and warn finding counts.
2. Per page, the checks whose status changed, such as `R-contrast fail→pass`. Any pass→fail or pass→warn here means revert.
3. The A and B state screenshots side by side, per theme and viewport.

Compare only runs of the same app on the same pages and design-system build. If the page list or rules changed between them, start a new baseline. The run exits 0 when it finished, 1 when a page errored and 2 on bad arguments or an app that does not answer. Fix a page error before you trust the score.

## Report

End with:

1. Before and after score, overall and per area.
2. The kept steps, one line each: check id, what changed, score change.
3. HIGH fails still open, and anything stopped under "Needs the user".
4. The scorecard path and the `Not verified` list.
