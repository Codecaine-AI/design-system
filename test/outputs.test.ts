/**
 * Contracts of the published artifacts: tokens.css, the JS module, the Tailwind theme, the guides
 * and package.json. Each test reads what a consumer reads.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MD_BEGIN, MD_END } from "../scripts/build.ts";
import {
  computeInTheme,
  computePinned,
  cssVarOf,
  declaredVars,
  PKG,
  parseCss,
  parseStylesheet,
  readJson,
  readText,
  SELECTORS,
  THEMES,
  tokensCss,
  varRefs,
} from "./support.ts";

const CUSTOM_PROPERTY = /^--ds-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every token path: base paths, then theme paths (both themes share them). */
function allPaths(): string[] {
  return [...Object.keys(readJson("dist/json/base.json")), ...Object.keys(readJson("dist/json/light.json"))];
}

describe("dist/css/tokens.css", () => {
  test("holds --ds-* custom properties only: :root, then the light block, then the dark block", () => {
    const blocks = parseCss(readText("dist/css/tokens.css")); // throws on any text outside a block
    // Order is behavior: the dark block must follow `:root, ...light` to win at equal specificity.
    expect(blocks.map((b) => b.prelude)).toEqual([SELECTORS.root, SELECTORS.light, SELECTORS.dark]);
    for (const { prelude, declarations } of blocks) {
      const names = declarations.map(([property]) => property);
      expect({ prelude, invalid: declarations.filter(([p, value]) => !CUSTOM_PROPERTY.test(p) || !value) }).toEqual({ prelude, invalid: [] });
      expect({ prelude, repeated: names.filter((n, i) => names.indexOf(n) !== i) }).toEqual({ prelude, repeated: [] });
    }
  });

  test("light and dark share their token paths: JSON keys, switch blocks and pinned variables", () => {
    const paths = Object.keys(readJson("dist/json/light.json"));
    expect(Object.keys(readJson("dist/json/dark.json")).sort()).toEqual([...paths].sort());
    const css = tokensCss();
    for (const theme of THEMES) {
      // Each switch block points every --ds-<path> at the theme's pinned --ds-<theme>-<path>, and nothing else.
      expect(Object.fromEntries(css[theme])).toEqual(Object.fromEntries(paths.map((p) => [cssVarOf(p), `var(${cssVarOf(p, theme)})`])));
      // :root declares the pinned variable for every theme path.
      expect(paths.map((p) => cssVarOf(p, theme)).filter((name) => !css.root.has(name))).toEqual([]);
    }
  });

  test("every variable computes to its resolved value from dist/json, in light and in dark", () => {
    const css = tokensCss();
    const wrong: string[] = [];
    const expectValue = (label: string, compute: () => string, want: unknown) => {
      let got: string;
      try {
        got = compute();
      } catch (error) {
        wrong.push(`${label}: ${(error as Error).message}`);
        return;
      }
      if (got !== String(want)) wrong.push(`${label}: ${got} (expected ${want})`);
    };
    for (const [path, value] of Object.entries(readJson("dist/json/base.json"))) {
      expectValue(cssVarOf(path), () => computePinned(css, cssVarOf(path)), value);
    }
    for (const theme of THEMES) {
      for (const [path, value] of Object.entries(readJson(`dist/json/${theme}.json`))) {
        expectValue(cssVarOf(path, theme), () => computePinned(css, cssVarOf(path, theme)), value);
        expectValue(`${cssVarOf(path)} in ${theme}`, () => computeInTheme(css, theme, cssVarOf(path)), value);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("dist/js", () => {
  test("exports resolved values and cssVar()", async () => {
    const js = await import("../dist/js/index.js");
    expect(js.tokens.light.color.surface.page).toBe("#fdfdfd");
    expect(js.flat.base["space.1"]).toBe("4px");
    expect(js.cssVar("space.2")).toBe("var(--ds-space-2)");
    expect(js.cssVar("color.surface.page")).toBe("var(--ds-color-surface-page)");
    expect(js.cssVar("color.surface.page", "dark")).toBe("var(--ds-dark-color-surface-page)");
    expect(() => js.cssVar("color.surface.nope")).toThrow(/color\.surface\.nope/);
    expect(() => js.cssVar("color.surface.page", "sepia")).toThrow(/sepia/);
  });

  test("flat and nested values match dist/json", async () => {
    const js = await import("../dist/js/index.js");
    for (const scope of ["base", ...THEMES]) expect(js.flat[scope]).toEqual(readJson(`dist/json/${scope}.json`));
    expect(js.tokens).toEqual(readJson("dist/json/tokens.json"));
  });

  test("index.d.ts declares cssVar and the TokenPath type", () => {
    const dts = readText("dist/js/index.d.ts");
    expect(dts).toMatch(/export (?:declare )?function cssVar\([^)]*\bTokenPath\b/);
    expect(dts).toMatch(/export type TokenPath\b/);
  });
});

describe("dist/tailwind/theme.css", () => {
  test("maps Tailwind keys onto --ds-* variables in one @theme inline block, each key once", () => {
    const main = parseStylesheet(readText("dist/tailwind/theme.css")).blocks.filter((b) => b.prelude === "@theme inline");
    expect(main).toHaveLength(1);
    const keys = main[0].declarations.map(([key]) => key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const theme = new Map(main[0].declarations);
    expect(theme.get("--spacing")).toBe("var(--ds-space-1)");
    expect(theme.get("--background-color-page")).toBe("var(--ds-color-surface-page)");
    expect(theme.get("--text-color-ink")).toBe("var(--ds-color-text-ink)");
    expect(theme.get("--border-color-rule")).toBe("var(--ds-color-border-default)");
  });

  test("references only declared variables, never a theme-pinned one (utilities follow data-theme)", () => {
    const refs = [...varRefs(readText("dist/tailwind/theme.css"))];
    const declared = declaredVars();
    const pinned = new Set(THEMES.flatMap((t) => Object.keys(readJson(`dist/json/${t}.json`)).map((p) => cssVarOf(p, t))));
    expect(refs).toContain("--ds-color-surface-page");
    expect(refs.filter((name) => !declared.has(name))).toEqual([]);
    expect(refs.filter((name) => pinned.has(name))).toEqual([]);
  });

  test("redefines `dark:` with the dark block's selectors, so it follows data-theme instead of the OS", () => {
    const { statements } = parseStylesheet(readText("dist/tailwind/theme.css"));
    const own = SELECTORS.dark.split(", ").flatMap((selector) => [selector, `${selector} *`]);
    expect(statements).toEqual([`@custom-variant dark (&:where(${own.join(", ")}));`]);
    expect(statements[0]).toBe('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *, .dark, .dark *));');
  });
});

describe("dist/tailwind/strict.css", () => {
  test("is one @theme block that resets Tailwind's default palette, type, radius and shadow namespaces", () => {
    const blocks = parseCss(readText("dist/tailwind/strict.css"));
    expect(blocks.map((b) => b.prelude)).toEqual(["@theme"]);
    const resets = blocks[0].declarations;
    expect(resets.filter(([namespace, value]) => !/^--[a-z]+(?:-[a-z]+)*-\*$/.test(namespace) || value !== "initial")).toEqual([]);
    const namespaces = resets.map(([namespace]) => namespace);
    expect(namespaces).toEqual(
      expect.arrayContaining(["--color-*", "--text-*", "--shadow-*", "--inset-shadow-*", "--drop-shadow-*", "--radius-*", "--font-*", "--font-weight-*"]),
    );
    // Spacing, breakpoints, containers and animations stay.
    expect(namespaces.filter((n) => ["--spacing-*", "--breakpoint-*", "--container-*", "--animate-*"].includes(n))).toEqual([]);
  });
});

describe("css/layout.css", () => {
  test("uses only variables declared in tokens.css", () => {
    const refs = [...varRefs(readText("css/layout.css"))];
    const declared = declaredVars();
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((name) => !declared.has(name))).toEqual([]);
  });
});

describe("guides", () => {
  test("guide/tokens.md has one generated reference region with a row for every token", () => {
    const md = readText("guide/tokens.md");
    expect(md.split(MD_BEGIN)).toHaveLength(2);
    expect(md.split(MD_END)).toHaveLength(2);
    const begin = md.indexOf(MD_BEGIN);
    const end = md.indexOf(MD_END);
    expect(begin).toBeLessThan(end);
    const region = md.slice(begin, end);
    const rows = new Set([...region.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]));
    expect(rows.has("color.surface.page")).toBe(true);
    expect(allPaths().filter((path) => !rows.has(path))).toEqual([]);
  });

  test("dist/guide/index.html links ../css/tokens.css and uses only declared variables", () => {
    const html = readText("dist/guide/index.html");
    const hrefs = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toContain("../css/tokens.css");
    expect(existsSync(join(PKG, "dist/guide", "../css/tokens.css"))).toBe(true);
    const refs = [...varRefs(html)];
    const declared = declaredVars();
    expect(refs).toContain("--ds-color-surface-page");
    expect(refs.filter((name) => !declared.has(name))).toEqual([]);
  });

  test.if(existsSync(join(PKG, "guide/app-shell-demo.html")))("dist/guide/index.html loads the fonts.css guide/app-shell-demo.html loads", () => {
    const fontLinks = (path: string) =>
      [...readText(path).matchAll(/<link\b[^>]*\bhref="([^"]+\/fonts\.css)"/g)].map((m) => resolve(PKG, dirname(path), m[1]));
    const guide = fontLinks("dist/guide/index.html");
    expect(guide).toHaveLength(1);
    expect(guide).toEqual(fontLinks("guide/app-shell-demo.html"));
  });
});

describe("package.json", () => {
  const pkg = readJson("package.json");

  test("is the private, dependency-free ES module @codecaine-ai/design-system 0.1.0", () => {
    expect(pkg).toMatchObject({ name: "@codecaine-ai/design-system", version: "0.1.0", private: true, type: "module" });
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) expect(pkg).not.toHaveProperty(key);
  });

  test("exports resolve to the files the package ships", () => {
    const resolveExport = (subpath: string) => relative(PKG, Bun.resolveSync(`${pkg.name}${subpath}`, PKG));
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining([".", "./tokens.css", "./layout.css", "./tailwind.css", "./tailwind-strict.css", "./json/*", "./package.json"]),
    );
    // Every condition's target exists (Bun resolves only its own conditions; Tailwind and Vite read "style").
    const targets = (entry: unknown): string[] =>
      typeof entry === "string" ? [entry] : entry && typeof entry === "object" ? Object.values(entry).flatMap(targets) : [];
    const onDisk = (target: string) => existsSync(join(PKG, target.includes("*") ? target.slice(0, target.indexOf("*")) : target));
    expect(targets(pkg.exports).filter((target) => !onDisk(target))).toEqual([]);
    expect(resolveExport("")).toBe("dist/js/index.js");
    expect(relative(PKG, join(PKG, pkg.exports["."].types))).toBe("dist/js/index.d.ts");
    expect(resolveExport("/tokens.css")).toBe("dist/css/tokens.css");
    expect(resolveExport("/layout.css")).toBe("css/layout.css");
    expect(resolveExport("/tailwind.css")).toBe("dist/tailwind/theme.css");
    expect(resolveExport("/tailwind-strict.css")).toBe("dist/tailwind/strict.css");
    for (const name of ["base", ...THEMES, "tokens"]) expect(resolveExport(`/json/${name}.json`)).toBe(`dist/json/${name}.json`);
    expect(resolveExport("/package.json")).toBe("package.json");
  });

  test("has build, check and test scripts", () => {
    expect(pkg.scripts.build).toContain("scripts/build.ts");
    expect(pkg.scripts.check).toMatch(/scripts\/build\.ts.*--check/);
    expect(pkg.scripts.test).toContain("bun test");
  });
});
