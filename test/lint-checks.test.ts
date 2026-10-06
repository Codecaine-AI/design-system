/**
 * lint:apps checks (scripts/lib/lint/) against a fixture workspace: a fake design-system
 * package, a connected app that passes every check, an unconnected app that breaks each
 * one, and small variants (see lint-support.ts). Token names, token paths and the AppShell
 * template come from this checkout's real build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesignSystem, type DesignSystemBuild } from "../scripts/lib/lint/design-system";
import type { Finding } from "../scripts/lib/lint/types";
import type { CheckId } from "../scripts/lib/registry";
import { checkOf, lint, materialize, NA_REASONS, REAL_TOKENS_CSS, sha256, STALE_SUFFIX, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;
let ds: DesignSystemBuild;

beforeAll(() => {
  ws = materialize();
  ds = loadDesignSystem();
});
afterAll(() => ws?.cleanup());

const check = (app: string, id: CheckId) => checkOf(ws, ds, app, id);
const at = (file: string, line: number, message: string) => ({ file, line, message: expect.stringContaining(message) });
const messages = (findings: Finding[]) => findings.map((f) => f.message);
/** The findings are exactly these, in any order. */
function expectExactly(findings: Finding[], expected: Array<ReturnType<typeof at>>) {
  expect(findings).toHaveLength(expected.length);
  for (const e of expected) expect(findings).toContainEqual(e);
}

const ALL_CHECKS: CheckId[] = ["resolution", "wiring", "literals", "names", "shell", "structure"];

test("a connected app passes every check at pass 3, a 400-line file included", () => {
  const [app] = lint(ws, ds, ["connected"], 3).apps;
  expect(app.ok).toBe(true);
  expect(app.checks.map((c) => ({ id: c.id, status: c.status, violations: c.violations, warnings: c.warnings }))).toEqual(
    ALL_CHECKS.map((id) => ({ id, status: "pass", violations: [], warnings: [] })),
  );
  expect(app.literals).toEqual({ hard: 0, floor: 0 });
});

