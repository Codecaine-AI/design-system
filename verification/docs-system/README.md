# docs-system screenshot harness

This harness proves that the docs-system web UI renders pixel-identical after its CSS moves onto design-system tokens. `before/` holds today's look as 30 PNGs. After the migration, capture `after/` and diff it against `before/`. The expected result is 0 changed pixels in every shot.

## Check the migration

```bash
cd /Users/Ford/workspace/codebases/design-system/verification/docs-system
bun snapshot.ts --out after        # about 1.5 min; starts and stops its own servers
bun diff.ts --a before --b after   # exit 0 = every shot identical
```

1. Read `diff-before-vs-after/report.json`. Per shot it gives size match, changed pixels, percent changed, max channel delta and a bounding box.
2. For each `DIFF` line, open `compare-before-vs-after/<key>.png`. It shows A, B and the diff side by side. Changed pixels are magenta, with a red box around them.
3. To iterate on one view, run `bun snapshot.ts --out after --only docs-callout-tones`, then `bun diff.ts --a before --b after --only docs-callout-tones`.

Ports 4870 to 4873 must be free. Nothing needs installing: Playwright resolves from Core (`packages/docs-workbench` depends on it), and the browsers come from `~/Library/Caches/ms-playwright`.

## What one run does

1. Verifies the checksum of `fixtures/frozen-inputs.tar.gz` and extracts it into `/tmp/ds-verify-docs-system`. The folder is deleted at the end of the run.
2. Per corpus, starts an isolated `docs-cli serve --dev`, then warms vite up. Dev mode means CSS edits apply without a rebuild.
3. Captures each shot in a fresh browser context to `<out>/<key>.png`.
4. Stops both servers and checks that their ports are released, then writes `<out>/manifest.json`.

The manifest records:

- Playwright and Chromium versions.
- The docs-system HEAD and its `git status`, so the AFTER manifest lists the migration's changes.
- The fixture checksum.
- Per shot: frames until stable, retries, blocked writes, blocked external requests and console errors.

## Server command

`lib/server.ts` runs this from `/Users/Ford/workspace/codebases/codecaine/core/docs-system`, with `S=/tmp/ds-verify-docs-system`:

```bash
CODECAINE_DOCS_STATE_DIR=$S/state \
CODECAINE_DOCS_GLOBAL_THEMES=$S/state/themes \
CODECAINE_DOCS_CODE_THEMES=$S/state/code-themes \
bun packages/docs-cli/src/index.ts serve --standalone \
  --root $S/corpora/<docs-system|workspace>/docs --themes-root $S/repo-themes \
  --dev --port <4870|4872> --ui-port <4871|4873> --kernel-url http://127.0.0.1:4879
```

The child environment drops `DOCS_SHARED_API_*`, `DOCS_STATIC` and `DOCS_API`. It pins `CANVAS_STUDIO_URL` and `SEQUENCE_STUDIO_URL` to their defaults, because both are build-time defines.

`--standalone` is not in the usage text, but `index.ts` reads it. Without it, `runServe` hands off to the installed central service whenever `background.json` exists.

## State isolation

| Live state | Harness uses | Mechanism |
| --- | --- | --- |
| `~/.local/state/codecaine-docs` (global theme, code themes) | A copy in `$S/state` | `CODECAINE_DOCS_STATE_DIR`, `CODECAINE_DOCS_GLOBAL_THEMES`, `CODECAINE_DOCS_CODE_THEMES` |
| The central docs service | Not used | `--standalone`; the copy also has no `background.json` |
| `docs-system/themes` | `$S/repo-themes` | `--themes-root` |
| Both docs corpora | `$S/corpora/*/docs` | `--root`; the backlinks index (`.index/`) is written into the copy |
| Docs kernel on `127.0.0.1:4840` | Dead port 4879 | `--kernel-url`; the browser also aborts every request to it |

The browser adds three more guards:

- It answers every non-GET `/api` request with 403 and logs it. The final runs logged none.
- It aborts every request to a non-loopback host.
- Each shot gets a fresh context, so localStorage writes (rail state, theme cache) are discarded with it.

Vite still writes its usual dependency cache to `packages/docs-workbench/node_modules/.vite` in Core. Nothing else under `codecaine/` is written.

## Frozen inputs

`fixtures/frozen-inputs.tar.gz` holds 433 files, listed with hashes in `fixtures/frozen-inputs.json`. `freeze.ts` built it on 2026-10-05 by copying these sources:

