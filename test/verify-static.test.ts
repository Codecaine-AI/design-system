/**
 * Run mode none: verify:apps resolves the package from the app the way node would and reads the entry
 * stylesheet, never starts anything, and says the app is not runtime-verified.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEntry, DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { staticCheck } from "../scripts/lib/verify/static-check.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";

const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-static-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A root with app/ linking the package from `packageDir`, and an entry stylesheet with `css`. */
function rootWith(packageDir: (root: string) => string, css: string): string {
  const root = mkdtempSync(join(scratch, "root-"));
  const pkg = packageDir(root);
  mkdirSync(join(pkg, "dist/css"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@codecaine-ai/design-system", exports: { "./package.json": "./package.json" } }));
  cpSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css"), join(pkg, "dist/css/tokens.css"));
  mkdirSync(join(root, "app/node_modules/@codecaine-ai"), { recursive: true });
  mkdirSync(join(root, "app/src"));
  writeFileSync(join(root, "app/package.json"), "{}");
  symlinkSync(pkg, join(root, "app/node_modules/@codecaine-ai/design-system"));
  writeFileSync(join(root, "app/src/index.css"), css);
  return root;
}

const app = { id: "lib", root: "app", entryStylesheet: "app/src/index.css", consume: { via: "workspace" }, run: { mode: "none", reason: "a library" } } as AppEntry;
const statuses = (root: string) => Object.fromEntries(staticCheck(app, root, values).map((a) => [a.id, [a.status, a.message]]));

test("a package inside the root with the current tokens.css, and a stylesheet that loads it, pass; the app is not runtime-verified", () => {
  const found = statuses(rootWith((root) => join(root, "design-system"), '@import "@codecaine-ai/design-system/tokens.css";'));
  expect(found).toEqual({
    runtime: ["n/a", "not runtime-verified: run mode none (a library)"],
    package: ["pass", expect.any(String)],
    "entry-stylesheet": ["pass", expect.any(String)],
  });
});

test("a package linked from outside the root, and a stylesheet without the tokens, fail", () => {
  const found = statuses(rootWith(() => mkdtempSync(join(scratch, "outside-")), "body { color: #333; }"));
  expect(found.package).toEqual(["fail", expect.stringMatching(/resolves outside the root/)]);
  expect(found["entry-stylesheet"]).toEqual(["fail", expect.stringMatching(/does not load tokens\.css/)]);
});
