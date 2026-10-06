/**
 * R2-B1 W2: the Tailwind v3 config check (tailwind-config.ts), the config in the literal scan
 * (workspace.ts scanSetup) and the Tailwind 4.3 additions to the default-scale list (tailwind-scale.ts).
 * Fixture apps: test/fixtures/lint/workspace/apps/r2c-*.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadDesignSystem, type DesignSystemBuild } from "../scripts/lib/lint/design-system";
import { exportsPreset, presetProblems, presetThemeKeys } from "../scripts/lib/lint/tailwind-config";
import { findDefaultScaleClasses } from "../scripts/lib/lint/tailwind-scale";
import type { Finding } from "../scripts/lib/lint/types";
import { appEntry, checkEntry, lintEntries, materialize, type Workspace } from "./lint-support";
import { PKG } from "./support";

let ws: Workspace;
let ds: DesignSystemBuild;

beforeAll(() => {
  ws = materialize();
  ds = loadDesignSystem();
});
afterAll(() => ws?.cleanup());

const P = `"@codecaine-ai/design-system/tailwind-v3-preset"`;
const at = (file: string, line: number, message: string) => ({ file, line, message: expect.stringContaining(message) });
const V3 = { summary: "Tailwind v3 (fixture)", tailwind: "v3", packageManager: "bun" } as const;
const v3App = (name: string) => appEntry({ id: name, root: `apps/${name}`, stack: V3 });
/** Wiring findings about the app's Tailwind config. */
const configFindings = (name: string): Finding[] =>
  checkEntry(ws, ds, v3App(name), "wiring").violations.filter((v) => v.file.includes("tailwind.config"));

describe("exportsPreset: the effective exported config uses the preset and nothing undoes it", () => {
  // The reviewer's probe cases (/tmp/r2b-lint/p-preset.ts), then the forms the fix adds.
  test.each<[string, string, boolean]>([
    ["plain", `module.exports = { presets: [require(${P})] };`, true],
    ["preset then defaultConfig preset", `module.exports = { presets: [require(${P}), require("tailwindcss/defaultConfig")] };`, false],
    ["presets then reassigned exports", `module.exports = { presets: [require(${P})] };\nmodule.exports = { content: [] };`, false],
    ["exports.presets mutated", `module.exports = { presets: [require(${P})] };\nmodule.exports.presets = [];`, false],
    ["duplicate presets key, last empty", `module.exports = { presets: [require(${P})], presets: [] };`, false],
    ["theme colors back", `module.exports = { presets: [require(${P})], theme: { colors: require("tailwindcss/colors") } };`, false],
    [
      "extend colors gray",
      `const colors = require("tailwindcss/colors");\nmodule.exports = { presets: [require(${P})], theme: { extend: { colors: { gray: colors.gray }, fontSize: { sm: "14px" } } } };`,
      false,
    ],
    ["ts satisfies", `import preset from ${P};\nexport default { presets: [preset] } satisfies Config;`, true],
    ["inside string", `const s = "module.exports = { presets: [require(${P.replaceAll('"', "'")})] }";\nmodule.exports = { presets: [] };`, false],
    ["commented", `// module.exports = { presets: [require(${P})] };\nmodule.exports = { presets: [] };`, false],
    ["binding shadowed", `const preset = require(${P});\nfunction f(){ const preset = {}; return preset }\nmodule.exports = { presets: [preset] };`, true],
    ["exports.presets set later with the preset", `module.exports = { presets: [] };\nmodule.exports.presets = [require(${P})];`, true],
    ["bare exports.presets", `exports.presets = [require(${P})];\nexports.content = ["./src/**/*.tsx"];`, true],
    ["exported binding mutated", `const config = { presets: [require(${P})] };\nexport default config;\nconfig.presets = [];`, false],
    ["bracket write", `module.exports = { presets: [require(${P})] };\nmodule.exports["presets"] = [];`, false],
    ["Object.assign onto module.exports", `module.exports = { presets: [require(${P})] };\nObject.assign(module.exports, { presets: [] });`, false],
    ["Object.assign without presets", `module.exports = { presets: [require(${P})] };\nObject.assign(module.exports, { content: [] });`, true],
    ["spread after presets", `module.exports = { presets: [require(${P})], ...shared };`, false],
    ["spread and no presets key", `module.exports = { ...shared, content: [] };`, false],
    ["spread before presets", `module.exports = { ...shared, presets: [require(${P})] };`, true],
    ["spread of a local object without presets", `const base = { content: [] };\nmodule.exports = { presets: [require(${P})], ...base };`, true],
    ["computed key after presets", `const k = "presets";\nmodule.exports = { presets: [require(${P})], [k]: [] };`, false],
    ["interop fallback on the preset binding", `const ds = require(${P});\nmodule.exports = { presets: [ds.default ?? ds] };`, true],
    ["another local preset", `const base = require("./base.cjs");\nmodule.exports = { presets: [require(${P}), base] };`, false],
    ["theme.spacing outside extend", `module.exports = { presets: [require(${P})], theme: { spacing: { 1: "4px" } } };`, false],
    ["theme.screens outside extend (the preset does not own it)", `module.exports = { presets: [require(${P})], theme: { screens: { tablet: "40rem" } } };`, true],
    ["theme.extend.colors", `module.exports = { presets: [require(${P})], theme: { extend: { colors: { brand: "var(--ds-color-accent)" } } } };`, true],
    ["import of tailwindcss/defaultTheme", `import defaultTheme from "tailwindcss/defaultTheme";\nexport default { presets: [require(${P})] };`, false],
    ["tailwindcss/colors in a comment", `// const colors = require("tailwindcss/colors");\nmodule.exports = { presets: [require(${P})] };`, true],
  ])("%s", (_label, src, want) => {
    expect(exportsPreset(src)).toBe(want);
  });
});

