/**
 * The design-system data the codemod proposes from: theme colors (both themes, parsed), base
 * values (font sizes, families, radii, spacing), the Tailwind v4 utility names and the Tailwind v3
 * preset's theme keys, all read from the built `dist/` of the design-system checkout the script
 * runs from.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DESIGN_SYSTEM_ROOT } from "../registry.ts";
import { parseColor, type Rgba } from "./color.ts";

export type Theme = "light" | "dark";

export interface ColorToken {
  path: string;
  light: Rgba;
  dark: Rgba;
}

export interface TokenData {
  colors: Map<string, ColorToken>;
  /** Base tokens: path -> value as written in dist/json/base.json. */
  base: Record<string, string | number>;
  /** Page surface per theme: the backdrop ΔE composites over. */
  page: Record<Theme, Rgba>;
  /** Tailwind v4 theme keys from dist/tailwind/theme.css: `--background-color-page` -> token path. */
  tailwind: Map<string, string>;
  /** Tailwind v3: the keys each theme section has under the preset (dist/tailwind/preset-v3.cjs) and Tailwind 3.4's defaults it keeps. */
  v3: Record<string, Set<string>>;
}

/** Tailwind 3.4 defaults the preset leaves in place (it sets no aspectRatio or opacity, and only extends zIndex). */
const V3_DEFAULTS: Record<string, string[]> = {
  aspectRatio: ["auto", "square", "video"],
  zIndex: ["0", "10", "20", "30", "40", "50", "auto"],
  opacity: Array.from({ length: 21 }, (_, i) => String(i * 5)),
};

/** Theme section -> keys, with `extend` merged in; color sections also take every `colors` key. */
function loadV3(dsRoot: string): Record<string, Set<string>> {
  const preset = createRequire(import.meta.url)(join(dsRoot, "dist/tailwind/preset-v3.cjs")) as { theme: Record<string, unknown> & { extend?: Record<string, unknown> } };
  const out: Record<string, Set<string>> = {};
  const add = (section: string, obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const set = (out[section] ??= new Set());
    for (const k of Object.keys(obj)) set.add(k);
  };
  for (const [section, obj] of Object.entries(preset.theme)) if (section !== "extend") add(section, obj);
  for (const [section, obj] of Object.entries(preset.theme.extend ?? {})) add(section, obj);
  for (const [section, keys] of Object.entries(V3_DEFAULTS)) for (const k of keys) (out[section] ??= new Set()).add(k);
  return out;
}

/** CSS custom property of a token: `color.surface.page` -> `--ds-color-surface-page`. */
export function cssVarName(path: string): string {
  return `--ds-${path.split(".").join("-")}`;
}

export function cssVarRef(path: string): string {
  return `var(${cssVarName(path)})`;
}

export function loadTokens(dsRoot: string = DESIGN_SYSTEM_ROOT): TokenData {
  const read = (p: string) => JSON.parse(readFileSync(join(dsRoot, "dist/json", p), "utf8")) as Record<string, string | number>;
  const light = read("light.json");
  const dark = read("dark.json");
  const base = read("base.json");
  const colors = new Map<string, ColorToken>();
  for (const [path, value] of Object.entries(light)) {
    if (!path.startsWith("color.")) continue;
    const l = parseColor(String(value));
    const d = parseColor(String(dark[path]));
    if (l && d) colors.set(path, { path, light: l, dark: d });
  }
  const byVar = new Map<string, string>();
  for (const path of [...Object.keys(base), ...Object.keys(light)]) byVar.set(cssVarName(path), path);
  const tailwind = new Map<string, string>();
  const theme = readFileSync(join(dsRoot, "dist/tailwind/theme.css"), "utf8");
  for (const m of theme.matchAll(/^\s*(--[a-z0-9-]+):\s*var\((--ds-[a-z0-9-]+)\);/gm)) {
    const path = byVar.get(m[2]);
    if (path) tailwind.set(m[1], path);
  }
  const pageOf = (t: Theme) => colors.get("color.surface.page")![t];
  return { colors, base, page: { light: pageOf("light"), dark: pageOf("dark") }, tailwind, v3: loadV3(dsRoot) };
}

/** Utility prefixes that color something, and the theme namespace each one also reads. */
const SCOPED_NAMESPACE: Record<string, string> = {
  bg: "--background-color-",
  text: "--text-color-",
  border: "--border-color-",
};

/**
 * The design-system utility that applies a color token with a Tailwind prefix (`bg`, `text`,
 * `border-t`, `ring`, ...), or null when theme.css generates none for that pair.
 */
export function colorUtility(data: TokenData, prefix: string, path: string): string | null {
  // Tailwind v4 border sides and divide-* read the --border-color-* namespace too.
  const scoped = SCOPED_NAMESPACE[prefix.startsWith("border") || prefix === "divide" ? "border" : prefix];
  for (const [key, p] of data.tailwind) {
    if (p !== path) continue;
    if (key.startsWith("--color-")) return `${prefix}-${key.slice("--color-".length)}`;
    if (scoped && key.startsWith(scoped)) return `${prefix}-${key.slice(scoped.length)}`;
  }
  return null;
}

/** The utility for a non-color token under one theme namespace (`--text-`, `--leading-`, ...). */
export function themeUtility(data: TokenData, namespace: string, prefix: string, path: string): string | null {
  for (const [key, p] of data.tailwind) {
    if (p !== path || !key.startsWith(namespace)) continue;
    const name = key.slice(namespace.length);
    if (!name || name.includes("--")) continue;
    return `${prefix}-${name}`;
  }
  return null;
}

/** Base tokens under a prefix with px values: `font.size` -> [["font.size.micro", 10], ...]. */
export function pxScale(data: TokenData, prefix: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [path, value] of Object.entries(data.base)) {
    if (!path.startsWith(prefix + ".")) continue;
    const v = String(value);
    const px = v.match(/^(-?\d*\.?\d+)px$/);
    const rem = v.match(/^(-?\d*\.?\d+)rem$/);
    if (px) out.push([path, Number(px[1])]);
    else if (rem) out.push([path, Number(rem[1]) * 16]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}
