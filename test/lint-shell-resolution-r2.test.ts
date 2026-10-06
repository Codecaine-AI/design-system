/**
 * Round-2 fixes to the shell and resolution checks (scripts/lib/lint/shell.ts, resolution.ts):
 * - N11: shell parts a module passes into the shell's slots count; a static-only app
 *   (run.mode none) must render its shell, not only import it.
 * - N14: a vendored tgz and its installed copy match the build in every file the app loads
 *   (plus the fonts when fonts.css loads); a copied app's every copied file matches too.
 * - N1: a design-system load from a file outside the package is a violation.
 * Shell fixtures: test/fixtures/lint/workspace/apps/r2h-*. The vendored and copied apps
 * (apps/r2r-*) are built here from this checkout's real build files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { loadDesignSystem, type DesignSystemBuild } from "../scripts/lib/lint/design-system";
import type { Finding } from "../scripts/lib/lint/types";
import type { AppEntry } from "../scripts/lib/registry";
import { appEntry, checkEntry, materialize, STALE_SUFFIX, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;
let ds: DesignSystemBuild;

const PACKAGE = "@codecaine-ai/design-system";
const FONT_FILES = readdirSync(join(PKG, "fonts")).sort();
/** What a vendored app whose entry loads fonts.css, tokens.css and layout.css ships. */
const SHIPPED = ["dist/css/tokens.css", "css/fonts.css", "css/layout.css", ...FONT_FILES.map((f) => `fonts/${f}`)];
const FAKE_PACKAGE_JSON = JSON.stringify({
  name: PACKAGE,
  exports: { "./fonts.css": "./css/fonts.css", "./tokens.css": "./dist/css/tokens.css", "./layout.css": "./css/layout.css" },
});

const build = (member: string) => readFileSync(join(PKG, member));
const stale = (member: string) => Buffer.concat([build(member), Buffer.from(STALE_SUFFIX)]);
const short = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 12);

const write = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};

/** The shipped files with some replaced (a Buffer) or left out (null). */
function shipped(edits: Record<string, Buffer | null> = {}): Map<string, Buffer> {
  const files = new Map(SHIPPED.map((m) => [m, build(m)] as const));
  for (const [m, data] of Object.entries(edits)) {
    if (data === null) files.delete(m);
    else files.set(m, data);
  }
  return files;
}