- The docs-system corpus at HEAD `2efb0c1`, with `docs/` clean.
- The workspace corpus `/Users/Ford/workspace/docs`, including its uncommitted edits.
- The global page theme and the active code theme from `~/.local/state/codecaine-docs`. Only `themes/` and `code-themes/` are copied; tokens and daemon files are not.
- `docs-system/themes`.

Because the inputs are frozen, later edits to the live docs never show up as a diff. Running `bun freeze.ts --force` replaces the fixture; after that, BEFORE must be captured again from unmigrated code.

The playground is an exception. It bundles `docs-system/docs/**/doc.json` from the live checkout through `import.meta.glob`, not from the fixture. Leave `docs-system/docs` unchanged during the migration.

## Light and dark

The app does not read `prefers-color-scheme`, so color-scheme emulation has no effect. Under the shared global theme, the boot code in `App.tsx` (lines 333 to 385) takes `dark` from `manifest.dark` in the `GET /api/themes/global` response. `applyTheme` (line 206) then toggles the `.dark` class and `data-theme`.

The harness rewrites `manifest.dark` in that response for each shot. This is the value the rail's dark-mode switch would save, but nothing is saved. The capture checks `html[data-theme]` before it shoots.

Each playground shot is one image that holds both halves. The playground renders them itself as `?theme=light` and `?theme=dark` iframes.

## Determinism

Fixed settings:

- Browser context: 1440×900, `deviceScaleFactor` 1, `reducedMotion: "reduce"`, locale `en-US`, timezone UTC.
- Screenshots: `animations: "disabled"`, `caret: "hide"`.
- Chromium flags (`LAUNCH_OPTIONS` in `lib/capture.ts`): `--disable-gpu --force-color-profile=srgb --disable-partial-raster --disable-skia-runtime-opts --run-all-compositor-stages-before-draw --disable-checker-imaging --disable-threaded-animation --disable-threaded-scrolling`. Without these flags, anti-aliased rounded corners differed by ±1 per channel between runs. Scrollbars stay visible because the theme styles them.
- Injected CSS (`DETERMINISM_CSS`): sets transition and animation durations to 0 s. Without it, the peek drawer's 300 ms width transition left sub-pixel scrollbar differences.

Before each shot, the harness waits for:

- The theme: the rail toggle, the theme CSS and `data-theme` are all in place.
- The docs tree to load.
- The page transition to reach idle.
- Network quiet. The open SSE stream does not count.
- Every bundled font to load in every frame, and every visible image to decode.
- A 400 ms settle.

It then shoots until two frames taken 250 ms apart are byte-identical, up to 12 frames. A shot that never settles fails the run.

Results:

- `before` and `before-repeat` are separate runs with a server restart between them. They match 30 of 30 with 0 changed pixels (`diff-before-vs-before-repeat/report.json`).
- Two later full runs with the final code also matched `before` exactly.
- A stress test captured every shot 4 to 6 times in one browser session, and every capture was byte-identical.
- Tiny injected CSS changes do register. A callout radius of 1 px instead of 2 px changed 30 pixels, and a 0.001em letter-spacing changed 20,663 pixels.

## Shots

There are 18 views and 30 PNGs. Docs views are captured light and dark (`<id>-light.png`, `<id>-dark.png`). Playground shots hold both halves in one image (`<id>.png`). Unless a view gives another scroll position, it is captured at the top of the page.

| id | Server | View | Covers |
| --- | --- | --- | --- |
| `playground-file-tree` | docs-system | `/playground.html` | Default playground view: file-tree block, registry defaults |
| `playground-callout` | docs-system | playground, `14-callout`, `callout` | Callouts of every tone and variant |
| `playground-process-outline` | docs-system | playground, `10-process-outline` | Process-outline: guides, notes, keywords |
| `playground-interaction-surface` | docs-system | playground, `20-interaction-surface` | Interaction-surface rows and signature tokens |
| `playground-call-stack` | docs-system | playground, `30-call-stack` | Call-stack frames, branches, comment column |
| `playground-stack` | docs-system | playground, `30-stack` | Stack layers, boundaries, uses arrows |
| `docs-callout-tones` | docs-system | `14-callout` | App shell (sidebar tree, header, collapsed rail), title, prose, every callout tone |
| `docs-visual-system-themes` | docs-system | `40-visual-system/30-themes`, scrolled 250 px | File-tree block, structured table, headings, bullet list |
| `docs-canvas-embed` | docs-system | `50-canvas`, scrolled 700 px | Canvas embed, doc reference chip, state-shape |
| `docs-sequence-and-code` | docs-system | `40-sequence`, scrolled 600 px | Sequence embed card, code block with gutter, state-shape |
| `workspace-entity-model` | workspace | `specs/30-knowledge-system/30-entity-model` | Workspace sidebar tree, note callout, table |
| `workspace-full-send-loop` | workspace | `40-full-send-and-babysit-skills`, scrolled 4300 px | Process-outline in the app theme, titled warning callout |
| `workspace-html-panel` | workspace | `50-theo-agent-fleet-reference`, scrolled 200 px | Titled info callout, html panel head (artifact masked) |
| `chrome-style-rail` | docs-system | `14-callout`, rail open on Colors | Style rail: dark-mode switch, swatches, nav, footer buttons |
| `chrome-annotate-panel` | docs-system | `14-callout` | Glass AI panel, targeting ring, inline composer |
| `chrome-export-dialog` | docs-system | `14-callout` | Export dialog over the dimmed page |
| `chrome-side-peek` | docs-system | `00-foundation` | Side peek drawer showing the Manifesto |
| `chrome-link-editor` | docs-system | `14-callout` | Editor link popover (Cmd+K) over a word selection |

