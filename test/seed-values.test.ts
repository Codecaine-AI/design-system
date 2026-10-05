/**
 * The public names apps style with, and the seed values docs-system renders today. Neither may drift:
 * a renamed variable breaks every app that reads it, a changed seed changes pixels.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeInTheme, computePinned, cssVarOf, PKG, readJson, type Theme, THEMES, tokensCss } from "./support.ts";

const HUES = ["gray", "blue", "teal", "green", "yellow", "orange", "red", "violet", "pink"];

/** Theme roles: each must follow the theme (--ds-*) and be pinnable (--ds-light-*, --ds-dark-*). */
const THEME_ROLES = [
  "--ds-color-surface-page",
  "--ds-color-surface-panel",
  "--ds-color-surface-sidebar",
  "--ds-color-text-ink",
  "--ds-color-text-body",
  "--ds-color-text-muted",
  "--ds-color-text-faint",
  "--ds-color-border-default",
  "--ds-color-border-subtle",
  "--ds-color-fill-chip",
  "--ds-color-fill-hover",
  "--ds-color-fill-active",
  "--ds-color-accent",
  "--ds-color-link",
  "--ds-color-focus-ring",
  "--ds-color-selection",
  ...HUES.flatMap((hue) => ["text", "solid", "on-solid", "soft", "line"].map((part) => `--ds-color-${hue}-${part}`)),
  ...["info", "success", "warning", "danger", "neutral"].map((status) => `--ds-color-status-${status}-on-solid`),
  "--ds-shadow-glass",
];

const BASE_NAMES = [
  ...["0", "0-5", "1", "1-5", "2", "3", "4", "5", "6", "7", "8", "10", "12", "16"].map((step) => `--ds-space-${step}`),
  "--ds-radius-none",
  "--ds-radius-base",
  "--ds-radius-pill",
  "--ds-border-width-hairline",
  "--ds-border-width-ring",
  "--ds-border-width-focus",
  "--ds-border-width-rail",
  "--ds-focus-ring-offset",
  "--ds-font-family-sans",
  "--ds-font-family-mono",
  ...["micro", "ui-xs", "ui-sm", "ui-md", "code", "reading", "title"].map((size) => `--ds-font-size-${size}`),
  ...["regular", "medium", "semibold", "bold"].map((weight) => `--ds-font-weight-${weight}`),
  "--ds-line-height-tight",
  "--ds-line-height-ui",
  "--ds-line-height-reading",
  "--ds-letter-spacing-title",
  "--ds-letter-spacing-micro",
  "--ds-motion-duration-fast",
  "--ds-motion-duration-base",
  "--ds-motion-duration-slow",
  "--ds-motion-easing-standard",
  "--ds-motion-easing-emphasized",
  "--ds-z-raised",
  "--ds-z-overlay",
  "--ds-z-popover",
  "--ds-z-top",
  "--ds-layout-lane-text",
  "--ds-layout-lane-code",
  "--ds-layout-lane-wide",
];

const APP_SHELL_NAMES = [
  "--ds-layout-sidebar-width",
  "--ds-layout-sidebar-width-collapsed",
  "--ds-layout-topbar-height",
  "--ds-layout-inspector-width",
];

describe("public names in dist/css/tokens.css", () => {
  test("theme roles follow the theme in both switch blocks and are pinned to light and dark in :root", () => {
    const css = tokensCss();
    const missing = THEME_ROLES.flatMap((name) => {
      const pinned = THEMES.map((theme) => `--ds-${theme}-${name.slice("--ds-".length)}`);
      return [
        ...THEMES.filter((theme) => !css[theme].has(name)).map((theme) => `${name} (${theme} block)`),
        ...pinned.filter((p) => !css.root.has(p)),
      ];
    });
    expect(missing).toEqual([]);
  });

  test("base names are declared in :root", () => {
    const { root } = tokensCss();
    expect(BASE_NAMES.filter((name) => !root.has(name))).toEqual([]);
  });

  test.if(existsSync(join(PKG, "tokens/base/app-shell.tokens.json")))("app-shell names are declared in :root", () => {
    const { root } = tokensCss();
    expect(APP_SHELL_NAMES.filter((name) => !root.has(name))).toEqual([]);
  });
});