describe("presetProblems messages", () => {
  const keys = () => presetThemeKeys(PKG);
  const problems = (src: string) => presetProblems(src, keys()).map((p) => p.message);

  test("the theme keys come from the build's preset-v3.cjs", () => {
    expect([...keys()].sort()).toEqual(expect.arrayContaining(["colors", "fontSize", "spacing", "boxShadow", "borderRadius"]));
    expect(keys().has("extend")).toBe(false);
    expect(keys().has("screens")).toBe(false);
  });

  test("another preset is named; a default import names the module; a non-extend theme key says to move it", () => {
    expect(problems(`const base = require("./base.cjs");\nmodule.exports = { presets: [require(${P}), base] };`)).toEqual([
      expect.stringContaining("presets also holds base"),
    ]);
    // In source order: the theme.colors key comes before the require in its value.
    expect(problems(`module.exports = { presets: [require(${P})], theme: { colors: require("tailwindcss/colors") } };`)).toEqual([
      expect.stringContaining("theme.colors replaces the preset's colors; move it under theme.extend"),
      expect.stringContaining("loads tailwindcss/colors"),
    ]);
  });

  test("a spread that could override presets is reported as unchecked", () => {
    expect(problems(`module.exports = { presets: [require(${P})], ...shared };`)).toEqual([expect.stringContaining("...shared could override presets")]);
  });
});

describe("wiring: fixture v3 configs that undo the preset", () => {
  test("a config reassigned later, or its presets mutated, does not use the preset", () => {
    expect(configFindings("r2c-reassigned")).toEqual([at("apps/r2c-reassigned/tailwind.config.cjs", 6, "does not use the preset")]);
    expect(configFindings("r2c-mutated")).toEqual([at("apps/r2c-mutated/tailwind.config.cjs", 5, "does not use the preset")]);
  });

  test("with duplicate presets keys the last one wins", () => {
    expect(configFindings("r2c-dupkey")).toEqual([at("apps/r2c-dupkey/tailwind.config.cjs", 4, "does not use the preset (the last presets key wins)")]);
  });

  test("another entry in presets is a violation that names it", () => {
    expect(configFindings("r2c-other-preset")).toEqual([at("apps/r2c-other-preset/tailwind.config.cjs", 4, "presets also holds base")]);
  });

  test("tailwindcss/colors and a non-extend theme key the preset owns are violations; screens and theme.extend are not", () => {
    const rel = "apps/r2c-theme/tailwind.config.cjs";
    expect(configFindings("r2c-theme")).toEqual([
      at(rel, 1, "loads tailwindcss/colors"),
      at(rel, 7, "theme.colors replaces the preset's colors; move it under theme.extend"),
    ]);
  });
});

