/**
 * dist/tailwind/preset-v3.cjs: the utility names of tailwind.css (the Tailwind v4 theme) as a Tailwind 3.4 preset.
 *
 * Generated from tailwindEntries(), the list that writes tailwind.css's `@theme inline` block, so the two
 * cannot drift. Each v4 theme key lands in a v3 theme section by its namespace (NAMESPACES). The sections
 * strict.css clears in v4 (palette, type, radius, shadow, blur, easing) replace v3's defaults; the scales
 * v4 keeps (z-index, widths, heights, padding) extend them. A key with no namespace fails the build.
 */
import { cssName, darkVariant, GENERATED_NOTE, type Model, type TailwindEntry, tailwindEntries, TokenError } from "../build.ts";

/** A JavaScript expression in the generated module. */
type Js = string;
/** One theme section: key -> value expression, in output order. */
type Section = Map<string, Js>;

interface Namespace {
  /** v4 theme key prefix, e.g. "--background-color-". */
  prefix: string;
  /** v3 sections the key lands in. "extend.*" adds to v3's defaults; the others replace them. */
  sections: string[];
  /** Values go through the generated color() helper, so opacity modifiers work. */
  color?: boolean;
}

/** v4 namespace -> v3 sections. The first matching prefix wins, so longer prefixes come first. */
const NAMESPACES: Namespace[] = [
  // v4 reads --background-color-* for bg-* and the gradient stops (from-*, via-*, to-*).
  { prefix: "--background-color-", sections: ["extend.backgroundColor", "extend.gradientColorStops"], color: true },
  { prefix: "--text-color-", sections: ["extend.textColor"], color: true },
  { prefix: "--border-color-", sections: ["extend.borderColor"], color: true },
  { prefix: "--border-width-", sections: ["extend.borderWidth"] },
  { prefix: "--color-", sections: ["colors"], color: true },
  { prefix: "--radius-", sections: ["borderRadius"] },
  { prefix: "--font-weight-", sections: ["fontWeight"] },
  { prefix: "--font-", sections: ["fontFamily"] },
  { prefix: "--leading-", sections: ["lineHeight"] },
  { prefix: "--tracking-", sections: ["letterSpacing"] },
  { prefix: "--shadow-", sections: ["boxShadow"] },
  { prefix: "--blur-", sections: ["blur", "backdropBlur"] },
  { prefix: "--ease-", sections: ["transitionTimingFunction"] },
  { prefix: "--z-index-", sections: ["extend.zIndex"] },
  { prefix: "--outline-offset-", sections: ["extend.outlineOffset"] },
  { prefix: "--container-", sections: ["extend.maxWidth", "extend.width", "extend.minWidth"] },
  { prefix: "--height-", sections: ["extend.height"] },
  { prefix: "--size-", sections: ["extend.size"] },
  { prefix: "--padding-", sections: ["extend.padding"] },
  { prefix: "--spacing-", sections: ["extend.spacing"] },
];

/** Sections that replace v3's defaults (the namespaces strict.css clears in v4), in output order. */
const REPLACED = [
  "colors",
  "spacing",
  "borderRadius",
  "fontFamily",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "boxShadow",
  "dropShadow",
  "blur",
  "backdropBlur",
  "transitionTimingFunction",
];

/** `--text-<size>--<companion>`: the property a font size utility sets with it. */
const FONT_SIZE_COMPANIONS: Record<string, string> = {
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing",
  "font-weight": "fontWeight",
};

/** v3's default spacing keys. v4 multiplies --spacing by any number; v3 needs the keys listed. */
const V3_SPACING_KEYS = [
  "px", "0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6", "7", "8", "9", "10", "11", "12",
  "14", "16", "20", "24", "28", "32", "36", "40", "44", "48", "52", "56", "60", "64", "72", "80", "96",
];

const str = (value: string): Js => JSON.stringify(value);
const colorOf = (value: string): Js => `color(${str(value)})`;

/**
 * Utilities v4 builds in without a theme key, so they survive strict.css: bg-transparent, bg-current,
 * bg-inherit, rounded-none, leading-none, shadow-none, drop-shadow-none, blur-none, ease-linear, and
 * `transition`'s default easing. A replaced v3 section would lose them, so they are added back.
 */
