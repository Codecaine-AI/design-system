/**
 * dist/tailwind/preset-v3.cjs, the Tailwind v3 preset: the utility names and var(--ds-*) values of
 * tailwind.css (the Tailwind v4 theme) for Tailwind 3.4 apps. The first group reads the two published
 * files; the second compiles with the Tailwind 3.4 that Core's apps use.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PKG, parseStylesheet, readText, workspaceRoot } from "./support.ts";

const preset = createRequire(import.meta.url)(join(PKG, "dist/tailwind/preset-v3.cjs"));

/** tailwind.css: its theme keys (the `@theme inline` block plus the `--radius` reference) and its `dark:` selector. */
function tailwindCss(): { theme: Map<string, string>; darkSelector: string } {
  const { blocks, statements } = parseStylesheet(readText("dist/tailwind/theme.css"));
  const theme = new Map(blocks.filter((b) => b.prelude.startsWith("@theme inline")).flatMap((b) => b.declarations));
  const dark = statements.map((s) => /^@custom-variant dark \((.+)\);$/.exec(s)).find(Boolean);
  if (!dark) throw new Error("dist/tailwind/theme.css has no @custom-variant dark");
  return { theme, darkSelector: dark[1] };
}

function v4(theme: Map<string, string>, key: string): string {
  const value = theme.get(key);
  if (value === undefined) throw new Error(`dist/tailwind/theme.css does not define ${key}`);
  return value;
}

/** v4 theme namespace -> the v3 theme sections ("extend.*" = added to v3's defaults) whose utilities it feeds. */
const V3_SECTIONS: Array<[prefix: string, sections: string[]]> = [
  ["--background-color-", ["extend.backgroundColor", "extend.gradientColorStops"]],
  ["--text-color-", ["extend.textColor"]],
  ["--border-color-", ["extend.borderColor"]],
  ["--border-width-", ["extend.borderWidth"]],
  ["--color-", ["colors"]],
  ["--radius-", ["borderRadius"]],
  ["--font-weight-", ["fontWeight"]],
  ["--font-", ["fontFamily"]],
  ["--text-", ["fontSize"]],
  ["--leading-", ["lineHeight"]],
  ["--tracking-", ["letterSpacing"]],
  ["--shadow-", ["boxShadow"]],
  ["--blur-", ["blur", "backdropBlur"]],
  ["--ease-", ["transitionTimingFunction"]],
  ["--z-index-", ["extend.zIndex"]],
  ["--outline-offset-", ["extend.outlineOffset"]],
  ["--container-", ["extend.maxWidth", "extend.width", "extend.minWidth"]],
  ["--height-", ["extend.height"]],
  ["--size-", ["extend.size"]],
  ["--padding-", ["extend.padding"]],
  ["--spacing-", ["extend.spacing"]],
];

type Sections = Record<string, Record<string, unknown>>;

/** What Tailwind 3 passes a color function for a bare utility (bg-page). */
const BARE_UTILITY = { opacityVariable: "--tw-bg-opacity", opacityValue: "var(--tw-bg-opacity, 1)" };

/** The preset's theme as "section" / "extend.section" -> name -> bare value; font sizes as [size, options]. */
function presetSections(): Sections {
  const { extend = {}, ...replaced } = preset.theme;
  const paths = [...Object.entries(replaced), ...Object.entries(extend).map(([name, section]) => [`extend.${name}`, section])];
  return Object.fromEntries(
    paths.map(([path, section]) => [
      path,
      Object.fromEntries(
        Object.entries(section as object).map(([name, value]) => [
          name,
          path === "fontSize" ? (Array.isArray(value) ? value : [value, {}]) : typeof value === "function" ? value(BARE_UTILITY) : value,
        ]),
      ),
    ]),
  );
}

