/**
 * lint:apps names (N10) and structure (N12), round 2: every way an app reaches token
 * paths, `--ds-*` redefinitions, and structure exemptions that match the right place.
 * Fixture apps: test/fixtures/lint/workspace/apps/r2n-* and r2s-* (see lint-support.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadDesignSystem, type DesignSystemBuild } from "../scripts/lib/lint/design-system";
import type { Finding } from "../scripts/lib/lint/types";
import { appEntry, checkEntry, materialize, REAL_TOKENS_CSS, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;
let ds: DesignSystemBuild;

beforeAll(() => {
  ws = materialize();
  ds = loadDesignSystem();
  // Copies of design-system files: one in the scan dirs, one the entry loads under another name.
  const vendor = join(ws.root, "apps/r2n-declare/src/vendor");
  mkdirSync(vendor, { recursive: true });
  copyFileSync(join(PKG, "css/layout.css"), join(vendor, "layout.css"));
  copyFileSync(REAL_TOKENS_CSS, join(vendor, "ds-tokens.css"));
});
afterAll(() => ws?.cleanup());

const at = (file: string, line: number, message: string) => ({ file, line, message: expect.stringContaining(message) });
function expectExactly(findings: Finding[], expected: Array<ReturnType<typeof at>>) {
  expect(findings).toHaveLength(expected.length);
  for (const e of expected) expect(findings).toContainEqual(e);
}

const STACK = { tailwind: "v4", packageManager: "bun" } as const;

describe("names: token paths through local modules, require and dynamic import", () => {
  const R = "apps/r2n-reexport/src";
  const violations = () => checkEntry(ws, ds, appEntry({ id: "r2n-reexport", root: "apps/r2n-reexport" }), "names").violations;

  test("a local module's re-export binds cssVar, `cssVar as v` and chains of re-exports in the importer", () => {
    const found = violations();
    for (const e of [
      at(`${R}/_components/Card/index.tsx`, 2, 'token path "color.surface.nope" (cssVar) does not exist'),
      at(`${R}/_components/Card/index.tsx`, 3, 'token path "color.not.a.token" (v) does not exist'),
      // export * through two modules, a namespace import of the chain, a held import re-exported, a default export.
      at(`${R}/_components/Chain/index.tsx`, 4, 'token path "color.chain.nope" (cssVar)'),
      at(`${R}/_components/Chain/index.tsx`, 5, "tokens.light.color.held does not exist"),
      at(`${R}/_components/Chain/index.tsx`, 6, 'token path "color.default.nope" (fn)'),
      at(`${R}/_components/Chain/index.tsx`, 7, 'token path "color.star.nope" (viaStar)'),
      // A tsconfig alias, and modules that re-export each other.
      at(`${R}/alias-use.ts`, 2, 'token path "color.alias.nope" (v)'),
      at(`${R}/cycle-use.ts`, 2, 'token path "color.cycle.nope" (cssVar)'),
    ]) {
      expect(found).toContainEqual(e);
    }
    expect(found.filter((f) => f.file === `${R}/_components/Card/index.tsx`)).toHaveLength(2);
  });

  test("destructured require, a required namespace, and await import bind the names they take", () => {
    const found = violations();
    for (const e of [
      at(`${R}/require.ts`, 2, 'token path "color.surface.nope2" (cssVar)'),
      at(`${R}/require.ts`, 3, "tokens.light.color.req does not exist"),
      at(`${R}/require.ts`, 5, 'token path "color.ns.nope" (cssVar)'),
      at(`${R}/dyn.ts`, 3, 'token path "color.surface.nope3" (cssVar)'),
      at(`${R}/dyn.ts`, 7, 'token path "color.dyn.nope" (cssVar)'),
    ]) {
      expect(found).toContainEqual(e);
    }
  });

  test("a token-path string is checked in a file that does not import the package; an app's own key there is not a token path", () => {
    expectExactly(violations().filter((f) => f.file === `${R}/plain.ts`), [at(`${R}/plain.ts`, 1, 'token path "color.surface.nope" does not exist')]);
  });

  test("a font file name is not a token path", () => {
    expect(violations().filter((f) => f.file === `${R}/fonts.ts`)).toEqual([]);
  });

  test("the reexport fixture has no other findings", () => {
    expect(violations()).toHaveLength(14);
  });
});

describe("names: apps never redefine --ds-* tokens", () => {
  const R = "apps/r2n-declare/src";
  const violations = () => checkEntry(ws, ds, appEntry({ id: "r2n-declare", root: "apps/r2n-declare" }), "names").violations;
  const DECLARED = "is declared here; apps never redefine --ds-* tokens";

  test("declarations in CSS, HTML, setProperty, style objects and CSS strings fail; references and copied design-system files pass", () => {
    expectExactly(violations(), [
      at(`${R}/index.css`, 1, `--ds-color-surface-page ${DECLARED}`),
      at(`${R}/index.css`, 2, `--ds-space-2 ${DECLARED}`),
      // An unknown name that is declared is reported once, as a declaration.
      at(`${R}/index.css`, 4, `--ds-app-own ${DECLARED}`),
      at(`${R}/style.ts`, 2, `--ds-space-4 ${DECLARED}`),
      at(`${R}/style.ts`, 3, "--ds-color-${hue}-solid " + DECLARED),
      at(`${R}/style.ts`, 6, `--ds-radius-pill ${DECLARED}`),
      at(`${R}/style.ts`, 7, `--ds-radius-pill ${DECLARED}`),
      at(`${R}/style.ts`, 8, `--ds-shadow-dialog ${DECLARED}`),
      // A Tailwind arbitrary property; the optional key of a type on line 12 is not a declaration.
      at(`${R}/style.ts`, 11, `--ds-space-2 ${DECLARED}`),
      at(`${R}/embed.html`, 1, `--ds-space-2 ${DECLARED}`),
      at(`${R}/embed.html`, 3, `--ds-space-4 ${DECLARED}`),
    ]);
  });
});

describe("structure: entry, route and hook exemptions match the right place", () => {
  const vite = (scan = ["apps/r2s-vite/src"]) =>
    checkEntry(ws, ds, appEntry({ id: "r2s-vite", root: "apps/r2s-vite", scan: { paths: scan, exclude: [] } }), "structure").violations;
  const PLAYGROUND = [
    at("apps/r2s-vite/src/playground/main.tsx", 0, "entry file main.tsx is not in a source root"),
    at("apps/r2s-vite/src/playground/App.tsx", 0, "entry file App.tsx is not in a source root"),
  ];
  const next = (root: string, scan: string, entry: string) =>
    checkEntry(
      ws,
      ds,
      appEntry({ id: `${root}-next`, root, scan: { paths: [scan], exclude: [] }, entryStylesheet: entry, stack: { summary: "Next 15 (fixture)", ...STACK } }),
      "structure",
    ).violations;

  test("App.tsx outside a root, a Vite loading.tsx, use<Name>.tsx and JSX in a hook file fail; use<Name>.ts passes", () => {
    const R = "apps/r2s-vite/src";
    expectExactly(vite(), [
      at(`${R}/features/x/App.tsx`, 0, "entry file App.tsx is not in a source root (the app root, src/ or an entry's folder); move it there, or make it a component in _components/App/index.tsx"),
      at(`${R}/pages/review/loading.tsx`, 0, "move it to _components/Loading/index.tsx"),
      at(`${R}/hooks/useThing.tsx`, 0, "hook file useThing.tsx: a hook file is useThing.ts with no JSX"),
      at(`${R}/hooks/useLegacy.js`, 0, "hook file useLegacy.js holds JSX"),
      // No page in the scan dirs loads src/playground/main.tsx (see the next test).
      ...PLAYGROUND,
    ]);
  });

  test("a module an HTML page loads with <script src> is an entry, and so is App.tsx beside it", () => {
    const found = vite(["apps/r2s-vite/src", "apps/r2s-vite/playground.html"]);
    expect(found).toHaveLength(4);
    for (const p of PLAYGROUND) expect(found).not.toContainEqual(p);
  });

  test("in a Next app, loading.tsx and not-found.tsx in app/ are route entries", () => {
    expect(next("apps/r2s-next", "apps/r2s-next/app", "apps/r2s-next/app/layout.tsx")).toEqual([]);
  });

  test("wrong-folders as a Next app: app/layout.tsx and app/not-found.tsx are entries, the rest still fails", () => {
    const R = "apps/wrong-folders/src";
    expectExactly(next("apps/wrong-folders", R, `${R}/main.tsx`), [
      at(`${R}/components/Panel/index.tsx`, 0, "move it to _components/Panel/index.tsx"),
      at(`${R}/components/ui/app-sidebar.tsx`, 0, "move it to _components/AppSidebar/index.tsx"),
      at(`${R}/_components/Shelf/ShelfItem.tsx`, 0, "component file ShelfItem.tsx in Shelf/"),
      at(`${R}/components/icon.tsx`, 0, "move it to _components/Icon/index.tsx"),
      at(`${R}/components/loading.tsx`, 0, "move it to _components/Loading/index.tsx"),
    ]);
  });
});
