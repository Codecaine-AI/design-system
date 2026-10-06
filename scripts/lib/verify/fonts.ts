/**
 * Inter and IBM Plex Mono load as the package's web fonts: the regular face (weight 400, normal style)
 * of each family is loaded, the @font-face rule that declares it (the last one, which wins) had its
 * url() fetched, and that url() comes from the design-system package's fonts/ directory (or a byte
 * copy of a package font where the app copies or bundles them). A local() face, a fallback, or the
 * same font from another package (text-measure's fonts) fails.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Assertion, fail, pass, type ResponseLog } from "./assertions";

export const FONT_FAMILIES = ["Inter", "IBM Plex Mono"] as const;

export interface FontReading {
  family: string;
  faces: Array<{ weight: string; style: string; status: string }>;
  /** @font-face rules for the family, in cascade order: descriptors, src, the resolved url()s, and whether a local() source is listed. */
  rules: Array<{ weight: string; style: string; src: string; urls: string[]; local: boolean }>;
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

/** Judges a fetched font url(); built by font-source.ts from the run (served paths, the resolved package). */
export type FontSourceJudge = (url: string) => FontSourceVerdict;

/** Asks the page to load each family at 400, then lists its faces and the @font-face rules that declare them. */
export async function readFonts(page: any, families: readonly string[] = FONT_FAMILIES): Promise<FontReading[]> {
  return page.evaluate(async (names: string[]) => {
    const clean = (family: string) => family.replace(/["']/g, "").trim();
    await Promise.all(names.map((name) => document.fonts.load(`400 16px "${name}"`).catch(() => undefined)));
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    const rules: Array<{ family: string; weight: string; style: string; src: string; base: string }> = [];
    let unreadableSheets = 0;
    const walk = (list: CSSRuleList, base: string) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSFontFaceRule) {
          const style = rule.style;
          rules.push({
            family: clean(style.getPropertyValue("font-family")),
            weight: style.getPropertyValue("font-weight").trim(),
            style: style.getPropertyValue("font-style").trim(),
            src: style.getPropertyValue("src"),
            base,
          });
        } else if (rule instanceof CSSImportRule) {
          try {
            if (rule.styleSheet) walk(rule.styleSheet.cssRules, rule.styleSheet.href ?? base);
          } catch {
            unreadableSheets += 1;
          }
        } else if ("cssRules" in rule) {
          walk((rule as CSSGroupingRule).cssRules, base);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules, sheet.href ?? document.baseURI);
      } catch {
        unreadableSheets += 1;
      }
    }
    return names.map((family) => ({
      family,
      faces: Array.from(document.fonts)
        .filter((face) => clean(face.family) === family)
        .map((face) => ({ weight: face.weight, style: face.style, status: face.status })),
      rules: rules
        .filter((rule) => rule.family === family)
        .map((rule) => ({
          weight: rule.weight,
          style: rule.style,
          src: rule.src,
          urls: [...rule.src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => {
            try {
              return new URL(m[2], rule.base).href;
            } catch {
              return m[2];
            }
          }),
          local: /local\(/.test(rule.src),
        })),
      unreadableSheets,
    }));
  }, [...families]);
}

function fetched(url: string, responses: ResponseLog): boolean {
  if (url.startsWith("data:")) return true;
  if (url.startsWith("file:")) return existsSync(fileURLToPath(url));
  const status = responses.get(url)?.status;
  return status !== undefined && ((status >= 200 && status < 300) || status === 304);
}

const KEYWORD_WEIGHT: Record<string, number> = { normal: 400, bold: 700, "": 400 };

/** Whether a font-weight descriptor ("400", "normal", "100 900") covers `weight`. */
export function weightCovers(descriptor: string, weight = 400): boolean {
  const parts = descriptor.trim().split(/\s+/).filter(Boolean).map((part) => KEYWORD_WEIGHT[part] ?? Number(part));
  if (parts.length === 0) return weight === 400;
  if (parts.some((n) => Number.isNaN(n))) return false;
  const [low, high = low] = parts as [number, number?];
  return weight >= low! && weight <= high!;
}

/** Whether a font-style descriptor is the upright style ("normal", or not set). */
export function styleIsNormal(descriptor: string): boolean {
  const value = descriptor.trim();
  return value === "" || value === "normal";
}

/**
 * Per family, the regular face (400, normal) is a package web font: loaded, its winning @font-face
 * rule's url() fetched, and the fetched file judged by `judge` to come from the package.
 */
export function fontAssertions(readings: FontReading[], responses: ResponseLog, judge: FontSourceJudge): Assertion[] {
  return readings.map((r) => {
    const id = `font: ${r.family}`;
    const regular = r.faces.filter((face) => weightCovers(face.weight) && styleIsNormal(face.style));
    const rules = r.rules.filter((rule) => weightCovers(rule.weight) && styleIsNormal(rule.style));
    const detail: Record<string, unknown> = { ...r };
    if (r.faces.length === 0) return fail(id, `no @font-face for ${r.family}: text renders in a local or fallback font`, detail);
    if (regular.length === 0) return fail(id, `no regular face (400, normal) of ${r.family} is declared (${r.faces.map((f) => `${f.weight} ${f.style}`).join(", ")})`, detail);
    if (!regular.some((face) => face.status === "loaded"))
      return fail(id, `the regular face of ${r.family} is declared but not loaded (${regular.map((f) => `${f.weight} ${f.status}`).join(", ")})`, detail);
    if (rules.length === 0) {
      return fail(
        id,
        r.rules.length === 0
          ? `faces are loaded but no readable @font-face declares ${r.family}${r.unreadableSheets ? ` (${r.unreadableSheets} stylesheet(s) unreadable)` : ""}`
          : `no readable @font-face rule declares the regular face (400, normal) of ${r.family}`,
        detail,
      );
    }
    // Of several rules with the same descriptors, the last one declared is the face the page uses.
    const winner = rules[rules.length - 1]!;
    detail.rule = winner;
    if (winner.urls.length === 0) return fail(id, `the regular face's @font-face lists only local() sources: a local font, not the package's web font`, detail);
    const got = winner.urls.filter((url) => fetched(url, responses));
    detail.fetched = got;
    if (got.length === 0) {
      return fail(id, `the regular face is loaded but none of its url()s was fetched (${winner.urls.slice(0, 2).join(", ")}): a local() source won or the request failed`, detail);
    }
    const verdicts = got.map((url) => ({ url, ...judge(url) }));
    detail.sources = verdicts;
    const good = verdicts.find((v) => v.ok);
    if (good) return pass(id, `regular face loaded from ${good.url} (${good.how})`, detail);
    const bad = verdicts[0]!;
    return fail(id, `the regular face loads from ${bad.path ?? bad.url}: ${bad.how}`, detail);
  });
}
