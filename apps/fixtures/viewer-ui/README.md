# viewer-ui trace fixture

The `viewer-ui` run profile renders agent-kernel's trace viewer in its host, the simple-research-kernel frontend, over one canned trace. No agent-kernel API runs and nothing is written.

## Files

- `serve.ts` is the launcher the profile starts (`run.start`). It opens `<tmp>/model-nodes-demo.db` read-only, serves the kernel's own trace read API over it on `--api-port` (GET and HEAD only, 405 otherwise), and runs the example's Vite dev server on `--ui-port` with `API_TARGET` at that API.
- `model-nodes-demo.db` is the trace. The run profile copies it into the run's temp dir (`runProfile.fixtures`).

## The trace

The DB is agent-kernel's model-nodes demo: one worker job with calls, decisions, steps, a gate, nested tools, an abstain, a failed call and retries. Its story and ids are in agent-kernel's `examples/simple-research-kernel/scripts/model-nodes-demo/README.md`.

The routes in `apps.json` click and wait on tree rows by `data-span-id` and on detail blocks by `data-detail-block`. The ids come from the generator's `routes.json` (`routeTargets`).

## Regenerate the DB

Regenerate only when the generator changes. From the agent-kernel repo root, with `<DS>` this design-system checkout:

```bash
# confirm the committed fixture JSON and routes.json match the generator (writes nothing)
bun examples/simple-research-kernel/scripts/model-nodes-demo/generate-fixture.ts --check

# write the DB; --json and --routes keep the copies it also writes out of the agent-kernel checkout
bun examples/simple-research-kernel/scripts/model-nodes-demo/generate-fixture.ts \
  --json /tmp/mn-fixture.json --routes /tmp/mn-routes.json \
  --db <DS>/apps/fixtures/viewer-ui/model-nodes-demo.db --journal-mode delete
```

The output is byte-identical across runs. `--journal-mode delete` matters: a WAL database cannot be opened read-only without its `-shm` file.

Then compare `routes.json`'s `routeTargets` with the route selectors in the `viewer-ui` entry, and run:

```bash
bun test ./test/fixture-viewer-ui.test.ts
bun run registry:check
```

The test's API cases read the workspace's agent-kernel sources. In a worktree outside the workspace, set `DS_MIRROR` to the workspace root.
