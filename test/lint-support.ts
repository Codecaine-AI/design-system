/**
 * Fixture workspace for the lint:apps tests.
 *
 * `materialize()` copies test/fixtures/lint/workspace into a fresh temp dir and adds what
 * should not live in git: the node_modules link to the fake design-system package, files
 * over the 400-line limit, copies of the real AppShell template and tokens.css, vendored
 * tgz files, and registry/apps.json (built here, so every entry carries the full AppEntry
 * shape and passes validateRegistry). Allowlists live in registry/apps/allowlists/, resolved
 * beside apps.json as the registry convention says.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DesignSystemBuild } from "../scripts/lib/lint/design-system";
import { lintApps, registryDirOf } from "../scripts/lib/lint/run";
import type { CheckResult, LintReport, PassNumber } from "../scripts/lib/lint/types";
import type { AppEntry, CheckId, Registry, Requirement } from "../scripts/lib/registry";
import { PKG } from "./support";

const FIXTURE = join(import.meta.dir, "fixtures/lint/workspace");
const APPSHELL_TEMPLATE = join(PKG, "templates/react-app-shell/src/_components/AppShell");
/** The real build's tokens.css: the file vendored and copied apps must match. */
export const REAL_TOKENS_CSS = join(PKG, "dist/css/tokens.css");

const REQUIRED = { required: true } as const;
const NEVER_RUN = { required: false, reason: "fixture app: never started" } as const;

type EntryInput = Omit<Partial<AppEntry>, "checks"> & {
  id: string;
  root: string;
  checks?: Partial<Record<CheckId, Requirement>>;
};

/** A complete registry entry for a Tailwind v4 shell app that consumes the package as a workspace member. */
export function appEntry(input: EntryInput): AppEntry {
  const { checks, ...rest } = input;
  const root = input.root;
  return {
    name: input.id,
    wave: 1,
    kind: "app",
    repo: root,
    scan: { paths: [`${root}/src`], exclude: [] },
    stack: { summary: "React + Tailwind v4 (fixture)", tailwind: "v4", packageManager: "bun" },
    consume: { via: "workspace", detail: "workspace:* (fixture)" },
    entryStylesheet: `${root}/src/main.tsx`,
    theme: { rule: "light-dark" },
    literalFloor: 0,
    allowlist: null,
    shell: true,
    folderStandard: true,
    passes: { "1": REQUIRED, "2": REQUIRED, "3": REQUIRED },
    gates: { lint: REQUIRED, verify: NEVER_RUN, snapshot: NEVER_RUN, pixelDiff: NEVER_RUN, tests: REQUIRED },
    run: { mode: "none", reason: "fixture app: never started" },
    commands: { cwd: root },
    tests: { safe: [] },
    routes: [],
    runProfile: {
      env: {},
      unsetEnv: [],
      tempHome: true,
      fixtures: [],
      flags: [],
      ports: {},
      proof: { status: "unproven", method: "fixture app: never run" },
    },
    exceptions: [],
    ...rest,
    checks: {
      resolution: REQUIRED,
      wiring: REQUIRED,
      literals: REQUIRED,
      names: REQUIRED,
      shell: REQUIRED,
      structure: REQUIRED,
      ...checks,
    },
  };
}

/** Reasons the registry gives for checks it marks n/a; tests compare the report against them. */
export const NA_REASONS = {
  libraryResolution: "widgets ships no CSS: its host app resolves the design system",
  libraryWiring: "widgets has no entry stylesheet: its host app loads the tokens",
  libraryShell: "widgets is a component library: its host renders the shell",
};

const UNCONNECTED = "apps/unconnected";
const WIRING = "apps/wiring";
const HTML_NESTED = "apps/html-nested";
const FAKE_LOADS = "apps/fake-loads";