const V4_BUILT_INS: Record<string, Array<[key: string, value: Js]>> = {
  colors: [["inherit", str("inherit")], ["current", colorOf("currentColor")], ["transparent", str("transparent")]],
  borderRadius: [["none", str("0px")]],
  lineHeight: [["none", str("1")]],
  boxShadow: [["none", str("none")]],
  dropShadow: [["none", str("0 0 #0000")]],
  blur: [["none", str("")]],
  transitionTimingFunction: [["DEFAULT", str("cubic-bezier(0.4, 0, 0.2, 1)")], ["linear", str("linear")]],
};

interface Preset {
  /** Section path ("colors", "extend.zIndex") -> its entries, in output order. */
  sections: Map<string, Section>;
  /** A section several paths share (bg and gradient stops, the three widths) -> its const name. */
  shared: Map<Section, string>;
}

const camel = (text: string) => text.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function presetSections(model: Model): Preset {
  const sections = new Map<string, Section>(REPLACED.map((path) => [path, new Map()]));
  const shared = new Map<Section, string>();
  const sectionOf = (ns: Namespace): Section => {
    const existing = sections.get(ns.sections[0]);
    if (existing && (ns.sections.length === 1 || shared.has(existing))) return existing;
    const section: Section = existing ?? new Map();
    if (ns.sections.length > 1) shared.set(section, camel(ns.prefix.slice(2, -1)));
    for (const path of ns.sections) sections.set(path, section);
    return section;
  };
  for (const [path, entries] of Object.entries(V4_BUILT_INS)) {
    const ns = NAMESPACES.find((n) => n.sections[0] === path);
    const section = ns ? sectionOf(ns) : sections.get(path)!;
    for (const [key, value] of entries) section.set(key, value);
  }
  const radius = sections.get("borderRadius")!;
  if (model.base.has("radius.base")) radius.set("DEFAULT", str(`var(${cssName("radius.base")})`));

  const unmapped: string[] = [];
  const sizes = new Map<string, { size?: string; options: Array<[string, string]> }>();
  const sizeOf = (key: string) => sizes.get(key) ?? sizes.set(key, { options: [] }).get(key)!;
  for (const entry of tailwindEntries(model)) {
    if (entry.key === "--spacing") {
      const spacing = sections.get("spacing")!;
      for (const key of V3_SPACING_KEYS) {
        spacing.set(key, str(key === "px" ? "1px" : key === "0" ? "0px" : `calc(${entry.value} * ${key})`));
      }
      continue;
    }
    const ns = NAMESPACES.find((n) => entry.key.startsWith(n.prefix));
    if (ns) {
      const key = entry.key.slice(ns.prefix.length);
      sectionOf(ns).set(key, ns.color ? colorOf(entry.value) : str(entry.value));
    } else if (entry.key.startsWith("--text-")) {
      const [size, companion, ...rest] = entry.key.slice("--text-".length).split("--");
      if (companion === undefined) sizeOf(size).size = entry.value;
      else if (Object.hasOwn(FONT_SIZE_COMPANIONS, companion) && !rest.length) sizeOf(size).options.push([FONT_SIZE_COMPANIONS[companion], entry.value]);
      else unmapped.push(describe(entry));
    } else {
      unmapped.push(describe(entry));
    }
  }
  const fontSize = sections.get("fontSize")!;
  for (const [key, { size, options }] of sizes) {
    if (size === undefined) {
      unmapped.push(`--text-${key}--* (companions of a font size tailwind.css does not define)`);
      continue;
    }
    const pairs = options.map(([prop, value]) => `${prop}: ${str(value)}`).join(", ");
    fontSize.set(key, options.length ? `[${str(size)}, { ${pairs} }]` : str(size));
  }
  if (unmapped.length) {
    throw new TokenError(unmapped.map((key) => `Tailwind v3 preset: no v3 theme section for ${key}; map its namespace in scripts/lib/tailwind-v3.ts`));
  }
  // v4 has rounded-full built in; here it is the pill radius.
  radius.set("full", radius.get("pill") ?? str("9999px"));
  if (!sections.get("spacing")!.size) sections.delete("spacing");

  // Ring defaults v3 would otherwise fill with its blue and white. A plain "currentColor" would not do: v3
  // cannot parse it and falls back to its blue, and a color() would take v3's 0.5 default ring opacity.
  const ensure = (path: string) => sections.get(path) ?? sections.set(path, new Map()).get(path)!;
  ensure("extend.ringColor").set("DEFAULT", '() => "currentColor"');
  if (model.themePaths.includes("color.surface.page")) {
    ensure("extend.ringOffsetColor").set("DEFAULT", colorOf(`var(${cssName("color.surface.page")})`));
  }
  return { sections, shared };
}

