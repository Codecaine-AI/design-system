/**
 * Evaluates the resolved color values the build accepts (#rrggbb, #rrggbbaa, rgba(), transparent,
 * currentcolor excluded, color-mix() in srgb) to sRGB channels, the way a browser computes them.
 * Used where a consumer needs a format CSS cannot derive from a var(): the RGB triplets of host-contract.css.
 */

/** sRGB channels 0-255 (unrounded) and alpha 0-1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Splits at top-level commas. */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** The sRGB value of a resolved token color. Throws on a form it cannot evaluate (currentcolor, a non-srgb mix). */
export function evaluateColor(value: string): Rgba {
  const s = value.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(s);
  if (hex) {
    const [r, g, b] = [hex[1], hex[2], hex[3]].map((h) => Number.parseInt(h, 16));
    return { r, g, b, a: hex[4] ? Number.parseInt(hex[4], 16) / 255 : 1 };
  }
  if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 };
  const rgb = /^rgba?\((.*)\)$/i.exec(s);
  if (rgb) {
    const [r, g, b, a = "1"] = splitArgs(rgb[1]);
    return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
  }
  const mix = /^color-mix\((.*)\)$/i.exec(s);
  if (mix) {
    const [space, first, second] = splitArgs(mix[1]);
    if (!/^in\s+srgb$/i.test(space)) throw new Error(`cannot evaluate "${s}": only color-mix(in srgb, ...) is supported`);
    const parse = (arg: string): { color: Rgba; pct: number | null } => {
      const trailing = /^(.*\S)\s+(\d+(?:\.\d+)?)%$/.exec(arg);
      const leading = /^(\d+(?:\.\d+)?)%\s+(.*)$/.exec(arg);
      if (trailing) return { color: evaluateColor(trailing[1]), pct: Number(trailing[2]) };
      if (leading) return { color: evaluateColor(leading[2]), pct: Number(leading[1]) };
      return { color: evaluateColor(arg), pct: null };
    };
    const a = parse(first);
    const b = parse(second);
    // CSS Color 5: missing percentages complete to 100; a sum under 100 scales alpha.
    const p1 = a.pct ?? (b.pct === null ? 50 : 100 - b.pct);
    const p2 = b.pct ?? 100 - p1;
    const sum = p1 + p2;
    const alphaScale = sum < 100 ? sum / 100 : 1;
    // Interpolate premultiplied by alpha, then un-premultiply. Weights stay in percent until the one
    // division, so an exact half (206.5) is not lost to 0.7 * 229 rounding down in binary.
    const weight = a.color.a * p1 + b.color.a * p2;
    const channel = (k: "r" | "g" | "b") => (weight === 0 ? 0 : (a.color[k] * a.color.a * p1 + b.color[k] * b.color.a * p2) / weight);
    return { r: channel("r"), g: channel("g"), b: channel("b"), a: (weight / sum) * alphaScale };
  }
  throw new Error(`cannot evaluate "${s}" as an sRGB color`);
}

/** "r g b" with 8-bit channels, for `rgb(var(--x) / <alpha>)`. Throws when the color is not opaque. */
export function rgbTriplet(value: string): string {
  const { r, g, b, a } = evaluateColor(value);
  if (Math.abs(a - 1) > 1e-9) throw new Error(`"${value}" has alpha ${+a.toFixed(4)}; an RGB triplet needs an opaque color`);
  return [r, g, b].map((c) => Math.min(255, Math.max(0, Math.round(Number(c.toFixed(6)))))).join(" ");
}