describe("dist/tailwind/preset-v3.cjs", () => {
  test("has tailwind.css's utility names and values, Tailwind's defaults removed, and its dark selector", () => {
    const { theme, darkSelector } = tailwindCss();
    const expected: Sections = {};
    const put = (section: string, name: string, value: unknown) => ((expected[section] ??= {})[name] = value);
    const unmapped: string[] = [];
    for (const [key, value] of theme) {
      if (key === "--spacing" || key === "--radius") continue; // spacing scale and bare `rounded`: below
      const companion = /^--text-(.+)--(line-height|letter-spacing|font-weight)$/.exec(key);
      if (companion) {
        const option = companion[2].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        (expected.fontSize[companion[1]] as [string, Record<string, string>])[1][option] = value;
        continue;
      }
      const ns = V3_SECTIONS.find(([prefix]) => key.startsWith(prefix));
      if (!ns) unmapped.push(key);
      else for (const section of ns[1]) put(section, key.slice(ns[0].length), section === "fontSize" ? [value, {}] : value);
    }
    expect(unmapped).toEqual([]);

    // The only names beyond tailwind.css's keys. Utilities v4 builds in without a theme key (bg-transparent,
    // rounded-none, leading-none, shadow-none, ...), which a replaced v3 section would otherwise lose:
    const builtIns: Sections = {
      colors: { inherit: "inherit", current: "currentColor", transparent: "transparent" },
      borderRadius: { DEFAULT: v4(theme, "--radius"), none: "0px", full: v4(theme, "--radius-pill") },
      lineHeight: { none: "1" },
      boxShadow: { none: "none" },
      dropShadow: { none: "0 0 #0000" },
      blur: { none: "" },
      backdropBlur: { none: "" },
      transitionTimingFunction: { DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)", linear: "linear" },
      // ...and the ring defaults v3 would otherwise fill with its own blue and white.
      "extend.ringColor": { DEFAULT: "currentColor" },
      "extend.ringOffsetColor": { DEFAULT: v4(theme, "--background-color-page") },
    };
    for (const [section, names] of Object.entries(builtIns)) for (const [name, value] of Object.entries(names)) put(section, name, value);

    // Exact equality: a Tailwind default key (white, sm, md) in a replaced section, or a section in the
    // wrong place (theme vs extend), fails here.
    const { spacing, ...actual } = presetSections();
    expect(actual).toEqual(expected);
    // v4 multiplies --spacing; v3 lists keys (checked against Tailwind's own below), each --spacing times the key.
    const step = (key: string) => (key === "px" ? "1px" : key === "0" ? "0px" : `calc(${v4(theme, "--spacing")} * ${key})`);
    expect(Object.keys(spacing)).toContain("1");
    expect(spacing).toEqual(Object.fromEntries(Object.keys(spacing).map((key) => [key, step(key)])));

    expect(preset.darkMode).toEqual(["variant", darkSelector]);
    expect(Object.keys(preset).sort()).toEqual(["darkMode", "theme"]); // no content, plugins or corePlugins
  });
});

/** Tailwind 3.4 and PostCSS as Core's v3 apps resolve them; null when the workspace or its install is absent. */
function tailwind3(): { tailwind: any; postcss: any; defaultTheme: any } | null {
  const root = workspaceRoot();
  if (!root) return null;
  try {
    const require = createRequire(join(root, "codecaine/core/package.json"));
    if (!require("tailwindcss/package.json").version.startsWith("3.4.")) return null;
    return { tailwind: require("tailwindcss"), postcss: require("postcss"), defaultTheme: require("tailwindcss/defaultTheme") };
  } catch {
    return null;
  }
}

const tw = tailwind3();

const GENERATES = [
  "bg-page", "text-ink", "border-rule", "bg-blue-soft", "bg-page/50", "p-1", "rounded", "rounded-lg", "rounded-pill",
  "text-ui-sm", "text-reading", "font-medium", "shadow-glass", "z-popover", "max-w-lane-text", "dark:bg-panel", "ring",
];
const TAILWIND_DEFAULTS = ["bg-red-500", "bg-white", "text-sm", "shadow-md", "font-light", "drop-shadow-md"];

interface Rule {
  selector: string;
  decls: Record<string, string>;
}

let compiled: Promise<Rule[]> | undefined;

