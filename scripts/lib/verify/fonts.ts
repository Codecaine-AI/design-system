/**
 * Inter and IBM Plex Mono load as the package's web fonts, judged on what the page itself loaded
 * (decision 20; the managing agent's ruling on finding N5):
 *
 *   Inter          its regular face (weight 400, normal style) was loaded by the page before the check
 *                  forced anything. The check never forces Inter.
 *   IBM Plex Mono  rendered on the route (one of its faces was not "unloaded" before the check, or a
 *                  font-family probe on a text element computes to it): the same rule as Inter. Not
 *                  rendered: the check force-loads `400 16px "IBM Plex Mono"` and passes only when that
 *                  face comes from the package ("available, not rendered on this route"). Rendered
 *                  only in other faces (the page loaded a 500 or 600 face and never asked for the
 *                  regular one, as simple-research-kernel does): every face the page loaded must pass
 *                  the source rules below, then the check force-loads the regular face as when not
 *                  rendered, and it must load and pass them too.
 *
 * Then the @font-face rule that declares the regular face (the last one, which wins) must list a url()
 * that was fetched and that font-source.ts accepts: the package's fonts/, or a byte copy of a package
 * font declared in the package's fonts.css. A local() face, a fallback, or the same font from another
 * package (text-measure's fonts) fails. A face other than the regular one is judged by the same rules,
 * on the rule that declares its own weight and style. Every judged face must be attributable to a
 * readable rule: when document.fonts holds more faces with its weight and style than readable rules
 * declare (a FontFace added from script, a rule in a cross-origin stylesheet), the check cannot read the
 * source of the face that loaded, and it fails. Family names match case-insensitively, as in the browser.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probeRole, type VerifySpec } from "../registry";
import { type Assertion, fail, pass, type ResponseLog } from "./assertions";

export const FONT_FAMILIES = ["Inter", "IBM Plex Mono"] as const;

/** Families the check may force-load when the route does not render them. Every other family is judged only on what the page loaded. */
export const FORCED_WHEN_NOT_RENDERED: readonly string[] = ["IBM Plex Mono"];

export interface FaceStatus {
  weight: string;
  style: string;
  /** FontFace.status: "unloaded", "loading", "loaded" or "error". */
  status: string;
  /** FontFace.unicodeRange; absent reads as the whole range (U+0-10FFFF). */
  unicodeRange?: string;
}

/** An @font-face rule: its descriptors, src, the resolved url()s, whether a local() source is listed, and its stylesheet. */
export interface FontRule {
  weight: string;
  style: string;
  src: string;
  urls: string[];
  local: boolean;
  /** href of the stylesheet that holds the rule, after following @import; null for an inline <style> or a constructed sheet. */
  sheet: string | null;
  /**
   * Whether the rule applies to the page: its sheet is enabled and its media list matches, every
   * @import on the way matches its media, every enclosing @media matches and every enclosing @supports
   * holds. An inactive rule (in `@media print`, say) puts no face in document.fonts.
   */
  active: boolean;
  /** The unicode-range descriptor; absent or empty reads as the whole range. */
  unicodeRange?: string;
}

export interface FontReading {
  family: string;
  /** The family's faces after document.fonts.ready (bounded), before the check forced any load. */
  before: FaceStatus[];
  /** The faces after the check's forced load; the same as `before` when it forced nothing. */
  after: FaceStatus[];
  /** The font the check force-loaded (`400 16px "IBM Plex Mono"`), or null. */
  forced: string | null;
  /** Selectors of font-family probes on text elements whose computed font-family starts with this family. */
  probedBy: string[];
  /** @font-face rules for the family, in cascade order. */
  rules: FontRule[];
  /** Stylesheets whose rules the page could not read (cross-origin). */
  unreadableSheets: number;
}

/** Where a fetched font url() came from. */
export interface FontSourceVerdict {
  ok: boolean;
  /** "the package's fonts/", "a copy of a package font", or why it does not count. */
  how: string;
  path?: string;
}

/**
 * Judges a fetched font url() of the winning @font-face rule, given the stylesheet that holds that rule
 * (FontRule.sheet); built by font-source.ts from the run (served paths, the resolved package).
 */
