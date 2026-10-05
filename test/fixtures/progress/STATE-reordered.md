# Rollout state (fixture, reordered)

## app_ledger

The same rows as STATE.md, with the columns moved, "workers" dropped and a column the parser does not know.

| p3 | literals | id | blocked reason → owner action | notes | rounds | p1 | wave | branch | repo (mirror path) | p2 | depends on | base | start |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| todo | 120 / 4 | alpha | | pilot app | 3 | done | 1 | design-system/alpha | repos/alpha | done | tooling (pilot 1) | main@aaaaaaa | 2026-10-05 |
| todo | 60 / – | beta | | | 1 | working | 1 | design-system/beta | repos/beta | todo | alpha | main@bbbbbbb | |
| blocked | 39 / – | gamma | Uncommitted `package.json` (version 0.1.0 → 0.0.1) → commit or revert it | | 2 | blocked | 1 | design-system/gamma | repos/gamma | n/a | pilot | main@ccccccc | |
| | | delta | | | | todo | 2 | design-system/delta | repos/delta | | pilot | main@ddddddd | |
| n/a | 10 / 7 | epsilon | | | – | review | 2 | design-system/epsilon | repos/epsilon | n/a | beta | main@eeeeeee | |
