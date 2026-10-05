/**
 * Picks the design-system color token for a color literal. Role first: the property, the
 * selector, the component and any variable name decide a family of tokens (surfaces, text,
 * borders, a status), and the nearest member of that family by ΔE wins. Nearest second: when no
 * role decides, the nearest semantic token, with hue tokens ranked behind semantic ones.
 */

import { chroma, composite, deltaE, type Rgba } from "./color.ts";
import type { Context } from "./context.ts";
import type { Theme, TokenData } from "./tokens.ts";

export interface ColorPick {
  path: string | null;
  method: "role" | "nearest" | null;
  deltaE: number | null;
  why: string;
  /** The literal's alpha, kept on the token: color-mix(in srgb, var(--ds-x) N%, transparent), or a Tailwind /N modifier. */
  keepAlpha?: number;
}

/** A family pick farther than this is not proposed: the role is probably misread. */
export const ROLE_MAX_DE = 20;
/** A pure nearest-color pick farther than this is not proposed. */
export const NEAREST_MAX_DE = 10;
/** A saturated literal in a generic family (text, background, border) must be this close. */
const SATURATED_MAX_DE = 12;
/** ... and this close when the token is a gray: a hue does not quietly become a neutral. */
const HUE_TO_GRAY_MAX_DE = 5;
/** A translucent literal keeps its alpha on a token whose opaque base is this close. */
const BASE_MATCH_DE = 3;
/** Added to a hue token's ΔE in nearest ranking, so a close semantic token wins. */
const HUE_PENALTY = 4;

type PropRole = "text" | "background" | "border" | "svgFill" | "svgStroke" | "shadow" | "accent" | null;

const HUES = ["gray", "blue", "teal", "green", "yellow", "orange", "red", "violet", "pink", "amber"];

/** Words in a name: `--muted-foreground` -> ["muted", "foreground"], `AGENT_COLOR` -> ["agent", "color"]. */
export function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function propRoleOf(property: string | null): PropRole {
  if (!property) return null;
  const p = property.replace(/^-webkit-/, "");
  if (/^(color|caret-?color|text-?decoration-?color|text-?fill-?color|text|decoration|caret|placeholder)$/i.test(p)) return "text";
  if (/^(background(-?color|-?image)?|bg|from|via|to)$/i.test(p)) return "background";
  if (/^(border|outline|column-rule|divide|ring)/i.test(p)) return "border";
  if (/^fill$/i.test(p)) return "svgFill";
  if (/^(stroke|stop-?color|flood-?color)$/i.test(p)) return "svgStroke";
  if (/shadow/i.test(p)) return "shadow";
  if (/^accent-?color$/i.test(p)) return "accent";
  return null;
}

/** A role from the words of a variable or key name (`--muted-foreground`, `SCRIM_COLOR`, `bg`). */
function propRoleFromName(name: string): PropRole {
  const w = words(name);
  if (w.some((x) => ["foreground", "fg", "text", "ink", "label", "glyph", "font"].includes(x))) return "text";
  if (w.some((x) => ["shadow"].includes(x))) return "shadow";
  if (w.some((x) => ["border", "rule", "divider", "separator", "outline", "line", "input", "ring", "stroke", "focus"].includes(x))) return "border";
  if (w.some((x) => ["background", "bg", "surface", "canvas", "page", "paper", "panel", "card", "popover", "fill", "wash", "tint", "scrim", "overlay", "backdrop", "primary", "secondary", "muted", "accent", "destructive", "sidebar", "base", "layer", "well", "chip", "highlight"].includes(x))) return "background";
  return null;
}

const STATUS: Array<[RegExp, string]> = [
  [/\b(error|errors|danger|destructive|invalid|fail|failed|failure|reject|rejected|critical|delete|remove)\b/, "danger"],
  [/\b(warning|warn|caution|pending|stale|attention)\b/, "warning"],
  [/\b(success|ok|valid|done|pass|passed|accept|accepted|complete|completed|positive|ready)\b/, "success"],
  [/\b(info|notice|hint|tip)\b/, "info"],
];

/** Words with hyphens and underscores split, for \b matching (`status-error` -> `status error`). */
const plain = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9:]+/g, " ");

interface Family {
  paths: string[];
  label: string;
  /** One token the context fixes outright (focus ring, link, selection): no ΔE cut-off. */
  definitive?: boolean;
  /** A narrowed family that falls back to `fallback` when nothing in it is close. */
  fallback?: Family;
  /** A generic property family: stricter limits for saturated and translucent literals. */
  strict?: boolean;
  /** Paints an area (a background, an SVG fill): an opaque token would cover what is under it. */
  covers?: boolean;
}