/** apps/<name>: a vendor-tgz app whose src/index.css loads fonts.css, tokens.css and layout.css. */
function vendoredApp(name: string, edits: { tgz?: Record<string, Buffer | null>; installed?: Record<string, Buffer | null> } = {}) {
  const dir = join(ws.root, "apps", name);
  write(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { [PACKAGE]: "file:vendor/design-system.tgz" } }, null, 2));
  write(join(dir, "src/index.css"), `@import "${PACKAGE}/fonts.css";\n@import "${PACKAGE}/tokens.css";\n@import "${PACKAGE}/layout.css";\n`);
  const staging = join(ws.root, `.pack-${name}`);
  write(join(staging, "package/package.json"), FAKE_PACKAGE_JSON);
  for (const [m, data] of shipped(edits.tgz)) write(join(staging, "package", m), data);
  mkdirSync(join(dir, "vendor"), { recursive: true });
  const tar = Bun.spawnSync(["tar", "-czf", join(dir, "vendor/design-system.tgz"), "-C", staging, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  rmSync(staging, { recursive: true, force: true });
  const installed = join(dir, "node_modules", PACKAGE);
  write(join(installed, "package.json"), FAKE_PACKAGE_JSON);
  for (const [m, data] of shipped(edits.installed)) write(join(installed, m), data);
}

/** apps/<name>: a consume.via copy app with ds/<copies> and the fonts beside them in fonts/. */
function copiedApp(name: string, copies: Record<string, Buffer>, fonts: Map<string, Buffer> = new Map()) {
  const dir = join(ws.root, "apps", name);
  for (const [file, data] of Object.entries(copies)) write(join(dir, "ds", file), data);
  for (const [file, data] of fonts) write(join(dir, "fonts", file), data);
  write(join(dir, "src/index.css"), Object.keys(copies).map((f) => `@import "../ds/${f}";\n`).join(""));
}

const fontsOnly = (edits: Record<string, Buffer | null> = {}) =>
  new Map([...shipped(edits)].filter(([m]) => m.startsWith("fonts/")).map(([m, data]) => [m.slice("fonts/".length), data] as const));

beforeAll(() => {
  ws = materialize();
  ds = loadDesignSystem();

  // A template copy that App.tsx imports but never renders.
  const unrendered = join(ws.root, "apps/r2h-template-unrendered/src");
  cpSync(join(PKG, "templates/react-app-shell/src/_components/AppShell"), join(unrendered, "_components/AppShell"), {
    recursive: true,
    filter: (src) => !/\.(test|spec)\.[jt]sx?$/.test(src),
  });
  write(join(unrendered, "App.tsx"), 'import { AppShell } from "./_components/AppShell";\n\nvoid AppShell;\n\nexport function App() {\n  return <main>no shell</main>;\n}\n');
  write(join(unrendered, "main.tsx"), 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n');

  vendoredApp("r2r-vendored");
  vendoredApp("r2r-tgz-stale-layout", { tgz: { "css/layout.css": stale("css/layout.css") } });
  vendoredApp("r2r-tgz-no-layout", { tgz: { "css/layout.css": null } });
  vendoredApp("r2r-installed-stale-font", { installed: { "fonts/Inter-Regular.woff2": stale("fonts/Inter-Regular.woff2") } });

  copiedApp("r2r-copied-ok", { "fonts.css": build("css/fonts.css"), "tokens.css": build("dist/css/tokens.css"), "layout.css": build("css/layout.css") }, fontsOnly());
  copiedApp("r2r-copied-stale-layout", { "tokens.css": build("dist/css/tokens.css"), "layout.css": stale("css/layout.css") });
  copiedApp(
    "r2r-copied-stale-font",
    { "fonts.css": build("css/fonts.css"), "tokens.css": build("dist/css/tokens.css") },
    fontsOnly({ "fonts/Inter-Bold.woff2": stale("fonts/Inter-Bold.woff2"), "fonts/IBMPlexMono-Medium.woff2": null }),
  );

  // The package an app installs as @codecaine-ai/design-system is another package (an npm alias).
  const alias = join(ws.root, "apps/r2r-alias");
  write(join(alias, "package.json"), JSON.stringify({ name: "r2r-alias", private: true, dependencies: { [PACKAGE]: "workspace:*" } }, null, 2));
  write(join(alias, "node_modules", PACKAGE, "package.json"), JSON.stringify({ name: "@acme/design-system-fork", exports: { "./tokens.css": "./dist/css/tokens.css" } }));
  write(join(alias, "node_modules", PACKAGE, "dist/css/tokens.css"), build("dist/css/tokens.css"));
  write(join(alias, "src/index.css"), `@import "${PACKAGE}/tokens.css";\n`);
});
afterAll(() => ws?.cleanup());

const at = (file: string, line: number, message: string) => ({ file, line, message: expect.stringContaining(message) });
/** The findings are exactly these, in any order. */
function expectExactly(findings: Finding[], expected: Array<ReturnType<typeof at>>) {
  expect(findings).toHaveLength(expected.length);
  for (const e of expected) expect(findings).toContainEqual(e);
}

const RUNNABLE: AppEntry["run"] = { mode: "static", staticDir: "dist" } as AppEntry["run"];

describe("shell: composition and rendering (N11)", () => {
  const FORMS = "apps/r2h-forms";
  const forms = (entry: string, extra: Partial<AppEntry> = {}) =>
    checkEntry(ws, ds, appEntry({ id: `forms-${entry}`, root: FORMS, entryStylesheet: `${FORMS}/src/${entry}.tsx`, ...extra }), "shell");

  test("parts a module passes into the shell's slots count: App renders <Shell sidebar={<Sidebar />}>", () => {
    expect(checkEntry(ws, ds, appEntry({ id: "r2h-slot", root: "apps/r2h-slot" }), "shell")).toMatchObject({ status: "pass", violations: [] });
  });

  test.each(["named", "default", "namespace", "create", "lazy", "barrel", "barrel2", "script"])(
    "a static-only app that renders its shell passes: %s",
    (entry) => {
      expect(forms(entry)).toMatchObject({ status: "pass", violations: [] });
    },
  );

  test.each([
    ["not-rendered", 2, "imports Shell from apps/r2h-forms/src/_components/Shell/index.tsx but never renders it"],
    ["side-effect", 2, "imports apps/r2h-forms/src/_components/Shell/index.tsx but never renders it"],
    ["in-string", 2, "imports Shell from apps/r2h-forms/src/_components/Shell/index.tsx but never renders it"],
    // `import { type ShellProps }` binds no value: it reads like a side-effect import.
    ["inline-type", 2, "imports apps/r2h-forms/src/_components/Shell/index.tsx but never renders it"],
  ] as const)("a static-only app that imports its shell but never renders it fails: %s", (entry, line, message) => {
    expect(forms(entry).violations).toEqual([at(`${FORMS}/src/${entry}.tsx`, line, message)]);
  });

  test("a barrel that re-exports the shell is followed: an import through it that renders nothing fails", () => {
    expect(forms("barrel-unrendered").violations).toEqual([
      at(`${FORMS}/src/barrel-unrendered.tsx`, 2, "imports Shell from apps/r2h-forms/src/ui/index.ts but never renders it"),
    ]);
  });

  test("an app that runs (run.mode is not none) is checked at runtime: importing the shell is enough here", () => {
    expect(forms("not-rendered", { run: RUNNABLE })).toMatchObject({ status: "pass", violations: [] });
  });

  test("an import type does not reach the shell module at all", () => {
    expect(forms("type-only").violations).toEqual([at(`${FORMS}/src`, 0, "renders no .ds-shell markup")]);
  });

  test("a template copy that App.tsx imports but never renders fails when nothing runs the app", () => {
    const entry = appEntry({ id: "r2h-template-unrendered", root: "apps/r2h-template-unrendered" });
    expect(checkEntry(ws, ds, entry, "shell").violations).toEqual([
      at("apps/r2h-template-unrendered/src/App.tsx", 1, "imports AppShell from apps/r2h-template-unrendered/src/_components/AppShell/index.tsx but never renders it"),
    ]);
    expect(checkEntry(ws, ds, { ...entry, run: RUNNABLE }, "shell")).toMatchObject({ status: "pass", violations: [] });
  });
});

describe("resolution: every shipped file the app loads (N14, N1)", () => {
  const vendored = (id: string) =>
    checkEntry(ws, ds, appEntry({ id, root: `apps/${id}`, consume: { via: "vendor-tgz", detail: "file:vendor/design-system.tgz" }, entryStylesheet: `apps/${id}/src/index.css` }), "resolution");
  const copied = (id: string) =>
    checkEntry(ws, ds, appEntry({ id, root: `apps/${id}`, consume: { via: "copy", detail: "ds/*.css" }, entryStylesheet: `apps/${id}/src/index.css` }), "resolution");

  test("a vendored app that loads fonts.css, tokens.css and layout.css passes when every file matches the build", () => {
    expect(vendored("r2r-vendored")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a stale layout.css in the tgz is one violation naming the member and both hashes", () => {
    expect(vendored("r2r-tgz-stale-layout").violations).toEqual([
      at(
        "apps/r2r-tgz-stale-layout/vendor/design-system.tgz",
        0,
        `css/layout.css in the tgz (sha256 ${short(stale("css/layout.css"))}) differs from the current build (${short(build("css/layout.css"))})`,
      ),
    ]);
  });

  test("a loaded file missing from the tgz is one violation", () => {
    expect(vendored("r2r-tgz-no-layout").violations).toEqual([at("apps/r2r-tgz-no-layout/vendor/design-system.tgz", 0, "the tgz has no package/css/layout.css")]);
  });

  test("a stale font file in the installed copy is one violation (fonts.css is loaded)", () => {
    const font = "fonts/Inter-Regular.woff2";
    expect(vendored("r2r-installed-stale-font").violations).toEqual([
      at(
        `apps/r2r-installed-stale-font/node_modules/${PACKAGE}/${font}`,
        0,
        `${font} in the installed copy (sha256 ${short(stale(font))}) differs from the current build (${short(build(font))})`,
      ),
    ]);
  });

  test("a copied app passes when every copied file and font matches the build", () => {
    expect(copied("r2r-copied-ok")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a stale copied layout.css is a violation", () => {
    expect(copied("r2r-copied-stale-layout").violations).toEqual([
      at(
        "apps/r2r-copied-stale-layout/ds/layout.css",
        0,
        `copied layout.css (sha256 ${short(stale("css/layout.css"))}) differs from the current build's css/layout.css (${short(build("css/layout.css"))})`,
      ),
    ]);
  });

  test("a copied fonts.css checks the font files its url()s point at: a stale one and a missing one", () => {
    const fontsCss = build("css/fonts.css").toString("utf8");
    const urlLine = fontsCss.slice(0, fontsCss.indexOf("../fonts/IBMPlexMono-Medium.woff2")).split("\n").length;
    expectExactly(copied("r2r-copied-stale-font").violations, [
      at(
        "apps/r2r-copied-stale-font/fonts/Inter-Bold.woff2",
        0,
        `copied font Inter-Bold.woff2 (sha256 ${short(stale("fonts/Inter-Bold.woff2"))}) differs from the current build's fonts/Inter-Bold.woff2 (${short(build("fonts/Inter-Bold.woff2"))})`,
      ),
      at("apps/r2r-copied-stale-font/ds/fonts.css", urlLine, "points at ../fonts/IBMPlexMono-Medium.woff2, which does not exist"),
    ]);
  });

  test("a design-system load whose file is not inside a @codecaine-ai/design-system package is a violation", () => {
    const { violations } = checkEntry(ws, ds, appEntry({ id: "r2r-alias", root: "apps/r2r-alias", entryStylesheet: "apps/r2r-alias/src/index.css" }), "resolution");
    expect(violations.filter((v) => v.message.includes("not inside"))).toEqual([
      at(
        "apps/r2r-alias/src/index.css",
        1,
        `${PACKAGE}/tokens.css loads apps/r2r-alias/node_modules/${PACKAGE}/dist/css/tokens.css, which is not inside a ${PACKAGE} package`,
      ),
    ]);
  });
});
