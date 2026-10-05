# Rollout state (fixture)

Current phase: **fixture**. The columns follow the real STATE.md.

## owner_snapshot

| id | Branch | HEAD |
| --- | --- | --- |
| alpha | main | 1111111 |

## app_ledger

Pass status: todo, working, review, done, blocked, n/a. Literals: audit baseline / now.

| id | wave | depends on | repo (mirror path) | branch | base | start | workers | p1 | p2 | p3 | literals | rounds | blocked reason → owner action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| alpha | 1 | tooling (pilot 1) | repos/alpha | design-system/alpha | main@aaaaaaa | 2026-10-05 | w1 | done | done | todo | 120 / 4 | 3 | |
| beta | 1 | alpha | repos/beta | design-system/beta | main@bbbbbbb | | | working | todo | todo | 60 / – | 1 | |
| gamma | 1 | pilot | repos/gamma | design-system/gamma | main@ccccccc | | | blocked | n/a | blocked | 39 / – | 2 | Uncommitted `package.json` (version 0.1.0 → 0.0.1) → commit or revert it |
| delta | 2 | pilot | repos/delta | design-system/delta | main@ddddddd | | | todo |
| epsilon | 2 | beta | repos/epsilon | design-system/epsilon | main@eeeeeee | | | review | n/a | n/a | 10 / 7 | – | |

Every app also depends on the tooling unit.

## open_findings

| id | unit | finding |
| --- | --- | --- |
| alpha | linter | a table after the ledger that also has an id column |
