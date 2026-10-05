/**
 * WCAG contrast of the glyph roles, computed from the resolved values in dist/json.
 * A glyph on a hue or status solid is its `on-solid` token: white or the theme's dark glyph, whichever
 * meets 4.5:1 on that solid. Where neither does, it is the better of the two, and the test names it.
 */
import { describe, expect, test } from "bun:test";
import { readJson, type Theme, THEMES } from "./support.ts";

const HUES = ["gray", "blue", "teal", "green", "yellow", "orange", "red", "violet", "pink"];
const STATUS_HUE: Record<string, string> = { info: "blue", success: "green", warning: "yellow", danger: "red", neutral: "gray" };
const AA = 4.5;

function channel(hex: string, offset: number): number {
  const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`expected an opaque #rrggbb color, got ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const values = (theme: Theme): Record<string, string> => readJson(`dist/json/${theme}.json`);

/** The two glyphs a solid can carry: white, and the theme's dark glyph. */
function glyphs(theme: Theme): string[] {
  const v = values(theme);
  return ["#ffffff", theme === "light" ? v["color.text.ink"] : v["color.text.on-solid"]];
}

const pairs = THEMES.flatMap((theme) => HUES.map((hue) => [theme, hue] as [Theme, string]));

describe("on-solid glyphs", () => {
  test.each(pairs)("%s %s.on-solid is the glyph that meets 4.5:1 on %s.solid, or the better one", (theme, hue) => {
    const v = values(theme);
    const solid = v[`color.${hue}.solid`];
    const glyph = v[`color.${hue}.on-solid`];
    const best = Math.max(...glyphs(theme).map((g) => contrast(g, solid)));
    expect(glyphs(theme)).toContain(glyph);
    if (best >= AA) expect(contrast(glyph, solid)).toBeGreaterThanOrEqual(AA);
    else expect(contrast(glyph, solid)).toBe(best);
  });

  test("only light red stays under 4.5:1 (white 4.26:1; ink is 3.87:1)", () => {
    const under = pairs
      .map(([theme, hue]) => [theme, hue, contrast(values(theme)[`color.${hue}.on-solid`], values(theme)[`color.${hue}.solid`])] as const)
      .filter(([, , ratio]) => ratio < AA)
      .map(([theme, hue, ratio]) => `${theme} ${hue} ${ratio.toFixed(2)}:1`);
    expect(under).toEqual(["light red 4.26:1"]);
  });

  test.each([...THEMES])("%s status tiles use their hue's solid and on-solid", (theme) => {
    const v = values(theme);
    for (const [status, hue] of Object.entries(STATUS_HUE)) {
      expect({ status, solid: v[`color.status.${status}.solid`], glyph: v[`color.status.${status}.on-solid`] }).toEqual({
        status,
        solid: v[`color.${hue}.solid`],
        glyph: v[`color.${hue}.on-solid`],
      });
    }
  });
});

describe("text colors", () => {
  test.each([...THEMES])("%s color.link meets 4.5:1 on page and panel (text uses link, not accent)", (theme) => {
    const v = values(theme);
    for (const surface of ["page", "panel"]) {
      expect(contrast(v["color.link"], v[`color.surface.${surface}`])).toBeGreaterThanOrEqual(AA);
    }
  });
});
