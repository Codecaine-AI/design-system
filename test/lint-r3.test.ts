/**
 * lint:apps, round 3: layout-token overrides on the shell (decision 32, Opus r3 P1-1), token-path
 * strings that count only as near misses (Opus r3 P2-1), design-system files by
 * `/@codecaine-ai/design-system/` URL and inlined into a server-rendered page (decision 30, Opus r3
 * P2-2), and stylesheets walked per compilation root and condition (Codex r3 P1).
 * Fixture apps: test/fixtures/lint/workspace/apps/r3n-* and r3w-* (see lint-support.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDesignSystem, type DesignSystemBuild } from "../scripts/lib/lint/design-system";
import { buildLoadGraph } from "../scripts/lib/lint/loads";
import type { Finding } from "../scripts/lib/lint/types";
import type { AppEntry, CheckId } from "../scripts/lib/registry";
import { appEntry, checkEntry, materialize, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;
let ds: DesignSystemBuild;

/** guide/layout.md's example of a shell-scoped layout override: the css block after "override the token on the shell". */
const GUIDE_EXAMPLE = (() => {
  const guide = readFileSync(join(PKG, "guide/layout.md"), "utf8");
  const at = guide.indexOf("override the token on the shell");
  const block = /```css\n([\s\S]*?)```/.exec(guide.slice(at));
  if (at === -1 || !block) throw new Error("guide/layout.md no longer shows a shell override example");
  return block[1];
})();

beforeAll(() => {
  ws = materialize();
  ds = loadDesignSystem();
  // The connected app with the guide's example appended, and the same app overriding a color on the shell.
  for (const id of ["r3n-guide", "r3n-guide-color"]) cpSync(join(ws.root, "apps/connected"), join(ws.root, `apps/${id}`), { recursive: true });
  appendFileSync(join(ws.root, "apps/r3n-guide/src/index.css"), `\n${GUIDE_EXAMPLE}`);
  appendFileSync(join(ws.root, "apps/r3n-guide-color/src/index.css"), "\n.docs-app.ds-shell { --ds-color-surface-sidebar: #fff; }\n");
});
afterAll(() => ws?.cleanup());

const at = (file: string, line: number, message: string) => ({ file, line, message: expect.stringContaining(message) });
function expectExactly(findings: Finding[], expected: Array<ReturnType<typeof at>>) {
  for (const e of expected) expect(findings).toContainEqual(e);
  expect(findings).toHaveLength(expected.length);
}
const check = (input: Parameters<typeof appEntry>[0], id: CheckId) => checkEntry(ws, ds, appEntry(input), id);
const names = (app: string) => check({ id: app, root: `apps/${app}` }, "names");

const OUTSIDE = "is declared here, outside the shell; override --ds-layout-* tokens only on .ds-shell or the shell element";
const DECLARED = "is declared here; apps never redefine --ds-* tokens";