function byPrefix(data: TokenData, ...prefixes: string[]): string[] {
  return [...data.colors.keys()].filter((p) => prefixes.some((x) => p === x || p.startsWith(x + ".")));
}

function genericFamily(data: TokenData, role: PropRole): Family | null {
  const text = byPrefix(data, "color.text").filter((p) => p !== "color.text.faint");
  switch (role) {
    case "text":
      return { paths: text, label: "text", strict: true };
    case "background":
      return { paths: [...byPrefix(data, "color.surface", "color.fill"), "color.accent"], label: "background (surface, fill, accent)", strict: true, covers: true };
    case "border":
      return { paths: [...byPrefix(data, "color.border"), "color.accent"], label: "border", strict: true };
    case "svgFill":
      return { paths: [...text, ...byPrefix(data, "color.border", "color.surface", "color.fill"), "color.accent"], label: "SVG fill", strict: true, covers: true };
    case "svgStroke":
      return { paths: [...byPrefix(data, "color.border"), ...text, "color.accent"], label: "SVG stroke", strict: true };
    case "accent":
      return { paths: ["color.accent"], label: "accent-color", definitive: true };
    default:
      return null;
  }
}

/** The family the context decides, or null when no role decides. */
function decideFamily(data: TokenData, ctx: Context, role: PropRole, ringShadow: boolean): Family | { none: string } | null {
  const h = plain(ctx.hints);
  const generic = genericFamily(data, role);
  const one = (path: string, label: string): Family => ({ paths: [path], label, definitive: true });
  const narrow = (paths: string[], label: string): Family => ({ paths, label, fallback: generic ?? undefined });

  if (role === "shadow" && !ringShadow) return { none: "shadow color: replace the whole box-shadow with shadow.glass or shadow.dialog, or keep it" };
  if (role === "shadow") role = "border";
  if (/::?selection\b/.test(h) || /\bselection\b/.test(h) && role === "background") return one("color.selection", "selection");
  if (/\bplaceholder\b/.test(h) && role === "text") return one("color.text.faint", "placeholder");
  if ((/\bfocus(?:ed|-visible|-within|visible|within)?\b|\bring\b/.test(h) || ringShadow) && role === "border") return one("color.focus-ring", "focus ring");
  for (const [re, kind] of STATUS) {
    if (!re.test(h)) continue;
    const s = `color.status.${kind}`;
    const onSolid = role === "text" && /\b(foreground|fg|on solid)\b/.test(h) && /\b(destructive|danger|error|warning|success|info)\b/.test(plain(ctx.definition ?? ""));
    if (onSolid) return narrow([`${s}.on-solid`], `${kind} glyph on solid`);
    if (role === "text") return narrow([`${s}.text`], `${kind} status text`);
    if (role === "background") return narrow([`${s}.soft`, `${s}.solid`], `${kind} status fill`);
    if (role === "border") return narrow([`${s}.line`, `${s}.solid`], `${kind} status border`);
    if (role === "svgFill" || role === "svgStroke") return narrow([`${s}.solid`, `${s}.text`], `${kind} status graphic`);
    return narrow(byPrefix(data, s), `${kind} status`);
  }
  if (/\b(diff|added|inserted|insertion|removed|deleted|deletion|modified)\b/.test(h)) {
    const kind = /\b(added|inserted|insertion|add|addition)\b/.test(h) ? "add" : /\b(removed|deleted|deletion|del)\b/.test(h) ? "del" : "mod";
    return narrow(role === "background" ? [`color.diff.${kind}-bg`] : [`color.diff.${kind}`], `diff ${kind}`);
  }
  if (/\b(hljs|token|syntax|keyword|cm)\b/.test(h) && role === "text") return narrow(byPrefix(data, "color.syntax"), "syntax");
  if (/\b(code|pre|kbd|samp|mono|monospace|codeblock)\b/.test(h)) {
    if (role === "background") return narrow(["color.code.bg", "color.code.gutter-bg", "color.fill.chip"], "code background");
    if (role === "border") return narrow(["color.code.border"], "code border");
    if (role === "text") return narrow(["color.code.chip.ink", "color.code.header-fg", "color.code.gutter-fg", ...byPrefix(data, "color.text").filter((p) => p !== "color.text.faint")], "code text");
  }
  if (role === "text" && (/(?:^|\s)a(?:\s|:|$)|\b(link|links|href|visited|anchor)\b/.test(h) || ctx.component === "a")) return one("color.link", "link");
  // A scrim stays translucent: no fallback to an opaque surface.
  if (role === "background" && /\b(backdrop|scrim|overlay)\b/.test(h)) return { paths: ["color.backdrop"], label: "backdrop" };
  if (/\bglass\b/.test(h) && (role === "background" || role === "border")) return narrow(role === "background" ? ["color.glass.bg"] : ["color.glass.border", "color.glass.zone-border"], "glass");
  if (/\b(chart|series|category|legend)\b/.test(h)) {
    const hues = byPrefix(data, ...HUES.map((x) => `color.${x}`), "color.category").filter((p) => !p.endsWith(".on-solid"));
    return { paths: hues, label: "categorical (hue tokens)" };
  }
  if (role === "background") {
    if (/(?:^|\s)hover\b|:hover\b/.test(h) || ctx.variants.includes("hover")) return narrow(["color.fill.hover"], "hover fill");
    if (/\b(active|selected|current|checked|pressed)\b|aria (?:selected|current|pressed)|data state (?:active|on|checked|open)/.test(h)) return narrow(["color.fill.active", "color.fill.accent"], "selected fill");
    if (/\b(sidebar|aside|nav|navigation|rail)\b/.test(h) || ctx.component === "aside" || ctx.component === "nav") return narrow(["color.surface.sidebar"], "sidebar surface");
    if (/\b(panel|card|popover|menu|dialog|modal|dropdown|tooltip|sheet|inspector|popup)\b/.test(h) || ctx.component === "dialog") return narrow(["color.surface.panel"], "panel surface");
    if (/\b(inset|well|sunken|recessed|track)\b/.test(h)) return narrow(["color.surface.sunken", "color.surface.inset"], "sunken surface");
    if (/\b(chip|tag|badge|pill)\b/.test(h)) return narrow(["color.fill.chip", "color.fill.active"], "chip fill");
    // A definition under :root is named for its role; only its name can say "page".
    const rootSelector = !ctx.definition && /(?:^|\s)(?::root|html|body)(?:\s|$)/.test(h);
    const pageName = /\b(page|app|main|layout|paper)\b/.test(h) || /^(--|\$)(background|bg)$/.test(ctx.definition ?? "");
    if (rootSelector || pageName || ctx.component === "body" || ctx.component === "html") return narrow(["color.surface.page"], "page surface");
  }
  if (role === "border" && /\b(active|selected|current|checked|dragging|drop|target)\b/.test(h)) return narrow(["color.accent", "color.border.strong"], "selected outline");
  return generic;
}

