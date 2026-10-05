/**
 * Inter and IBM Plex Mono load as web fonts: a loaded FontFace whose @font-face url() the page fetched,
 * not a local() face or a fallback.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Assertion, fail, pass, type ResponseLog } from "./assertions";

export const FONT_FAMILIES = ["Inter", "IBM Plex Mono"] as const;

export interface FontReading {
  family: string;
  faces: Array<{ weight: string; style: string; status: string }>;
  /** @font-face rules for the family: their src, the resolved url()s, and whether a local() source is listed. */
  rules: Array<{ src: string; urls: string[]; local: boolean }>;
  /** Stylesheets whose rules the page could not read (cross-origin). */
  unreadableSheets: number;
}

/** Asks the page to load each family at 400, then lists its faces and the @font-face rules that declare them. */
export async function readFonts(page: any, families: readonly string[] = FONT_FAMILIES): Promise<FontReading[]> {
  return page.evaluate(async (names: string[]) => {
    const clean = (family: string) => family.replace(/["']/g, "").trim();
    await Promise.all(names.map((name) => document.fonts.load(`400 16px "${name}"`).catch(() => undefined)));
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    const rules: Array<{ family: string; src: string; base: string }> = [];
    let unreadableSheets = 0;
    const walk = (list: CSSRuleList, base: string) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSFontFaceRule) {
          rules.push({ family: clean(rule.style.getPropertyValue("font-family")), src: rule.style.getPropertyValue("src"), base });
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
  const status = responses.get(url);
  return status !== undefined && ((status >= 200 && status < 300) || status === 304);
}

/** Each family is a web font the page loaded over the run's server: a loaded face whose @font-face url() was fetched. */
export function fontAssertions(readings: FontReading[], responses: ResponseLog): Assertion[] {
  return readings.map((r) => {
    const id = `font: ${r.family}`;
    const loaded = r.faces.filter((face) => face.status === "loaded");
    const urls = r.rules.flatMap((rule) => rule.urls);
    const got = urls.filter((url) => fetched(url, responses));
    const detail = { ...r, fetched: got };
    if (r.faces.length === 0) return fail(id, `no @font-face for ${r.family}: text renders in a local or fallback font`, detail);
    if (loaded.length === 0) return fail(id, `${r.faces.length} face(s) declared, none loaded (${r.faces.map((f) => `${f.weight} ${f.status}`).join(", ")})`, detail);
    if (got.length > 0) return pass(id, `${loaded.length} face(s) loaded from ${got[0]}${got.length > 1 ? ` (+${got.length - 1})` : ""}`, detail);
    if (r.rules.length > 0 && urls.length === 0) return fail(id, `@font-face lists only local() sources: a local font, not the package's web font`, detail);
    if (r.rules.length === 0) {
      return fail(id, `faces are loaded but no readable @font-face declares ${r.family}${r.unreadableSheets ? ` (${r.unreadableSheets} stylesheet(s) unreadable)` : ""}`, detail);
    }
    return fail(id, `faces are loaded but none of their url()s was fetched (${urls.slice(0, 2).join(", ")}): a local() source won or the request failed`, detail);
  });
}
