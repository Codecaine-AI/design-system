/**
 * The current build's token values, and how a computed CSS value is compared with them.
 *
 * Expected values come from the build that the script runs from (`dist/json/<theme>.json` and
 * `dist/json/base.json` in DESIGN_SYSTEM_ROOT), never from the app. The browser then computes
 * both sides (the app's element and a probe element painted with the build value), so aliases
 * and `color-mix()` resolve the same way on both.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Theme = "light" | "dark";

export interface BuildValues {
  /** Design-system directory the values were read from. */
  dir: string;
  theme: Record<Theme, Record<string, string>>;
  base: Record<string, string>;
  /** sha256 of the build's dist/css/tokens.css. */
  tokensCssSha256: string;
}

/** The CSS custom property of a token: "color.surface.page" → "--ds-color-surface-page". */
export function tokenCssVar(path: string): string {
  return `--ds-${path.split(".").join("-")}`;
}

export function loadBuildValues(dsDir: string): BuildValues {
  const read = (name: string) => JSON.parse(readFileSync(join(dsDir, "dist/json", name), "utf8")) as Record<string, string>;
  return {
    dir: dsDir,
    theme: { light: read("light.json"), dark: read("dark.json") },
    base: read("base.json"),
    tokensCssSha256: createHash("sha256").update(readFileSync(join(dsDir, "dist/css/tokens.css"))).digest("hex"),
  };
}

/** The build's value of a token in a theme: theme tokens first, then base tokens. Throws on an unknown path. */
export function buildValue(values: BuildValues, path: string, theme: Theme): string {
  const value = values.theme[theme][path] ?? values.base[path];
  if (value === undefined) throw new Error(`token "${path}" is not in the current build (${values.dir}/dist/json)`);
  return String(value);
}

type Rgba = [number, number, number, number];

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const RGB_RE = new RegExp(String.raw`^rgba?\(\s*(${NUM})[\s,]+(${NUM})[\s,]+(${NUM})(?:\s*[,/]\s*(${NUM})(%?))?\s*\)$`, "i");
const SRGB_RE = new RegExp(String.raw`^color\(\s*srgb\s+(${NUM})\s+(${NUM})\s+(${NUM})(?:\s*/\s*(${NUM})(%?))?\s*\)$`, "i");

/** A computed sRGB color as 0..1 channels, or null when the value is not a plain sRGB color. */
export function parseComputedColor(value: string): Rgba | null {
  const text = value.trim();
  if (text.toLowerCase() === "transparent") return [0, 0, 0, 0];
  const alpha = (a: string | undefined, pct: string | undefined) => (a === undefined ? 1 : pct ? Number(a) / 100 : Number(a));
  const rgb = RGB_RE.exec(text);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, alpha(rgb[4], rgb[5])];
  const srgb = SRGB_RE.exec(text);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), alpha(srgb[4], srgb[5])];
  return null;
}

/**
 * Two computed values are the same: colors within half an 8-bit step per channel (a hex literal and the
 * float a `color-mix()` computes to name the same color), anything else by exact text after whitespace.
 */
export function sameComputedValue(actual: string, expected: string): boolean {
  const a = parseComputedColor(actual);
  const b = parseComputedColor(expected);
  if (a && b) {
    if (a[3] === 0 && b[3] === 0) return true;
    const step = 0.5 / 255 + 1e-6;
    return Math.abs(a[0] - b[0]) <= step && Math.abs(a[1] - b[1]) <= step && Math.abs(a[2] - b[2]) <= step && Math.abs(a[3] - b[3]) <= 0.005;
  }
  return actual.trim().replace(/\s+/g, " ") === expected.trim().replace(/\s+/g, " ");
}
