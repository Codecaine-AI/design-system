# Design System
UI rules and app checks: the `design-system` skill. Token and app guide: the docs section `docs/30-guide`. Commands and app-check details: docs hub project `design-system-8d5003d8`, page `docs/20-app-checks-and-commands`.
Edit `tokens/`, never `dist/`. Then run `bun run build && bun run check && bun run test`.

## Test commands

Run every command from the design-system root. The repo has no CI workflow and no
typecheck script, so the commands below are the whole gate. Diff base for the
changed-files gate: `origin/main`.

### Tier 1: every agent change

| Check | Command |
| --- | --- |
| Build outputs current | `bun run check` |
| Typecheck | None. The repo has no `tsconfig.json`. |
| Lint | None for repo code. `bun run lint:apps` lints the registered apps, not this repo. |
| Focused tests on changed files | The command below |

```bash
{ git diff --name-only --diff-filter=d origin/main; git ls-files --others --exclude-standard; } \
  | grep -E '^test/.*\.test\.ts$' | sed 's#^#./#' | xargs -r bun test
```

- Keep the `./` prefix. Without it `bun test` treats a path as a name filter.
- `templates/` is its own app with its own dependencies. Run `bun test ./templates`
  only when you change it.

### Tier 2: before a PR

| Check | Command |
| --- | --- |
| Changed-files gate | None. Run the full suite: `bun run test` |
| Touched-area keeper tests | The keeper test files of each touched area, from the table below |
| Registry paths | `bun run registry:check` (needs the sibling core repos checked out) |

- `test:apps` and `verify:apps` drive real apps and need macOS. They are not
  part of the gate on Linux.

### Tier 3: before a release or a big merge

| Check | Command |
| --- | --- |
| Full suite | `bun run build && bun run check && bun run test` |
| Templates | `bun test ./templates` |
| Real apps (macOS only) | `bun run test:apps`, then `bun run verify:apps` |

### Product areas

There is no `e2e/` suite. Each area's keeper tests are the test files that drive
its CLI or entry point end to end.

| Area | Main contracts | Keeper tests | Source globs |
| --- | --- | --- | --- |
| Tokens and build | Token values, every dist output, Tailwind v3 preset, host contract, contrast | `test/build.test.ts`, `test/outputs.test.ts`, `test/host-contract.test.ts` | `tokens/**`, `scripts/build.ts`, `scripts/lib/{color,host-contract,tailwind-v3}.ts`, `css/**` |
| App lint | Literal, name, structure, wiring and shell checks over a registered app | `test/lint-cli.test.ts`, `test/lint-checks.test.ts` | `scripts/lint-apps.ts`, `scripts/scan-literals.ts`, `scripts/lib/lint/**` |
| App verify | Fonts, tokens, roles, propagation and page checks on a running app | `test/verify-page.test.ts`, `test/verify-propagate.test.ts`, `test/verify-fonts.test.ts` | `scripts/verify-apps.ts`, `scripts/lib/verify/**` |
| App runner and sandbox | Start, stop and confine an app run: ports, egress, signals, checkout guard | `test/app-runner.test.ts`, `test/sandbox.test.ts` | `scripts/lib/{app-runner,sandbox,egress,system-bin,checkouts,git,safe-paths,owner,output-dir}.ts` |
| Codemod | Literal-to-token rewrites | `test/codemod-literals.test.ts` | `scripts/codemod-literals.ts`, `scripts/lib/codemod/**` |
| Snapshots and capture | Capture, diff and sheet of app screens | `test/snapshot-diff.test.ts`, `test/png.test.ts` | `scripts/snapshot*.ts`, `scripts/lib/{capture,png,snapshot-set,playwright}.ts` |
| Design score | Static and browser checks, judge, fixtures | `test/design-score.test.ts`, `test/design-score-fixtures.test.ts` | `scripts/design-score/**`, `design-score/**` |
| Pack, registry and progress | Package tarball, registry paths, rollout progress | `test/pack.test.ts`, `test/registry-check.test.ts`, `test/progress.test.ts` | `scripts/{pack,registry-check,registry-prove,progress}.ts`, `scripts/lib/{registry,provenance}.ts`, `scripts/lib/progress/**`, `apps.json` |
| Use app and test apps | Point an app at the local package, run app test commands | `test/use-app.test.ts`, `test/test-apps.test.ts` | `scripts/{use-app,test-apps}.ts`, `scripts/lib/use-app/**` |

### Routing rules

- A change under a source glob runs that area's keeper tests and every test
  file that imports the changed module.
- A change to `test/support.ts`, `test/*-support.ts` or `test/fixtures/**` runs
  the full suite.
- A change to `tokens/**` also needs `bun run build`, and the `dist/` diff in the
  same commit.

### Platform

Most sandbox, signal and pack tests use macOS `sandbox-exec`, `lsof` and the user
database. On Linux they fail on main. They are not regressions there. Prove a
change to those modules on macOS.

### Quarantine

No tests are quarantined.

| Test | Owner | Expiry |
| --- | --- | --- |