export const APPS: AppEntry[] = [
  appEntry({ id: "connected", root: "apps/connected" }),
  appEntry({ id: "connected-no-shell", root: "apps/connected", shell: false }),
  appEntry({ id: "unconnected", root: UNCONNECTED, entryStylesheet: `${UNCONNECTED}/src/index.css` }),
  // The same sources with an allowlist, a floor at the hard count, and the docs-system repo.
  appEntry({ id: "unconnected-allowlisted", root: UNCONNECTED, entryStylesheet: `${UNCONNECTED}/src/index.css`, allowlist: "apps/allowlists/unconnected-allowlisted.json" }),
  appEntry({ id: "unconnected-at-floor", root: UNCONNECTED, entryStylesheet: `${UNCONNECTED}/src/index.css`, literalFloor: 2 }),
  appEntry({ id: "unconnected-docs-system", root: UNCONNECTED, repo: "codecaine/core/docs-system", entryStylesheet: `${UNCONNECTED}/src/index.css` }),
  appEntry({ id: "misordered", root: WIRING, scan: { paths: [WIRING], exclude: [] }, entryStylesheet: `${WIRING}/misordered.css` }),
  appEntry({ id: "dark-first", root: WIRING, scan: { paths: [WIRING], exclude: [] }, entryStylesheet: `${WIRING}/dark-first.css`, theme: { rule: "dark-first" } }),
  appEntry({ id: "dark-first-as-light-dark", root: WIRING, scan: { paths: [WIRING], exclude: [] }, entryStylesheet: `${WIRING}/dark-first.css` }),
  appEntry({ id: "host-contract", root: WIRING, scan: { paths: [WIRING], exclude: [] }, entryStylesheet: `${WIRING}/host-contract.css`, theme: { rule: "dark-first" } }),
  appEntry({ id: "host-contract-paired", root: WIRING, scan: { paths: [WIRING], exclude: [] }, entryStylesheet: `${WIRING}/host-contract-paired.css`, theme: { rule: "dark-first" } }),
  appEntry({ id: "shell-no-topbar", root: "apps/shell-no-topbar", scan: { paths: ["apps/shell-no-topbar"], exclude: [] } }),
  appEntry({ id: "templated", root: "apps/templated" }),
  appEntry({ id: "templated-no-topbar", root: "apps/templated-no-topbar" }),
  appEntry({ id: "own-shell", root: "apps/own-shell" }),
  appEntry({
    id: "widgets",
    root: "libs/widgets",
    kind: "library",
    stack: { summary: "React components (fixture)", tailwind: "none", packageManager: "bun" },
    consume: { via: "host-css", detail: "names --ds-* variables; the host loads tokens.css" },
    entryStylesheet: null,
    shell: false,
    folderStandard: false,
    checks: {
      resolution: { required: false, reason: NA_REASONS.libraryResolution },
      wiring: { required: false, reason: NA_REASONS.libraryWiring },
      shell: { required: false, reason: NA_REASONS.libraryShell },
    },
  }),
  // Registry requires resolution, but consume.via host-css leaves the check nothing to resolve.
  appEntry({
    id: "widgets-resolution-required",
    root: "libs/widgets",
    kind: "library",
    consume: { via: "host-css", detail: "names --ds-* variables; the host loads tokens.css" },
    entryStylesheet: null,
    shell: false,
    folderStandard: false,
    checks: { shell: { required: false, reason: NA_REASONS.libraryShell } },
  }),
  // The widgets sources, with a host that compiles their class strings.
  appEntry({
    id: "widgets-utility-classes",
    root: "libs/widgets",
    kind: "library",
    stack: { summary: "React components (fixture)", tailwind: "none", packageManager: "bun", utilityClasses: true } as AppEntry["stack"],
    consume: { via: "host-css", detail: "names --ds-* variables; the host loads tokens.css" },
    entryStylesheet: null,
    shell: false,
    folderStandard: false,
    checks: {
      resolution: { required: false, reason: NA_REASONS.libraryResolution },
      wiring: { required: false, reason: NA_REASONS.libraryWiring },
      shell: { required: false, reason: NA_REASONS.libraryShell },
    },
  }),
  // Literals: Tailwind default-scale classes in and out of class contexts.
  appEntry({ id: "scale-classes", root: "apps/scale-classes" }),
  appEntry({ id: "templated-unused", root: "apps/templated-unused" }),
  // Wiring: stylesheets under a media or supports condition; root-absolute links on nested pages.
  appEntry({ id: "conditional", root: WIRING, scan: { paths: [WIRING], exclude: [] }, entryStylesheet: `${WIRING}/conditional.css` }),
  appEntry({ id: "html-nested", root: HTML_NESTED, scan: { paths: [HTML_NESTED], exclude: [] }, entryStylesheet: `${HTML_NESTED}/about/index.html` }),
  appEntry({ id: "html-nested-broken", root: HTML_NESTED, scan: { paths: [HTML_NESTED], exclude: [] }, entryStylesheet: `${HTML_NESTED}/broken/index.html` }),
  // Wiring: imports that load nothing (?url, a <link> in an export template, an import line in JSX text),
  // and a server-rendered entry whose returned page links the stylesheets.
  appEntry({ id: "fonts-url", root: FAKE_LOADS, entryStylesheet: `${FAKE_LOADS}/src/url-entry.tsx` }),
  appEntry({ id: "fonts-in-string", root: FAKE_LOADS, entryStylesheet: `${FAKE_LOADS}/src/string-entry.tsx` }),
  appEntry({ id: "fonts-in-jsx", root: FAKE_LOADS, entryStylesheet: `${FAKE_LOADS}/src/jsx-entry.tsx` }),
  appEntry({
    id: "ssr-home",
    root: FAKE_LOADS,
    stack: { summary: "server-rendered page (fixture)", tailwind: "none", packageManager: "bun" },
    entryStylesheet: `${FAKE_LOADS}/src/home.ts`,
    shell: false,
    checks: { shell: { required: false, reason: "a single server-rendered page" } },
  }),
  appEntry({ id: "tw3-unused", root: "apps/tw3-unused", stack: { summary: "Tailwind v3 (fixture)", tailwind: "v3", packageManager: "bun" } }),
  appEntry({ id: "tw3-bound", root: "apps/tw3-bound", stack: { summary: "Tailwind v3 (fixture)", tailwind: "v3", packageManager: "bun" } }),
  // Structure: component files in every wrong place, and every kind of entry file.
  appEntry({ id: "wrong-folders", root: "apps/wrong-folders" }),
  // Resolution: where each design-system file comes from.
  appEntry({ id: "stale-copy", root: "apps/stale-copy", entryStylesheet: "apps/stale-copy/src/index.css" }),
  appEntry({ id: "nested-pkg", root: "apps/nested-pkg", entryStylesheet: "apps/nested-pkg/src/index.css" }),
  appEntry({ id: "second-checkout", root: "apps/second-checkout", consume: { via: "link", detail: "link: to a second checkout" }, entryStylesheet: "apps/second-checkout/src/index.css" }),
  appEntry({ id: "relimp", root: "apps/relimp", consume: { via: "relative-import", detail: "packed copy by path" }, entryStylesheet: "apps/relimp/src/index.css" }),
  appEntry({ id: "relimp-ok", root: "apps/relimp-ok", consume: { via: "relative-import", detail: "the root checkout by path" }, entryStylesheet: "apps/relimp-ok/src/index.css" }),
  appEntry({ id: "names-order", root: "apps/names-order" }),
  appEntry({ id: "tw3-commented", root: "apps/tw3-commented", stack: { summary: "Tailwind v3 (fixture)", tailwind: "v3", packageManager: "bun" } }),
  appEntry({ id: "tw3", root: "apps/tw3", stack: { summary: "Tailwind v3 (fixture)", tailwind: "v3", packageManager: "bun" } }),
  appEntry({ id: "html-entry", root: "apps/html-entry", scan: { paths: ["apps/html-entry"], exclude: [] }, entryStylesheet: "apps/html-entry/index.html" }),
  appEntry({ id: "vendored", root: "apps/vendored", consume: { via: "vendor-tgz", detail: "file:vendor/design-system.tgz" } }),
  appEntry({ id: "vendored-stale", root: "apps/vendored-stale", consume: { via: "vendor-tgz", detail: "file:vendor/design-system.tgz" } }),
  appEntry({ id: "copied", root: "apps/copied", consume: { via: "copy", detail: "ds/tokens.css" }, entryStylesheet: "apps/copied/src/index.css" }),
  appEntry({ id: "copied-stale", root: "apps/copied-stale", consume: { via: "copy", detail: "ds/tokens.css" }, entryStylesheet: "apps/copied-stale/src/index.css" }),
];