function describe(entry: TailwindEntry): string {
  return `${entry.key} (token ${entry.token})`;
}

/** The selector list of tailwind.css's `@custom-variant dark`, e.g. `&:where([data-theme="dark"], ...)`. */
function darkSelector(model: Model): string | null {
  const variant = darkVariant(model);
  if (!variant) return null;
  const match = /^@custom-variant dark \((.+)\);$/.exec(variant);
  if (!match) throw new Error(`Tailwind v3 preset: cannot read the dark selector from ${variant}`);
  return match[1];
}

const keyOf = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : str(key));

function body(section: Section, indent: string): string[] {
  return [...section].map(([key, value]) => `${indent}${keyOf(key)}: ${value},`);
}

const HEADER = (note: string) => [
  "// @codecaine-ai/design-system Tailwind v3 preset (Tailwind 3.4).",
  `// ${note}`,
  "//",
  "// The utility names of tailwind.css (the Tailwind v4 theme) for Tailwind 3.4 apps: bg-page, text-ink,",
  "// border-rule, p-1 (--ds-space-1), rounded, text-ui-sm, font-medium, shadow-glass, max-w-lane-text.",
  "// Tailwind's default palette, type, radius, shadow, blur and easing scales are removed, as with",
  "// tailwind-strict.css, so bg-red-500, text-sm and shadow-md do not generate. Every value reads a",
  "// --ds-* custom property, so utilities follow data-theme; `dark:` matches data-theme=\"dark\" and .dark.",
  "//",
  "// Usage (tailwind.config.cjs), with @codecaine-ai/design-system/tokens.css loaded before Tailwind's layers:",
  "//   module.exports = {",
  '//     presets: [require("@codecaine-ai/design-system/tailwind-v3-preset")],',
  '//     content: ["./index.html", "./src/**/*.{ts,tsx}"],',
  "//   };",
  "// Utility names are listed in guide/tokens.md.",
];

const COLOR_HELPER = [
  "// A color. Tailwind 3 calls it with opacityVariable for a bare utility (bg-page) and with no opacity",
  "// from theme(): both get exactly var(--ds-*). An opacity modifier (bg-page/50) passes only opacityValue",
  "// and gets color-mix(in oklab, var(--ds-*) 50%, transparent), as Tailwind v4 writes it.",
  "// The v3-only bg-opacity-* utilities have no effect.",
  "const color = (value) => ({ opacityVariable, opacityValue } = {}) => {",
  "  if (opacityVariable !== undefined || opacityValue === undefined) return value;",
  "  const alpha = String(opacityValue).trim();",
  "  const number = Number(alpha);",
  '  const percent = alpha.endsWith("%") ? alpha : alpha !== "" && Number.isFinite(number) ? `${Math.round(number * 10000) / 100}%` : `calc(${alpha} * 100%)`;',
  "  return `color-mix(in oklab, ${value} ${percent}, transparent)`;",
  "};",
];

export function renderTailwindV3Preset(model: Model): string {
  const { sections, shared } = presetSections(model);
  const dark = darkSelector(model);
  const property = (name: string, section: Section, indent: string): string[] => {
    const ref = shared.get(section);
    if (ref) return [`${indent}${name === ref ? name : `${name}: ${ref}`},`];
    if (!section.size) return [`${indent}${name}: {},`];
    return [`${indent}${name}: {`, ...body(section, `${indent}  `), `${indent}},`];
  };
  const lines = [...HEADER(GENERATED_NOTE), '"use strict";', "", ...COLOR_HELPER, ""];
  for (const [section, name] of shared) lines.push(`const ${name} = {`, ...body(section, "  "), "};", "");
  lines.push("module.exports = {");
  if (dark) lines.push(`  darkMode: ["variant", ${str(dark)}],`);
  lines.push("  theme: {");
  // extend in NAMESPACES order (sort is stable: paths of one namespace keep theirs), ring defaults last.
  const rank = (path: string) => ((i) => (i === -1 ? NAMESPACES.length : i))(NAMESPACES.findIndex((n) => n.sections.includes(path)));
  const extend = [...sections].filter(([path]) => path.startsWith("extend.")).sort(([a], [b]) => rank(a) - rank(b));
  for (const [path, section] of sections) if (!path.startsWith("extend.")) lines.push(...property(path, section, "    "));
  lines.push("    extend: {");
  for (const [path, section] of extend) lines.push(...property(path.slice("extend.".length), section, "      "));
  lines.push("    },", "  },", "};");
  return `${lines.join("\n")}\n`;
}
