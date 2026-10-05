/**
 * Token picks for the non-color literals: font sizes, radii, font families, spacing, and the
 * Tailwind arbitrary values that carry them. Each returns the token and the CSS value or utility
 * that replaces the literal.
 */

import { parseColor, type Rgba } from "./color.ts";
import { TAILWIND_PALETTE } from "./tailwind-palette.ts";
import type { Context } from "./context.ts";
import { pickColor } from "./color-role.ts";
import { colorUtility, cssVarName, cssVarRef, pxScale, themeUtility, type TokenData } from "./tokens.ts";

export interface Pick {
  path: string | null;
  method: "role" | "nearest" | null;
  deltaE: number | null;
  why: string;
  /** CSS value that replaces the literal; default `var(<path>)`. */
  css?: string;
  /** Tailwind class that replaces the literal (class slot). */
  utility?: string | null;
  /** Color picks: the literal's alpha, kept on the token. */
  keepAlpha?: number;
}

const none = (why: string): Pick => ({ path: null, method: null, deltaE: null, why });

export function toPx(value: string): number | null {
  const m = value.trim().match(/^(-?\d*\.?\d+)(px|rem|pt)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "rem" ? n * 16 : m[2] === "pt" ? (n * 4) / 3 : n;
}

export function pickFontSize(data: TokenData, value: string, ctx: Context): Pick {
  if (/(em|%)$/.test(value.trim()) && !/rem$/.test(value.trim())) return none(`relative size ${value}: keep, or set a token size on the parent`);
  const px = toPx(value);
  if (px === null) return none(`not a size: ${value}`);
  const scale = pxScale(data, "font.size");
  const mono = /\b(code|mono|monospace|pre|kbd|editor|program|gutter)\b/.test(ctx.hints.toLowerCase().replace(/[^a-z0-9]+/g, " "));
  const exact = scale.filter(([, v]) => v === px);
  if (exact.length) {
    const path = (exact.find(([p]) => (mono ? p === "font.size.code" : p !== "font.size.code")) ?? exact[0])[0];
    return { path, method: "role", deltaE: null, why: `font size ${value}${exact.length > 1 ? (mono ? " in code" : " in UI text") : ""}` };
  }
  const near = scale
    .map(([p, v]) => ({ p, v, d: Math.abs(v - px) }))
    .filter((x) => x.d <= 1 && (mono || x.p !== "font.size.code"))
    .sort((a, b) => a.d - b.d || b.v - a.v)[0];
  if (near) return { path: near.p, method: "role", deltaE: null, why: `font size ${value} becomes ${near.v}px` };
  const below = scale.filter(([, v]) => v < px).pop();
  const above = scale.find(([, v]) => v > px);
  const around = [below, above].filter(Boolean).map((x) => `${x![0]} ${x![1]}px`).join(", ");
  return none(`no font-size token within 1px of ${px}px (${around}); add a token or allowlist it`);
}

export function pickRadius(value: string): Pick {
  if (value.includes("/")) return none("elliptical radius: no token");
  const parts = value.trim().split(/\s+/);
  const mapped: string[] = [];
  const paths = new Set<string>();
  for (const part of parts) {
    if (/^0(?:px|rem|em|%)?$/.test(part)) {
      mapped.push("0");
      continue;
    }
    const pct = part.match(/^(\d*\.?\d+)%$/);
    const px = toPx(part);
    let path: string | null = null;
    if (pct) path = Number(pct[1]) >= 50 ? "radius.pill" : null;
    else if (px !== null) path = px >= 999 ? "radius.pill" : "radius.base";
    if (!path) return none(`radius ${value}: no token for ${part}`);
    paths.add(path);
    mapped.push(cssVarRef(path));
  }
  if (!paths.size) return none(`radius ${value}`);
  const list = [...paths];
  const why = list.includes("radius.pill") && list.length === 1 ? "fully round: radius.pill" : `${value} becomes the one app radius${list.includes("radius.base") ? " (2px)" : ""}`;
  return { path: list.join(", "), method: "role", deltaE: null, why, css: mapped.join(" ") };
}

const FAMILIES: Array<[RegExp, string]> = [
  [/mono|menlo|consolas|courier|monaco|sfmono|sf mono|plex mono|jetbrains|fira code|source code|cascadia|ui-monospace/, "font.family.mono"],
  [/^(serif|ui-serif|georgia|times|times new roman|cambria|garamond|palatino|iowan)/, "font.family.serif"],
  [/^(inter|system-ui|ui-sans-serif|-apple-system|blinkmacsystemfont|sans-serif|helvetica|helvetica neue|arial|segoe ui|roboto|sf pro|sf pro text|sf pro display|ibm plex sans|geist|avenir|avenir next)$/, "font.family.sans"],
];

export function pickFamily(first: string): Pick {
  const name = first.toLowerCase().replace(/^['"]|['"]$/g, "").trim();
  for (const [re, path] of FAMILIES) {
    if (re.test(name)) return { path, method: "role", deltaE: null, why: `font family ${name}` };
  }
  return none(`display or brand face "${name}": no family token; keep it with an allowlist entry, or use font.family.sans`);
}

const SPACE_ZERO = /^(?:0|auto|0px)$/;

export function pickSpacing(data: TokenData, value: string): Pick {
  const scale = pxScale(data, "space");
  const mapped: string[] = [];
  const paths = new Set<string>();
  for (const part of value.trim().split(/\s+/)) {
    if (SPACE_ZERO.test(part)) {
      mapped.push(part);
      continue;
    }
    const px = toPx(part);
    const hit = px === null ? undefined : scale.find(([, v]) => v === Math.abs(px));
    if (!hit) return none(`spacing ${value}: ${part} is off the space scale`);
    paths.add(hit[0]);
    mapped.push(px! < 0 ? `calc(-1 * ${cssVarRef(hit[0])})` : cssVarRef(hit[0]));
  }
  return { path: [...paths].join(", "), method: "role", deltaE: null, why: "space scale", css: mapped.join(" ") };
}

// ---------------------------------------------------------------------------
// Tailwind classes

const COLOR_ROOTS = /^(bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow|inset-shadow|inset-ring|text-shadow|drop-shadow)$/;
const SPACING_ROOTS = /^(?:[pm][xytrblse]?|gap(?:-[xy])?|space-[xy]|(?:min-|max-)?[wh]|size|basis|inset(?:-[xy])?|top|right|bottom|left|start|end|indent|translate-[xy]|scroll-[mp][xytrblse]?)$/;
const RADIUS_ROOT = /^rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|ee|es))?$/;
const HUE_STEP = /^(.*?)-((?:[a-z]+)-(?:50|[1-9]00|950)|white|black)$/;

function modAlpha(mod: string | undefined): number {
  if (!mod) return 1;
  const v = mod.replace(/^\/\[?|\]$/g, "");
  return v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v) > 1 ? Number(v) / 100 : Number(v);
}