/** Text appended to tokens.css in the stale vendored and copied apps. */
export const STALE_SUFFIX = "\n/* edited by hand after the copy */\n";

export interface Workspace {
  /** Real path of the temp workspace (what `--root` resolves to). */
  root: string;
  registryPath: string;
  registry: Registry;
  cleanup(): void;
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** `n` lines of plain TypeScript with no literals. */
const linesOfCode = (n: number) => Array.from({ length: n }, (_, i) => `export const line${i + 1} = ${i + 1};\n`).join("");

function copyAppShell(appDir: string, rendered = true) {
  cpSync(APPSHELL_TEMPLATE, join(appDir, "src/_components/AppShell"), {
    recursive: true,
    filter: (src) => !/\.(test|spec)\.[jt]sx?$/.test(src),
  });
  // The app renders its copy, as the template's App.tsx does.
  if (rendered) write(join(appDir, "src/App.tsx"), 'import { AppShell } from "./_components/AppShell";\n\nexport function App() {\n  return <AppShell appName="Fixture" sections={[]} title="Home">home</AppShell>;\n}\n');
}

function vendoredApp(appDir: string, tmp: string, tgzTokens: string) {
  const realTokens = readFileSync(REAL_TOKENS_CSS, "utf8");
  write(join(appDir, "package.json"), JSON.stringify({ name: "vendored", private: true, dependencies: { "@codecaine-ai/design-system": "file:vendor/design-system.tgz" } }, null, 2));
  // The tgz holds `package/...`, the layout `bun pm pack` writes.
  const staging = join(tmp, `pack-${Math.random().toString(36).slice(2)}`);
  write(join(staging, "package/package.json"), JSON.stringify({ name: "@codecaine-ai/design-system" }));
  write(join(staging, "package/dist/css/tokens.css"), tgzTokens);
  mkdirSync(join(appDir, "vendor"), { recursive: true });
  const tar = Bun.spawnSync(["tar", "-czf", join(appDir, "vendor/design-system.tgz"), "-C", staging, "package"]);
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  rmSync(staging, { recursive: true, force: true });
  // The installed copy matches the build, so only the tgz can differ.
  const installed = join(appDir, "node_modules/@codecaine-ai/design-system");
  write(join(installed, "package.json"), JSON.stringify({ name: "@codecaine-ai/design-system" }));
  write(join(installed, "dist/css/tokens.css"), realTokens);
}

function copiedApp(appDir: string, tokens: string) {
  write(join(appDir, "ds/tokens.css"), tokens);
  write(join(appDir, "src/index.css"), '@import "../ds/tokens.css";\n');
}

export function materialize(): Workspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-apps-test-")));
  cpSync(FIXTURE, root, { recursive: true });