describe("names: a --ds-layout-* override is allowed on the shell (decision 32)", () => {
  test("guide/layout.md's example passes; the same rule overriding a color token fails", () => {
    expect(GUIDE_EXAMPLE).toContain("--ds-layout-sidebar-width");
    expect(names("r3n-guide")).toMatchObject({ status: "pass", violations: [] });
    expectExactly(names("r3n-guide-color").violations, [at("apps/r3n-guide-color/src/index.css", 7, `--ds-color-surface-sidebar ${DECLARED}`)]);
  });

  test("CSS: rules whose subject carries ds-shell pass; :root, descendants, mixed lists, colors and pinned tokens fail", () => {
    const R = "apps/r3n-layout/src";
    expectExactly(
      names("r3n-layout").violations.filter((f) => f.file === `${R}/index.css`),
      [
        // Lines 8-13 (an attribute selector, a rule in @media, a nested `&.wide`) pass.
        at(`${R}/index.css`, 17, `--ds-layout-sidebar-width ${OUTSIDE}`),
        at(`${R}/index.css`, 18, `--ds-layout-lane-code ${OUTSIDE}`),
        at(`${R}/index.css`, 19, `--ds-layout-inspector-width ${OUTSIDE}`),
        at(`${R}/index.css`, 20, `--ds-layout-lane-text ${OUTSIDE}`),
        at(`${R}/index.css`, 21, `--ds-color-surface-page ${DECLARED}`),
        at(`${R}/index.css`, 22, `--ds-light-color-surface-page ${DECLARED}`),
        at(`${R}/index.css`, 23, `--ds-layout-lane-wide ${OUTSIDE}`),
        // On the shell, but the build has no such token.
        at(`${R}/index.css`, 25, "--ds-layout-nope is not defined by the current build"),
        // Round-3 close (R3-B3): a :is()/:where() branch that is not the shell, a pseudo-element, a class in an
        // attribute value. Lines 37-40 (every branch the shell, in @layer, @media and nesting) pass.
        at(`${R}/index.css`, 28, `--ds-layout-sidebar-width ${OUTSIDE}`), // :is(.ds-shell, .ordinary)
        at(`${R}/index.css`, 29, `--ds-layout-lane-text ${OUTSIDE}`), // :is(.ds-shell, :root)
        at(`${R}/index.css`, 30, `--ds-layout-lane-code ${OUTSIDE}`), // .ds-shell::before
        at(`${R}/index.css`, 31, `--ds-layout-lane-code ${OUTSIDE}`), // .ds-shell:after
        at(`${R}/index.css`, 32, `--ds-layout-lane-wide ${OUTSIDE}`), // :where(.ds-shell)::after, .ds-shell
        at(`${R}/index.css`, 33, `--ds-layout-inspector-width ${OUTSIDE}`), // [data-x=".ds-shell"]
        at(`${R}/index.css`, 34, `--ds-layout-lane-text ${OUTSIDE}`), // .x:where(.ds-shell .y)
        at(`${R}/index.css`, 35, `--ds-layout-lane-wide ${OUTSIDE}`), // &::before in .ds-shell
      ],
    );
  });

  test("runtime: setProperty on document.documentElement or the shell element passes; elsewhere, or a color, fails", () => {
    const R = "apps/r3n-layout/src";
    expectExactly(
      names("r3n-layout").violations.filter((f) => f.file === `${R}/App.tsx`),
      [
        // Lines 6-10: documentElement, a ref on the ds-shell tag, a bound querySelector, a cast querySelector.
        at(`${R}/App.tsx`, 11, `--ds-layout-lane-code ${OUTSIDE}`), // document.body
        at(`${R}/App.tsx`, 12, `--ds-color-accent ${DECLARED}`),
        at(`${R}/App.tsx`, 13, `--ds-layout-lane-wide ${OUTSIDE}`), // `.ds-shell .x`
        // Line 16: the shell tag's style object passes; line 17: another tag's fails.
        at(`${R}/App.tsx`, 17, `--ds-layout-lane-text ${OUTSIDE}`),
        // Line 18: an arbitrary property beside ds-shell passes; line 19: without it fails.
        at(`${R}/App.tsx`, 19, `--ds-layout-sidebar-width ${OUTSIDE}`),
        // Line 25: CSS in a string on .ds-shell passes; line 26: on :root fails.
        at(`${R}/App.tsx`, 26, `--ds-layout-sidebar-width ${OUTSIDE}`),
        // Round-3 close (R3-B3), computed keys: line 31, a layout key on the ds-shell tag after a spread, passes;
        // a color key on the shell tag and a layout key on another tag fail.
        at(`${R}/App.tsx`, 32, `--ds-color-accent ${DECLARED}`),
        at(`${R}/App.tsx`, 33, `--ds-layout-lane-text ${OUTSIDE}`),
      ],
    );
  });

  test("HTML: a <style> rule on .ds-shell and a style attribute on the ds-shell element pass", () => {
    const R = "apps/r3n-layout/src";
    expectExactly(
      names("r3n-layout").violations.filter((f) => f.file === `${R}/embed.html`),
      [at(`${R}/embed.html`, 1, `--ds-layout-lane-text ${OUTSIDE}`), at(`${R}/embed.html`, 3, `--ds-layout-sidebar-width ${OUTSIDE}`)],
    );
  });
});

describe("names: token-path strings outside the token API count only as near misses (Opus r3 P2-1)", () => {
  const R = "apps/r3n-paths/src";

  test("an app's own keys pass where the file uses cssVar; near misses and cssVar typos fail", () => {
    expectExactly(names("r3n-paths").violations, [
      // style-rail.ts lines 4-5: the Style Rail keys (layout.radius, layout.editor, …) pass.
      at(`${R}/style-rail.ts`, 7, 'token path "color.surface.nope" does not exist in the current build (did you mean "color.surface.page"?)'),
      at(`${R}/style-rail.ts`, 7, 'token path "color.surfce.page" does not exist in the current build (did you mean "color.surface.page"?)'),
      at(`${R}/style-rail.ts`, 7, 'token path "space.9" does not exist in the current build'),
      at(`${R}/style-rail.ts`, 9, 'token path "layout.radius" (cssVar) does not exist'),
      at(`${R}/style-rail.ts`, 10, 'token path "color.surfce.page" (cssVar) does not exist'),
      at(`${R}/plain.ts`, 2, 'token path "layout.lane.texts" does not exist in the current build (did you mean "layout.lane.text"?)'),
      // cssVar imported by its /@codecaine-ai/design-system/ URL (decision 30) is the package's.
      at(`${R}/url-import.ts`, 3, 'token path "layout.radius" (cssVar) does not exist'),
    ]);
  });
});