/** Splits `hover:-mt-[4px]/50` style classes (variants already stripped) into root, value and modifier. */
export function parseClass(cls: string): { neg: boolean; root: string; value: string; mod?: string; palette: boolean } | null {
  const m = cls.match(/^!?(-?)([a-z][a-z0-9-]*?)-(\[(.+)\]|\((--[\w-]+)\))(\/(?:\d{1,3}|\[[^\]]+\]))?$/);
  if (m) return { neg: m[1] === "-", root: m[2], value: (m[4] ?? m[5]).replace(/_/g, " "), mod: m[6], palette: false };
  const p = cls.match(/^!?(.+?)(\/(?:\d{1,3}|\[[^\]]+\]))?$/);
  const hs = p?.[1].match(HUE_STEP);
  if (p && hs) return { neg: false, root: hs[1], value: hs[2], mod: p[2], palette: true };
  return null;
}

function colorOfClass(value: string, palette: boolean, mod?: string): Rgba | null {
  const raw = palette ? (TAILWIND_PALETTE[value] ?? null) : value.replace(/^color:/, "");
  const c = raw ? parseColor(raw) : null;
  if (!c) return null;
  return { ...c, a: c.a * modAlpha(mod) };
}

export function pickClass(data: TokenData, cls: string, ctx: Context, opts: { appId: string }): Pick & { root?: string } {
  const parsed = parseClass(cls);
  if (!parsed) return none(`class ${cls}: not parsed`);
  const { root, value, mod, palette, neg } = parsed;
  if (value.startsWith("--") || /^var\(/.test(value)) return { ...none("wraps an app variable: map that variable's definition instead"), root };

  if (COLOR_ROOTS.test(root)) {
    const color = colorOfClass(value, palette, mod);
    if (color) {
      const pick = pickColor(data, color, { ...ctx, property: root }, { appId: opts.appId });
      if (!pick.path) return { ...pick, root };
      let utility = colorUtility(data, root, pick.path) ?? `${root}-(${cssVarName(pick.path)})`;
      let why = pick.why;
      if (pick.keepAlpha !== undefined) utility += mod ?? `/${Math.round(pick.keepAlpha * 100)}`;
      else if (mod) why += `; drops ${mod}`;
      return { ...pick, why, utility, root };
    }
  }
  if (root === "text" || root === "font" || RADIUS_ROOT.test(root) || root === "leading" || root === "tracking") {
    const v = value.replace(/^(length|size|number|family-name):/, "");
    if (root === "text") {
      const p = pickFontSize(data, v, ctx);
      return { ...p, utility: p.path ? themeUtility(data, "--text-", "text", p.path) : null, root };
    }
    if (RADIUS_ROOT.test(root)) {
      const p = pickRadius(v);
      if (!p.path || p.path.includes(",")) return { ...p, utility: null, root };
      const suffix = p.path === "radius.pill" ? "-pill" : p.path === "radius.none" ? "-none" : "";
      return { ...p, utility: `${root}${suffix}`, root };
    }
    if (root === "font") {
      const weight = Object.entries(data.base).find(([p, w]) => p.startsWith("font.weight.") && String(w) === v);
      if (weight) return { path: weight[0], method: "role", deltaE: null, why: `font weight ${v}`, utility: themeUtility(data, "--font-weight-", "font", weight[0]), root };
      const p = pickFamily(v.split(",")[0]);
      return { ...p, utility: p.path ? themeUtility(data, "--font-", "font", p.path) : null, root };
    }
    const prefix = root === "leading" ? "line-height." : "letter-spacing.";
    const match = Object.entries(data.base).find(([p, x]) => p.startsWith(prefix) && String(x) === v);
    if (match) return { path: match[0], method: "role", deltaE: null, why: `${root} ${v}`, utility: themeUtility(data, `--${root}-`, root, match[0]), root };
    return { ...none(`${root} ${v}: no token`), root };
  }
  if (SPACING_ROOTS.test(root)) {
    const px = toPx(value);
    if (px === null || px % 1 !== 0 || px % 2 !== 0) return { ...none(`${root} ${value}: not on the 4px spacing scale (layout value; keep it with an allowlist entry or pick a scale step)`), root };
    const step = px / 4;
    return { path: "space.1", method: "role", deltaE: null, why: `${px}px on the spacing scale (${step} × space.1)`, utility: `${neg ? "-" : ""}${root}-${step}`, root };
  }
  if (root === "aspect" && /^\d+\s*\/\s*\d+$/.test(value)) {
    return { path: null, method: "role", deltaE: null, why: "ratio: Tailwind v4 takes it without brackets", utility: `aspect-${value.replace(/\s+/g, "")}`, root };
  }
  if (root === "z") {
    const z = Object.entries(data.base).find(([p, x]) => p.startsWith("z.") && String(x) === value);
    if (z) return { path: z[0], method: "role", deltaE: null, why: `z-index ${value}`, utility: themeUtility(data, "--z-index-", "z", z[0]), root };
  }
  if (root === "ease") {
    const e = Object.entries(data.base).find(([p, x]) => p.startsWith("motion.easing.") && String(x).replace(/\s+/g, "") === value.replace(/\s+/g, ""));
    if (e) return { path: e[0], method: "role", deltaE: null, why: `easing ${value}`, utility: themeUtility(data, "--ease-", "ease", e[0]), root };
  }
  return { ...none(`${root}-[${value}]: no design-system utility`), root };
}