function nearestIn(data: TokenData, literal: Rgba, theme: Theme, paths: string[], penalty: (p: string) => number = () => 0) {
  let best: { path: string; de: number; rank: number } | null = null;
  for (const path of paths) {
    const token = data.colors.get(path);
    if (!token) continue;
    const de = deltaE(literal, token[theme], data.page[theme]);
    const rank = de + 25 * Math.abs(literal.a - token[theme].a) + penalty(path);
    if (!best || rank < best.rank) best = { path, de, rank };
  }
  return best;
}

type Verdict = { ok: true; path: string; de: number; keepAlpha?: number; note: string } | { ok: false; reason: string };

/**
 * The family's best token for the literal, or why none fits. A translucent literal whose base color
 * matches an opaque token keeps its alpha. A generic family is strict: a saturated literal must be
 * close (a hue never quietly becomes a gray), and a very translucent one never becomes opaque.
 */
function evaluate(data: TokenData, literal: Rgba, theme: Theme, family: Family, appId: string): Verdict {
  const page = data.page[theme];
  let paths = family.paths.filter((p) => allowed(p, appId));
  // A gray stays a gray in a generic family: no tinted fill for a neutral literal.
  // Neutral means within 0.01 chroma of the theme's page (dark neutrals carry a blue cast).
  const neutral = (c: Rgba) => chroma(composite(c, page)) < chroma(page) + 0.01;
  if (family.strict && neutral(literal)) paths = paths.filter((p) => neutral(data.colors.get(p)![theme]));
  if (literal.a < 0.99) {
    let base: { path: string; de: number } | null = null;
    for (const path of paths) {
      const token = data.colors.get(path)?.[theme];
      if (!token || token.a < 0.99) continue;
      const de = deltaE({ ...literal, a: 1 }, token, page);
      if (!base || de < base.de) base = { path, de };
    }
    if (base && base.de <= BASE_MATCH_DE) {
      const token = data.colors.get(base.path)![theme];
      const de = deltaE(literal, { ...token, a: literal.a }, page);
      return { ok: true, path: base.path, de, keepAlpha: literal.a, note: `; keeps alpha ${round2(literal.a)}` };
    }
  }
  const best = nearestIn(data, literal, theme, paths);
  if (!best) return { ok: false, reason: `${family.label}: no token` };
  const token = data.colors.get(best.path)![theme];
  const alpha = Math.abs(literal.a - token.a) > 0.02 ? `; alpha ${round2(literal.a)} becomes ${round2(token.a)}` : "";
  if (family.definitive) {
    const big = best.de > ROLE_MAX_DE ? `; visible change (ΔE ${round(best.de)})` : "";
    return { ok: true, path: best.path, de: best.de, note: `${big}${alpha}` };
  }
  let max = ROLE_MAX_DE;
  if (family.strict) {
    const saturated = chroma(composite(literal, page)) > chroma(page) + 0.04;
    if (saturated) max = neutral(token) ? HUE_TO_GRAY_MAX_DE : SATURATED_MAX_DE;
    if (family.covers && literal.a < 0.3 && token.a >= 0.99) return { ok: false, reason: `${family.label}: ${best.path} is opaque and the literal is ${round2(literal.a)} alpha (an overlay would cover what is under it)` };
  }
  if (best.de > max) return { ok: false, reason: `${family.label}: ${best.path} ΔE ${round(best.de)}` };
  return { ok: true, path: best.path, de: best.de, note: alpha };
}

