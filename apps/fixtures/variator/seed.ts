/**
 * Seed a Variator data root with one open batch: two variations (copied from ./variations) and one
 * pinned note, so the review UI has a real screen to show. The variator run profile runs it before the
 * server starts:
 *
 *   cd <variator> && VARIATOR_DATA_ROOT={tmp}/variator-data bun --no-env-file <ds>/apps/fixtures/variator/seed.ts
 *
 * It drives Variator's own CLI (create_batch, add_variation, add_feedback) from the current directory,
 * so the data matches what the checked-out Variator writes. Variator stores absolute paths, so the seed
 * runs in each run's own temp dir instead of shipping a built data root. It skips the batch screenshots
 * (the review UI never shows them), so it needs no Chromium.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const dataRoot = process.env.VARIATOR_DATA_ROOT;
if (!dataRoot) throw new Error("set VARIATOR_DATA_ROOT to the data root to seed");
if (!existsSync("src/cli.ts")) throw new Error("run from the Variator checkout (src/cli.ts not found)");

function cli(command: string, args: Record<string, unknown>) {
  const run = Bun.spawnSync(["bun", "--no-env-file", "src/cli.ts", command, "--json", JSON.stringify(args)]);
  if (run.exitCode !== 0) throw new Error(`variator ${command} failed: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString());
}

const batch = cli("create_batch", {
  app: "sample-notes",
  page: "home",
  goal: "Find a calmer home layout for a notes app",
  directions: ["List and reader", "Card grid"],
});
for (const folder of batch.folders as Array<{ slug: string; path: string }>) {
  cpSync(join(import.meta.dir, "variations", folder.slug), folder.path, { recursive: true });
  cli("add_variation", { batchId: batch.batchId, slug: folder.slug, screenshots: false });
}
cli("add_feedback", {
  batchId: batch.batchId,
  variationId: batch.folders[0].variationId,
  note: "The list column feels wide. Try a narrower list.",
  selector: "nav",
});
console.log(`seeded ${dataRoot} with batch ${batch.batchId}`);
