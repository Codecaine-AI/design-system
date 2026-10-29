/**
 * Every check fixture is a test: design-score/fixtures/<check-id>/bad.html must get fail (warn for a
 * warn-only check) with at least one finding, and good.html must pass. A check id with no fixture folder
 * is listed as missing (not a failure yet).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHECK_IDS } from "../scripts/design-score/checks";
import { expectedBad, fixtureIds, runFixture } from "../scripts/design-score/fixture";
import { DESIGN_SYSTEM_ROOT, workspaceRoot } from "../scripts/lib/registry";

const ids = fixtureIds(DESIGN_SYSTEM_ROOT);
const missing = CHECK_IDS.filter((id) => !ids.includes(id));
console.log(`design:score fixtures: ${ids.length} of ${CHECK_IDS.length} checks have one${missing.length ? `. Missing: ${missing.join(", ")}` : ""}`);

const skipBrowser = !!process.env.DS_SKIP_BROWSER;
if (skipBrowser) console.log(`design:score fixtures: DS_SKIP_BROWSER is set, so ${ids.length} fixtures are not run`);

describe.skipIf(skipBrowser)("design:score check fixtures", () => {
  const outRoot = mkdtempSync(join(tmpdir(), "ds-fixtures-"));
  afterAll(() => rmSync(outRoot, { recursive: true, force: true }));

  test("every fixture folder names a check", () => {
    for (const id of ids) expect(CHECK_IDS).toContain(id);
  });

  for (const id of ids) {
    test(`${id}: bad gets ${expectedBad(id)}, good passes`, async () => {
      const res = await runFixture(id, { designSystem: DESIGN_SYSTEM_ROOT, root: workspaceRoot(), outRoot, writeShots: false });
      const summary = (v: "good" | "bad") => {
        const r = res[v];
        return r ? { status: r.status, findings: r.findings.length > 0, errors: r.errors } : null;
      };
      expect(summary("bad")).toEqual({ status: expectedBad(id), findings: true, errors: [] });
      expect(summary("good")).toEqual({ status: "pass", findings: false, errors: [] });
    }, 120_000);
  }
});
