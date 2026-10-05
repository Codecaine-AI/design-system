/**
 * Color math for the literal codemod: parse a CSS color, convert it to OKLab, and measure how far
 * two colors are apart.
 *
 * ΔE here is 100 × the Euclidean distance in OKLab between the two colors composited over the
 * theme's page surface. Compositing makes a translucent literal comparable with an opaque token the
 * way it renders on the page; about 2 is the smallest visible step.
 */

import { NAMED_COLORS } from "./named-colors.ts";

/** sRGB channels 0..1 and alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A number, percentage or `none` in a CSS color function. `pct` is what 100% means. */
function num(token: string, pct: number): number {
  if (token === "none") return 0;
  if (token.endsWith("%")) return (parseFloat(token) / 100) * pct;
  return parseFloat(token);
}

function hue(token: string): number {
  if (token === "none") return 0;
  const n = parseFloat(token);
  if (token.endsWith("turn")) return n * 360;
  if (token.endsWith("grad")) return n * 0.9;
  if (token.endsWith("rad")) return (n * 180) / Math.PI;
  return n;
}

/** Splits `a b c / d` or `a, b, c, d` into channels and alpha. */
function channels(args: string): { ch: string[]; alpha: string | null } | null {
  const [main, slash] = args.split("/");
  const ch = main.trim().split(/[\s,]+/).filter(Boolean);
  if (slash !== undefined) return ch.length === 3 ? { ch, alpha: slash.trim() } : null;
  if (ch.length === 4) return { ch: ch.slice(0, 3), alpha: ch[3] };
  return ch.length === 3 ? { ch, alpha: null } : null;
}

function parseHex(hex: string): Rgba | null {
  let h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
  if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklab({ r, g, b }: Rgba): Oklab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }: Oklab, alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: alpha,
  };
}

/** `color-mix(in srgb, A p%, B q%)`, with the CSS Color 5 percentage rules and premultiplied alpha. */
function parseColorMix(args: string): Rgba | null {
  const parts = splitTopLevel(args);
  if (parts.length !== 3 || !/^in\s+srgb$/i.test(parts[0].trim())) return null;
  const side = (s: string) => {
    const m = s.trim().match(/^(.*?)(?:\s+(\d*\.?\d+)%)?$/);
    if (!m) return null;
    const color = parseColor(m[1]);
    return color ? { color, pct: m[2] === undefined ? null : parseFloat(m[2]) } : null;
  };
  const a = side(parts[1]);
  const b = side(parts[2]);
  if (!a || !b) return null;
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 === null && p2 === null) p1 = p2 = 50;
  else if (p1 === null) p1 = 100 - p2!;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2!;
  if (sum <= 0) return null;
  const w1 = p1 / sum;
  const w2 = p2! / sum;
  const alpha = a.color.a * w1 + b.color.a * w2;
  const mix = (k: "r" | "g" | "b") =>
    alpha === 0 ? 0 : (a.color[k] * a.color.a * w1 + b.color[k] * b.color.a * w2) / alpha;
  return { r: mix("r"), g: mix("g"), b: mix("b"), a: alpha * Math.min(1, sum / 100) };
}

/** Splits at top-level commas (outside parentheses). */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parses hex, rgb()/rgba(), hsl()/hsla(), oklch(), oklab(), named colors, `transparent` and
 * `color-mix(in srgb, ...)`. Returns null for anything else (var(), currentColor, lab(), ...).
 */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) return parseHex(s);
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED_COLORS[s]) return parseHex(NAMED_COLORS[s]);
  const fn = s.match(/^([a-z-]+)\((.*)\)$/s);
  if (!fn) return null;
  const [, name, args] = fn;
  if (name === "color-mix") return parseColorMix(args);
  const parsed = channels(args);
  if (!parsed) return null;
  const { ch } = parsed;
  const alpha = parsed.alpha === null ? 1 : clamp01(num(parsed.alpha, 1));
  if (name === "rgb" || name === "rgba") {
    const [r, g, b] = ch.map((c) => clamp01(num(c, 255) / 255));
    return { r, g, b, a: alpha };
  }
  if (name === "hsl" || name === "hsla") {
    const [r, g, b] = hslToRgb(hue(ch[0]), clamp01(num(ch[1], 100) / 100), clamp01(num(ch[2], 100) / 100));
    return { r, g, b, a: alpha };
  }
  if (name === "oklab") return oklabToRgb({ L: num(ch[0], 1), a: num(ch[1], 0.4), b: num(ch[2], 0.4) }, alpha);
  if (name === "oklch") {
    const C = num(ch[1], 0.4);
    const h = (hue(ch[2]) * Math.PI) / 180;
    return oklabToRgb({ L: num(ch[0], 1), a: C * Math.cos(h), b: C * Math.sin(h) }, alpha);
  }
  return null;
}

/** `top` drawn over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const k = (c: "r" | "g" | "b") => top[c] * top.a + bottom[c] * (1 - top.a);
  return { r: k("r"), g: k("g"), b: k("b"), a: 1 };
}

/** ΔE (OKLab × 100) between two colors as they render over `backdrop`. */
export function deltaE(x: Rgba, y: Rgba, backdrop: Rgba): number {
  const p = rgbToOklab(composite(x, backdrop));
  const q = rgbToOklab(composite(y, backdrop));
  return 100 * Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/** OKLCH chroma of the opaque color: about 0.03 and below reads as gray. */
export function chroma(c: Rgba): number {
  const { a, b } = rgbToOklab(c);
  return Math.hypot(a, b);
}

export function toHex(c: Rgba): string {
  const h = (n: number) => Math.round(clamp01(n) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a) : ""}`;
}
