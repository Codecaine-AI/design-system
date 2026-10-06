/**
 * Picks the design-system color token for a color literal. Role first: the property, the
 * selector, the component and any variable name decide a chain of token families (a status, a
 * hover fill, then the generic text, background or border family), and the first family with a
 * close, compatible member wins. Nearest second: when no role decides, the nearest semantic token,
 * with hue tokens ranked behind semantic ones.
 *
 * Every family runs the same guards: a neutral literal only takes a neutral token, a hued literal
 * only a token of its hue (or a gray it is already close to), and a translucent literal on an area
 * keeps its alpha or stays unmapped.
 */

import { chroma, composite, deltaE, rgbToOklab, type Rgba } from "./color.ts";
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

/** A generic family pick farther than this is not proposed: the role is probably misread. */
export const ROLE_MAX_DE = 20;
/** A narrowed family (a status, a hover fill, a focus ring) must be this close, or the chain moves on. */
export const NARROW_MAX_DE = 10;
/** A pure nearest-color pick farther than this is not proposed. */
export const NEAREST_MAX_DE = 10;
/** A saturated literal in a generic family (text, background, border) must be this close. */
const SATURATED_MAX_DE = 12;
/** A hued literal becomes a gray only this close: a hue does not quietly become a neutral. */
const HUE_TO_GRAY_MAX_DE = 5;
/** A translucent literal keeps its alpha on a token whose opaque base is this close. */
const BASE_MATCH_DE = 3;
/** Added to a hue token's ΔE in nearest ranking, so a close semantic token wins. */
const HUE_PENALTY = 4;
/** Tint (OKLab chroma away from the theme's page) at or under which a color reads as gray. */
const NEUTRAL_TINT = 0.008;
/** ... and at or under which a tinted literal may still become a gray at any ΔE in the cap. */
const FAINT_TINT = 0.02;
/** Tokens at or under this tint are the neutral roles (dark neutrals share the page's blue cast). */
const NEUTRAL_TOKEN_TINT = 0.01;
/** Two tints are the same hue within this many degrees. */
const SAME_HUE_DEG = 45;
/** ... and of a like strength (as rendered): within this much OKLab chroma, or this ratio. A wash is not a solid. */
const SAME_CHROMA = 0.03;
const SAME_CHROMA_RATIO = 0.4;
/** A literal this transparent paints nothing: no token is proposed. */
const INVISIBLE_ALPHA = 0.02;

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

/**
 * A role from the words of a variable or key name (`--muted-foreground`, `SCRIM_COLOR`, `bg`).
 * Background words outrank `input`, `ring` and `focus`, so `--input-bg` is a background and
 * `--input` (shadcn's input border) a border.
 */
function propRoleFromName(name: string): PropRole {
  const w = words(name);
  if (w.some((x) => ["foreground", "fg", "text", "ink", "label", "glyph", "font"].includes(x))) return "text";
  if (w.some((x) => ["shadow"].includes(x))) return "shadow";
  if (w.some((x) => ["border", "rule", "divider", "separator", "outline", "line", "stroke"].includes(x))) return "border";
  if (w.some((x) => ["background", "bg", "surface", "canvas", "page", "paper", "panel", "card", "popover", "fill", "wash", "tint", "scrim", "overlay", "backdrop", "primary", "secondary", "muted", "accent", "destructive", "sidebar", "base", "layer", "well", "chip", "highlight"].includes(x))) return "background";
  if (w.some((x) => ["input", "ring", "focus"].includes(x))) return "border";
  return null;
}

const STATUS: Array<[RegExp, string]> = [
  [/\b(error|errors|danger|destructive|invalid|fail|failed|failure|reject|rejected|critical|delete|remove)\b/, "danger"],
  [/\b(warning|warn|caution|pending|stale|attention)\b/, "warning"],
  [/\b(success|ok|valid|done|pass|passed|accept|accepted|complete|completed|positive|ready)\b/, "success"],
  [/\b(info|notice|hint|tip)\b/, "info"],
];

/** Tailwind hues that paint a status when a class string uses them as a tone (bg, text and border in one hue). */
const TONES: Record<string, string> = { amber: "warning", yellow: "warning", orange: "warning", red: "danger", rose: "danger", green: "success", emerald: "success", lime: "success" };