/** One compile of every candidate above, with the preset and nothing else. */
function compile(): Promise<Rule[]> {
  compiled ??= tw!.postcss([
    tw!.tailwind({ presets: [preset], content: [{ raw: [...GENERATES, ...TAILWIND_DEFAULTS].join(" ") }], corePlugins: { preflight: false } }),
  ])
    .process("@tailwind base;\n@tailwind utilities;", { from: undefined })
    .then((result: any) => {
      const rules: Rule[] = [];
      result.root.walkRules((rule: any) => {
        const decls: Record<string, string> = {};
        rule.walkDecls((decl: any) => {
          decls[decl.prop] = decl.value;
        });
        rules.push({ selector: rule.selector, decls });
      });
      return rules;
    });
  return compiled;
}

/** A value with var() references to custom properties declared in the same rule substituted. */
function local(decls: Record<string, string>, value: string | undefined): string | undefined {
  return value?.replace(/var\((--[\w-]+)\)/g, (ref, name: string) => (name in decls ? (local(decls, decls[name]) ?? ref) : ref));
}

/** The expectations no compiled rule meets, each with the declarations its selector's rules hold instead. */
function missing(rules: Rule[], want: Array<[selector: string, decls: Record<string, string>]>): string[] {
  return want
    .filter(([selector, decls]) => !rules.some((r) => r.selector === selector && Object.entries(decls).every(([p, v]) => local(r.decls, r.decls[p]) === v)))
    .map(([selector, decls]) => `${selector}: want ${JSON.stringify(decls)}, got ${JSON.stringify(rules.filter((r) => r.selector === selector).map((r) => r.decls))}`);
}

describe.skipIf(!tw)(`Tailwind 3.4 with the preset${tw ? "" : " (skipped: no Tailwind 3.4 under codecaine/core)"}`, () => {
  test("design-system utilities compile to tailwind.css's var(--ds-*) values, `dark:` on data-theme and .dark", async () => {
    const { theme } = tailwindCss();
    const v = (key: string) => v4(theme, key);
    const want: Array<[selector: string, decls: Record<string, string>]> = [
      [".bg-page", { "background-color": v("--background-color-page") }],
      [".text-ink", { color: v("--text-color-ink") }],
      [".border-rule", { "border-color": v("--border-color-rule") }],
      [".bg-blue-soft", { "background-color": v("--color-blue-soft") }],
      [".bg-page\\/50", { "background-color": `color-mix(in oklab, ${v("--background-color-page")} 50%, transparent)` }],
      [".p-1", { padding: `calc(${v("--spacing")} * 1)` }],
      [".rounded", { "border-radius": v("--radius") }],
      [".rounded-lg", { "border-radius": v("--radius-lg") }],
      [".rounded-pill", { "border-radius": v("--radius-pill") }],
      [".text-ui-sm", { "font-size": v("--text-ui-sm") }],
      [".text-reading", { "font-size": v("--text-reading"), "line-height": v("--text-reading--line-height") }],
      [".font-medium", { "font-weight": v("--font-weight-medium") }],
      // v3 also reads shadow-glass as the shadow color `glass` (--color-glass); the shadow it applies is still the token.
      [".shadow-glass", { "--tw-shadow": v("--shadow-glass") }],
      [".z-popover", { "z-index": v("--z-index-popover") }],
      [".max-w-lane-text", { "max-width": v("--container-lane-text") }],
      ['.dark\\:bg-panel:where([data-theme="dark"], [data-theme="dark"] *, .dark, .dark *)', { "background-color": v("--background-color-panel") }],
      // `ring` pulls in the ring defaults: currentColor and the page surface, not v3's blue and white.
      ["*, ::before, ::after", { "--tw-ring-color": "currentColor", "--tw-ring-offset-color": v("--background-color-page") }],
    ];
    expect(missing(await compile(), want)).toEqual([]);
  });

  test("Tailwind's default palette and scales do not generate", async () => {
    const generated = new Set((await compile()).map((r) => r.selector));
    expect(generated.has(".bg-page")).toBe(true); // the same content was scanned
    expect(TAILWIND_DEFAULTS.filter((name) => generated.has(`.${name}`))).toEqual([]);
  });

  test("spacing keeps Tailwind 3's default keys", () => {
    expect(Object.keys(preset.theme.spacing).sort()).toEqual(Object.keys(tw!.defaultTheme.spacing).sort());
  });
});