const color = (light: string, dark: string) => ({ light, dark });

/** Resolved seed values per theme. Only the themes listed are checked. */
const THEME_SEEDS: Array<[path: string, seeds: Partial<Record<Theme, string>>]> = [
  ["color.surface.page", color("#fdfdfd", "#0d1117")],
  ["color.surface.panel", color("#f8f8f7", "#151b23")],
  ["color.surface.sidebar", color("#f9f9f9", "#010409")],
  ["color.text.ink", color("#1f1f1f", "#f0f6fc")],
  ["color.text.body", color("#2a2a2a", "#d1d9e0")],
  ["color.text.muted", color("#666562", "#9198a1")],
  ["color.text.faint", color("#9b9a97", "#656c76")],
  ["color.border.default", color("#e6e5e3", "#3d444d")],
  ["color.border.subtle", color("#efeeec", "#262c36")],
  ["color.fill.chip", color("#ebebe9", "#21262d")],
  ["color.accent", color("#0078df", "#4493f8")],
  ["color.link", color("#245a81", "#4493f8")],
  ["color.amber.text", color("#9a5b00", "#d29922")],
  ["color.fill.hover", { light: "color-mix(in srgb, #1f1f1f 6%, #f8f8f7)" }],
  ["color.selection", color("color-mix(in srgb, #0078df 18%, transparent)", "color-mix(in srgb, #4493f8 30%, transparent)")],
  ["color.gray.soft", { dark: "color-mix(in srgb, #656c76 13%, #151b23)" }],
  ["color.blue.line", color("color-mix(in srgb, #0b6e99 45%, #f8f8f7)", "color-mix(in srgb, #4493f8 50%, #151b23)")],
  // Code panels: VS Code Light+ and Dark+.
  ["color.syntax.keyword", color("#0000ff", "#569cd6")],
  ["color.syntax.string", color("#a31515", "#ce9178")],
  ["color.syntax.comment", color("#008000", "#6a9955")],
  ["shadow.glass", color("0 10px 32px rgba(30, 22, 60, 0.12), 0 1px 3px rgba(0, 0, 0, 0.07)", "0 10px 32px rgba(0, 0, 0, 0.5)")],
];

/** Base seeds; numbers must stay JSON numbers. */
const BASE_SEEDS: Array<[path: string, value: string | number]> = [
  ["space.1", "4px"],
  ["space.0-5", "2px"],
  ["radius.base", "2px"],
  ["font.size.title", "2.25rem"],
  ["font.size.ui-md", "13.5px"],
  ["line-height.reading", 1.45],
  ["motion.duration.slow", "260ms"],
  ["motion.easing.emphasized", "cubic-bezier(0.32, 0.72, 0, 1)"],
  ["z.top", 60],
  ["layout.lane.code", "88ch"],
];

describe("seed values", () => {
  test.each(THEME_SEEDS)("%s", (path, seeds) => {
    const css = tokensCss();
    for (const [theme, seed] of Object.entries(seeds) as Array<[Theme, string]>) {
      expect({
        theme,
        json: readJson(`dist/json/${theme}.json`)[path],
        pinned: computePinned(css, cssVarOf(path, theme)),
        following: computeInTheme(css, theme, cssVarOf(path)),
      }).toEqual({ theme, json: seed, pinned: seed, following: seed });
    }
  });

  test.each(BASE_SEEDS)("%s", (path, seed) => {
    expect(readJson("dist/json/base.json")[path]).toBe(seed);
    expect(computePinned(tokensCss(), cssVarOf(path))).toBe(String(seed));
  });

  test("an alias is emitted as a var() reference (color.focus-ring -> color.accent)", () => {
    // The switch blocks' var() indirection (--ds-color-surface-page: var(--ds-light-color-surface-page))
    // is checked for every theme path in outputs.test.ts.
    expect(tokensCss().root.get("--ds-light-color-focus-ring")).toBe("var(--ds-light-color-accent)");
  });
});