  // Every app resolves the fake package through the workspace's hoisted node_modules.
  mkdirSync(join(root, "node_modules/@codecaine-ai"), { recursive: true });
  symlinkSync("../../design-system", join(root, "node_modules/@codecaine-ai/design-system"));

  // Line limit: exactly at it (connected passes) and one over it (an app fails, a library warns).
  write(join(root, "apps/connected/src/limit.ts"), linesOfCode(400));
  write(join(root, "apps/unconnected/src/big.ts"), linesOfCode(401));
  write(join(root, "libs/widgets/src/big.ts"), linesOfCode(401));

  copyAppShell(join(root, "apps/templated"));
  copyAppShell(join(root, "apps/templated-no-topbar"));
  unlinkSync(join(root, "apps/templated-no-topbar/src/_components/AppShell/_components/Topbar/index.tsx"));
  copyAppShell(join(root, "apps/templated-unused"), false);

  // A stale local copy of tokens.css in a workspace app; a nested link to a second checkout;
  // an app linked to that checkout.
  copiedApp(join(root, "apps/stale-copy"), readFileSync(REAL_TOKENS_CSS, "utf8"));
  mkdirSync(join(root, "apps/nested-pkg/src/theme/node_modules/@codecaine-ai"), { recursive: true });
  symlinkSync("../../../../../../other-ds", join(root, "apps/nested-pkg/src/theme/node_modules/@codecaine-ai/design-system"));
  mkdirSync(join(root, "apps/second-checkout/node_modules/@codecaine-ai"), { recursive: true });
  symlinkSync("../../../../other-ds", join(root, "apps/second-checkout/node_modules/@codecaine-ai/design-system"));

  const realTokens = readFileSync(REAL_TOKENS_CSS, "utf8");
  vendoredApp(join(root, "apps/vendored"), root, realTokens);
  vendoredApp(join(root, "apps/vendored-stale"), root, realTokens + STALE_SUFFIX);
  copiedApp(join(root, "apps/copied"), realTokens);
  copiedApp(join(root, "apps/copied-stale"), realTokens + STALE_SUFFIX);

  const registry: Registry = { version: 1, apps: APPS };
  const registryPath = join(root, "registry/apps.json");
  write(registryPath, JSON.stringify(registry, null, 2) + "\n");

  return { root, registryPath, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** lintApps over the fixture workspace, the way the CLI calls it. */
export function lint(ws: Workspace, ds: DesignSystemBuild, apps: string[], pass: PassNumber | null = null): LintReport {
  return lintApps({ root: ws.root, registry: ws.registry, registryDir: registryDirOf(ws.registryPath), ds, pass, apps });
}

/** One check's result for one app. */
export function checkOf(ws: Workspace, ds: DesignSystemBuild, app: string, check: CheckId): CheckResult {
  const result = lint(ws, ds, [app]).apps[0].checks.find((c) => c.id === check);
  if (!result) throw new Error(`${app}: no ${check} result`);
  return result;
}

export const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
