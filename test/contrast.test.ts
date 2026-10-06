/**
 * WCAG contrast of the glyph roles, computed from the resolved values in dist/json.
 * A glyph on a hue or status solid is its `on-solid` token: white or the theme's dark glyph, whichever
 * meets 4.5:1 on that solid. Where neither does, it is the better of the two, and the test names it.
 */
import { describe, expect, test } from "bun:test";
import { evaluateColor } from "../scripts/lib/color.ts";
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

/**
 * The chart palette (color.chart.*) against the dataviz checks, recomputed here from the published values:
 * OKLab for lightness, chroma and distance (Delta E x 100), and the Machado-Oliveira-Fernandes 2009 matrices
 * at severity 1.0 for protanopia and deuteranopia.
 */
describe("chart palette", () => {
  const linear = (hex: string) => [1, 3, 5].map((i) => channel(hex, i));
  const oklab = ([r, g, b]: number[]) => {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const MACHADO: Record<string, number[][]> = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  };
  const simulate = (rgb: number[], m: number[][]) => m.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
  const deltaE = (a: string, b: string, kind?: string) => {
    const [x, y] = [a, b].map((hex) => oklab(kind ? simulate(linear(hex), MACHADO[kind]) : linear(hex)));
    return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  };
  const cvd = (a: string, b: string) => Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan"));
  const BAND: Record<Theme, [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
  const series = (theme: Theme) => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => values(theme)[`color.chart.series.${n}`]);

  test.each([...THEMES])("%s series: in the lightness band, chroma >= 0.1, and >= 3:1 on page and panel (the surfaces charts sit on)", (theme) => {
    const v = values(theme);
    const report = series(theme).map((hex) => {
      const [L, a, b] = oklab(linear(hex));
      return { hex, L: +L.toFixed(3), C: +Math.hypot(a, b).toFixed(3), page: +contrast(hex, v["color.surface.page"]).toFixed(2), panel: +contrast(hex, v["color.surface.panel"]).toFixed(2) };
    });
    const [lo, hi] = BAND[theme];
    expect(report.filter((r) => r.L < lo || r.L > hi || r.C < 0.1 || r.page < 3 || r.panel < 3)).toEqual([]);
  });

  test("3:1 is promised on page and panel only: on surface.sunken exactly light series 2, 4, 5 and 8 fall under (color.chart's description says so)", () => {
    const hex = (value: string) => {
      const { r, g, b, a } = evaluateColor(value);
      if (a !== 1) throw new Error(`${value} is not opaque`);
      // The 8-bit color the screen shows.
      return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
    };
    const under = THEMES.flatMap((theme) => {
      const sunken = hex(values(theme)["color.surface.sunken"]);
      return series(theme).flatMap((color, i) => {
        const ratio = contrast(color, sunken);
        return ratio < 3 ? [`${theme} series.${i + 1} ${ratio.toFixed(2)}:1`] : [];
      });
    });
    expect(under).toEqual(["light series.2 2.86:1", "light series.4 2.85:1", "light series.5 2.88:1", "light series.8 2.84:1"]);
  });

  test.each([...THEMES])("%s series: neighbors stay apart under protanopia and deuteranopia (dE >= 8) and normal vision (dE >= 15)", (theme) => {
    const s = series(theme);
    const close = s.slice(1).flatMap((hex, i) => {
      const [cvdE, normal] = [cvd(s[i], hex), deltaE(s[i], hex)];
      return cvdE < 8 || normal < 15 ? [`series.${i + 1}-${i + 2}: cvd ${cvdE.toFixed(1)}, normal ${normal.toFixed(1)}`] : [];
    });
    expect(close).toEqual([]);
  });

  test.each([...THEMES])("%s series 1-3 pass all pairs, for scatter and small multiples", (theme) => {
    const [a, b, c] = series(theme);
    const pairs: Array<[string, string]> = [[a, b], [a, c], [b, c]];
    expect(pairs.filter(([x, y]) => cvd(x, y) < 8 || deltaE(x, y) < 15)).toEqual([]);
  });

  test.each([...THEMES])("%s diverging: the poles stay apart under color-vision deficiency and the midpoint is a gray", (theme) => {
    const v = values(theme);
    const [pos, mid, neg] = ["positive", "midpoint", "negative"].map((k) => v[`color.chart.diverging.${k}`]);
    expect(cvd(pos, neg)).toBeGreaterThanOrEqual(8);
    expect(chromaOf(mid)).toBeLessThan(0.03);
  });

  /** OKLCH chroma of a resolved value: #rrggbb, or color-mix(in srgb, #a P%, #b) of two of them. */
  function chromaOf(value: string): number {
    const mix = /^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/.exec(value);
    const rgb = mix
      ? [1, 3, 5].map((i) => {
          const p = Number(mix[2]) / 100;
          const c = (hex: string) => Number.parseInt(hex.slice(i, i + 2), 16);
          return Math.round(c(mix[1]) * p + c(mix[3]) * (1 - p));
        })
      : [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
    const [, a, b] = oklab(linear(`#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`));
    return Math.hypot(a, b);
  }
});