/** Words with hyphens and underscores split, for \b matching (`status-error` -> `status error`). */
const plain = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9:]+/g, " ");

interface Family {
  paths: string[];
  label: string;
  /** Structure fixes the token outright (`::selection`, `accent-color`): no ΔE cut-off, no guards. */
  definitive?: boolean;
  /** The next family to try when nothing here is close and compatible. */
  fallback?: Family;
  /** A generic property family: the wider ΔE cap, stricter for saturated literals. */
  strict?: boolean;
  /** The chain stops here (a scrim never falls back to an opaque surface). */
  terminal?: boolean;
}

function byPrefix(data: TokenData, ...prefixes: string[]): string[] {
  return [...data.colors.keys()].filter((p) => prefixes.some((x) => p === x || p.startsWith(x + ".")));
}

const coversRole = (role: PropRole) => role === "background" || role === "svgFill";

function genericFamily(data: TokenData, role: PropRole): Family | null {
  const text = byPrefix(data, "color.text").filter((p) => p !== "color.text.faint");
  switch (role) {
    case "text":
      return { paths: text, label: "text", strict: true };
    case "background":
      return { paths: [...byPrefix(data, "color.surface", "color.fill"), "color.accent"], label: "background (surface, fill, accent)", strict: true };
    case "border":
      return { paths: [...byPrefix(data, "color.border"), "color.accent"], label: "border", strict: true };
    case "svgFill":
      return { paths: [...text, ...byPrefix(data, "color.border", "color.surface", "color.fill"), "color.accent"], label: "SVG fill", strict: true };
    case "svgStroke":
      return { paths: [...byPrefix(data, "color.border"), ...text, "color.accent"], label: "SVG stroke", strict: true };
    case "accent":
      return { paths: ["color.accent"], label: "accent-color", definitive: true };
    default:
      return null;
  }
}

/** The variable or key the literal is the value of, when it is a name rather than a CSS property. */
function ownName(ctx: Context): string | null {
  if (ctx.definition) return ctx.definition;
  return ctx.property && propRoleOf(ctx.property) === null ? ctx.property : null;
}

/**
 * Roles only structure can give: a focus ring needs a `:focus*` selector, a `focus:` variant or a
 * name (`--ring`, `focusRing`); a placeholder needs `::placeholder`, `placeholder:` or a name; a
 * link needs an `a` element, `:link`/`:visited` or a name. Loose words in classes or text never do.
 */
function structure(ctx: Context) {
  const sel = ctx.inCss ? (ctx.selector ?? "") : "";
  const v = ctx.variants;
  const name = words(ownName(ctx) ?? "");
  return {
    focus: /:focus(?:-visible|-within)?(?![\w-])/i.test(sel) || v.some((x) => /^(?:group-|peer-)?focus(?:-visible|-within)?$/.test(x)) || name.includes("focus") || name.includes("ring"),
    placeholder: /:(?::|-webkit-input-|-moz-)?placeholder/i.test(sel) || v.includes("placeholder") || ctx.property === "placeholder" || name.includes("placeholder"),
    link: /^(?:a|Link|NavLink)$/.test(ctx.component ?? "") || /:(?:link|visited|any-link)(?![\w-])/i.test(sel) || name.includes("link"),
    selection: /::?selection(?![\w-])/i.test(sel) || v.includes("selection"),
  };
}

/**
 * Tint of a color's opaque base: how far it is from gray, and its hue measured from the theme's
 * page. Gray is either axis: true gray (absolute chroma) or the page's own cast (dark neutrals
 * share the dark page's blue), so `#444` and the dark surfaces both read as gray.
 */
function tintOf(c: Rgba, page: Rgba): { c: number; h: number } {
  const p = rgbToOklab(page);
  const q = rgbToOklab({ ...c, a: 1 });
  const a = q.a - p.a;
  const b = q.b - p.b;
  return { c: Math.min(Math.hypot(a, b), Math.hypot(q.a, q.b)), h: (Math.atan2(b, a) * 180) / Math.PI };
}

const hueGap = (x: number, y: number) => {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};

