# Writing

Rule ids and checks: see the key at the top of `layout-and-alignment.md`. Most copy rules are judged by `V-judge` as a text-only pass over the page's extracted strings, not a screenshot. Before you change copy, list the strings that already exist and reuse their terms.

## Labels

| Rule | Example | Rule id | Check |
| --- | --- | --- | --- |
| Buttons start with a verb that names the action. Never `OK`, `Yes`, `No` or `Let's go!`. | `Save draft` | `copy-verb-first-buttons` | `V-judge` |
| An icon-only button is named for the action, not the glyph. | `Delete project`, not `Trash icon` | `copy-icon-name-is-action` | `R-axe` (present), `V-judge` (wording) |
| Toggles describe the ON state. Never start with `Don't`, `Disable` or `Hide`. | `Send read receipts` | `copy-toggle-on-state` | `V-judge` |
| Link text makes sense alone. No `Click here`; every `Learn more` says about what. | `Learn more about Sources` | `copy-descriptive-links` | `V-judge` |
| One capitalization per element type: sentence case. | `Start session` | `copy-capitalization-policy` | `V-judge` |

## Errors and Confirmations

| Rule | Example | Rule id | Check |
| --- | --- | --- | --- |
| Every error says what failed and how to fix it, next to the field that broke. | `Name is taken. Try another name.` | `copy-error-says-fix` | `V-judge` (trigger) |
| No blame, no `Oops`, no `Something went wrong`, no exclamation marks. | — | `copy-no-oops` | `V-judge` |
| A confirm title names the action and the object. Buttons are verb + object. Never `Are you sure?`. | `Delete 3 Sources?` / `Delete Sources` | `copy-confirm-dialog-shape`, `copy-verb-first-buttons` | `V-judge` |
| Show a known requirement as helper text before input, not only in the error. | `At least 8 characters` | `copy-requirements-before-input` | `V-judge` |
| Placeholders show a real example in the accepted format, never an instruction. | `jane@example.com` | `copy-placeholder-example` | `V-judge` |

## Empty States and Status

| Rule | Example | Rule id | Check |
| --- | --- | --- | --- |
| An empty state says what the place is, how to fill it, and offers one action. A filtered empty names the query and offers `Clear filters`. | `No Sources yet. Drop a file to add one.` | `copy-empty-state-forward` | `V-judge` |
| In progress: `-ing` + object + `…`. Done: object + past tense. A partial result gives both counts. | `Saving draft…`, `Draft saved`, `8 of 10 imported` | `copy-status-parallel` | `V-judge` |
| Cut `successfully` and routine `Please`. | `Saved`, not `Saved successfully` | `copy-no-successfully-please` | `V-judge` |

## Voice and Terms

| Rule | Example | Rule id | Check |
| --- | --- | --- | --- |
| One name per object and per action across the app. One forward label through a flow. | `Archive` everywhere, not `Move to storage` in the toast | `copy-consistent-terms`, `copy-flow-vocabulary` | `V-judge` |
| Address the reader as `you`, never `the user`. Avoid `we` in errors. | — | `copy-address-reader` | `V-judge` |
| Plain words a tired reader gets on the first pass. No idioms. | — | `copy-plain-words` | `V-judge` |
| Build sentences whole. No string fragments around a variable, no hand-rolled plurals. | `{count, plural, one {# Source} other {# Sources}}` | `copy-whole-strings` | — |
| Numbers, dates and relative times go through `Intl`. | — | `copy-intl-formatting` | — |

---

Adapted from Jakub Krehel's skills (`better-writing`) and Interfaces Magazine issue 19. Skills text: Copyright (c) 2026 Jakub Krehel, MIT License, full notice in `../LICENSE-jakub-krehel`.