export type FontSourceJudge = (url: string, sheet: string | null) => FontSourceVerdict;

/** Selectors of the spec's font-family probes on a text element: the selector is also a text-role probe's (probeRole). */
export function fontProbeSelectors(verify: Pick<VerifySpec, "probes"> | undefined): string[] {
  const probes = verify?.probes ?? [];
  const text = new Set(probes.filter((probe) => probeRole(probe) === "text").map((probe) => probe.selector));
  return [...new Set(probes.filter((probe) => probe.property === "font-family" && text.has(probe.selector)).map((probe) => probe.selector))];
}

/** Whether the route renders the family: the page started loading one of its faces, or a text probe's font-family computes to it. */
export function rendersFamily(reading: Pick<FontReading, "before" | "probedBy">): boolean {
  return reading.before.some((face) => face.status !== "unloaded") || reading.probedBy.length > 0;
}

/**
 * Whether the route renders the family only in faces other than the regular one: the page loaded one of
 * its faces before the check, and the family declares a regular face that the page never asked for.
 */
export function rendersOnlyOtherFaces(reading: Pick<FontReading, "before">): boolean {
  const regular = regularOf(reading.before);
  return regular.length > 0 && regular.every((face) => face.status === "unloaded") && reading.before.some((face) => face.status === "loaded");
}

/**
 * The font the check force-loads for a family (`400 16px "<family>"`), or null: only for a family in
 * FORCED_WHEN_NOT_RENDERED that the route does not render, or renders only in other faces.
 */
export function forcedLoad(family: string, reading: Pick<FontReading, "before" | "probedBy">): string | null {
  if (!FORCED_WHEN_NOT_RENDERED.includes(family)) return null;
  return !rendersFamily(reading) || rendersOnlyOtherFaces(reading) ? `400 16px "${family}"` : null;
}

export interface ReadFontsOptions {
  families?: readonly string[];
  /** fontProbeSelectors(verify): text elements whose computed font-family can show IBM Plex Mono renders. */
  textProbes?: string[];
}

/**
 * Reads each family's faces as the page left them (after document.fonts.ready, at most 10 s), then
 * force-loads the regular face of a family in FORCED_WHEN_NOT_RENDERED that the route does not render
 * or renders only in other faces (forcedLoad), and reads the faces again with the @font-face rules that
 * declare them. Nothing else is forced.
 */