Every chrome state opens without a write. The rail is read only, and no control is touched. The composer files nothing until Enter. The export dialog does no work until its Export button. The link popover changes nothing until a link is applied.

## Masks and pins

| Shot | Change | Reason |
| --- | --- | --- |
| `workspace-html-panel` | Mask over `[data-docs-block-type="html"] dialog` (magenta box) | The sandboxed iframe measures its own content and the panel scales it to fit. That measure races the frame's layout, so the scaled artifact and the panel height (604 or 659 px) differ between loads. The panel head, border and everything above it are still compared. |
| `chrome-annotate-panel` | Scroll pinned to 0 after the composer opens | Depending on layout timing, the composer's `textarea.focus()` sometimes scrolls the page about 80 px to center it. |
| `chrome-side-peek` | Opens the peek by dispatching `spectre:doc-reference-navigate` | This is the same event a click on the Manifesto chip sends. A real click left the drag grip and the chip's selection highlight in the shot. |

There are no other masks. No relative times or random ids appear on screen. Dates in the annotation panel use `toLocaleString`, which the fixed locale and timezone pin.

## Not covered

- **Search or command palette:** the app has none, with no Cmd+K palette and no sidebar search. `chrome-link-editor` covers the only Cmd+K surface.
- **Slash menu and `@` picker:** both open only after typing, which dirties the doc and sends draft-lock and autosave POSTs.
- **A rendered sequence diagram:** the corpus has one sequence embed, and today it shows "Sequence failed to load" because its `src` is bundle-relative. That card is what the shot captures. The playground has no embed provider.
- **The html artifact:** its content is masked, and nothing below an html block is captured.
- **Other surfaces:**
  - Hover-only affordances (block grip, chip tooltip).
  - Full-screen canvas, sequence and image viewers.
  - The static export site and the Electron app.

## Gotchas for the migration

- **Vite file access:** if docs-system imports CSS from `/Users/Ford/workspace/codebases/design-system`, vite dev will likely refuse to serve it. `server.fs.allow` in `web/vite.config.ts` (line 56) covers only `codecaine/core` and the text-measure fonts. Add the path, or link the package inside the workspace. Otherwise AFTER renders unstyled.
- **Selectors:** when a step selector stops matching, the shot fails with a timeout rather than a wrong image. Steps use data attributes and ARIA labels, not CSS classes, so renaming classes does not break them.
- **The baseline is not in git:** the repo `.gitignore` ignores `verification/**/*.png`. Because of this, `before*` sets refuse to be overwritten without `--force`. BEFORE was captured from docs-system HEAD `2efb0c1` with no changes under `packages/`.

## Files

| Path | Purpose |
| --- | --- |
| `shots.json` | Shot list: id, server, url, themes, rail state, waits, steps, masks |
| `snapshot.ts` | Capture CLI |
| `diff.ts` | Diff CLI; exact RGBA compare through the dependency-free PNG codec in `lib/png.ts` |
| `freeze.ts` | Builds the fixture; refuses to overwrite it without `--force` |
| `lib/` | Capture, server lifecycle, shot schema, PNG codec, paths |
| `fixtures/` | Frozen inputs and their manifest |
| `before/`, `before-repeat/` | The baseline and the determinism run |
| `diff-before-vs-before-repeat/`, `compare-before-vs-before-repeat/` | Determinism evidence |
| `mapping.md` | Owned by the token-mapping worker, not by this harness |