const round = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Token paths a proposal may never use: Notion compat outside docs-system, annotation outside annotations. */
function allowed(path: string, appId: string): boolean {
  if (path.startsWith("color.notion.")) return /^docs-/.test(appId);
  if (path.startsWith("color.annotation.")) return /annotation/.test(appId);
  return true;
}

/** The pool for a pure nearest match: semantic roles plus hue tokens (ranked behind). */
function nearestPool(data: TokenData, appId: string, role: PropRole): string[] {
  const hues = HUES.map((x) => `color.${x}`);
  // Text never takes color.accent, not even as a hint.
  if (role === "text") return [...byPrefix(data, "color.text", "color.link"), ...byPrefix(data, ...hues).filter((p) => p.endsWith(".text"))];
  return byPrefix(data, "color.surface", "color.text", "color.border", "color.fill", "color.accent", "color.link", "color.backdrop", ...hues)
    .filter((p) => !p.endsWith(".on-solid") && allowed(p, appId));
}

const isHue = (p: string) => HUES.some((x) => p.startsWith(`color.${x}.`));

export function pickColor(data: TokenData, literal: Rgba, ctx: Context, opts: { appId: string; ringShadow?: boolean }): ColorPick {
  const theme = ctx.theme;
  let role = propRoleOf(ctx.property);
  const name = ctx.definition ?? (role === null ? ctx.property : null);
  if (name && (ctx.definition || role === null)) role = propRoleFromName(name) ?? role;
  const decided = decideFamily(data, ctx, role, !!opts.ringShadow);
  if (decided && "none" in decided) return { path: null, method: null, deltaE: null, why: decided.none };

  const pool = nearestPool(data, opts.appId, role);
  const overall = nearestIn(data, literal, theme, pool, (p) => (isHue(p) ? HUE_PENALTY : 0));
  const hint = overall ? `closest token overall: ${overall.path} (ΔE ${round(overall.de)})` : "";

  if (!decided) {
    if (overall && overall.de <= NEAREST_MAX_DE) {
      const hue = isHue(overall.path) ? "; a hue token: keep it only if the color is categorical" : "";
      return { path: overall.path, method: "nearest", deltaE: round(overall.de), why: `no role in context; nearest in ${theme}${hue}` };
    }
    return { path: null, method: null, deltaE: null, why: `no role in context and no token within ΔE ${NEAREST_MAX_DE}; ${hint}` };
  }

  let family: Family | undefined = decided;
  const tried: string[] = [];
  while (family) {
    const v = evaluate(data, literal, theme, family, opts.appId);
    if (v.ok) {
      const fell = tried.length ? ` (${tried.join("; ")}: too far)` : "";
      const flips = v.path === "color.text.on-solid" ? "; on-solid is near-black in dark: check the fill under it" : "";
      return { path: v.path, method: "role", deltaE: round(v.de), why: `${family.label}${fell}${v.note}${flips}`, keepAlpha: v.keepAlpha };
    }
    tried.push(v.reason);
    family = family.fallback;
  }
  const saturated = chroma(literal) > 0.06 ? "; saturated: a hue token fits only categorical color" : "";
  return { path: null, method: null, deltaE: null, why: `role ${decided.label} has no close token (${tried.join("; ")})${saturated}; ${hint}` };
}
