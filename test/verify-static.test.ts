/**
 * Run mode none: verify:apps resolves the package from the app the way node would and follows the
 * entry stylesheet's active imports to the package's tokens.css, never starts anything, and says the
 * app is not runtime-verified. The CLI runs this static check for every mode-none app, also when the
 * registry marks the runtime verify gate n/a.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEntry, DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import { packageCheck, staticCheck } from "../scripts/lib/verify/static-check.ts";
import { loadBuildValues } from "../scripts/lib/verify/tokens.ts";

const values = loadBuildValues(DESIGN_SYSTEM_ROOT);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-static-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const IMPORT = '@import "@codecaine-ai/design-system/tokens.css";';

/** A root with app/ linking the package from `packageDir`, and an entry stylesheet with `css`. */
function rootWith(packageDir: (root: string) => string, css: string): string {
  const root = mkdtempSync(join(scratch, "root-"));
  const pkg = packageDir(root);
  mkdirSync(join(pkg, "dist/css"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@codecaine-ai/design-system", exports: { "./tokens.css": "./dist/css/tokens.css", "./package.json": "./package.json" } }),
  );
  cpSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css"), join(pkg, "dist/css/tokens.css"));
  mkdirSync(join(root, "app/node_modules/@codecaine-ai"), { recursive: true });
  mkdirSync(join(root, "app/src"));
  writeFileSync(join(root, "app/package.json"), "{}");
  symlinkSync(pkg, join(root, "app/node_modules/@codecaine-ai/design-system"));
  writeFileSync(join(root, "app/src/index.css"), css);
  return root;
}
const inRoot = (root: string) => join(root, "design-system");

const app = {
  id: "lib",
  root: "app",
  entryStylesheet: "app/src/index.css",
  theme: { rule: "light-dark" },
  consume: { via: "workspace" },
  run: { mode: "none", reason: "a library" },
} as AppEntry;
const statuses = (root: string) => Object.fromEntries(staticCheck(app, root, values).map((a) => [a.id, [a.status, a.message]]));

test("a package inside the root with the current tokens.css, and a stylesheet that loads it, pass; the app is not runtime-verified", () => {
  const found = statuses(rootWith(inRoot, IMPORT));
  expect(found).toEqual({
    runtime: ["n/a", "not runtime-verified: run mode none (a library)"],
    package: ["pass", expect.any(String)],
    "entry-stylesheet": ["pass", expect.stringMatching(/loads dist\/css\/tokens\.css/)],
  });
});

test("a package linked from outside the root, and a stylesheet without the tokens, fail", () => {
  const found = statuses(rootWith(() => mkdtempSync(join(scratch, "outside-")), "body { color: #333; }"));
  expect(found.package).toEqual(["fail", expect.stringMatching(/is outside the root/)]);
  expect(found["entry-stylesheet"]).toEqual(["fail", expect.stringMatching(/does not load tokens\.css/)]);
});

test("an import inside a comment does not load the tokens; a stale tokens.css in the package fails", () => {
  expect(statuses(rootWith(inRoot, `/* ${IMPORT} */\nbody { margin: 0; }`))["entry-stylesheet"]).toEqual([
    "fail",
    expect.stringMatching(/does not load tokens\.css \(an import inside a comment does not count\)/),
  ]);
  const stale = rootWith(inRoot, IMPORT);
  writeFileSync(join(stale, "design-system/dist/css/tokens.css"), `${readFileSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css"), "utf8")}\n/* stale */\n`);
  const found = statuses(stale);
  expect(found.package).toEqual(["fail", expect.stringMatching(/differs from the current build/)]);
  expect(found["entry-stylesheet"]).toEqual(["fail", expect.stringMatching(/differs from the current build's dist\/css\/tokens\.css/)]);
});

test("verify:apps runs the static check for a mode-none app whose verify gate is n/a, and fails it on a commented-out import", () => {
  const run = (css: string) => {
    const root = rootWith(inRoot, css);
    const out = mkdtempSync(join(scratch, "out-"));
    const registry = join(root, "apps.json");
    const gateNa = { required: false, reason: "a library: nothing to start" };
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [{ ...app, name: "lib", gates: { verify: gateNa } }] }));
    const result = Bun.spawnSync([process.execPath, "scripts/verify-apps.ts", "--root", root, "--out-dir", out, "--registry", registry, "lib"], {
      cwd: DESIGN_SYSTEM_ROOT,
      env: { ...process.env, DS_RUN: out },
    });
    const dir = join(out, "lib/verify");
    const report = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8"));
    return { code: result.exitCode, assertions: Object.fromEntries(report.assertions.map((a: any) => [a.id, a.status])) };
  };
  expect(run(IMPORT)).toEqual({ code: 0, assertions: { runtime: "n/a", package: "pass", "entry-stylesheet": "pass", gate: "n/a" } });
  expect(run(`/* ${IMPORT} */`)).toEqual({ code: 1, assertions: { runtime: "n/a", package: "pass", "entry-stylesheet": "fail", gate: "n/a" } });
});

test("packageCheck, which every run mode applies: relative-import follows the stylesheet to the package, copy checks the copied file, host-css is n/a", () => {
  const root = rootWith(inRoot, IMPORT);
  const status = (over: Partial<AppEntry>) => packageCheck({ ...app, ...over } as AppEntry, root, values).assertions.map((a) => [a.id, a.status, a.message]);

  writeFileSync(join(root, "app/src/relative.css"), '@import "../../design-system/dist/css/tokens.css";');
  const relative = packageCheck({ ...app, consume: { via: "relative-import", detail: "" }, entryStylesheet: "app/src/relative.css" } as AppEntry, root, values);
  expect([relative.dir, relative.assertions[0]!.status]).toEqual([realpathSync(join(root, "design-system")), "pass"]);

  mkdirSync(join(root, "app/vendor"));
  cpSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css"), join(root, "app/vendor/tokens.css"));
  writeFileSync(join(root, "app/src/copied.css"), '@import "../vendor/tokens.css";');
  const copy = { consume: { via: "copy", detail: "" }, entryStylesheet: "app/src/copied.css" } as Partial<AppEntry>;
  expect(status(copy)).toEqual([["package", "pass", expect.stringContaining("match the current build's dist/css/tokens.css")]]);
  writeFileSync(join(root, "app/vendor/tokens.css"), `${readFileSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css"), "utf8")}\n.stale {}\n`);
  expect(status(copy)).toEqual([["package", "fail", expect.stringContaining("differ from the current build's dist/css/tokens.css")]]);

  expect(status({ consume: { via: "host-css", detail: "" }, entryStylesheet: null })).toEqual([["package", "n/a", expect.stringContaining("host-css")]]);
});