test("the linter refuses a design-system build whose dist/ is stale against tokens/", () => {
  const copy = mkdtempSync(join(tmpdir(), "lint-ds-stale-"));
  try {
    for (const p of ["tokens", "dist", "css", "templates", "guide/tokens.md"]) cpSync(join(PKG, p), join(copy, p), { recursive: true });
    expect(loadDesignSystem(copy).tokensCssSha256).toBe(sha256(readFileSync(REAL_TOKENS_CSS, "utf8")));
    appendFileSync(join(copy, "dist/css/tokens.css"), STALE_SUFFIX);
    expect(() => loadDesignSystem(copy)).toThrow("dist/css/tokens.css (out of date)");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

describe("pass selection", () => {
  test.each([
    [1, ALL_CHECKS.slice(0, 4)],
    [2, ALL_CHECKS.slice(0, 5)],
    [3, ALL_CHECKS],
    [null, ALL_CHECKS],
  ] as const)("--pass %p runs %p", (pass, ids) => {
    expect(lint(ws, ds, ["connected"], pass).apps[0].checks.map((c) => c.id)).toEqual([...ids]);
  });

  test("a check the registry marks n/a reports the registry's reason and does not run", () => {
    // Without the n/a mark, wiring runs and fails: a library has no entry stylesheet.
    expect(check("widgets-resolution-required", "wiring").status).toBe("fail");
    expect(check("widgets", "wiring")).toEqual({ id: "wiring", status: "n/a", reason: NA_REASONS.libraryWiring, violations: [], warnings: [] });
    expect(check("widgets", "resolution")).toMatchObject({ status: "n/a", reason: NA_REASONS.libraryResolution });
  });

  test("a check the registry requires but the app data leaves nothing to check fails: only the registry marks n/a", () => {
    expect(check("widgets-resolution-required", "resolution")).toMatchObject({
      status: "fail",
      violations: [at("libs/widgets", 0, "registry requires resolution but widgets-resolution-required consumes the tokens through its host's CSS")],
    });
    expect(check("connected-no-shell", "shell")).toMatchObject({
      status: "fail",
      violations: [at("apps/connected", 0, "registry requires shell but connected-no-shell is not a shell app (shell: false in apps.json)")],
    });
  });
});

describe("resolution", () => {
  test("an app whose package.json does not declare the package fails", () => {
    expect(check("unconnected", "resolution").violations).toEqual([
      at("apps/unconnected/package.json", 1, "does not declare @codecaine-ai/design-system"),
    ]);
  });

  test("a vendored tgz passes when its tokens.css matches the build and fails with both hashes when not", () => {
    expect(check("vendored", "resolution")).toMatchObject({ status: "pass", violations: [] });
    const stale = sha256(readFileSync(REAL_TOKENS_CSS, "utf8") + STALE_SUFFIX).slice(0, 12);
    const build = sha256(readFileSync(REAL_TOKENS_CSS, "utf8")).slice(0, 12);
    expect(check("vendored-stale", "resolution").violations).toEqual([
      at("apps/vendored-stale/vendor/design-system.tgz", 0, `in the tgz (sha256 ${stale}) differs from the current build (${build})`),
    ]);
  });

  test("design-system files must come from the package the app resolves, and a live link from the root's checkout", () => {
    expect(check("stale-copy", "resolution").violations).toEqual([
      at("apps/stale-copy/src/index.css", 1, "is a copy of a design-system file (apps/stale-copy/ds/tokens.css); consume.via workspace loads it from the package"),
    ]);
    expect(check("nested-pkg", "resolution").violations).toEqual([
      at("apps/nested-pkg/src/theme/ds.css", 1, "loads other-ds/dist/css/tokens.css, not the package the app resolves (design-system)"),
    ]);
    expect(check("second-checkout", "resolution").violations).toEqual([
      at("apps/second-checkout/package.json", 5, "reaches other-ds, not the root's design-system checkout (design-system)"),
    ]);
  });

  test("relative-import passes into the root's checkout and fails into a packed copy", () => {
    expect(check("relimp-ok", "resolution")).toMatchObject({ status: "pass", violations: [] });
    expect(check("relimp", "resolution").violations).toEqual([
      at("apps/relimp/src/index.css", 1, "reaches packed-ds, not the root's design-system checkout (design-system)"),
    ]);
  });

  test("a library's own copy of the package is a violation: a stale link, a stale packed copy, a dependency that does not resolve", () => {
    expectExactly(check("with-libs", "resolution").violations, [
      at("apps/with-libs/package.json", 7, "library stale-lib resolves @codecaine-ai/design-system to packed-ds, the app to design-system"),
      at("apps/with-libs/package.json", 7, "library stale-lib: its @codecaine-ai/design-system reaches packed-ds, not the root's design-system checkout (design-system)"),
      at("apps/with-libs/package.json", 8, "missing-lib (workspace:*) does not resolve"),
    ]);
    const stale = sha256(readFileSync(REAL_TOKENS_CSS, "utf8") + STALE_SUFFIX).slice(0, 12);
    expectExactly(check("vendored-with-lib", "resolution").violations, [
      at("apps/vendored-with-lib/package.json", 6, "library packed-lib resolves @codecaine-ai/design-system to libs/packed-lib/node_modules/@codecaine-ai/design-system, the app to apps/vendored-with-lib/node_modules/@codecaine-ai/design-system"),
      at("apps/vendored-with-lib/package.json", 6, `library packed-lib: dist/css/tokens.css in its copy (libs/packed-lib/node_modules/@codecaine-ai/design-system, sha256 ${stale})`),
    ]);
  });

  test("copied tokens pass when they match the build and fail with their hash when edited", () => {
    expect(check("copied", "resolution")).toMatchObject({ status: "pass", violations: [] });
    const stale = sha256(readFileSync(REAL_TOKENS_CSS, "utf8") + STALE_SUFFIX).slice(0, 12);
    expect(check("copied-stale", "resolution").violations).toEqual([at("apps/copied-stale/ds/tokens.css", 0, `copied tokens (sha256 ${stale}) differ`)]);
  });
});

describe("wiring", () => {
  test("each design-system stylesheet the entry does not load is one violation", () => {
    const { violations } = check("unconnected", "wiring");
    const missing = ["/fonts.css", "/tokens.css", "/layout.css", "/tailwind-strict.css", "/tailwind.css"];
    expect(missing.map((m) => violations.filter((v) => v.message.includes(`design-system${m}`)).length)).toEqual(missing.map(() => 1));
    expect(violations).toHaveLength(missing.length);
  });

  test("fonts after tokens and tailwind-strict.css after tailwind.css are order violations", () => {
    expectExactly(check("misordered", "wiring").violations, [
      at("apps/wiring/misordered.css", 3, "fonts.css loads after tokens.css (apps/wiring/misordered.css:2)"),
      at("apps/wiring/misordered.css", 6, "tailwind-strict.css loads after tailwind.css (apps/wiring/misordered.css:5)"),
    ]);
  });

  test("tokens-dark-first.css is allowed on a dark-first app and a violation on a light-dark app", () => {
    expect(check("dark-first", "wiring")).toMatchObject({ status: "pass", violations: [] });
    expect(check("dark-first-as-light-dark", "wiring").violations).toContainEqual(
      at("apps/wiring/dark-first.css", 3, "loads tokens-dark-first.css, which is for dark-first surfaces"),
    );
  });

  test("an HTML entry's href and a CSS @import resolve document-relative before node_modules", () => {
    expect(check("html-entry", "wiring")).toMatchObject({ status: "pass", violations: [] });
  });

  test("Tailwind v3 needs the preset in the exported presets array; commented out, required but unused, or elsewhere does not count", () => {
    const presetFindings = (app: string) => check(app, "wiring").violations.filter((v) => v.message.includes("preset"));
    expect(presetFindings("tw3")).toEqual([]);
    expect(presetFindings("tw3-bound")).toEqual([]);
    expect(presetFindings("tw3-shorthand")).toEqual([]);
    expect(presetFindings("tw3-commented")).toEqual([at("apps/tw3-commented/tailwind.config.js", 2, "does not use the preset")]);
    expect(presetFindings("tw3-unused")).toEqual([at("apps/tw3-unused/tailwind.config.js", 3, "does not use the preset")]);
  });

  test("a root-absolute link on a nested page resolves against the app's web root; an unresolved link on the entry page fails", () => {
    expect(check("html-nested", "wiring")).toMatchObject({ status: "pass", violations: [] });
    expectExactly(check("html-nested-broken", "wiring").violations, [
      at("apps/html-nested/broken/index.html", 5, "/styles/missing.css does not resolve; the entry page links it"),
      // print.css is linked with media="print": the fonts.css it imports applies only when printing.
      at("apps/html-nested/styles/print.css", 1, '@codecaine-ai/design-system/fonts.css loads only under "print"'),
    ]);
  });

  test("a stylesheet imported under a media query or supports condition does not count; all and screen do", () => {
    expectExactly(check("conditional", "wiring").violations, [
      at("apps/wiring/conditional.css", 3, '@codecaine-ai/design-system/tokens.css loads only under "print"'),
      at("apps/wiring/conditional.css", 5, '@codecaine-ai/design-system/tailwind-strict.css loads only under "supports(display: grid)"'),
      at("apps/wiring/conditional.css", 1, "does not load @codecaine-ai/design-system/tokens.css"),
      at("apps/wiring/conditional.css", 1, "Tailwind v4 app does not import @codecaine-ai/design-system/tailwind-strict.css"),
    ]);
  });

  test.each(["fonts-url", "fonts-in-string", "fonts-in-jsx"])("%s: an import that injects nothing does not load fonts.css", (app) => {
    expect(messages(check(app, "wiring").violations)).toEqual([expect.stringContaining("does not load fonts.css")]);
  });

  test("a server-rendered entry module loads the stylesheets its returned page links", () => {
    expect(check("ssr-home", "wiring")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a static import on its own line after a statement without a semicolon still loads", () => {
    expect(check("asi-import", "wiring")).toMatchObject({ status: "pass", violations: [] });
  });

  test("Tailwind v4 import options (source(none), layer(…)) are not conditions: the order checks still see the import", () => {
    expectExactly(check("tw-options", "wiring").violations, [
      at("apps/wiring/tw-options.css", 4, 'tailwind-strict.css loads before "tailwindcss" (apps/wiring/tw-options.css:5)'),
    ]);
  });

  test("host-contract.css sits between the tokens and layout.css, in the tokens' variant", () => {
    expect(check("host-contract-paired", "wiring")).toMatchObject({ status: "pass", violations: [] });
    expectExactly(check("host-contract", "wiring").violations, [
      at("apps/wiring/host-contract.css", 5, "loads host-contract.css with tokens-dark-first.css; pair the variants"),
      at("apps/wiring/host-contract.css", 5, "host-contract.css loads after layout.css (apps/wiring/host-contract.css:4)"),
    ]);
  });
});

describe("literals", () => {
  test("each hard literal is a violation at its file and line", () => {
    const { violations } = check("unconnected", "literals");
    expect(violations).toContainEqual(at("apps/unconnected/src/index.css", 4, "hard literal #ff0000 (hex, inline)"));
    expect(violations).toContainEqual(at("apps/unconnected/src/index.css", 5, "hard literal 6px (radius)"));
  });

  test("a hard total over literalFloor is a violation; a total at the floor is not", () => {
    expect(messages(check("unconnected", "literals").violations)).toContain("2 hard literals in the scan dirs, over the floor of 0");
    const [atFloor] = lint(ws, ds, ["unconnected-at-floor"]).apps;
    expect(atFloor.literals).toEqual({ hard: 2, floor: 2 });
    expect(messages(atFloor.checks.find((c) => c.id === "literals")!.violations).filter((m) => m.includes("over the floor"))).toEqual([]);
  });

  test("allowlist entries suppress the hits they match; an entry without a reason fails and an unused one warns", () => {
    const allowlist = "registry/apps/allowlists/unconnected-allowlisted.json";
    const { violations, warnings } = check("unconnected-allowlisted", "literals");
    const hits = messages(violations);
    expect(hits.some((m) => m.includes("#ff0000"))).toBe(false);
    expect(hits.some((m) => m.includes("class rounded-lg"))).toBe(false);
    expect(hits.some((m) => m.includes("6px"))).toBe(true);
    expect(violations).toContainEqual(at(allowlist, 5, "literal entry for apps/unconnected/src/missing.css has no reason"));
    expect(warnings).toContainEqual(at(allowlist, 4, "literals entry matches nothing"));
  });

  test("Tailwind default-scale classes are violations; design-system utilities and CSS easing values are not", () => {
    const tw = check("unconnected", "literals")
      .violations.filter((v) => v.message.startsWith("Tailwind default-scale class "))
      .map((v) => `${v.file}:${v.line} ${v.message.split(" ")[3]}`);
    // Widget.tsx line 6 also holds text-ui-sm, rounded-pill and font-medium; line 9 holds "opacity 150ms ease-out".
    expect(tw.sort()).toEqual([
      "apps/unconnected/src/Widget.tsx:10 ease-out",
      "apps/unconnected/src/Widget.tsx:6 bg-red-500",
      "apps/unconnected/src/Widget.tsx:6 rounded-lg",
      "apps/unconnected/src/Widget.tsx:6 text-sm",
    ]);
  });

  test("bare shadow, blur and numeric leading count only in class contexts; container sizes and animations always; bare rounded never", () => {
    const tw = check("scale-classes", "literals")
      .violations.filter((v) => v.message.startsWith("Tailwind default-scale class "))
      .map((v) => `${v.file.replace("apps/scale-classes/src/", "")}:${v.line} ${v.message.split(" ")[3]}`);
    // Not flagged: rounded, the MODE constant, title="shadow", the WORDS array, el.title and the title property.
    // Flagged in class contexts: a className assignment across lines, an overlayClassName prop, a Svelte class={…}.
    expect(tw.sort()).toEqual([
      "_components/Panel/index.tsx:10 blur",
      "_components/Panel/index.tsx:10 inset-shadow",
      "_components/Panel/index.tsx:7 animate-spin",
      "_components/Panel/index.tsx:7 max-w-2xl",
      "_components/Panel/index.tsx:7 shadow",
      "_components/Panel/index.tsx:8 leading-6",
      "_components/Panel/index.tsx:8 text-gray-500",
      "_components/Panel/index.tsx:9 backdrop-blur",
      "_components/Panel/index.tsx:9 drop-shadow",
      "dom.ts:4 shadow",
      "dom.ts:5 backdrop-blur",
      "dom.ts:6 blur",
      "dom.ts:6 leading-3",
      "dom.ts:9 drop-shadow",
      "dom.ts:13 shadow",
      "dom.ts:14 blur",
      "_components/Dialog/index.tsx:4 backdrop-blur",
      "Badge.svelte:5 blur",
      "Badge.svelte:5 shadow",
    ].sort());
  });

  test("a library without Tailwind gets the class check only when its host compiles its class strings", () => {
    const twOf = (app: string) => messages(check(app, "literals").violations).filter((m) => m.startsWith("Tailwind default-scale class "));
    expect(twOf("widgets")).toEqual([]);
    expect(twOf("widgets-utility-classes")).toEqual([expect.stringContaining("class shadow-md (shadow)")]);
    expect(messages(check("widgets-utility-classes", "wiring").violations)).toEqual([]);
  });
});

describe("names", () => {
  test("unknown --ds-* names, notion names and bad token paths fail; valid ones in the same files pass", () => {
    expectExactly(check("unconnected", "names").violations, [
      at("apps/unconnected/src/Widget.tsx", 7, 'token path "color.nope" (cssVar) does not exist'),
      at("apps/unconnected/src/index.css", 7, "--ds-not-a-token is not defined by the current build"),
      at("apps/unconnected/src/index.css", 8, "--ds-color-notion-bg-blue is docs-system compat"),
    ]);
  });

  test("token paths are checked even when another import comes before the design-system one", () => {
    expectExactly(check("names-order", "names").violations.filter((v) => !v.message.includes("--ds-")), [
      at("apps/names-order/src/tokens-use.ts", 4, "tokens.light.color.surface.nope does not exist"),
      at("apps/names-order/src/tokens-use.ts", 5, 'token path "color.surface.page" is not in flat.base'),
    ]);
  });

  test("a name is a prefix only when interpolation or concatenation follows it; a static name cut short fails", () => {
    expectExactly(check("names-order", "names").violations.filter((v) => v.message.includes("--ds-")), [
      at("apps/names-order/src/tokens-use.ts", 9, "--ds-color-surface- is not defined by the current build"),
      at("apps/names-order/src/names.css", 2, "--ds-color-surface- is not defined by the current build"),
    ]);
  });

  test("the docs-system repo may use notion names", () => {
    expectExactly(check("unconnected-docs-system", "names").violations, [
      at("apps/unconnected/src/Widget.tsx", 7, '"color.nope"'),
      at("apps/unconnected/src/index.css", 7, "--ds-not-a-token"),
    ]);
  });
});

describe("shell", () => {
  test("an app without .ds-shell markup or an AppShell copy fails", () => {
    expect(messages(check("unconnected", "shell").violations)).toEqual([expect.stringContaining("renders no .ds-shell markup")]);
  });

  test(".ds-shell markup without .ds-topbar names the missing class", () => {
    expect(check("shell-no-topbar", "shell").violations).toEqual([at("apps/shell-no-topbar/App.tsx", 3, "the .ds-shell markup has no .ds-topbar")]);
  });

  test("a copy of the AppShell template passes; without Topbar/index.tsx it names the missing file", () => {
    expect(check("templated", "shell")).toMatchObject({ status: "pass", violations: [] });
    expect(check("templated-no-topbar", "shell").violations).toContainEqual(
      at("apps/templated-no-topbar/src/_components/AppShell", 0, "AppShell copy is missing _components/Topbar/index.tsx"),
    );
  });

  // shell.ts: "Either of these passes". A hand-written _components/AppShell is not a template copy,
  // but it renders the complete .ds-shell markup.
  test("a template copy that no app file imports fails", () => {
    expect(check("templated-unused", "shell").violations).toEqual([
      at("apps/templated-unused/src/_components/AppShell", 0, "AppShell copy is not imported by any file reachable from the entry (apps/templated-unused/src/main.tsx)"),
    ]);
  });

  test("only rendered markup counts: a class list in a constant, markup beside the shell, a file nothing imports", () => {
    // App.tsx renders .ds-shell; its parts sit in a data attribute (PARTS), in other/Panels.tsx (rendered by
    // main.tsx, outside the shell's subtree) and in legacy/Old.tsx (complete, but nothing imports it).
    expectExactly(
      check("shell-dead", "shell").violations,
      ["ds-sidebar", "ds-sidebar-toggle", "ds-workspace", "ds-topbar", "ds-main"].map((c) =>
        at("apps/shell-dead/src/App.tsx", 4, `the .ds-shell markup has no .${c} in its file or the modules it imports`),
      ),
    );
  });

  test("markup split across a component subtree passes, through a lazy import, an @/ alias and cn() class lists", () => {
    expect(check("shell-split", "shell")).toMatchObject({ status: "pass", violations: [] });
  });

  test("scripts an HTML page loads render into one DOM: markup split across them passes", () => {
    expect(check("shell-page", "shell")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a Next.js app router page counts as rendered: the router reaches it without an import", () => {
    expect(check("shell-next", "shell")).toMatchObject({ status: "pass", violations: [] });
  });

  test("a hand-written AppShell folder that renders the complete .ds-shell markup passes", () => {
    const { status, violations } = check("own-shell", "shell");
    expect({ status, first: violations[0]?.message }).toEqual({ status: "pass", first: undefined });
  });
});

describe("structure", () => {
  test("a flat component, a loose _components/ file and a 401-line file are violations in an app", () => {
    expectExactly(check("unconnected", "structure").violations, [
      at("apps/unconnected/src/Widget.tsx", 0, "component file outside _components/<Name>/index.tsx"),
      at("apps/unconnected/src/_components/helpers.ts", 0, "loose file in _components/"),
      at("apps/unconnected/src/big.ts", 0, "401 lines, over the 400-line limit"),
    ]);
  });

  test("every .tsx file outside _components/<Name>/index.tsx is a component in the wrong place; entry and hook files are not", () => {
    // Not flagged: main.tsx, App.tsx, mdx-components.tsx, src/index.tsx, pages/home/page.tsx, app/layout.tsx, app/not-found.tsx,
    // _components/Shelf/index.tsx, pages/home/_components/Card/index.tsx and its useCard.tsx hook.
    expectExactly(check("wrong-folders", "structure").violations, [
      at("apps/wrong-folders/src/components/Panel/index.tsx", 0, "component file outside _components/<Name>/index.tsx; move it to _components/Panel/index.tsx"),
      at("apps/wrong-folders/src/components/ui/app-sidebar.tsx", 0, "move it to _components/AppSidebar/index.tsx"),
      at("apps/wrong-folders/src/_components/Shelf/ShelfItem.tsx", 0, "component file ShelfItem.tsx in Shelf/; a component folder renders one component"),
      // Next.js file names are entries only inside an app/ or pages/ router folder.
      at("apps/wrong-folders/src/components/icon.tsx", 0, "move it to _components/Icon/index.tsx"),
      at("apps/wrong-folders/src/components/loading.tsx", 0, "move it to _components/Loading/index.tsx"),
    ]);
  });

  test("a library's 401-line file is a warning: status warn, no violations, the app stays ok", () => {
    const [lib] = lint(ws, ds, ["widgets"]).apps;
    const structure = lib.checks.find((c) => c.id === "structure")!;
    expect(structure.status).toBe("warn");
    expect(structure.violations).toEqual([]);
    expect(structure.warnings).toEqual([at("libs/widgets/src/big.ts", 0, "401 lines, over the 400-line limit")]);
    expect(lib.ok).toBe(true);
  });
});