/** The status a Tailwind tone names: two or more color utilities of one status hue in the class string, in the literal's own hue. */
function toneStatus(data: TokenData, ctx: Context, literal: Rgba, theme: Theme): string | null {
  if (ctx.inCss || !ctx.selector) return null;
  const counts = new Map<string, number>();
  for (const m of ctx.selector.matchAll(/(?:^|[\s:!"'`])(?:bg|text|border(?:-[xytrblse])?|ring|outline|fill|stroke|from|via|to|divide)-([a-z]+)-(?:50|[1-9]00|950)(?![\w-])/g)) {
    if (TONES[m[1]]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const page = data.page[theme];
  const lt = tintOf(literal, page);
  for (const [hue, n] of counts) {
    if (n < 2) continue;
    const kind = TONES[hue];
    const solid = data.colors.get(`color.status.${kind}.solid`)?.[theme];
    if (solid && lt.c > NEUTRAL_TINT && hueGap(lt.h, tintOf(solid, page).h) <= SAME_HUE_DEG) return kind;
  }
  return null;
}

/** Ordered families the context decides (each falls back to the next), or a reason it maps to nothing. */
function decideFamily(data: TokenData, ctx: Context, role: PropRole, ringShadow: boolean, literal: Rgba): Family | { none: string } | null {
  const h = plain(ctx.hints);
  const s = structure(ctx);
  if (role === "shadow" && !ringShadow) return { none: "shadow color: replace the whole box-shadow with shadow.glass or shadow.dialog, or keep it" };
  if (role === "shadow") role = "border";
  const generic = genericFamily(data, role);
  const chain: Family[] = [];
  const one = (path: string, label: string): Family => ({ paths: [path], label, definitive: true });
  const narrow = (paths: string[], label: string, extra: Partial<Family> = {}) => chain.push({ paths, label, ...extra });

  if (s.selection && role === "background") return one("color.selection", "selection");
  if (role === "accent") return generic;
  if (s.placeholder && role === "text") narrow(["color.text.faint"], "placeholder");
  if (s.focus && role === "border") narrow(["color.focus-ring"], "focus ring");
  if (role === "background" && /\bselection\b/.test(h)) narrow(["color.selection"], "selection");

  const chart = /\b(chart|charts|series|legend|legends|axis|axes|tick|ticks|gridline|gridlines|plot|sparkline|donut|pie)\b/.test(h);
  if (chart && role !== "text") {
    // Labels, values and legends use text tokens; axes border.strong; gridlines border.subtle; marks
    // (fills, strokes, swatches) the series. The chart's own chrome (a card border) is not a mark.
    const polarity = /\b(diverging|polarity|midpoint|baseline|zero|gain|gains|loss|losses|inflow|outflow|positive|negative|delta)\b/.test(h);
    if (/\b(axis|axes|tick|ticks|domain)\b/.test(h) && role !== "background") narrow(["color.border.strong"], "chart axis");
    else if (/\b(gridline|gridlines|grid)\b/.test(h)) narrow(["color.border.subtle"], "chart gridline");
    else if (role !== "border" || /\b(series|legend|legends|swatch)\b/.test(h)) {
      const diverging = byPrefix(data, "color.chart.diverging").filter((p) => polarity || !p.endsWith(".midpoint"));
      narrow([...byPrefix(data, "color.chart.series"), ...diverging], "chart series");
    }
  }

  // A category map (`TAG_CATEGORY_COLORS = { red: … }`) is categorical: its hues are not statuses.
  const categorical = !chart && /\b(category|categories|categorical)\b/.test(h);
  if (categorical) {
    narrow(byPrefix(data, ...HUES.map((x) => `color.${x}`), "color.category").filter((p) => !p.endsWith(".on-solid")), "categorical (hue tokens)");
  }
  const tone = categorical ? null : toneStatus(data, ctx, literal, ctx.theme);
  for (const [re, kind] of STATUS) {
    if (!re.test(h) && tone !== kind) continue;
    const st = `color.status.${kind}`;
    const onSolid = role === "text" && /\b(foreground|fg|on solid)\b/.test(h) && /\b(destructive|danger|error|warning|success|info)\b/.test(plain(ctx.definition ?? ""));
    if (onSolid) narrow([`${st}.on-solid`], `${kind} glyph on solid`);
    else if (role === "text") narrow([`${st}.text`], `${kind} status text`);
    else if (role === "background") narrow([`${st}.soft`, `${st}.solid`], `${kind} status fill`);
    else if (role === "border") narrow([`${st}.line`, `${st}.solid`], `${kind} status border`);
    else if (role === "svgFill" || role === "svgStroke") narrow([`${st}.solid`, `${st}.text`], `${kind} status graphic`);
    else narrow(byPrefix(data, st), `${kind} status`);
    break;
  }
  if (/\b(diff|added|inserted|insertion|removed|deleted|deletion|modified)\b/.test(h)) {
    const kind = /\b(added|inserted|insertion|add|addition)\b/.test(h) ? "add" : /\b(removed|deleted|deletion|del)\b/.test(h) ? "del" : "mod";
    narrow(role === "background" ? [`color.diff.${kind}-bg`] : [`color.diff.${kind}`], `diff ${kind}`);
  }
  if (/\b(hljs|token|syntax|keyword|cm)\b/.test(h) && role === "text") narrow(byPrefix(data, "color.syntax"), "syntax");
  if (/\b(code|pre|kbd|samp|mono|monospace|codeblock)\b/.test(h)) {
    if (role === "background") narrow(["color.code.bg", "color.code.gutter-bg", "color.fill.chip"], "code background");
    if (role === "border") narrow(["color.code.border"], "code border");
    if (role === "text") narrow(["color.code.chip.ink", "color.code.header-fg", "color.code.gutter-fg"], "code text");
  }
  if (role === "text" && s.link) narrow(["color.link"], "link");
  // A scrim stays translucent: no fallback to an opaque surface. An opaque fill under `.overlay`
  // (`.overlay .dialog`) is a surface, not the scrim.
  if (role === "background" && /\b(backdrop|scrim|overlay)\b/.test(h) && literal.a < 0.99) narrow(["color.backdrop"], "backdrop", { terminal: true });
  else {
    if (/\bglass\b/.test(h) && (role === "background" || role === "border")) narrow(role === "background" ? ["color.glass.bg"] : ["color.glass.border", "color.glass.zone-border"], "glass");
    if (role === "background") {
      if (/(?:^|\s)hover\b|:hover\b/.test(h) || ctx.variants.includes("hover")) narrow(["color.fill.hover"], "hover fill");
      if (/\b(active|selected|current|checked|pressed)\b|aria (?:selected|current|pressed)|data state (?:active|on|checked|open)/.test(h)) narrow(["color.fill.active", "color.fill.accent"], "selected fill");
      if (/\b(sidebar|aside|nav|navigation|rail)\b/.test(h) || ctx.component === "aside" || ctx.component === "nav") narrow(["color.surface.sidebar"], "sidebar surface");
      if (/\b(panel|card|popover|menu|dialog|modal|dropdown|tooltip|sheet|inspector|popup)\b/.test(h) || ctx.component === "dialog") narrow(["color.surface.panel"], "panel surface");
      if (/\b(inset|well|sunken|recessed|track)\b/.test(h)) narrow(["color.surface.sunken", "color.surface.inset"], "sunken surface");
      if (/\b(chip|tag|badge|pill)\b/.test(h)) narrow(["color.fill.chip", "color.fill.active"], "chip fill");
      // A definition under :root is named for its role; only its name can say "page".
      const rootSelector = !ctx.definition && /(?:^|\s)(?::root|html|body)(?:\s|$)/.test(h);
      const pageName = /\b(page|app|main|layout|paper)\b/.test(h) || /^(--|\$)(background|bg)$/.test(ctx.definition ?? "");
      if (rootSelector || pageName || ctx.component === "body" || ctx.component === "html") narrow(["color.surface.page"], "page surface");
    }
    if (role === "border" && /\b(active|selected|current|checked|dragging|drop|target)\b/.test(h)) narrow(["color.accent", "color.border.strong"], "selected outline");
    if (generic) chain.push(generic);
  }
  if (!chain.length) return null;
  for (let i = 0; i < chain.length - 1; i++) if (!chain[i].terminal) chain[i].fallback = chain[i + 1];
  return chain[0];
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

/**
 * Whether `token` may stand for `literal`: a gray literal takes a gray token; a tinted literal
 * takes a token of its hue, or a gray when the tint is faint or the gray is already within
 * HUE_TO_GRAY_MAX_DE (as rendered).
 */
function compatible(literal: Rgba, token: Rgba, page: Rgba, de: number): boolean {
  if (!Number.isFinite(de)) return false;
  const lt = tintOf(literal, page);
  const tt = tintOf(token, page);
  const grayToken = tt.c <= NEUTRAL_TOKEN_TINT;
  if (lt.c <= NEUTRAL_TINT) return grayToken;
  if (grayToken) return lt.c <= FAINT_TINT || de <= HUE_TO_GRAY_MAX_DE;
  if (hueGap(lt.h, tt.h) > SAME_HUE_DEG) return false;
  // Same hue, but a wash never becomes a solid (or back): chroma as rendered stays within reach.
  const lc = chroma(composite(literal, page));
  const tc = chroma(composite(token, page));
  return Math.abs(lc - tc) <= SAME_CHROMA || Math.min(lc, tc) / Math.max(lc, tc) >= SAME_CHROMA_RATIO;
}

type Verdict = { ok: true; path: string; de: number; keepAlpha?: number; note: string } | { ok: false; reason: string };

/**
 * The family's best token for the literal, or why none fits. A translucent literal whose base color
 * matches an opaque token keeps its alpha; on an area it never becomes an opaque token. Neutral and
 * hue compatibility hold in every family; a narrowed family caps at NARROW_MAX_DE, a generic one at
 * ROLE_MAX_DE (tighter for a saturated literal).
 */
function evaluate(data: TokenData, literal: Rgba, theme: Theme, family: Family, opts: Allow, covers: boolean): Verdict {
  const page = data.page[theme];
  const paths = family.paths.filter((p) => tokenAllowed(p, opts) && data.colors.has(p));
  if (family.definitive) {
    const best = nearestIn(data, literal, theme, paths);
    if (!best) return { ok: false, reason: `${family.label}: no token` };
    const token = data.colors.get(best.path)![theme];
    const alpha = Math.abs(literal.a - token.a) > 0.02 ? `; alpha ${round2(literal.a)} becomes ${round2(token.a)}` : "";
    const big = best.de > ROLE_MAX_DE ? `; visible change (ΔE ${round(best.de)})` : "";
    return { ok: true, path: best.path, de: best.de, note: `${big}${alpha}` };
  }
  if (literal.a < 0.99) {
    // A translucent token drawn the same way (text.secondary, selection, backdrop) beats a kept alpha.
    const same = nearestIn(data, literal, theme, paths.filter((p) => Math.abs(data.colors.get(p)![theme].a - literal.a) <= 0.02));
    if (same && same.de <= BASE_MATCH_DE) return { ok: true, path: same.path, de: same.de, note: "" };
    let base: { path: string; de: number } | null = null;
    for (const path of paths) {
      const token = data.colors.get(path)![theme];
      if (token.a < 0.99) continue;
      const opaque = { ...literal, a: 1 };
      const de = deltaE(opaque, token, page);
      if (!compatible(opaque, token, page, de)) continue;
      if (!base || de < base.de) base = { path, de };
    }
    if (base && base.de <= BASE_MATCH_DE) {
      const token = data.colors.get(base.path)![theme];
      const de = deltaE(literal, { ...token, a: literal.a }, page);
      return { ok: true, path: base.path, de, keepAlpha: literal.a, note: `; keeps alpha ${round2(literal.a)}` };
    }
  }
  const fits = paths.filter((p) => {
    const token = data.colors.get(p)![theme];
    if (covers && literal.a < 0.99 && token.a >= 0.99) return false;
    return compatible(literal, token, page, deltaE(literal, token, page));
  });
  const best = nearestIn(data, literal, theme, fits);
  if (!best) {
    if (covers && literal.a < 0.99) return { ok: false, reason: `${family.label}: no token keeps alpha ${round2(literal.a)} (an opaque token would cover what is under it)` };
    const lt = tintOf(literal, page);
    return { ok: false, reason: `${family.label}: no ${lt.c <= NEUTRAL_TINT ? "neutral" : "same-hue"} token` };
  }
  const token = data.colors.get(best.path)![theme];
  const alpha = Math.abs(literal.a - token.a) > 0.02 ? `; alpha ${round2(literal.a)} becomes ${round2(token.a)}` : "";
  let max = family.strict ? ROLE_MAX_DE : NARROW_MAX_DE;
  if (family.strict && chroma(composite(literal, page)) > chroma(page) + 0.04) max = SATURATED_MAX_DE;
  if (!(best.de <= max)) return { ok: false, reason: `${family.label}: ${best.path} ΔE ${round(best.de)}` };
  return { ok: true, path: best.path, de: best.de, note: alpha };
}

const round = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Allow {
  appId: string;
  /** Root-relative path of the file the literal sits in. */
  file?: string;
}

/**
 * Token paths a proposal may use here: Notion compat only in the docs-system repo
 * (`codecaine/core/docs-system/`), annotation tokens only in annotation apps.
 */
export function tokenAllowed(path: string, where: Allow): boolean {
  if (path.startsWith("color.notion.")) return /(?:^|\/)codecaine\/core\/docs-system\//.test(where.file ?? "");
  if (path.startsWith("color.annotation.")) return /annotation/.test(where.appId);
  return true;
}

/** The pool for a pure nearest match: semantic roles plus hue tokens (ranked behind). */
function nearestPool(data: TokenData, where: Allow, role: PropRole): string[] {
  const hues = HUES.map((x) => `color.${x}`);
  // Text never takes color.accent, not even as a hint.
  if (role === "text") return [...byPrefix(data, "color.text", "color.link"), ...byPrefix(data, ...hues).filter((p) => p.endsWith(".text"))];
  return byPrefix(data, "color.surface", "color.text", "color.border", "color.fill", "color.accent", "color.link", "color.backdrop", ...hues)
    .filter((p) => !p.endsWith(".on-solid") && tokenAllowed(p, where));
}

const isHue = (p: string) => HUES.some((x) => p.startsWith(`color.${x}.`));

export function pickColor(data: TokenData, literal: Rgba, ctx: Context, opts: Allow & { ringShadow?: boolean }): ColorPick {
  if (literal.a <= INVISIBLE_ALPHA) return { path: null, method: null, deltaE: null, why: `transparent (alpha ${round2(literal.a)}): keep \`transparent\`, or drop the declaration` };
  const theme = ctx.theme;
  const page = data.page[theme];
  let role = propRoleOf(ctx.property);
  const name = ctx.definition ?? (role === null ? ctx.property : null);
  if (name && (ctx.definition || role === null)) role = propRoleFromName(name) ?? role;
  const decided = decideFamily(data, ctx, role, !!opts.ringShadow, literal);
  // A translucent literal on an area (a background, an SVG fill) never becomes an opaque token.
  const covers = coversRole(role);
  if (decided && "none" in decided) return { path: null, method: null, deltaE: null, why: decided.none };

  const pool = nearestPool(data, opts, role).filter((p) => {
    const token = data.colors.get(p)![theme];
    return compatible(literal, token, page, deltaE(literal, token, page));
  });
  const overall = nearestIn(data, literal, theme, pool, (p) => (isHue(p) ? HUE_PENALTY : 0));
  const hint = overall ? `closest compatible token: ${overall.path} (ΔE ${round(overall.de)})` : "no compatible token in the nearest pool";

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
    const v = evaluate(data, literal, theme, family, opts, covers);
    if (v.ok) {
      const fell = tried.length ? ` (${tried.join("; ")}: no fit)` : "";
      const flips = v.path === "color.text.on-solid" ? "; on-solid is near-black in dark: check the fill under it" : "";
      return { path: v.path, method: "role", deltaE: round(v.de), why: `${family.label}${fell}${v.note}${flips}`, keepAlpha: v.keepAlpha };
    }
    tried.push(v.reason);
    family = family.fallback;
  }
  const saturated = chroma(literal) > 0.06 ? "; saturated: a hue token fits only categorical color" : "";
  return { path: null, method: null, deltaE: null, why: `role ${decided.label} has no close token (${tried.join("; ")})${saturated}; ${hint}` };
}