describe("decision 30: design-system files by /@codecaine-ai/design-system/ URL, and inlined into a server-rendered page", () => {
  const SSR: Partial<AppEntry> = {
    stack: { summary: "server-rendered page (fixture)", tailwind: "none", packageManager: "bun" },
    theme: { rule: "dark-first" },
    shell: false,
    checks: { shell: { required: false, reason: "a single server-rendered page" } } as AppEntry["checks"],
  };
  const page = (file: string, id: CheckId) =>
    check({ id: `r3w-ssr-${file}`, root: "apps/r3w-ssr", entryStylesheet: `apps/r3w-ssr/src/${file}`, ...(SSR as object) } as Parameters<typeof appEntry>[0], id);

  test("<link href=\"/@codecaine-ai/design-system/<package path>\"> loads that file of the package the app resolves", () => {
    expect(page("home-url.ts", "wiring")).toMatchObject({ status: "pass", violations: [] });
    expect(page("home-url.ts", "resolution")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a /@codecaine-ai/design-system/ URL to a file the package does not have is a design-system load that does not resolve", () => {
    expectExactly(page("home-url-missing.ts", "wiring").violations, [
      at("apps/r3w-ssr/src/home-url-missing.ts", 5, "/@codecaine-ai/design-system/dist/css/tokens-dark.css does not resolve"),
      at("apps/r3w-ssr/src/home-url-missing.ts", 1, "does not load @codecaine-ai/design-system/tokens.css or tokens-dark-first.css"),
    ]);
  });

  test("a `?raw` import and readFileSync(require.resolve(…)) interpolated into <style> load the package's files", () => {
    expect(page("home-inline.ts", "wiring")).toMatchObject({ status: "pass", violations: [] });
    expect(page("home-inline.ts", "resolution")).toMatchObject({ status: "pass", violations: [] });
  });

  test("Bun.file(join(packageDir, …)).text() and readFileSync, joined into one <style> block, load in order", () => {
    expect(page("home-join.ts", "wiring")).toMatchObject({ status: "pass", violations: [] });
    expect(page("home-join.ts", "resolution")).toMatchObject({ status: "pass", violations: [] });
    const graph = buildLoadGraph(join(ws.root, "apps/r3w-ssr/src/home-join.ts"));
    expect(graph.loads.map((l) => [l.kind, l.line])).toEqual([
      ["fonts", 10],
      ["tokens-dark-first", 10],
    ]);
  });

  test("text read but not put in a <style>, and a ?url import in one, load nothing", () => {
    expectExactly(page("home-unused.ts", "wiring").violations, [
      at("apps/r3w-ssr/src/home-unused.ts", 1, "does not load fonts.css"),
      at("apps/r3w-ssr/src/home-unused.ts", 1, "does not load @codecaine-ai/design-system/tokens.css or tokens-dark-first.css"),
    ]);
  });
});

describe("Codex r3 P1: a stylesheet is walked once per compilation root and inherited condition", () => {
  const entry = (file: string, extra: Partial<Parameters<typeof appEntry>[0]> = {}) => ({
    id: `r3w-shared-${file}`,
    root: "apps/r3w-shared",
    entryStylesheet: `apps/r3w-shared/src/${file}`,
    ...extra,
  });

  test("two Tailwind roots that import one shared strict + theme stylesheet both pass", () => {
    expect(check(entry("main.tsx"), "wiring")).toMatchObject({ status: "pass", violations: [] });
    const graph = buildLoadGraph(join(ws.root, "apps/r3w-shared/src/main.tsx"));
    const strictRoots = graph.loads.filter((l) => l.kind === "tw-strict").map((l) => l.root.split("/").pop());
    expect(strictRoots).toEqual(["a.css", "b.css"]);
    expect(new Set(graph.files).size).toBe(graph.files.length);
  });

  test("tokens loaded under print first and then unconditionally pass", () => {
    expect(check(entry("cond.tsx"), "wiring")).toMatchObject({ status: "pass", violations: [] });
  });

  test("an @import cycle under growing conditions stops at the file already on the walk path", () => {
    expect(check(entry("cycle.tsx"), "wiring")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a finding in a stylesheet two roots share is reported once", () => {
    const plain = entry("dup.tsx", { stack: { summary: "plain CSS (fixture)", tailwind: "none", packageManager: "bun" } });
    expectExactly(check(plain, "wiring").violations, [
      at("apps/r3w-shared/src/late.css", 3, "@codecaine-ai/design-system/layout.css comes after a rule, so it is ignored"),
      at("apps/r3w-shared/src/dup.tsx", 1, "shell app does not load @codecaine-ai/design-system/layout.css"),
    ]);
    expectExactly(check(plain, "resolution").violations, [at("apps/r3w-shared/src/late.css", 1, "./vendor/tokens.css is a copy of a design-system file")]);
  });
});
