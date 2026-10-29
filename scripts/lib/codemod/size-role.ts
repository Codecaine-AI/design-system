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
  /** Names a token but offers no ready replacement: approving the row is a deliberate hand edit. */
  handEdit?: true;
}

const none = (why: string): Pick => ({ path: null, method: null, deltaE: null, why });

export function toPx(value: string): number | null {
  const m = value.trim().match(/^(-?\d*\.?\d+)(px|rem|pt)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "rem" ? n * 16 : m[2] === "pt" ? (n * 4) / 3 : n;
}

/** Sizes for uppercase labels: an exact match takes one only when no general size has the same value. */
const LABEL_SIZES = new Set(["font.size.micro", "font.size.ui-2xs"]);

export function pickFontSize(data: TokenData, value: string, ctx: Context): Pick {
  if (/(em|%)$/.test(value.trim()) && !/rem$/.test(value.trim())) return none(`relative size ${value}: keep, or set a token size on the parent`);
  const px = toPx(value);
  if (px === null) return none(`not a size: ${value}`);
  const scale = pxScale(data, "font.size");
  const mono = /\b(code|mono|monospace|pre|kbd|editor|program|gutter)\b/.test(ctx.hints.toLowerCase().replace(/[^a-z0-9]+/g, " "));
  const exact = scale.filter(([, v]) => v === px);
  if (exact.length) {
    const fits = exact.filter(([p]) => (mono ? p === "font.size.code" : p !== "font.size.code"));
    const path = (fits.find(([p]) => !LABEL_SIZES.has(p)) ?? fits[0] ?? exact[0])[0];
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
  if (/calc\(/i.test(value)) return none(`radius ${value}: a length added in calc(); use the one radius token (radius.base) or radius.pill by hand`);
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

/** The alpha an opacity modifier sets: a bare `/N` is always N%; `/[0.07]` and `/[7%]` are read as written. */
function modAlpha(mod: string | undefined): number {
  if (!mod) return 1;
  const bracket = mod.match(/^\/\[(.+)\]$/);
  if (!bracket) return Number(mod.slice(1)) / 100;
  const v = bracket[1].trim();
  return v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
}

/**
 * Splits a class (variants already stripped) into root, value, opacity modifier and the important
 * flag (`!bg-[#fff]` or v4's `bg-[#fff]!`).
 */
export function parseClass(raw: string): { neg: boolean; root: string; value: string; mod?: string; palette: boolean; important: { lead: boolean; trail: boolean } } | null {
  const important = { lead: raw.startsWith("!"), trail: raw.endsWith("!") };
  const cls = raw.replace(/^!|!$/g, "");
  const m = cls.match(/^(-?)([a-z][a-z0-9-]*?)-(\[(.+?)\]|\((--[\w-]+)\))(\/(?:\d{1,3}|\[[^\]]+\]))?$/);
  if (m) return { neg: m[1] === "-", root: m[2], value: (m[4] ?? m[5]).replace(/_/g, " "), mod: m[6], palette: false, important };
  const p = cls.match(/^(.+?)(\/(?:\d{1,3}|\[[^\]]+\]))?$/);
  const hs = p?.[1].match(HUE_STEP);
  if (p && hs) return { neg: false, root: hs[1], value: hs[2], mod: p[2], palette: true, important };
  return null;
}

function colorOfClass(value: string, palette: boolean, mod?: string): Rgba | null {
  const raw = palette ? (TAILWIND_PALETTE[value] ?? null) : value.replace(/^color:/, "");
  const c = raw ? parseColor(raw) : null;
  if (!c) return null;
  return { ...c, a: c.a * modAlpha(mod) };
}

/**
 * The Tailwind that compiles a file's classes: v4 (also "none": a Tailwind-free app's stray
 * classes), v3 (only what the design-system preset generates), or "uno" (UnoCSS: no class rewrites).
 */
export type TailwindTarget = "v4" | "v3" | "none" | "uno";

export interface ClassOptions {
  appId: string;
  /** Root-relative path of the file (token guards). */
  file?: string;
  /** The Tailwind that compiles the class: v3 hosts get only utilities their preset generates; UnoCSS hosts get none. */
  tailwind?: TailwindTarget;
}

export function pickClass(data: TokenData, cls: string, ctx: Context, opts: ClassOptions): Pick & { root?: string } {
  if (opts.tailwind === "uno") {
    const would = pickClassBody(data, cls, ctx, { ...opts, tailwind: "v4" });
    const hint = would.utility ? `; under Tailwind v4 it would be ${would.utility}` : "";
    return { ...none(`UnoCSS host: its presets have no design-system utilities, so no class rewrite is proposed${hint}: edit by hand`), root: would.root };
  }
  let pick = pickClassBody(data, cls, ctx, opts);
  if (opts.tailwind === "v3" && pick.utility && pick.root && !v3Generates(data, pick.root, pick.utility, false) && !v3Generates(data, pick.root, pick.utility, true)) {
    pick = { ...none(`Tailwind v3: the preset has no ${pick.utility} (${pick.why}); pick a preset step or keep it with an allowlist entry`), root: pick.root };
  }
  const parsed = parseClass(cls);
  if (pick.utility && parsed) pick.utility = `${parsed.important.lead ? "!" : ""}${pick.utility}${parsed.important.trail ? "!" : ""}`;
  return pick;
}

/** Theme sections a Tailwind v3 utility root reads (Tailwind 3.4 core plugins), for color and for other values. */
function v3Sections(root: string, color: boolean): string[] {
  const r = root.replace(/^-/, "");
  if (color) {
    if (r === "bg") return ["colors", "backgroundColor"];
    if (r === "text") return ["colors", "textColor"];
    if (/^border(?:-[xytrblse])?$/.test(r) || r === "divide") return ["colors", "borderColor"];
    if (r === "ring") return ["colors", "ringColor"];
    if (r === "ring-offset") return ["colors", "ringOffsetColor"];
    if (r === "from" || r === "via" || r === "to") return ["colors", "gradientColorStops"];
    return ["colors"];
  }
  if (r === "text") return ["fontSize"];
  if (RADIUS_ROOT.test(r)) return ["borderRadius"];
  if (r === "font") return ["fontFamily", "fontWeight"];
  if (r === "leading") return ["lineHeight"];
  if (r === "tracking") return ["letterSpacing"];
  if (r === "z") return ["zIndex"];
  if (r === "ease") return ["transitionTimingFunction"];
  if (r === "aspect") return ["aspectRatio"];
  if (SPACING_ROOTS.test(r)) return ["spacing"];
  return [];
}

/** Whether Tailwind 3.4 with the design-system preset generates `utility` (`min-h-29`, `aspect-16/10`: no). */
function v3Generates(data: TokenData, root: string, utility: string, color: boolean): boolean {
  const u = utility.replace(/^!|!$/g, "").replace(/^-/, "");
  const r = root.replace(/^-/, "");
  let key = u === r ? "DEFAULT" : u.startsWith(`${r}-`) ? u.slice(r.length + 1) : null;
  if (key === null) return false;
  if (color) {
    // v3 takes an opacity modifier only from its opacity scale, or in brackets.
    const mod = key.match(/\/(\d{1,3}|\[[^\]]+\])$/);
    if (mod) {
      if (!mod[1].startsWith("[") && !data.v3.opacity?.has(mod[1])) return false;
      key = key.slice(0, -mod[0].length);
    }
  }
  if (key.startsWith("[")) return true;
  return v3Sections(r, color).some((s) => data.v3[s]?.has(key!));
}

function pickClassBody(data: TokenData, cls: string, ctx: Context, opts: ClassOptions): Pick & { root?: string } {
  const parsed = parseClass(cls);
  if (!parsed) return none(`class ${cls}: not parsed`);
  const { root, value, mod, palette, neg } = parsed;
  if (value.startsWith("--") || /^var\(/.test(value)) return { ...none("wraps an app variable: map that variable's definition instead"), root };
  // A leading `-` negates the value; only spacing utilities have a negative form (`-top-1`), so a token would drop the sign.
  if (neg && !SPACING_ROOTS.test(root)) return { ...none(`-${root}-[${value}]: a leading - negates the value, and ${root} has no negative token utility; keep it or edit by hand`), root };

  if (COLOR_ROOTS.test(root)) {
    const color = colorOfClass(value, palette, mod);
    if (color) {
      const pick = pickColor(data, color, { ...ctx, property: root }, { appId: opts.appId, file: opts.file });
      if (!pick.path) return { ...pick, root };
      const named = colorUtility(data, root, pick.path);
      let alpha = pick.keepAlpha !== undefined ? (mod ?? `/${Math.round(pick.keepAlpha * 100)}`) : "";
      // v3 reads a bare modifier only from its opacity scale (0, 5, …, 100): anything else in brackets.
      if (opts.tailwind === "v3" && alpha && !alpha.startsWith("/[") && !data.v3.opacity?.has(alpha.slice(1))) alpha = `/[${Math.round(pick.keepAlpha! * 1000) / 1000}]`;
      let why = pick.why;
      if (pick.keepAlpha === undefined && mod) why += `; drops ${mod}`;
      if (opts.tailwind === "v3" && (!named || !v3Generates(data, root, named, true))) {
        // v3 takes an arbitrary value; it cannot put an opacity modifier on var(), so the mix is written out.
        const value = alpha ? `color-mix(in_srgb,${cssVarRef(pick.path)}_${Math.round(pick.keepAlpha! * 1000) / 10}%,transparent)` : cssVarRef(pick.path);
        return { ...pick, why, utility: `${root}-[${value}]`, root };
      }
      const utility = (named ?? `${root}-(${cssVarName(pick.path)})`) + alpha;
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
      // rounded-[6px_0_0_6px] sets each corner: one utility would round all four.
      if (v.trim().split(/\s+/).length > 1) return { ...none(`radius ${v}: one value per corner; write per-corner classes (rounded-tl, rounded-tr, rounded-br, rounded-bl) by hand`), utility: null, root };
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
    const step = Math.abs(px) / 4;
    // A negative value is a leading `-` on the utility (`top-[-4px]` is `-top-1`; `top--1` generates nothing); `-top-[-4px]` is positive.
    const negative = neg !== px < 0;
    return { path: "space.1", method: "role", deltaE: null, why: `${px}px on the spacing scale (${step} × space.1)`, utility: `${negative && step !== 0 ? "-" : ""}${root}-${step}`, root };
  }
  if (root === "aspect" && /^\d+\s*\/\s*\d+$/.test(value)) {
    const [w, h] = value.split("/").map((x) => Number(x.trim()));
    const named = w === h ? "aspect-square" : w * 9 === h * 16 ? "aspect-video" : null;
    if (named) return { path: null, method: "role", deltaE: null, why: `ratio ${value}: ${named}`, utility: named, root };
    if (opts.tailwind === "v3") return { ...none(`ratio ${value}: Tailwind v3 has only aspect-square and aspect-video; keep the arbitrary value`), root };
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