export async function readFonts(page: any, opts: ReadFontsOptions = {}): Promise<FontReading[]> {
  const families = [...(opts.families ?? FONT_FAMILIES)];
  const seen: Array<Pick<FontReading, "before" | "probedBy">> = await page.evaluate(
    async ({ names, selectors }: { names: string[]; selectors: string[] }) => {
      // Family names match case-insensitively, as the browser matches them.
      const clean = (family: string) => family.replace(/["']/g, "").trim().toLowerCase();
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      const firstFamilies = selectors.map((selector) => {
        const element = document.querySelector(selector);
        return { selector, family: element ? clean(getComputedStyle(element).fontFamily.split(",")[0] ?? "") : null };
      });
      return names.map((name) => ({
        before: Array.from(document.fonts)
          .filter((face) => clean(face.family) === name.toLowerCase())
          .map((face) => ({ weight: face.weight, style: face.style, status: face.status, unicodeRange: face.unicodeRange })),
        probedBy: firstFamilies.filter((probe) => probe.family === name.toLowerCase()).map((probe) => probe.selector),
      }));
    },
    { names: families, selectors: opts.textProbes ?? [] },
  );
  const forced = families.map((family, i) => forcedLoad(family, seen[i]!));
  const rest: Array<Pick<FontReading, "after" | "rules" | "unreadableSheets">> = await page.evaluate(
    async ({ names, loads }: { names: string[]; loads: string[] }) => {
      const clean = (family: string) => family.replace(/["']/g, "").trim().toLowerCase();
      if (loads.length) {
        const loading = Promise.all(loads.map((font) => document.fonts.load(font).catch(() => undefined)));
        await Promise.race([loading, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      }
      const rules: Array<{ family: string; weight: string; style: string; src: string; unicodeRange: string; base: string; sheet: string | null; active: boolean }> = [];
      let unreadableSheets = 0;
      // A media list matches when it is empty or matchMedia says so (screen, not print, for the check's page).
      const mediaMatches = (media: MediaList | null | undefined) => !media || !media.mediaText.trim() || window.matchMedia(media.mediaText).matches;
      const walk = (list: CSSRuleList, base: string, sheet: string | null, active: boolean) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSFontFaceRule) {
            const style = rule.style;
            rules.push({
              family: clean(style.getPropertyValue("font-family")),
              weight: style.getPropertyValue("font-weight").trim(),
              style: style.getPropertyValue("font-style").trim(),
              src: style.getPropertyValue("src"),
              unicodeRange: style.getPropertyValue("unicode-range").trim(),
              base,
              sheet,
              active,
            });
          } else if (rule instanceof CSSImportRule) {
            try {
              const imported = rule.styleSheet;
              if (imported) walk(imported.cssRules, imported.href ?? base, imported.href ?? sheet, active && mediaMatches(rule.media) && !imported.disabled && mediaMatches(imported.media));
            } catch {
              unreadableSheets += 1;
            }
          } else if (rule instanceof CSSMediaRule) {
            walk(rule.cssRules, base, sheet, active && mediaMatches(rule.media));
          } else if (rule instanceof CSSSupportsRule) {
            walk(rule.cssRules, base, sheet, active && CSS.supports(rule.conditionText));
          } else if ("cssRules" in rule) {
            walk((rule as CSSGroupingRule).cssRules, base, sheet, active);
          }
        }
      };
      const sheets = [...Array.from(document.styleSheets), ...Array.from(document.adoptedStyleSheets ?? [])];
      for (const sheet of sheets) {
        try {
          walk(sheet.cssRules, sheet.href ?? document.baseURI, sheet.href ?? null, !sheet.disabled && mediaMatches(sheet.media));
        } catch {
          unreadableSheets += 1;
        }
      }
      return names.map((family) => ({
        after: Array.from(document.fonts)
          .filter((face) => clean(face.family) === family.toLowerCase())
          .map((face) => ({ weight: face.weight, style: face.style, status: face.status, unicodeRange: face.unicodeRange })),
        rules: rules
          .filter((rule) => rule.family === family.toLowerCase())
          .map((rule) => ({
            weight: rule.weight,
            style: rule.style,
            src: rule.src,
            urls: [...rule.src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => {
              try {
                return new URL(m[2]!, rule.base).href;
              } catch {
                return m[2]!;
              }
            }),
            local: /local\(/.test(rule.src),
            sheet: rule.sheet,
            active: rule.active,
            unicodeRange: rule.unicodeRange,
          })),
        unreadableSheets,
      }));
    },
    { names: families, loads: forced.filter((font): font is string => font !== null) },
  );
  return families.map((family, i) => ({ family, ...seen[i]!, forced: forced[i]!, ...rest[i]! }));
}

function fetched(url: string, responses: ResponseLog): boolean {
  if (url.startsWith("data:")) return true;
  if (url.startsWith("file:")) return existsSync(fileURLToPath(url));
  const status = responses.get(url)?.status;
  return status !== undefined && ((status >= 200 && status < 300) || status === 304);
}

const KEYWORD_WEIGHT: Record<string, number> = { normal: 400, bold: 700, "": 400 };

/** A font-weight descriptor ("400", "normal", "100 900") as its [low, high] range, or null when it does not parse. */
function weightRange(descriptor: string): [number, number] | null {
  const parts = descriptor.trim().split(/\s+/).filter(Boolean).map((part) => KEYWORD_WEIGHT[part] ?? Number(part));
  if (parts.length === 0) return [400, 400];
  if (parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0]!, parts[1] ?? parts[0]!];
}

/** Whether a font-weight descriptor ("400", "normal", "100 900") covers `weight`. */
export function weightCovers(descriptor: string, weight = 400): boolean {
  const range = weightRange(descriptor);
  return range !== null && weight >= range[0] && weight <= range[1];
}

/** Whether a font-style descriptor is the upright style ("normal", or not set). */
export function styleIsNormal(descriptor: string): boolean {
  const value = descriptor.trim();
  return value === "" || value === "normal";
}

const WHOLE_RANGE = "0-10ffff";

/**
 * A unicode-range descriptor in one canonical form: its ranges as lowercase hex `lo-hi`, sorted and
 * merged ("U+0-10FFFF" for absent or empty, wildcards such as U+4?? expanded). null when it does not parse.
 */
export function canonicalRange(descriptor: string | undefined): string | null {
  const text = (descriptor ?? "").replace(/\s+/g, "");
  if (!text) return WHOLE_RANGE;
  const ranges: Array<[number, number]> = [];
  for (const part of text.split(",")) {
    const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(part);
    if (!m) return null;
    const lo = parseInt(m[1]!.replace(/\?/g, "0"), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1]!.replace(/\?/g, "f"), 16);
    ranges.push([lo, hi]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [lo, hi] of ranges) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged.map(([lo, hi]) => `${lo.toString(16)}-${hi.toString(16)}`).join(",");
}

type Descriptors = { weight: string; style: string; unicodeRange?: string };

/**
 * Whether two sets of descriptors name the same face: the same weight range, the same style (unset reads
 * as normal) and the same unicode-range (unset reads as the whole range).
 */
export function sameFace(a: Descriptors, b: Descriptors): boolean {
  const style = (descriptor: string) => descriptor.trim().toLowerCase() || "normal";
  const [wa, wb] = [weightRange(a.weight), weightRange(b.weight)];
  const [ra, rb] = [canonicalRange(a.unicodeRange), canonicalRange(b.unicodeRange)];
  return wa !== null && wb !== null && wa[0] === wb[0] && wa[1] === wb[1] && style(a.style) === style(b.style) && ra !== null && ra === rb;
}

/** Whether a rule puts a face in document.fonts: it applies to the page (active) and lists a src. */
const applies = (rule: FontRule) => rule.active !== false && rule.src.trim() !== "";
const live = (face: FaceStatus) => face.status === "loaded" || face.status === "loading";

const regularOf = <T extends { weight: string; style: string }>(items: T[]) => items.filter((item) => weightCovers(item.weight) && styleIsNormal(item.style));
const statuses = (faces: FaceStatus[]) => faces.map((face) => `${face.weight} ${face.style} ${face.status}`).join(", ");
const faceName = (face: Descriptors) => {
  const range = canonicalRange(face.unicodeRange);
  return `${face.weight} ${face.style}${range === WHOLE_RANGE ? "" : ` (unicode-range ${face.unicodeRange})`}`;
};

/** One face's source verdict: the fetched url() the judge accepted, or why the face fails. Either way, what was read. */
type SourceCheck = ({ ok: true; url: string; how: string } | { ok: false; message: string }) & { detail: Record<string, unknown> };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Each face once, by its weight and style descriptors as the page reports them. */
const distinctFaces = (faces: FaceStatus[]) => faces.filter((face, i) => faces.findIndex((other) => faceName(other) === faceName(face)) === i);
const countSame = (faces: FaceStatus[], face: FaceStatus, keep: (f: FaceStatus) => boolean = () => true) => faces.filter((other) => keep(other) && sameFace(other, face)).length;

/**
 * Why a judged face cannot be attributed to a readable @font-face rule, or null. document.fonts holds one
 * FontFace per @font-face rule, readable or not, plus every face a script added, and a face's source is
 * not readable from the page. When the faces with a judged face's weight and style outnumber the readable
 * rules that declare them, or none is readable and a stylesheet is unreadable, the face that loaded may
 * be one whose source the check never sees (a script FontFace from another package, say), so the last
 * readable rule proves nothing about it.
 */
function unattributed(r: FontReading, faces: FaceStatus[]): string | null {
  for (const face of distinctFaces(faces)) {
    // A face loaded before the check that is gone after it was removed by the page: what rendered can no longer be attributed.
    const [loadedBefore, loadedAfter] = [countSame(r.before, face, (f) => f.status === "loaded"), countSame(r.after, face, (f) => f.status === "loaded")];
    if (loadedAfter < loadedBefore) {
      return `the ${faceName(face)} face of ${r.family}: a judged face left document.fonts during the check (${loadedBefore} loaded before, ${loadedAfter} after), so its source cannot be attributed to the package`;
    }
    const inSet = Math.max(countSame(r.before, face), countSame(r.after, face));
    const declaring = r.rules.filter((rule) => sameFace(rule, face)).length;
    if (inSet > declaring || (declaring === 0 && r.unreadableSheets > 0)) {
      const unreadable = r.unreadableSheets ? ` (${plural(r.unreadableSheets, "stylesheet")} unreadable)` : "";
      return `the ${faceName(face)} face of ${r.family} has ${plural(inSet, "FontFace object")} in document.fonts but ${plural(declaring, "active readable @font-face rule")}${unreadable}: one is a face added from script or an unreadable stylesheet, so its source cannot be attributed to the package`;
    }
  }
  return null;
}

/**
 * The source rules for one face, given the faces of it that the check judges (`faces`, from
 * document.fonts) and the readable @font-face rules that declare it, in cascade order: every judged face
 * is attributable to a readable rule (unattributed), the last rule wins, it lists a url() and no local()
 * before it, one of its url()s was fetched, and `judge` accepts a fetched one. `noun` names the face in
 * messages ("the regular face", "the 500 normal face"); `declared` names it when no rule declares it.
 */
function checkSource(r: FontReading & { inactiveRules?: number }, faces: FaceStatus[], rules: FontRule[], noun: string, declared: string, responses: ResponseLog, judge: FontSourceJudge): SourceCheck {
  const detail: Record<string, unknown> = {};
  if (r.rules.length === 0) {
    const inactive = r.inactiveRules ? ` (${plural(r.inactiveRules, "rule")} inactive here: a non-matching @media, @supports or media list, or a disabled sheet)` : "";
    return { ok: false, message: `faces are loaded but no readable @font-face declares ${r.family}${r.unreadableSheets ? ` (${r.unreadableSheets} stylesheet(s) unreadable)` : ""}${inactive}`, detail };
  }
  const ambiguous = unattributed(r, faces);
  if (ambiguous) return { ok: false, message: ambiguous, detail };
  if (rules.length === 0) return { ok: false, message: `no readable @font-face rule declares ${declared} of ${r.family}`, detail };
  // Of several rules with the same descriptors, the last one declared is the face the page uses.
  const winner = rules[rules.length - 1]!;
  detail.rule = winner;
  if (winner.urls.length === 0) return { ok: false, message: `${noun}'s @font-face lists only local() sources: a local font, not the package's web font`, detail };
  // A local() source listed before the url(): the browser renders an installed font when there is one,
  // and a preload can still fetch the url(). The fetch then proves nothing about what renders.
  if (winner.local && winner.src.indexOf("local(") < winner.src.indexOf("url(")) {
    return { ok: false, message: `${noun}'s @font-face lists a local() source before its url(): an installed font wins over the package's web font`, detail };
  }
  const got = winner.urls.filter((url) => fetched(url, responses));
  detail.fetched = got;
  if (got.length === 0) {
    return { ok: false, message: `${noun} is loaded but none of its url()s was fetched (${winner.urls.slice(0, 2).join(", ")}): a local() source won or the request failed`, detail };
  }
  const verdicts = got.map((url) => ({ url, ...judge(url, winner.sheet) }));
  detail.sources = verdicts;
  const good = verdicts.find((v) => v.ok);
  if (good) return { ok: true, url: good.url, how: good.how, detail };
  const bad = verdicts[0]!;
  return { ok: false, message: `${noun} loads from ${bad.path ?? bad.url}: ${bad.how}`, detail };
}

/**
 * Per family, the regular face (400, normal) is a package web font by the rules in the header: loaded
 * by the page itself (or, for IBM Plex Mono not rendered on the route or rendered only in other faces,
 * by the check's forced load), its winning @font-face rule's url() fetched, and the fetched file judged
 * by `judge` to come from the package. IBM Plex Mono rendered only in other faces: every face the page
 * loaded passes the same rules first, on the rule that declares that face. In every branch, a judged face
 * with more FontFace objects than active readable rules for its descriptors, or one that left
 * document.fonts between the readings, fails (unattributed).
 */
export function fontAssertions(readings: FontReading[], responses: ResponseLog, judge: FontSourceJudge): Assertion[] {
  return readings.map((reading) => {
    const id = `font: ${reading.family}`;
    const detail: Record<string, unknown> = { ...reading };
    // Only rules that put a face in document.fonts count, for attribution and for the winner: an inactive
    // rule (in @media print, say) declares nothing on this page.
    const r = { ...reading, rules: reading.rules.filter(applies), inactiveRules: reading.rules.filter((rule) => !applies(rule)).length };
    if (r.before.length === 0) return fail(id, `no @font-face for ${r.family}: text renders in a local or fallback font`, detail);
    const regularBefore = regularOf(r.before);
    if (regularBefore.length === 0) return fail(id, `no regular face (400, normal) of ${r.family} is declared (${r.before.map((f) => `${f.weight} ${f.style}`).join(", ")})`, detail);
    const mayForce = FORCED_WHEN_NOT_RENDERED.includes(r.family);
    const rendered = !mayForce || rendersFamily(r);
    let loadedBy: string;
    if (mayForce && rendersOnlyOtherFaces(r)) {
      // The page rendered the family in other faces and never asked for the regular one: each face it
      // started loading must have loaded from the package, then the regular face from the forced load.
      const started = r.before.filter((face) => face.status !== "unloaded");
      const why = `${r.family} renders on this route only in faces other than the regular one (faces ${statuses(started)})`;
      const stuck = started.find((face) => face.status !== "loaded");
      if (stuck) return fail(id, `the ${faceName(stuck)} face did not load before the check (${stuck.status}): its text renders in a fallback font; ${why}`, detail);
      // Each distinct face once; a face whose descriptors match no rule fails below (sameFace never matches an unparsed weight).
      const faces = distinctFaces(started);
      const judged: Array<Record<string, unknown>> = [];
      detail.renderedFaces = judged;
      for (const face of faces) {
        const noun = `the ${faceName(face)} face`;
        const check = checkSource(r, [face], r.rules.filter((rule) => sameFace(rule, face)), noun, noun, responses, judge);
        judged.push({ weight: face.weight, style: face.style, ...check.detail });
        if (!check.ok) return fail(id, `${check.message}; ${why}`, detail);
      }
      const regularAfter = regularOf(r.after);
      if (!regularAfter.some((face) => face.status === "loaded")) {
        const load = r.forced ? `did not load when the check forced ${r.forced}` : "is not loaded, and the check forced nothing";
        return fail(id, `${why}, and its regular face ${load} (${statuses(regularAfter)})`, detail);
      }
      loadedBy = `renders only in faces ${faces.map(faceName).join(", ")}, each from the package; regular face loaded${r.forced ? " when the check forced it" : ""}`;
    } else if (rendered) {
      if (!regularBefore.some((face) => face.status === "loaded")) {
        const why = mayForce
          ? `${r.family} renders on this route (${r.probedBy.length ? `font-family of ${r.probedBy.join(", ")}` : `faces ${statuses(r.before.filter((f) => f.status !== "unloaded"))}`})`
          : `the check never forces ${r.family}: the route must render text in it`;
        return fail(id, `regular face of ${r.family}: none loaded by the page before the check (${statuses(regularBefore)}); ${why}`, detail);
      }
      loadedBy = "regular face loaded";
    } else {
      const regularAfter = regularOf(r.after);
      if (!regularAfter.some((face) => face.status === "loaded"))
        return fail(id, `${r.family} is not rendered on this route, and its regular face did not load when the check forced ${r.forced ?? "it"} (${statuses(regularAfter)})`, detail);
      loadedBy = "available, not rendered on this route: regular face loaded";
    }
    // Every live regular face, before the forced load or after it: a face that left between the readings is judged too.
    const liveRegular = regularOf([...r.before, ...r.after]).filter(live);
    const check = checkSource(r, liveRegular, regularOf(r.rules), "the regular face", "the regular face (400, normal)", responses, judge);
    Object.assign(detail, check.detail);
    return check.ok ? pass(id, `${loadedBy} from ${check.url} (${check.how})`, detail) : fail(id, check.message, detail);
  });
}