describe("literals: the app's Tailwind config is in the literal scan", () => {
  test("a v3 config above the app root: its hard literal counts in the hard total and its safelist is a default-scale class", () => {
    const entry = appEntry({ id: "r2c-up", root: "apps/r2c-up/web", repo: "apps/r2c-up", stack: V3 });
    const [app] = lintEntries(ws, ds, [entry]).apps;
    expect(app.literals.hard).toBe(1);
    const rel = "apps/r2c-up/tailwind.config.cjs";
    const literals = app.checks.find((c) => c.id === "literals")!;
    expect(literals.violations).toContainEqual(at(rel, 5, "hard literal #ff0000"));
    expect(literals.violations).toContainEqual(at(rel, 4, "Tailwind default-scale class bg-red-500 (palette color)"));
    expect(checkEntry(ws, ds, entry, "wiring").violations.filter((v) => v.file === rel)).toEqual([]);
  });

  test("any app's tailwind.config.* in the app root is scanned once, also when a scan path already holds it", () => {
    const outside = appEntry({ id: "r2c-v4", root: "apps/r2c-v4" });
    const inside = appEntry({ id: "r2c-v4-root-scan", root: "apps/r2c-v4", scan: { paths: ["apps/r2c-v4"], exclude: [] } });
    const [a, b] = lintEntries(ws, ds, [outside, inside]).apps;
    for (const app of [a, b]) {
      expect(app.literals.hard).toBe(1);
      expect(app.checks.find((c) => c.id === "literals")!.violations).toContainEqual(at("apps/r2c-v4/tailwind.config.js", 1, "hard literal #00ff00"));
    }
  });
});

describe("default-scale classes: Tailwind 4.3 hues and container utilities", () => {
  const classes = (src: string, kind: "js" | "html" | "css" = "js") => findDefaultScaleClasses(src, kind).map((h) => h.className);
  const scales = (src: string, kind: "js" | "html" | "css" = "js") => findDefaultScaleClasses(src, kind).map((h) => `${h.className} ${h.scale}`);

  test("new hues 4.3: mauve, olive, mist and taupe are palette colors", () => {
    expect(classes(`<div className="bg-mauve-500 text-olive-700 border-mist-200 ring-taupe-400" />`)).toEqual([
      "bg-mauve-500",
      "text-olive-700",
      "border-mist-200",
      "ring-taupe-400",
    ]);
  });

  test("logical container sizes and columns with a container step are container sizes", () => {
    expect(scales(`<div className="max-inline-2xl inline-md min-inline-xs columns-3xs" />`)).toEqual([
      "max-inline-2xl container size",
      "inline-md container size",
      "min-inline-xs container size",
      "columns-3xs container size",
    ]);
  });

  test("inline, inline-flex, inline-block, columns-2, columns-3 and columns-auto are not container sizes", () => {
    expect(classes(`<div className="inline inline-flex inline-block columns-2 columns-3 columns-auto" />`)).toEqual([]);
  });

  test("@container variant: the default container sizes in @<step>:, @max-, @min- and named containers", () => {
    expect(scales(`<div className="@md:flex @max-2xl:hidden" />`)).toEqual(["@md: container size", "@max-2xl: container size"]);
    expect(classes(`const c = "dark:@min-lg:grid @md/main:flex @3xs:block @7xl:hidden";`)).toEqual(["@min-lg:", "@md/main:", "@3xs:", "@7xl:"]);
  });

  test("@container, @container/main and arbitrary container values do not match", () => {
    expect(classes(`<div className="@container @container/main @[500px]:flex @min-[400px]:grid @max-[30rem]:hidden" />`)).toEqual([]);
    expect(classes(`const mail = "write to user@md: soon";`)).toEqual([]);
  });

  test("container variants match in class attributes and @apply too", () => {
    expect(classes(`<div class="@md:flex inline-lg"></div>`, "html")).toEqual(["@md:", "inline-lg"]);
    expect(classes(`.card { @apply @lg:grid columns-xs; }`, "css")).toEqual(["@lg:", "columns-xs"]);
  });
});
