/**
 * The literal codemod's contract: `propose` maps each scan-literals hit to a token by role first and
 * nearest color second, writes the replacement each slot needs, and marks what it cannot map;
 * `apply` changes only approved rows whose line still holds the literal.
 *
 * Fixtures: test/fixtures/codemod/app/src (a CSS file, a TSX file, a TSX file that imports cssVar,
 * and a TS file with CSS in a template literal).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { classTarget, designSystemCommit } from "../scripts/codemod-literals.ts";
import { applyTable } from "../scripts/lib/codemod/apply.ts";
import { tokenAllowed } from "../scripts/lib/codemod/color-role.ts";
import { buildConsumers } from "../scripts/lib/codemod/consumers.ts";
import { applyRoot, tableDir } from "../scripts/lib/codemod/paths.ts";
import { prepareSource } from "../scripts/lib/codemod/source.ts";
import { DEFAULT_CATEGORIES, propose } from "../scripts/lib/codemod/propose.ts";
import { fileSha, lineSha, summarize, type Row, type Table } from "../scripts/lib/codemod/table.ts";
import { loadTokens } from "../scripts/lib/codemod/tokens.ts";
import { loadRegistry } from "../scripts/lib/registry.ts";
import { SYSTEM_BIN } from "../scripts/lib/system-bin.ts";
import { PKG } from "./support.ts";

const FIXTURES = join(PKG, "test/fixtures/codemod");
const SRC = "app/src";

function proposeAt(root: string) {
  return propose(loadTokens(), { root, paths: [SRC], exclude: [] }, { appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES) });
}
function proposeIn(root: string): Row[] {
  return proposeAt(root).rows;
}

let rows: Row[];
beforeAll(() => {
  rows = proposeIn(FIXTURES);
});

/** The row for a literal on a fixture line (the first, or the nth when it repeats). */
function row(file: string, line: number, literal: string, nth = 0): Row {
  const found = rows.filter((r) => r.file === `${SRC}/${file}` && r.line === line && r.literal === literal);
  if (!found[nth]) throw new Error(`no row for ${file}:${line} ${literal}; rows on that line: ${rows.filter((r) => r.line === line && r.file.endsWith(file)).map((r) => r.literal).join(", ")}`);
  return found[nth];
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codemod-test-"));
  cpSync(join(FIXTURES, "app"), join(root, "app"), { recursive: true });
  return root;
}

/** The files' hashes as they are now (what propose would record), for rows written by hand. */
function hashesNow(root: string, list: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of list) if (existsSync(join(root, r.file))) out[r.file] = fileSha(readFileSync(join(root, r.file), "utf8"));
  return out;
}

/** A table over `list`; `files` are the hashes propose recorded (default: the files as they are now). */
const tableOf = (root: string, list: Row[], files: Record<string, string> = hashesNow(root, list)): Table => ({
  tool: "codemod-literals",
  version: 1,
  app: "fixture",
  root,
  createdAt: "2026-10-05T00:00:00.000Z",
  designSystem: { root: PKG, commit: null },
  scan: { paths: [SRC], exclude: [], categories: DEFAULT_CATEGORIES },
  summary: summarize(list),
  files,
  rows: list,
});

describe("propose: role first", () => {
  test.each([
    // [file, line, literal, proposed token, replacement]
    ["theme.css", 3, "#f5f3ef", "color.surface.page", "var(--ds-color-surface-page)"], // --background: a definition becomes an alias
    ["theme.css", 4, "#62666d", "color.text.muted", "var(--ds-color-text-muted)"], // --muted-foreground
    ["theme.css", 7, "#e03e3e", "color.status.danger.text", "var(--ds-color-status-danger-text)"], // --destructive: the host contract's token
    ["theme.css", 12, "#f6f4f0", "color.fill.hover", "var(--ds-color-fill-hover)"], // :hover
    ["theme.css", 16, "#f9f9f9", "color.surface.sidebar", "var(--ds-color-surface-sidebar)"], // .sidebar
    ["theme.css", 20, "#c62121", "color.status.danger.text", "var(--ds-color-status-danger-text)"], // .error-text
    ["theme.css", 24, "#245a81", "color.link", "var(--ds-color-link)"], // a.doc-link
    ["theme.css", 29, "11px", "font.size.ui-2xs", "var(--ds-font-size-ui-2xs)"],
    ["theme.css", 30, '"SF Mono", Menlo, monospace', "font.family.mono", "var(--ds-font-family-mono)"],
    ["theme.css", 34, "999px", "radius.pill", "var(--ds-radius-pill)"],
    ["theme.css", 39, "6px", "radius.base", "var(--ds-radius-base)"],
    ["theme.css", 41, "#f8f8f7", "color.surface.panel", "var(--ds-color-surface-panel)"], // var(--card-bg, #f8f8f7): fallback in a .card
    ["theme.css", 49, "13px", "font.size.code", "var(--ds-font-size-code)"], // 13px in pre code, not ui-sm
    ["widgets.tsx", 7, "13", "font.size.ui-sm", '"var(--ds-font-size-ui-sm)"'], // style={{ fontSize: 13 }}
    ["widgets.tsx", 7, '"10px"', "radius.base", '"var(--ds-radius-base)"'],
    ["with-cssvar.tsx", 4, "12", "font.size.ui-xs", 'cssVar("font.size.ui-xs")'], // the file imports cssVar
    ["with-cssvar.tsx", 4, '"#ebebe9"', "color.fill.chip", 'cssVar("color.fill.chip")'],
    ["with-cssvar.tsx", 4, "#e6e5e3", "color.border.default", "var(--ds-color-border-default)"], // inside "1px solid #e6e5e3"
  ])("%s:%i %s -> %s", (file, line, literal, proposed, replacement) => {
    const r = row(file, line, literal);
    expect({ proposed: r.proposed, replacement: r.replacement, method: r.method }).toEqual({ proposed, replacement, method: "role" });
  });

  test("a definition keeps its kind, and nothing proposes a Notion compat token", () => {
    expect(row("theme.css", 3, "#f5f3ef").kind).toBe("definition");
    expect(row("theme.css", 41, "#f8f8f7").kind).toBe("fallback");
    expect(rows.filter((r) => r.proposed?.startsWith("color.notion."))).toEqual([]);
  });

  test("text never gets color.accent, even when the literal is the accent", () => {
    const text = row("theme.css", 28, "#0078df"); // .heading { color: #0078df }
    expect(text.proposed).toBeNull();
    expect(text.why).not.toContain("color.accent");
    // The same color with no role is the accent by nearest color.
    expect(row("widgets.tsx", 12, '"#0078df"')).toMatchObject({ proposed: "color.accent", method: "nearest", deltaE: 0, replacement: null });
  });

  test("rows it cannot map say why, and rows that map but must not change get no replacement", () => {
    // A shadcn channel triplet: the host contract names the token, but the triplet is a hand edit.
    expect(pick(row("theme.css", 8, "hsl(222 47% 11%)"))).toEqual({ proposed: "color.text.ink", replacement: null });
    expect(row("theme.css", 8, "hsl(222 47% 11%)").why).toContain("not found on the line as written");
    const unmapped: Array<[string, number, string, string]> = [
      ["theme.css", 35, "16px", "16px"], // off the font-size scale
      ["theme.css", 40, "rgb(0 0 0 / 8%)", "shadow"], // a drop shadow's color
      ["theme.css", 50, '"Press Start 2P", monospace', "press start 2p"], // a display face
    ];
    for (const [file, line, literal, reason] of unmapped) {
      const r = row(file, line, literal);
      expect({ at: `${file}:${line}`, proposed: r.proposed, replacement: r.replacement, method: r.method }).toEqual({ at: `${file}:${line}`, proposed: null, replacement: null, method: null });
      expect(r.why.toLowerCase()).toContain(reason.toLowerCase());
    }
    expect(row("theme.css", 8, "hsl(222 47% 11%)").column).toBeNull();
    // ctx.fillStyle: var() does not resolve in canvas 2D.
    expect(row("widgets.tsx", 16, "#ffffff")).toMatchObject({ replacement: null });
    expect(row("widgets.tsx", 16, "#ffffff").why).toContain("canvas");
    // { id, type, color: "white" } is data, not a style.
    expect(row("widgets.tsx", 19, '"white"')).toMatchObject({ replacement: null });
    expect(row("widgets.tsx", 19, '"white"').why).toContain("data object");
  });
});

describe("propose: nearest color", () => {
  test("a far color with no role is unmapped and names the closest token with its ΔE", () => {
    const r = row("widgets.tsx", 13, '"#8c2ef2"');
    expect(r.proposed).toBeNull();
    expect(r.why).toMatch(/closest compatible token: color\.violet\.\w+ \(ΔE \d+(\.\d)?\)/);
  });

  test("the theme comes from a dark selector or the dark: variant, and ΔE is measured in it", () => {
    // #151b23 is the dark panel: exact under [data-theme="dark"], far from every light background.
    expect(row("theme.css", 54, "#151b23")).toMatchObject({ proposed: "color.surface.panel", deltaE: 0, context: { theme: "dark" } });
    expect(row("theme.css", 58, "#151b23")).toMatchObject({ proposed: null, context: { theme: "light" } });
    expect(row("widgets.tsx", 6, "bg-[#0d1117]")).toMatchObject({ proposed: "color.surface.page", replacement: "bg-page", deltaE: 0, context: { theme: "dark" } });
    // CSS rules inside a JS template literal read as CSS: selector chain, property and theme.
    expect(row("styled.ts", 4, "#151b23")).toMatchObject({
      proposed: "color.surface.panel",
      deltaE: 0,
      context: { property: "background", selector: ".dark .panel", theme: "dark" },
    });
    // A sibling's dark: variant does not make this class dark.
    expect(row("widgets.tsx", 6, "bg-[#f2f2f1]").context.theme).toBe("light");
  });
});

describe("propose: Tailwind classes", () => {
  test.each([
    [4, "w-[320px]", "w-80"],
    [4, "text-[11px]", "text-ui-2xs"],
    [4, "rounded-[6px]", "rounded"],
    [4, "bg-[#fdfdfd]", "bg-page"],
    [4, "aspect-[16/10]", "aspect-16/10"],
    [5, "rounded-[999px]", "rounded-pill"],
    [5, "text-neutral-900", "text-ink"],
    [5, "bg-white/95", "bg-page/95"], // same base color: the opacity modifier stays
    [5, "border-black/10", "border-rule"], // matched as rendered: the modifier goes
    [6, "bg-[#f2f2f1]", "bg-hover"], // hover: variant
    [21, "text-[11px]", "text-ui-2xs"], // !text-[11px]: the leading ! stays outside the literal
    [21, "bg-[#fdfdfd]!", "bg-page!"], // v4 trailing important carries over
  ])("widgets.tsx:%i %s -> %s", (line, literal, replacement) => {
    expect(row("widgets.tsx", line, literal).replacement).toBe(replacement);
  });

  test("the same class twice on a line gets one row per occurrence", () => {
    const [a, b] = [row("widgets.tsx", 6, "text-neutral-900", 0), row("widgets.tsx", 6, "text-neutral-900", 1)];
    expect([a.replacement, b.replacement]).toEqual(["text-ink", "text-ink"]);
    expect(a.column).toBeLessThan(b.column!);
  });
});

/** Rows for the review fixtures (test/fixtures/codemod/review): light default, or dark-first, or a v3 app. */
function reviewRows(path: string, opts: { theme?: "light" | "dark"; tailwind?: "v3" | "v4" | "uno" } = {}): Row[] {
  return propose(loadTokens(), { root: FIXTURES, paths: [`review/${path}`], exclude: [] }, {
    appId: "fixture", defaultTheme: opts.theme ?? "light", categories: new Set(DEFAULT_CATEGORIES), tailwind: opts.tailwind,
  }).rows;
}

function at(list: Row[], file: string, line: number, literal: string): Row {
  const found = list.find((r) => r.file === `review/${file}` && r.line === line && r.literal === literal);
  if (!found) throw new Error(`no row for ${file}:${line} ${literal}`);
  return found;
}

describe("propose: roles only structure gives", () => {
  const css = () => reviewRows("roles.css");
  const tsx = () => reviewRows("widgets.tsx");

  test("a focus ring needs a :focus selector, a focus: variant or a name, and stays within the ΔE cap", () => {
    expect(at(css(), "roles.css", 6, "#0a7ae0")).toMatchObject({ proposed: "color.focus-ring", method: "role" }); // .field:focus-visible outline
    expect(at(css(), "roles.css", 3, "#e6e5e3")).toMatchObject({ proposed: "color.border.default", why: "border" }); // 0 0 0 1px ring shadow on .card
    expect(at(tsx(), "widgets.tsx", 3, "#e0e0e0").proposed).toBe("color.border.default"); // <input onFocus> is not a focus selector
    // --ring is a host-contract name: the contract's focus ring, whatever its ΔE (a blue-gray wash here).
    const ring = row("theme.css", 6, "#aeb8c6");
    expect(ring.proposed).toBe("color.focus-ring");
    expect(ring.why).toMatch(/^host contract: --ring is color\.focus-ring/);
    expect(row("theme.css", 45, "rgb(174 184 198 / 35%)").proposed).toBe("color.border.default");
  });

  test("only an image or media context takes color.border.image; the same black 10% elsewhere is a generic border", () => {
    expect(at(css(), "roles.css", 91, "rgba(0, 0, 0, 0.1)")).toMatchObject({ proposed: "color.border.image", method: "role" }); // .thumbnail img outline
    expect(at(css(), "roles.css", 94, "rgba(0, 0, 0, 0.1)").proposed).not.toBe("color.border.image"); // .list-row rule
  });

  test("placeholder and link need ::placeholder or an a element, not a word", () => {
    expect(at(css(), "roles.css", 9, "#9b9a97").proposed).toBe("color.text.faint"); // .field::placeholder
    expect(at(tsx(), "widgets.tsx", 3, '"#9b9a97"').proposed).not.toBe("color.text.faint"); // <input placeholder="Search">
    const loose = at(css(), "roles.css", 12, "#245a81"); // .more-link: a class word, no a element
    expect(loose.proposed).toBeNull();
    expect(loose.why).toContain("closest compatible token: color.link");
    expect(row("theme.css", 24, "#245a81").proposed).toBe("color.link"); // a.doc-link
  });
});

describe("propose: guards in every family", () => {
  test("a neutral literal leaves a status or accent family for the next one in the chain", () => {
    const rows = reviewRows("roles.css");
    expect(at(rows, "roles.css", 15, "#666562").proposed).toBe("color.text.muted"); // .hint (info)
    expect(at(rows, "roles.css", 18, "#f2f2f1").proposed).toBe("color.fill.hover"); // .remove-btn:hover (danger, then hover)
    expect(at(rows, "roles.css", 21, "#f8f8f7").proposed).toBe("color.surface.panel"); // .ok-row (success)
    expect(at(rows, "roles.css", 27, "#dcd8d1").proposed).not.toBe("color.fill.accent"); // warm gray, not the blue wash
  });

  test("a narrowed family caps at ΔE 10: a dark red in an error box is not the danger solid", () => {
    const r = at(reviewRows("roles.css"), "roles.css", 85, "#9f1d1d");
    expect(r.proposed).toBeNull();
    expect(r.why).toContain("danger status fill: color.status.danger.solid ΔE 15.2");
  });

  test("a translucent literal on an area keeps its alpha or stays unmapped", () => {
    const rows = reviewRows("roles.css");
    expect(at(rows, "roles.css", 24, "rgb(159 29 29 / 8%)")).toMatchObject({ proposed: null, replacement: null }); // 8% danger tint on hover
    expect(at(reviewRows("widgets.tsx"), "widgets.tsx", 6, "bg-white/15")).toMatchObject({ replacement: "bg-page/15" });
  });

  test("a Tailwind tone (bg, text and border in one status hue) proposes that status, in the literal's hue", () => {
    expect(at(reviewRows("widgets.tsx"), "widgets.tsx", 7, "bg-amber-50")).toMatchObject({ proposed: "color.status.warning.soft", replacement: "bg-warning-soft" });
  });
});

describe("propose: charts", () => {
  test("marks take the chart series, labels the text family, axes border.strong", () => {
    const rows = reviewRows("roles.css");
    expect(at(rows, "roles.css", 30, "#088bd9").proposed).toBe("color.chart.series.1");
    expect(at(rows, "roles.css", 33, "#dd6d07").proposed).toBe("color.chart.series.2");
    expect(at(rows, "roles.css", 36, "#666562").proposed).toBe("color.text.muted"); // .legend-label
    expect(at(rows, "roles.css", 39, "#d0cfcc").proposed).toBe("color.border.strong"); // .chart-axis
  });
});

describe("propose: theme and hints", () => {
  test("a dark mark inside :not() means light, any data-*=\"dark\" means dark, and a light region wins in a dark-first app", () => {
    const rows = reviewRows("roles.css");
    expect(at(rows, "roles.css", 42, "#37352f")).toMatchObject({ context: { theme: "light" } });
    expect(at(rows, "roles.css", 42, "#37352f").proposed).not.toBe("color.text.on-solid");
    expect(at(rows, "roles.css", 45, "#151b23").context.theme).toBe("dark");
    const dark = reviewRows("dark-first", { theme: "dark" });
    expect(at(dark, "dark-first/sheet.css", 3, "#f8f8f7")).toMatchObject({ proposed: "color.surface.panel", deltaE: 0, context: { theme: "light" } });
    expect(at(dark, "dark-first/sheet.css", 6, "#151b23")).toMatchObject({ proposed: "color.surface.panel", deltaE: 0, context: { theme: "dark" } });
  });

  test("hints never come from comments in CSS templates or from attribute values", () => {
    const rows = reviewRows("widgets.tsx");
    expect(at(rows, "widgets.tsx", 13, "#666562").proposed).toBe("color.text.muted"); // under "/* a row ... */": not a link
    expect(at(rows, "widgets.tsx", 5, '"#f2f2f1"').proposed).not.toMatch(/status/); // title="Delete"
    expect(at(reviewRows("roles.css"), "roles.css", 48, "#f8f8f7").proposed).toBe("color.surface.panel"); // --input-bg is a background
  });
});

describe("propose: the occurrence on the line", () => {
  test("a color inside a Tailwind class, a selector or another key is never the row's literal", () => {
    const rows = reviewRows("widgets.tsx");
    const style = at(rows, "widgets.tsx", 8, '"#e6e5e3"'); // the style's hex, not the one in border-[#e6e5e3]
    expect(style.column).toBe(readFileSync(join(FIXTURES, "review/widgets.tsx"), "utf8").split("\n")[7].indexOf('"#e6e5e3"') + 1);
    expect(at(rows, "widgets.tsx", 9, '"black"').column).toBe(46); // color: "black", not label: "black"
    expect(at(reviewRows("roles.css"), "roles.css", 51, "white").column).toBe(15); // background: white, not .swatch.white
  });
});

describe("propose: Tailwind v3 apps", () => {
  test("only utilities the v3 preset generates; the rest stay unmapped with the reason", () => {
    const rows = reviewRows("v3.tsx", { tailwind: "v3" });
    const by = (literal: string) => at(rows, "v3.tsx", 2, literal);
    expect(by("min-h-[116px]")).toMatchObject({ replacement: null });
    expect(by("min-h-[116px]").why).toContain("Tailwind v3: the preset has no min-h-29");
    expect(by("w-[320px]").replacement).toBe("w-80");
    expect(by("aspect-[16/10]").replacement).toBeNull();
    expect(by("aspect-[16/9]").replacement).toBe("aspect-video");
    expect(by("bg-[#f8f8f7]").replacement).toBe("bg-panel");
    expect(reviewRows("v3.tsx", { tailwind: "v4" }).find((r) => r.literal === "min-h-[116px]")!.replacement).toBe("min-h-29");
  });
});

describe("propose: JSX attributes and cssVar", () => {
  test("an attribute value takes cssVar in braces, through the import's local name, and the result compiles", () => {
    const root = mkdtempSync(join(tmpdir(), "codemod-jsx-"));
    cpSync(join(FIXTURES, "review"), join(root, "review"), { recursive: true });
    const list = propose(loadTokens(), { root, paths: ["review/attrs.tsx", "review/plain-attrs.tsx", "review/no-semi.tsx"], exclude: [] }, {
      appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES),
    }).rows.map((r) => ({ ...r, approve: r.replacement === null ? "" : "yes" }));
    expect(at(list, "attrs.tsx", 6, '"#e6e5e3"').replacement).toBe('{dsVar("color.border.default")}');
    expect(at(list, "attrs.tsx", 9, '"#ebebe9"').replacement).toBe('dsVar("color.fill.chip")');
    expect(at(list, "plain-attrs.tsx", 2, '"#e6e5e3"').replacement).toBe('"var(--ds-color-border-default)"');
    // Imports without semicolons: the binding is cssVar, not React.cssVar. A style assigned in a
    // handler is JS inside the attribute's braces: no extra braces.
    expect(at(list, "no-semi.tsx", 5, '"#ebebe9"').replacement).toBe('cssVar("color.fill.chip")');
    expect(at(list, "no-semi.tsx", 6, '"#ebebe9"').replacement).toBe('cssVar("color.fill.chip")');
    const result = applyTable(tableOf(root, list), realpathSync(root));
    expect(result.skipped).toEqual([]);
    for (const file of ["attrs.tsx", "plain-attrs.tsx", "no-semi.tsx"]) {
      const out = join(root, "out", file);
      const build = spawnSync(process.execPath, ["build", join(root, "review", file), "--outfile", out, "--packages", "external"], { encoding: "utf8" });
      expect({ file, status: build.status, stderr: build.stderr }).toEqual({ file, status: 0, stderr: "" });
    }
  });
});

describe("propose: second review round", () => {
  const roles = () => reviewRows("roles.css");
  const widgets = () => reviewRows("widgets.tsx");

  test("a color whose channel or alpha is decided at runtime is not a literal", () => {
    expect(at(roles(), "roles.css", 61, "rgb(37 99 235 / var(--tw-bg-opacity))")).toMatchObject({ proposed: null, replacement: null });
    expect(at(widgets(), "widgets.tsx", 16, "`rgba(0, 120, 223, ${a})`")).toMatchObject({ proposed: null, replacement: null });
  });

  test("a transparent literal gets no token, whatever the role", () => {
    expect(at(roles(), "roles.css", 64, "rgba(0, 0, 0, 0)").proposed).toBeNull(); // a border
    const faint = widgets().filter((r) => r.line === 19).map((r) => [r.literal, r.proposed]);
    expect(faint).toEqual([["bg-white/1", null], ["text-[color:transparent]", null]]); // /1 is 1%, not opaque
  });

  test("in dark, a gray reads as gray, not as a tint of the page's blue", () => {
    const dark = reviewRows("dark-first", { theme: "dark" });
    expect(at(dark, "dark-first/sheet.css", 9, "#444444").proposed).not.toMatch(/status/); // .pending
    expect(at(dark, "dark-first/notice.tsx", 2, "bg-neutral-800").proposed).toBe("color.fill.chip"); // under an amber tone
  });

  test("a wash never becomes a solid, an exact translucent token wins, chart chrome is not a series", () => {
    expect(at(roles(), "roles.css", 67, "#d3d1cb").proposed).toBe("color.border.strong"); // .warning: not status.warning.line
    expect(at(roles(), "roles.css", 70, "rgba(42, 42, 42, 0.839)")).toMatchObject({ proposed: "color.text.secondary", replacement: "var(--ds-color-text-secondary)" });
    expect(at(roles(), "roles.css", 73, "#e6e5e3").proposed).toBe("color.border.default"); // .chart-card border
  });

  test("a category map is categorical, not a status", () => {
    expect(at(widgets(), "widgets.tsx", 18, "bg-red-100").proposed).toBe("color.red.soft");
  });

  test("the subject element, an opaque fill under an overlay, and a selector list that disagrees", () => {
    expect(at(roles(), "roles.css", 76, "#245a81").proposed).toBe("color.link"); // .nav li a: the a, not the li
    expect(at(roles(), "roles.css", 79, "#f8f8f7").proposed).toBe("color.surface.panel"); // .overlay .dialog
    expect(at(roles(), "roles.css", 82, "#f8f8f7").context.theme).toBe("light"); // .dark .card, .card
  });

  test("theme: a .light class anywhere, and a shade key named light inside a dark theme", () => {
    expect(at(reviewRows("dark-first", { theme: "dark" }), "dark-first/sheet.css", 12, "#2a2a2a")).toMatchObject({ proposed: "color.text.body", context: { theme: "light" } });
    expect(at(widgets(), "widgets.tsx", 22, '"#2a2a2a"').context.theme).toBe("dark");
  });

  test("hints: later classes in the class string are classes, not attribute names", () => {
    expect(at(widgets(), "widgets.tsx", 20, "bg-[#f2f2f1]").proposed).not.toBe("color.fill.hover");
  });

  test("the occurrence: a var() fallback, a font face and a ternary's longer string are not where scan-literals counted", () => {
    expect(at(roles(), "roles.css", 57, "white").column).toBe(readFileSync(join(FIXTURES, "review/roles.css"), "utf8").split("\n")[56].indexOf("color: white") + 8);
    expect(at(roles(), "roles.css", 59, '"Inter", sans-serif').column).toBeGreaterThan(50); // body, not @font-face
    const ring = at(widgets(), "widgets.tsx", 17, '"white"');
    expect(ring.context.property).toBe("color");
  });

  test("an opacity modifier folds only into a color: text-[13px]/5 keeps its line height", () => {
    expect(at(widgets(), "widgets.tsx", 21, "text-[13px]").replacement).toBe("text-ui-sm");
  });

  test("Tailwind v3: an alpha off the opacity scale goes in brackets", () => {
    const rows = reviewRows("v3.tsx", { tailwind: "v3" });
    expect(at(rows, "v3.tsx", 3, "bg-[#0078df12]").replacement).toBe("bg-accent/[0.071]");
    expect(at(rows, "v3.tsx", 3, "bg-[rgba(253,253,253,.72)]").replacement).toBe("bg-page/[0.72]");
  });

  test("JS that is not a CSS value gets no replacement: a call, an object key, a literal type", () => {
    const rows = reviewRows("js-values.ts");
    expect(at(rows, "js-values.ts", 3, "rgb(253, 253, 253)")).toMatchObject({ replacement: null });
    expect(at(rows, "js-values.ts", 4, '"#ffffff"').why).toContain("an object key");
    expect(at(rows, "js-values.ts", 5, '"#e6e5e3"').why).toContain("a literal type");
    expect(rows.filter((r) => r.replacement !== null)).toEqual([]);
  });
});

/** Rows for the round-2 fixtures (test/fixtures/codemod/review/r2). */
function r2Rows(path: string, opts: { tailwind?: "v3" | "v4" | "uno"; ext?: string } = {}): Row[] {
  return propose(loadTokens(), { root: FIXTURES, paths: [`review/r2/${path}`], exclude: [], ext: opts.ext }, {
    appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES), tailwind: opts.tailwind,
  }).rows;
}

function r2(list: Row[], line: number, literal: string, nth = 0): Row {
  const found = list.filter((r) => r.line === line && r.literal === literal);
  if (!found[nth]) throw new Error(`no row for line ${line} ${literal}; rows on that line: ${list.filter((r) => r.line === line).map((r) => r.literal).join(", ")}`);
  return found[nth];
}

describe("propose: canvas 2D reads the whole statement", () => {
  test("ternaries, ||, ??, a ternary over several lines and a gradient stop are canvas: no replacement", () => {
    const rows = r2Rows("canvas.ts");
    expect(rows.length).toBe(8);
    expect(rows.filter((r) => r.replacement !== null)).toEqual([]);
    for (const r of rows.filter((x) => x.proposed)) expect({ line: r.line, why: r.why }).toEqual({ line: r.line, why: expect.stringContaining("canvas 2D does not resolve var()") });
  });
});

describe("propose: a JS value gets a replacement only where it reaches CSS", () => {
  const rows = () => r2Rows("js-slots.tsx");

  test("settings, palettes, chart options, color inputs, comparisons, call arguments and component props: none", () => {
    const list = rows();
    const cases: Array<[number, string, string]> = [
      [3, "15", "an object held by BASE_SETTINGS"], // prompt-kit BASE_SETTINGS.fontSize
      [3, '"#ffffff"', "foregroundColor is not a CSS property"],
      [4, '"#1a1a1a"', "an array element"], // pen-plotter PALETTE
      [5, '"#666562"', "an object under series, a chart or map option"], // an ECharts series label
      [5, "11", "an object under series, a chart or map option"],
      [5, '"#e6e5e3"', "itemStyle is a chart option"],
      [6, '"#808080"', "the value attribute is not a style"], // a color input's value
      [7, '"#ffffff"', "compared"], // === "#ffffff"
      [8, '"#4a463f"', "an argument to label()"],
      [9, '"#e6e5e3"', "snakeStartColor is not a CSS property"], // circlesnakes DEFAULT_SETTINGS
      [18, '"#e6e5e3"', "the color prop of <Badge> (a component)"],
    ];
    for (const [line, literal, why] of cases) {
      const r = r2(list, line, literal);
      expect({ line, literal, replacement: r.replacement, why: r.why.includes(`not known to reach CSS (${why}`) }).toEqual({ line, literal, replacement: null, why: true });
    }
  });

  test("a nearest pick in a CSS slot that names no CSS property gets none", () => {
    const r = r2(rows(), 20, '"#0078df"'); // el.style.setProperty(name, "#0078df")
    expect(r).toMatchObject({ proposed: "color.accent", method: "nearest", replacement: null });
    expect(r.why).toContain("a nearest-color pick in JS with no CSS property");
  });

  test("a mask's colors and an SVG filter's flood and lighting colors get no token", () => {
    expect(r2(rows(), 21, "rgb(0 0 0 / 0.55)")).toMatchObject({ proposed: null, replacement: null, context: { property: "mask-image" } });
    expect(r2(rows(), 25, '"#808080"')).toMatchObject({ proposed: null, replacement: null });
    expect(r2(rows(), 25, '"#ffffff"')).toMatchObject({ proposed: null, replacement: null });
  });

  test("a style attribute object, a style-named object, a CSSProperties object, el.style, setProperty and a color attribute do", () => {
    const list = rows();
    expect(r2(list, 10, '"#ffffff"').replacement).toBe('"var(--ds-color-surface-page)"'); // style={{ background: on ? … : "#ffffff" }}
    expect(r2(list, 10, "13").replacement).toBe('"var(--ds-font-size-ui-sm)"');
    expect(r2(list, 11, '"#e6e5e3"').replacement).toBe('"var(--ds-color-border-default)"'); // panelStyle
    expect(r2(list, 12, '"#ffffff"').replacement).toBe('"var(--ds-color-text-on-solid)"'); // box: CSSProperties
    expect(r2(list, 14, '"#ffffff"').replacement).toBe('"var(--ds-color-surface-page)"'); // el.style.background =
    expect(r2(list, 15, '"#ebebe9"')).toMatchObject({ proposed: "color.fill.chip", method: "role", replacement: '"var(--ds-color-fill-chip)"', context: { property: "--chip" } });
    expect(r2(list, 17, '"#e6e5e3"').replacement).toBe('"var(--ds-color-border-default)"'); // <circle fill={on ? … : "#e6e5e3"}>
    expect(r2(list, 22, '"#ffffff"').replacement).toBe('"var(--ds-color-text-on-solid)"'); // a spread inside style={{…}}
    expect(r2(list, 23, "{12}").replacement).toBe('"var(--ds-font-size-ui-xs)"'); // <text fontSize={12}>: the tag's `>` is no comparison
    expect(r2(list, 24, "#ffffff").replacement).toMatch(/^var\(--ds-color-/); // el.style.filter is CSS, not canvas
    expect(r2(list, 24, "#ffffff").why).not.toContain("canvas");
  });

  test("approved, every replacement compiles", () => {
    const root = mkdtempSync(join(tmpdir(), "codemod-r2-"));
    cpSync(join(FIXTURES, "review"), join(root, "review"), { recursive: true });
    const p = propose(loadTokens(), { root, paths: ["review/r2/js-slots.tsx", "review/r2/types.ts", "review/r2/commented-import.tsx"], exclude: [] }, {
      appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES),
    });
    const list = p.rows.map((r) => ({ ...r, approve: r.replacement === null ? "" : "yes" }));
    const result = applyTable(tableOf(root, list, p.files), realpathSync(root));
    expect(result.skipped).toEqual([]);
    for (const file of ["js-slots.tsx", "types.ts", "commented-import.tsx"]) {
      const build = spawnSync(process.execPath, ["build", join(root, "review/r2", file), "--outfile", join(root, "out", file), "--packages", "external"], { encoding: "utf8" });
      expect({ file, status: build.status, stderr: build.stderr }).toEqual({ file, status: 0, stderr: "" });
    }
  });
});

describe("propose: text, prose and code are never styles", () => {
  test("JSX text children, aria-label, title and alt values get no replacement", () => {
    const rows = r2Rows("text-slots.tsx");
    expect(rows.map((r) => [r.line, r.literal])).toEqual([[3, '"#ffffff"'], [3, '"#e6e5e3"'], [4, '"#2563eb"'], [7, '"#ffffff"']]);
    expect(rows.filter((r) => r.replacement !== null)).toEqual([]);
  });

  test("Markdown: prose, inline code and fenced code never change; <style>, style and class attributes do", () => {
    const rows = r2Rows("notes.md", { ext: "+md" });
    expect(rows.map((r) => [r.line, r.literal, r.replacement])).toEqual([
      [3, "#ffffff", null], // prose
      [3, "#e6e5e3", null], // `inline code`
      [6, "#ffffff", null], // ```css fence
      [10, "#666562", "var(--ds-color-text-muted)"], // <style>
      [13, "#666562", "var(--ds-color-text-muted)"], // style="…"
      [13, "bg-[#ffffff]", "bg-page"], // class="…"
    ]);
    expect(r2(rows, 6, "#ffffff").why).toContain("Markdown code");
  });

  test("HTML: an SVG fill changes; HTML's own bgcolor and <font color> do not (var() does not resolve there)", () => {
    const rows = r2Rows("legacy.html");
    expect(rows.map((r) => [r.line, r.literal, r.replacement])).toEqual([
      [1, "#ffffff", null],
      [1, "#e6e5e3", null],
      [2, "#ffffff", "var(--ds-color-surface-page)"], // an SVG shape's fill: no solid under it, so not on-solid
    ]);
  });

  test("Vue: a :style binding and <style> change; a title, element text and the <script> block do not", () => {
    const rows = r2Rows("comp.vue");
    expect(rows.map((r) => [r.line, r.literal, r.replacement])).toEqual([
      [2, "#666562", "var(--ds-color-text-muted)"],
      [2, "#ffffff", null],
      [2, "#e6e5e3", null],
      [5, "#3B82F6", null],
      [8, "#ffffff", "var(--ds-color-surface-page)"],
    ]);
  });
});

describe("propose: radius, names and types", () => {
  test("a class with a radius per corner stays unmapped instead of rounding every corner", () => {
    for (const tailwind of ["v4", "v3"] as const) {
      const rows = r2Rows("radius.tsx", { tailwind });
      expect(r2(rows, 2, "rounded-[6px_0_0_6px]")).toMatchObject({ proposed: null, replacement: null });
      expect(r2(rows, 2, "rounded-[6px_0_0_6px]").why).toContain("one value per corner");
      expect(r2(rows, 2, "rounded-[6px]").replacement).toBe("rounded");
    }
  });

  test("the last role word of a name decides: a label's background is a background", () => {
    const rows = r2Rows("names.css");
    expect(r2(rows, 3, "#f8f8f7").proposed).toBe("color.surface.panel"); // --connector-label-background
    expect(r2(rows, 4, "#666562").proposed).toBe("color.text.muted"); // --label-color
    // Only a CSS mask property is a mask: a variable named for a mask scrim still reads by role.
    expect(r2(rows, 6, "#000000").why).toContain("a mask");
    expect(r2(rows, 6, "rgba(0, 0, 0, 0.45)").why).not.toContain("a mask");
  });

  test("a literal type alias, an annotation and a type argument are hand edits", () => {
    const rows = r2Rows("types.ts");
    expect(r2(rows, 3, '"#ffffff"')).toMatchObject({ replacement: null });
    expect(r2(rows, 3, '"#ffffff"').why).toContain("a literal type alias");
    expect(r2(rows, 4, '"#e6e5e3"', 0).why).toContain("a type annotation");
    expect(r2(rows, 4, '"#e6e5e3"', 1).replacement).toBeNull(); // the value: assigned to a variable
    expect(r2(rows, 6, '"#ffffff"').why).toContain("a type argument");
    expect(r2(rows, 7, '"#ebebe9"').replacement).toBe('cssVar("color.fill.chip")'); // the file's live import
  });

  test("a commented-out import and import text in a string bind no cssVar", () => {
    expect(r2(r2Rows("commented-import.tsx"), 4, '"#ebebe9"').replacement).toBe('"var(--ds-color-fill-chip)"');
  });
});

describe("propose: second-pass review of the slot reading", () => {
  const none = (rows: Row[], line: number, literal: string, why: string, nth = 0) => {
    const r = r2(rows, line, literal, nth);
    expect({ line, literal, replacement: r.replacement, why: r.why.includes(why) }).toEqual({ line, literal, replacement: null, why: true });
  };

  test("a comparison with `<` followed by an assignment is not a JSX attribute", () => {
    const rows = r2Rows("lt.ts");
    none(rows, 5, '"#ffffff"', "assigned to color"); // after `innerWidth<breakpoint;`
    none(rows, 7, '"#ffffff"', "assigned to color"); // `if (n<min) color = …`
  });

  test("a Tailwind class in a compared string, prose or a non-class attribute is not rewritten", () => {
    const rows = r2Rows("classes.tsx");
    none(rows, 2, "bg-blue-500", "compared");
    none(rows, 3, "text-[#ffffff]", "text, not a class list");
    none(rows, 4, "text-[#ffffff]", "the aria-label attribute");
    expect(r2(rows, 4, "text-[#ffffff]", 1).replacement).toBe("text-on-solid"); // its className
    // A class template whose ${…} holds quoted classes over several lines is still a class list.
    expect(r2(rows, 5, "rounded-[2px]").replacement).toBe("rounded");
    expect(r2(rows, 6, "bg-[#ffffff]").replacement).toBe("bg-page");
  });

  test("color and fill are presentation attributes only on SVG elements", () => {
    const rows = r2Rows("props.tsx");
    none(rows, 3, '"#ffffff"', "the color prop of <MyIcon>");
    none(rows, 4, '"#ffffff"', "<meshStandardMaterial> is not an SVG presentation attribute");
    none(rows, 5, '"#ffffff"', "<link> is not an SVG presentation attribute");
    expect(r2(rows, 6, '"#ffffff"').replacement).toBe('"var(--ds-color-surface-page)"');
    const vue = r2Rows("guards.vue");
    none(vue, 2, "#ffffff", "<MyIcon> is not an SVG presentation attribute");
    expect(r2(vue, 3, "#e6e5e3").replacement).toBe("var(--ds-color-border-default)");
    none(vue, 6, "#ffffff", "a <script> block"); // markup in a script string
  });

  test("markup: <style> inside comments or backticks opens nothing; script blocks, indented and list-indented code never change", () => {
    const md = r2Rows("guards.md", { ext: "+md" });
    none(md, 3, "#ffffff", "Markdown prose");
    none(md, 8, "#ffffff", "Markdown code"); // a fence indented inside a list item
    none(md, 13, "#ffffff", "Markdown code"); // an indented code block
    expect(r2(md, 15, "#666562").replacement).toBe("var(--ds-color-text-muted)");
    const html = r2Rows("guards.html");
    none(html, 2, "#ffffff", "element text"); // after a comment naming <style>
    expect(r2(html, 4, "#666562").replacement).toBe("var(--ds-color-text-muted)");
    expect(html.filter((r) => r.line === 4 && r.replacement !== null).map((r) => r.literal)).toEqual(["#666562"]); // #bad, #face are selectors
    none(html, 7, "#ffffff", "a <script> block");
  });

  test("templates holding code or an SVG image are not CSS; a page template is CSS only in its <style>; a curried call is a call", () => {
    const rows = r2Rows("templates.ts");
    none(rows, 2, "#ffffff", "assigned to snippet");
    none(rows, 3, "#ffffff", "assigned to cursor");
    none(rows, 4, "#ffffff", "assigned to page");
    expect(r2(rows, 4, "#666562").replacement).toBe("var(--ds-color-text-muted)");
    none(rows, 6, '"#ffffff"', "an argument to darken(…)()");
    expect(r2(rows, 6, '"#ebebe9"').replacement).toBe('"var(--ds-color-fill-chip)"');
  });

  test("chart and map options, other functions' arguments, a map feature's setProperty and a type leaking past a line without a semicolon: none", () => {
    const rows = r2Rows("configs.tsx");
    none(rows, 4, '"#ffffff"', "an object under graphic"); // ECharts graphic style
    none(rows, 5, '"#ffffff"', "an object under stylers"); // Google Maps styles
    none(rows, 6, '"#ffffff"', "an object under paint"); // a Mapbox layer
    none(rows, 7, '"#ffffff"', "an argument to L.geoJSON()");
    none(rows, 8, '"#ffffff"', "an argument to feature.setProperty()");
    none(rows, 10, '"#ffffff"', "an object under legend");
  });

  test("styled templates with type arguments and interpolated functions are CSS; a typed class field is; a style-named object in canvas code is not", () => {
    const rows = r2Rows("styled.tsx");
    expect(r2(rows, 5, "#666562").replacement).toBe("var(--ds-color-text-muted)");
    expect(r2(rows, 6, '"#ffffff"')).toMatchObject({ context: { property: "background" }, replacement: '"var(--ds-color-surface-page)"' });
    expect(r2(rows, 9, '"#ffffff"').replacement).toBe('"var(--ds-color-text-on-solid)"'); // private boxStyle: CSSProperties
    none(rows, 10, '"#ffffff"', "an object held by settings");
    none(r2Rows("canvas-file.ts"), 3, '"#ffffff"', "textStyle in a file that draws on a canvas");
  });
});

describe("propose: the Tailwind that compiles the classes", () => {
  test("a library's classes target its host's Tailwind from the registry", () => {
    const app = (id: string) => loadRegistry().apps.find((a) => a.id === id)!;
    expect(classTarget(app("prompt-kit-ui"))).toEqual({ tailwind: "v3", from: "stack.hostTailwind" });
    expect(classTarget(app("viewer-shell")).tailwind).toBe("v3");
    expect(classTarget(app("canvas-renderer")).tailwind).toBe("v4");
    expect(classTarget(app("slidev-template"))).toEqual({ tailwind: "uno", from: "stack.hostTailwind" });
    expect(classTarget(app("docs-workbench"))).toEqual({ tailwind: "v4", from: "stack.tailwind" });
    expect(classTarget(app("simple-research-kernel")).tailwind).toBe("v3");
    expect(classTarget(app("sequence-studio")).tailwind).toBe("none");
  });

  test("an UnoCSS host gets no class rewrites: the rows are unmapped with the reason", () => {
    const rows = reviewRows("v3.tsx", { tailwind: "uno" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect({ literal: r.literal, proposed: r.proposed, replacement: r.replacement, method: r.method }).toEqual({ literal: r.literal, proposed: null, replacement: null, method: null });
      expect(r.why).toContain("UnoCSS host");
    }
  });
});

/** Rows for the round-3 fixtures (test/fixtures/codemod/review/r3), built from the rows the round-3 review cites. */
function r3Rows(paths: string[], opts: { theme?: "light" | "dark" } = {}): Row[] {
  return propose(loadTokens(), { root: FIXTURES, paths: paths.map((p) => `review/r3/${p}`), exclude: [] }, {
    appId: "fixture", defaultTheme: opts.theme ?? "light", categories: new Set(DEFAULT_CATEGORIES),
  }).rows;
}

function r3(list: Row[], file: string, line: number, literal: string): Row {
  const found = list.find((r) => r.file === `review/r3/${file}` && r.line === line && r.literal === literal);
  if (!found) throw new Error(`no row for ${file}:${line} ${literal}; rows on that line: ${list.filter((r) => r.line === line).map((r) => r.literal).join(", ")}`);
  return found;
}

describe("propose: round-3 review of the role choices", () => {
  test("P1-2: color.text.on-solid only on a solid fill; white text on a fixed dark region gets none", () => {
    const rows = r3Rows(["on-solid.tsx"]);
    const none: Array<[number, string]> = [
      [4, '"#FFFFFF"'], // canvas-renderer 177: the search input's text, no fill under it
      [5, '"#FFFFFF"'], // canvas-renderer 180: background is transparent or a 14% white hover
      [6, "text-white"], // canvas-studio 2
      [7, "text-white"], // canvas-studio 3 (a ghost button)
      [8, "text-white/70"], // canvas-studio 8
      [10, '"#ccc"'], // docs-workbench 23
      [11, '"#FFFFFF"'], // canvas-renderer 251: solid only while active
    ];
    for (const [line, literal] of none) expect({ line, literal, ...pick(r3(rows, "on-solid.tsx", line, literal)) }).toEqual({ line, literal, proposed: null, replacement: null });
    expect(r3(rows, "on-solid.tsx", 4, '"#FFFFFF"').why).toContain("color.text.on-solid needs a solid fill under it");
    // A solid under it: the rule's own background, a solid class on the element, a primary word.
    expect(r3(rows, "on-solid.tsx", 12, '"#ffffff"').replacement).toBe('"var(--ds-color-text-on-solid)"');
    expect(r3(rows, "on-solid.tsx", 13, "text-white").replacement).toBe("text-on-solid");
    expect(r3(rows, "on-solid.tsx", 14, '"#ffffff"').replacement).toBeNull(); // a class name (btn-primary) is not a fill
    // A definition named for the glyph on a solid; a light shade (`-50`) is a tint, not a solid. --primary-foreground
    // is a host-contract name: it takes the contract's page color (the glyph on the ink fill).
    const named = r3Rows(["readers.css"]);
    expect(r3(named, "readers.css", 28, "#ffffff").replacement).toBe("var(--ds-color-text-on-solid)");
    expect(r3(named, "readers.css", 28, "#ffffff").why).toBe("text; on-solid is near-black in dark: check the fill under it");
    expect(named.filter((r) => r.line === 25).map((r) => r.replacement)).toEqual(["var(--ds-color-surface-page)", null]);
    // mainmenu 438 and 487: a dim gray in a dark app was on-solid at ΔE 19.8.
    const dark = r3Rows(["on-solid-dark.tsx"], { theme: "dark" });
    expect(pick(r3(dark, "on-solid-dark.tsx", 2, "text-gray-700"))).toEqual({ proposed: null, replacement: null });
    expect(pick(r3(dark, "on-solid-dark.tsx", 3, "text-gray-700"))).toEqual({ proposed: null, replacement: null });
  });

  test("P1-3: color-scheme marks its block's theme; a block whose own background is of the other theme gets no tokens", () => {
    const rows = r3Rows(["scheme.css"]);
    // canvas-agent agent-theme.css: `:root { color-scheme: dark }` is dark, so its foreground is body text, not on-solid.
    expect(r3(rows, "scheme.css", 5, "#d4d4d4")).toMatchObject({ proposed: "color.text.body", replacement: "var(--ds-color-text-body)", context: { theme: "dark" } });
    expect(r3(rows, "scheme.css", 6, "#d4d4d4")).toMatchObject({ proposed: "color.text.body", context: { theme: "dark" } });
    // observatory index.css: no color-scheme, a dark --background, read in light: a fixed region.
    for (const [line, literal] of [[10, "#d4d4d4"], [11, "rgb(255 255 255 / 0.08)"], [12, "rgb(255 255 255 / 0.028)"]] as const) {
      const r = r3(rows, "scheme.css", line, literal);
      expect({ line, ...pick(r), fixed: r.why.includes("a fixed dark region") }).toEqual({ line, proposed: null, replacement: null, fixed: true });
    }
    // `color-scheme: light dark` names no theme.
    expect(r3(rows, "scheme.css", 16, "#2a2a2a").context.theme).toBe("light");
  });

  test("P1-4: a custom property takes its readers' role; none or mixed readers get no token", () => {
    const rows = r3Rows(["readers.css", "readers.tsx"]);
    // docs-viewer 99, 107: --op-kind-soft is read as a background, not a border.
    expect(r3(rows, "readers.css", 2, "#faebdd")).toMatchObject({ proposed: "color.fill.chip", why: "chip fill" });
    expect(r3(rows, "readers.css", 3, "#eae4f2").proposed).toMatch(/^color\.fill\./);
    // docs-viewer 325, 326: --fl-muted and --fl-optional are read as text (one through --fl-type-punct).
    for (const col of [0, 1]) {
      const r = rows.filter((x) => x.file === "review/r3/readers.css" && x.line === 5)[col];
      expect({ col, ...pick(r), text: r.why.startsWith("role text") }).toEqual({ col, proposed: null, replacement: null, text: true });
    }
    // mainmenu 923 and agent-skills-manager 21: read as backgrounds, not borders.
    expect(r3(rows, "readers.css", 8, "#2f3236").why).toMatch(/^background/);
    expect(r3(rows, "readers.css", 10, "#454B4E").proposed).toMatch(/^color\.(?:fill|surface)\./);
    // personal-site 55-67 and slidev 22: read nowhere, or as border and text.
    expect(r3(rows, "readers.css", 13, "rgba(155,154,151,0.4)")).toMatchObject({ proposed: null, replacement: null });
    expect(r3(rows, "readers.css", 14, "#E9E5E3").why).toContain("--color-bg-brown is read nowhere");
    expect(r3(rows, "readers.css", 15, "#D9730D").why).toContain("is read as border (review/r3/readers.css:17) and text (review/r3/readers.css:18): mixed roles");
    expect(r3(rows, "readers.css", 19, "#4D4D4D")).toMatchObject({ proposed: null, replacement: null });
    // A color-mix() reader derives a wash; it gives no role. Utility classes read too.
    expect(r3(rows, "readers.css", 20, "#2a2a2a").proposed).toBe("color.text.body");
    expect(r3(rows, "readers.css", 20, "#666562").proposed).toBe("color.text.muted"); // text-[var(--chip-ink)]
    expect(r3(rows, "readers.css", 22, "#0078df").proposed).toBe("color.accent"); // @theme --color-brand, read by bg-brand
  });

  test("P1-5: a nearest pick keeps the alpha or gets none, and the backdrop needs a scrim, overlay, backdrop or modal hint", () => {
    const rows = r3Rows(["alpha.css"]);
    // simple-research-kernel 107, gamecube 890: never the 40% black backdrop.
    expect(r3(rows, "alpha.css", 3, "rgb(255 255 255 / 0.028)").proposed).not.toBe("color.backdrop");
    // canvas-renderer 172: the 25% white thumb keeps its alpha.
    expect(r3(rows, "alpha.css", 5, "rgba(255, 255, 255, 0.25)").replacement).toBe("color-mix(in srgb, var(--ds-color-surface-page) 25%, transparent)");
    // canvas-agent 60 / observatory 101: an opaque border token would drop the 40%.
    expect(pick(r3(rows, "alpha.css", 6, "rgb(168 168 168 / 0.4)"))).toEqual({ proposed: null, replacement: null });
    expect(pick(r3(rows, "alpha.css", 7, "rgba(0, 0, 0, 0.4)"))).toEqual({ proposed: null, replacement: null });
    expect(r3(rows, "alpha.css", 8, "rgba(0, 0, 0, 0.4)").proposed).toBe("color.backdrop"); // .modal
  });

  test("P1-6: paint inside a mask, a clipPath or a pattern a mask uses gets no token", () => {
    const rows = r3Rows(["mask.tsx"]);
    expect(r3(rows, "mask.tsx", 6, '"white"')).toMatchObject({ proposed: null, replacement: null, why: expect.stringContaining("inside an SVG <mask>") }); // canvas-renderer 167
    expect(r3(rows, "mask.tsx", 8, '"#ffffff"').why).toContain("inside an SVG <clipPath>");
    expect(r3(rows, "mask.tsx", 9, '"#000000"').why).toContain("inside an SVG <pattern>"); // used by mask#cut
    expect(r3(rows, "mask.tsx", 10, '"#e6e5e3"').replacement).toBe('"var(--ds-color-border-default)"'); // a pattern no mask uses
    expect(r3(rows, "mask.tsx", 13, '"white"').replacement).toBe('"var(--ds-color-surface-page)"');
  });

  test("P1-7: a state attribute counts only by its own value, and a word only when every branch of the list has it", () => {
    const tsx = r3Rows(["states.tsx"]);
    // canvas-renderer 192: `data-state={…}` then `onAnimationEnd` read as "data state on".
    expect(r3(tsx, "states.tsx", 8, '"#FFFFFF"').proposed).toBe("color.surface.panel");
    expect(r3(tsx, "states.tsx", 12, '"#ebebe9"').why).toBe("selected fill"); // aria-selected="true"
    expect(r3(tsx, "states.tsx", 13, '"#ebebe9"').why).not.toContain("selected"); // aria-selected="false"
    const css = r3Rows(["states.css"]);
    // annotations 6, 9: selected and chip came from one branch of four.
    expect(r3(css, "states.css", 6, "#ffffff")).toMatchObject({ proposed: "color.surface.page", why: expect.stringMatching(/^background/) });
    expect(r3(css, "states.css", 7, "rgba(0, 0, 0, 0.15)").why).toMatch(/^border/);
    expect(r3(css, "states.css", 10, "#ebebe9").why).toBe("selected fill"); // .tab.active, .tab[aria-selected="true"]
    expect(r3(css, "states.css", 11, "#ebebe9").why).not.toContain("selected"); // :not(.active)
    expect(r3(css, "states.css", 12, "#ebebe9").why).not.toContain("selected"); // [aria-selected="false"]
  });

  test("P2: `err` is a danger word; a negative arbitrary offset is a leading minus", () => {
    const rows = r3Rows(["readers.css"]);
    expect(r3(rows, "readers.css", 23, "#fdecec").proposed).toBe("color.status.danger.soft"); // pen-plotter 71
    expect(r3(rows, "readers.css", 23, "#a11d1d").proposed).toBe("color.status.danger.text");
    const spacing = r3Rows(["spacing.tsx"]).map((r) => [r.literal, r.replacement]);
    expect(spacing).toEqual([["top-[-4px]", "-top-1"], ["mt-[-2px]", "-mt-0.5"], ["-mt-[8px]", "-mt-2"], ["-left-[-8px]", "left-2"]]);
  });
});

/** Rows for the round-3 second-pass fixtures (test/fixtures/codemod/review/r3/second), from the internal review's probes. */
function r3b(paths: string[], opts: { theme?: "light" | "dark" } = {}): Row[] {
  return r3Rows(paths.map((p) => `second/${p}`), opts);
}

function at3(list: Row[], file: string, line: number, literal: string, nth = 0): Row {
  const found = list.filter((r) => r.file === `review/r3/second/${file}` && r.line === line && r.literal === literal);
  if (!found[nth]) throw new Error(`no row for ${file}:${line} ${literal}; rows on that line: ${list.filter((r) => r.line === line).map((r) => r.literal).join(", ")}`);
  return found[nth];
}

describe("propose: round-3 second review of the role choices", () => {
  test("P1-1: color-scheme off the root, without a theme selector, is a fixed region", () => {
    const rows = r3b(["island.css"]);
    for (const [line, literal] of [[2, "#d1d9e0"], [2, "#3d444d"], [3, "#d1d9e0"]] as const) {
      const r = at3(rows, "island.css", line, literal);
      expect({ line, literal, ...pick(r), island: r.why.includes("switches the browser's colors, not the tokens; add data-theme=\"dark\"") }).toEqual({ line, literal, proposed: null, replacement: null, island: true });
    }
    expect(at3(rows, "island.css", 4, "#2a2a2a")).toMatchObject({ proposed: null, why: expect.stringContaining("`color-scheme: light` on `.x`") });
    // With a theme selector the tokens switch too: a theme mark.
    expect(at3(rows, "island.css", 5, "#d1d9e0")).toMatchObject({ proposed: "color.text.body", context: { theme: "dark" } });
  });

  test("P1-2: a JS key reads a variable only when the string is its whole value", () => {
    const rows = r3b(["js-readers.tsx", "js-readers.css"]);
    const read = (literal: string, nth = 0) => rows.filter((r) => r.file.endsWith("js-readers.css") && r.literal === literal)[nth];
    expect(read("#d4d4d4").why).toContain("--stroke-c is read as other"); // a JSX attribute after a parameter type `{ color: string }`
    expect(read("#333333").why).toContain("--ink is read as other"); // `color: hovered ? bg : "var(--ink)"`
    expect(read("#f5f5f5").why).toContain("--surface is read as other"); // `background: hovered ? color : …`, not text
    expect(read("#e6e5e3").why).toContain("--line is read as other");
    expect(read("#2a2a2a").proposed).toBe("color.text.body"); // { padding: 4, color: "var(--plain-ink)" }
  });

  test("P2-11: bg-[--x] reads a variable, and a ring offset paints the background's color", () => {
    const rows = r3b(["js-readers.tsx", "js-readers.css"]);
    const chip = rows.filter((r) => r.file.endsWith("js-readers.css") && r.literal === "#ebebe9");
    expect(chip.map((r) => [r.line, r.proposed])).toEqual([[2, "color.fill.chip"], [3, "color.fill.chip"]]);
  });

  test("P1-3: the reader index is linear on long unbroken text, and skips generated files", () => {
    const long = prepareSource("logo.tsx", `export const D = "M0,0${"l1,2".repeat(75000)}";\n`, "js");
    const t0 = performance.now();
    buildConsumers([long]);
    expect(performance.now() - t0).toBeLessThan(2000);
    const root = mkdtempSync(join(tmpdir(), "codemod-gen-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/theme.css"), ":root { --gen-ink: #2a2a2a; }\n");
    writeFileSync(join(root, "src/out.css"), "/* @generated by a tool */\n.x { color: var(--gen-ink); }\n");
    const rows = propose(loadTokens(), { root, paths: ["src"], exclude: [] }, { appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES) }).rows;
    expect(rows.find((r) => r.literal === "#2a2a2a")!.why).toContain("--gen-ink is read nowhere");
  });

  test("P1-4, P2-8, P2-9: :not() and :has() say nothing, :is() is a branch list, a bare aria-* and data-state=open are no state", () => {
    const rows = r3b(["not.css"]);
    const why = (line: number, literal: string) => at3(rows, "not.css", line, literal).why;
    expect(at3(rows, "not.css", 2, "#ffffff").proposed).toBeNull(); // button:not(.primary): not a primary button
    expect(why(3, "#fef2f2")).not.toContain("danger"); // .btn:not(.danger)
    expect(why(4, "#0a7ae0")).not.toContain("focus ring"); // .field:not(:focus)
    expect(why(5, "#9b9a97")).not.toContain("placeholder"); // input:not(:placeholder-shown)
    expect(why(6, "#ebebe9")).not.toContain("selected"); // .row:has(.child.active)
    expect(why(7, "#ebebe9")).not.toMatch(/hover|selected/); // .tab:is(.active, :hover)
    expect(at3(rows, "not.css", 8, "#c62121").proposed).toBeNull(); // :is(.error, .note) .msg: not a danger rule
    expect(why(9, "#ebebe9")).not.toContain("selected"); // [aria-selected] matches "false" too
    expect(why(10, "#ebebe9")).not.toContain("selected"); // an open dialog is not a selected row
    expect(why(11, "#ebebe9")).toBe("selected fill"); // :is(.active, [aria-selected="true"])
    const tw = r3b(["variants.tsx"]);
    expect(at3(tw, "variants.tsx", 2, "bg-[#f2f2f1]").why).not.toContain("hover"); // not-hover:
    expect(at3(tw, "variants.tsx", 2, "bg-[#ebebe9]", 0).why).not.toContain("selected"); // not-aria-selected:
    expect(at3(tw, "variants.tsx", 2, "bg-[#ebebe9]", 1).why).toBe("selected fill"); // aria-selected:
  });

  test("P1-5: an @apply class string ends at its own declaration", () => {
    const rows = r3b(["apply.css"]);
    expect(pick(at3(rows, "apply.css", 2, "text-white"))).toEqual({ proposed: null, replacement: null }); // not on .cta's bg-blue-600
  });

  test("P1-6, P2-10: a mask with a style object, a gradient a mask uses, and HTML's case-insensitive names", () => {
    const rows = r3b(["masks.tsx", "masks.html"]);
    expect(at3(rows, "masks.tsx", 8, '"#ffffff"').why).toContain("inside an SVG <mask>"); // <mask style={{ maskType: "alpha" }}>
    expect(at3(rows, "masks.tsx", 5, '"#ffffff"').why).toContain("inside an SVG <linearGradient>"); // url(#fade) inside <mask id="m">
    expect(at3(rows, "masks.tsx", 5, '"#000000"').proposed).toBeNull();
    expect(at3(rows, "masks.tsx", 10, '"#e6e5e3"').replacement).toBe('"var(--ds-color-border-default)"'); // a gradient no mask uses
    const html = rows.filter((r) => r.file.endsWith("masks.html")).map((r) => [r.literal, r.replacement]);
    expect(html).toEqual([["#ffffff", null], ["#ffffff", null], ["#e6e5e3", "var(--ds-color-border-default)"]]); // <clippath>, <MASK>
  });

  test("P2-7: on-solid only from a solid background or a definition name, never a class, tag or attribute name", () => {
    const rows = r3b(["solid.tsx"]);
    for (const [line, literal] of [[3, "text-white"], [4, "text-white"], [5, "text-white"], [6, "text-white"], [7, '"#ffffff"'], [8, "text-white"]] as const) {
      expect({ line, ...pick(at3(rows, "solid.tsx", line, literal)) }).toEqual({ line, proposed: null, replacement: null });
    }
    expect(at3(rows, "solid.tsx", 9, "text-white").replacement).toBe("text-on-solid"); // bg-blue-600 hover:bg-blue-700: solid in both
  });
});

/** Rows for the round-3 closing fixtures (test/fixtures/codemod/review/r3/closing), from the closing review's probes. */
function closing(paths: string[], opts: { theme?: "light" | "dark" } = {}): Row[] {
  return r3Rows(paths.map((p) => `closing/${p}`), opts);
}

function atClosing(list: Row[], file: string, line: number, literal: string): Row {
  const found = list.find((r) => r.file === `review/r3/closing/${file}` && r.line === line && r.literal === literal);
  if (!found) throw new Error(`no row for ${file}:${line} ${literal}; rows on that line: ${list.filter((r) => r.line === line).map((r) => r.literal).join(", ")}`);
  return found;
}

describe("propose: round-3 closing review (R3-B3)", () => {
  test("P1-7: a template-literal class value gives hints from its static chunks only; current, inherit, transparent and drop-shadow are no state", () => {
    const rows = closing(["states.tsx"]);
    const state = (line: number, literal: string) => {
      const r = atClosing(rows, "states.tsx", line, literal);
      return { line, literal, state: /selected|hover|outline/.test(r.why) ? r.why : null };
    };
    // The condition (`selectedType ? …`, `isSelected ? …`) is not a class: no state from it.
    for (const [line, literal] of [[4, "bg-[#ebebe9]"], [4, "bg-[#f7f7f5]"], [10, "bg-[#ebebe9]"], [17, '"#ebebe9"']] as const) {
      expect(state(line, literal)).toEqual({ line, literal, state: null });
    }
    // The unselected tab keeps its own color: a panel, not the selected fill.
    expect(pick(atClosing(rows, "states.tsx", 4, "bg-[#f7f7f5]"))).toEqual({ proposed: "color.surface.panel", replacement: "bg-panel" });
    // text-current, drop-shadow-md, border-current and bg-transparent are no state words.
    for (const [line, literal] of [[7, "bg-[#ebebe9]"], [8, "border-[#d3d1cb]"], [20, "border-[#d3d1cb]"]] as const) {
      expect(state(line, literal)).toEqual({ line, literal, state: null });
    }
    // A state word in a static chunk after the interpolation still holds.
    expect(atClosing(rows, "states.tsx", 19, '"#ebebe9"').why).toBe("selected fill");
  });

  test("P1-7: mainmenu 637 and 647, the unselected asset chip, is not the selected fill", () => {
    const rows = closing(["mainmenu.tsx"], { theme: "dark" });
    for (const line of [8, 21]) {
      const r = atClosing(rows, "mainmenu.tsx", line, "bg-[#1d1d1d]");
      expect({ line, proposed: r.proposed, selected: r.why.includes("selected") }).toEqual({ line, proposed: expect.not.stringMatching(/active/), selected: false });
    }
  });

  test("P2-5: a leading - on a root outside the spacing scale is refused; spacing roots keep it", () => {
    const rows = closing(["negative.tsx"]);
    const by = (literal: string) => atClosing(rows, "negative.tsx", 2, literal);
    for (const literal of ["-z-[40]", "-tracking-[0.09em]"]) {
      expect({ literal, ...pick(by(literal)), why: by(literal).why }).toEqual({ literal, proposed: null, replacement: null, why: expect.stringContaining("leading -") });
    }
    expect(rows.map((r) => [r.literal, r.replacement])).toEqual([
      ["-z-[40]", null],
      ["z-[40]", "z-overlay"],
      ["-tracking-[0.09em]", null],
      ["tracking-[-0.02em]", "tracking-title"],
      ["-top-[4px]", "-top-1"],
      ["-mt-[8px]", "-mt-2"],
    ]);
  });
});

function pick(r: Row) {
  return { proposed: r.proposed, replacement: r.replacement };
}

describe("token guards", () => {
  test("Notion compat tokens stay in the docs-system repo", () => {
    const pool = ["color.notion.bg.yellow", "color.notion.text.navigation", "color.surface.panel"];
    const keep = (appId: string, file: string) => pool.filter((p) => tokenAllowed(p, { appId, file }));
    expect(keep("docs-viewer", "codecaine/core/docs-system/packages/docs-viewer/src/a.css")).toEqual(pool);
    expect(keep("docs-mcp-home", "codecaine/core/docs-mcp-home/src/a.css")).toEqual(["color.surface.panel"]);
    expect(keep("docs-publish", "codecaine/core/docs-publish/src/a.css")).toEqual(["color.surface.panel"]);
  });
});

describe("apply", () => {
  function approved(list: Row[], pick: (r: Row) => boolean): Row[] {
    return list.map((r) => ({ ...r, approve: pick(r) ? "yes" : "" }));
  }

  test("changes only approved rows, skips every row of a changed file and replacement-less rows, and dry-run writes nothing", () => {
    const root = tempRoot();
    const fresh = proposeAt(root);
    const wanted = new Set(["#f5f3ef", "text-neutral-900", "w-[320px]", "13", "#c62121", "#ffffff"]);
    const list = approved(fresh.rows, (r) => wanted.has(r.literal));
    // Line 20 (.error-text) changes after propose: every row of theme.css is stale, line 3's too.
    const theme = join(root, SRC, "theme.css");
    const before = readFileSync(theme, "utf8").split("\n");
    before[19] = "  color: #c00000;";
    writeFileSync(theme, before.join("\n"));
    const widgets = join(root, SRC, "widgets.tsx");
    const original = readFileSync(widgets, "utf8");

    const dry = applyTable(tableOf(root, list, fresh.files), root, { dryRun: true });
    expect(readFileSync(widgets, "utf8")).toBe(original);

    const result = applyTable(tableOf(root, list, fresh.files), root);
    expect(result.applied.length).toBe(dry.applied.length);
    expect(result.unapproved).toBe(list.length - list.filter((r) => r.approve === "yes").length);
    const themeLines = readFileSync(theme, "utf8").split("\n");
    const widgetLines = readFileSync(widgets, "utf8").split("\n");
    expect(themeLines[2]).toBe("  --background: #f5f3ef;"); // its line is unchanged, but its file is not
    expect(themeLines[19]).toBe("  color: #c00000;");
    expect(widgetLines[3]).toContain('className="w-80 text-[11px]');
    expect(widgetLines[5]).toContain("text-ink text-ink"); // both occurrences on one line
    expect(widgetLines[6]).toContain('fontSize: "var(--ds-font-size-ui-sm)"');
    expect(widgetLines[15]).toBe('  ctx.fillStyle = "#ffffff";'); // canvas row has no replacement
    expect(result.skipped.map((s) => [s.row.literal, s.reason.split(":")[0]])).toEqual([
      ["#f5f3ef", "stale"],
      ["#c62121", "stale"],
      ["#ffffff", "no replacement"],
    ]);
    expect(result.staleFiles).toEqual([{ file: `${SRC}/theme.css`, rows: 2, reason: "the file changed since propose (whole-file hash): run propose again" }]);
  });

  test("an edited replacement wins", () => {
    const root = tempRoot();
    const list = approved(proposeIn(root), (r) => r.literal === "#f9f9f9");
    list.find((r) => r.literal === "#f9f9f9")!.replacement = "var(--ds-color-surface-panel)";
    const result = applyTable(tableOf(root, list), root);
    expect(result.applied.map((r) => r.literal)).toEqual(["#f9f9f9"]);
    expect(readFileSync(join(root, SRC, "theme.css"), "utf8").split("\n")[15]).toBe("  background: var(--ds-color-surface-panel);");
  });

  test("lines shifted down by an edit above: the row is stale, and the line that moved into its place is untouched", () => {
    const root = tempRoot();
    const file = join(root, SRC, "shift.css");
    writeFileSync(file, ".btn {\n  color: #f9f9f9;\n}\n.card {\n  background: #f9f9f9;\n}\n");
    const p = proposeAt(root);
    const list = approved(p.rows, (r) => r.file.endsWith("shift.css") && r.line === 5);
    expect(list.filter((r) => r.approve === "yes").map((r) => r.literal)).toEqual(["#f9f9f9"]);
    // Three lines above push `.btn`'s color onto line 5.
    const shifted = `/* a */\n/* b */\n/* c */\n${readFileSync(file, "utf8")}`;
    writeFileSync(file, shifted);
    const result = applyTable(tableOf(root, list, p.files), root);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["stale: the file changed since propose (whole-file hash): run propose again"]);
    expect(readFileSync(file, "utf8")).toBe(shifted);
  });

  test("an identical line shifted into the row's place is not the row's line: the whole file is stale", () => {
    const root = tempRoot();
    const file = join(root, SRC, "same.css");
    writeFileSync(file, ".btn:hover {\n  background: #ffffff;\n}\n.card {\n  background: #ffffff;\n}\n");
    const p = proposeAt(root);
    // Approve `.card`'s row (line 5) only.
    const list = approved(p.rows, (r) => r.file.endsWith("same.css") && r.line === 5);
    expect(list.filter((r) => r.approve === "yes").length).toBe(1);
    // Three lines above put `.btn:hover`'s identical line on line 5: same text, same column, same line hash.
    const shifted = `/* a */\n/* b */\n/* c */\n${readFileSync(file, "utf8")}`;
    writeFileSync(file, shifted);
    expect(shifted.split("\n")[4]).toBe("  background: #ffffff;");
    const result = applyTable(tableOf(root, list, p.files), root);
    expect(result.applied).toEqual([]);
    expect(result.staleFiles.map((s) => s.file)).toEqual([`${SRC}/same.css`]);
    expect(readFileSync(file, "utf8")).toBe(shifted);
  });

  test("a table without file hashes (from an older codemod) changes nothing", () => {
    const root = tempRoot();
    const list = approved(proposeIn(root), (r) => r.literal === "#f9f9f9");
    const result = applyTable({ ...tableOf(root, list), files: undefined }, root);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["stale: the table has no hash for this file (a table from an older codemod): run propose again"]);
  });

  test("a literal at its column that runs on into a longer token is not replaced", () => {
    const root = tempRoot();
    const file = join(root, SRC, "long.css");
    writeFileSync(file, ".chip { color: #fff000; }\n.size { --n: 135px; }\n");
    const lines = readFileSync(file, "utf8").split("\n");
    const hand = (id: number, line: number, literal: string, category: string, replacement: string): Row => ({
      id, file: `${SRC}/long.css`, line, column: lines[line - 1].indexOf(literal) + 1, lineSha: lineSha(lines[line - 1]), category, kind: null,
      literal, context: { property: null, selector: null, component: null, theme: "light" }, proposed: "x", replacement, method: "role", deltaE: 0, why: "", approve: "yes",
    });
    const result = applyTable(tableOf(root, [hand(1, 1, "#fff", "hex", "var(--ds-color-text-on-solid)"), hand(2, 2, "13", "pxFontSize", "var(--ds-font-size-ui-sm)")]), root);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'stale: "#fff" at column 16 is part of a longer token',
      'stale: "13" at column 14 is part of a longer token',
    ]);
    expect(readFileSync(file, "utf8")).toBe(".chip { color: #fff000; }\n.size { --n: 135px; }\n");
  });

  test("a row without a line hash (a table from before hashes) is stale", () => {
    const root = tempRoot();
    const list = approved(proposeIn(root), (r) => r.literal === "#f9f9f9").map((r) => ({ ...r, lineSha: null }));
    const result = applyTable(tableOf(root, list), root);
    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toContain("no line hash");
  });

  test("rows naming files outside the root, by path or through a link, are refused and the files untouched", () => {
    const root = realpathSync(tempRoot());
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "codemod-outside-")));
    const victim = join(outside, "x.css");
    writeFileSync(victim, ".x {\n  background: #f9f9f9;\n}\n");
    symlinkSync(outside, join(root, "app", "linked"));
    const base = approved(proposeIn(root), (r) => r.literal === "#f9f9f9").find((r) => r.literal === "#f9f9f9")!;
    const at = (id: number, file: string): Row => ({ ...base, id, file, line: 2, column: 15, lineSha: lineSha("  background: #f9f9f9;") });
    const result = applyTable(tableOf(root, [at(1, victim), at(2, `../${basename(outside)}/x.css`), at(3, "app/linked/x.css")]), root);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((s) => s.reason.split(":")[0])).toEqual(["refused", "refused", "refused"]);
    expect(readFileSync(victim, "utf8")).toBe(".x {\n  background: #f9f9f9;\n}\n");
  });

  test("a root in the owner's tree applies only when --root names the owner's tree itself", () => {
    const owner = realpathSync(mkdtempSync(join(tmpdir(), "codemod-owner-")));
    mkdirSync(join(owner, "app"));
    expect(() => applyRoot(owner, false, owner)).toThrow("pass --root");
    expect(() => applyRoot(join(owner, "app"), true, owner)).toThrow("inside the owner's tree");
    expect(applyRoot(owner, true, owner)).toBe(owner);
    const mirror = realpathSync(mkdtempSync(join(tmpdir(), "codemod-mirror-")));
    expect(applyRoot(mirror, false, owner)).toBe(mirror);
  });
});

describe("CLI", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/codemod-literals.ts", ...args], { cwd: PKG, encoding: "utf8" });

  test("propose writes numbered Markdown and JSON tables; apply reports and exits 1 on a skipped approved row", () => {
    const root = tempRoot();
    const out = mkdtempSync(join(tmpdir(), "codemod-out-"));
    for (let i = 0; i < 2; i++) expect(cli("--app", "fixture", "--root", root, "--out-dir", out, "propose", "--paths", SRC).status).toBe(0);
    const dir = join(out, "fixture/codemod");
    expect(readdirSync(dir).sort()).toEqual(["mapping-1.json", "mapping-1.md", "mapping-2.json", "mapping-2.md"]);
    const table = JSON.parse(readFileSync(join(dir, "mapping-1.json"), "utf8")) as Table;
    expect(table.rows.every((r) => r.approve === "")).toBe(true);
    const md = readFileSync(join(dir, "mapping-1.md"), "utf8");
    expect(md).toContain("| # | file:line | literal | context | proposed | replacement | how | ΔE | why | approve |");
    expect(md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length).toBe(table.rows.length);

    for (const r of table.rows) if (r.literal === "#f9f9f9" || r.literal === "#ffffff") r.approve = "yes";
    writeFileSync(join(dir, "mapping-1.json"), JSON.stringify(table));
    const run = cli("apply", "--table", join(dir, "mapping-1.json"));
    expect(run.status).toBe(1); // the canvas row has no replacement
    expect(run.stdout).toContain("applied 1 rows in 1 files");
    expect(run.stdout).toMatch(/skipped #\d+ app\/src\/widgets\.tsx:16 "#ffffff": no replacement/);
    expect(readFileSync(join(root, SRC, "theme.css"), "utf8")).toContain("background: var(--ds-color-surface-sidebar);");

    // mapping-2 was proposed before that apply changed theme.css: its theme.css rows are stale, and apply says so.
    const second = JSON.parse(readFileSync(join(dir, "mapping-2.json"), "utf8")) as Table;
    for (const r of second.rows) if (r.literal === "#f5f3ef") r.approve = "yes";
    writeFileSync(join(dir, "mapping-2.json"), JSON.stringify(second));
    const stale = cli("apply", "--table", join(dir, "mapping-2.json"));
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("applied 0 rows in 0 files");
    expect(stale.stdout).toContain(`stale ${SRC}/theme.css: the file changed since propose (whole-file hash): run propose again (1 approved rows skipped)`);
  });

  test("propose counts the soft hits it leaves out, in the summary and the table", () => {
    const out = mkdtempSync(join(tmpdir(), "codemod-out-"));
    const run = cli("--app", "fixture", "--root", FIXTURES, "--out-dir", out, "propose", "--paths", "review/roles.css");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("left out (soft categories; --all adds them): 1 pxSpacing");
    const md = readFileSync(join(out, "fixture/codemod/mapping-1.md"), "utf8");
    expect(md).toContain("Not in this table (soft categories; `propose --all` adds them): 1 pxSpacing.");
    expect((JSON.parse(readFileSync(join(out, "fixture/codemod/mapping-1.json"), "utf8")) as Table).dropped).toEqual({ pxSpacing: 1 });
  });

  test("propose refuses an app id that climbs out of --out-dir, and an --out-dir inside a git checkout", () => {
    const base = mkdtempSync(join(tmpdir(), "codemod-out-"));
    const out = join(base, "out");
    const climb = cli("--app", "../escape", "--root", FIXTURES, "--out-dir", out, "propose", "--paths", "review/roles.css");
    expect(climb.status).toBe(2);
    expect(existsSync(join(base, "escape"))).toBe(false);
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const inRepo = cli("--app", "fixture", "--root", FIXTURES, "--out-dir", join(repo, "reports"), "propose", "--paths", "review/roles.css");
    expect(inRepo.status).toBe(2);
    expect(inRepo.stderr).toContain("inside the git checkout");
    expect(existsSync(join(repo, "reports"))).toBe(false);
    const owner = mkdtempSync(join(tmpdir(), "codemod-owner-"));
    expect(() => tableDir(join(owner, "rollout"), "fixture", owner)).toThrow("owner's tree");
  });

  test("propose targets a v3 host's Tailwind for a library, and --tailwind uno is accepted", () => {
    const out = mkdtempSync(join(tmpdir(), "codemod-out-"));
    const run = cli("--app", "prompt-kit-ui", "--root", FIXTURES, "--out-dir", out, "propose", "--paths", "review/r2/v3-host.tsx");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("classes target Tailwind v3 (stack.hostTailwind)");
    const table = JSON.parse(readFileSync(join(out, "prompt-kit-ui/codemod/mapping-1.json"), "utf8")) as Table;
    expect(table.tailwind).toBe("v3");
    const by = (literal: string) => table.rows.find((r) => r.literal === literal)!;
    expect(by("w-[60px]").replacement).toBeNull(); // w-15: v4 only
    expect(by("w-[64px]").replacement).toBe("w-16");
    expect(Object.keys(table.files ?? {})).toEqual(["review/r2/v3-host.tsx"]);
    const uno = cli("--app", "fixture", "--root", FIXTURES, "--out-dir", out, "propose", "--paths", "review/r2/v3-host.tsx", "--tailwind", "uno");
    expect(uno.status).toBe(0);
    expect(uno.stdout).toContain("classes target UnoCSS (no class rewrites) (--tailwind)");
  });

  test("the design-system commit is read with git by its absolute path, never through PATH", () => {
    const stand = join(mkdtempSync(join(tmpdir(), "codemod-git-")), "git");
    writeFileSync(stand, "#!/bin/sh\necho stand-in\n");
    chmodSync(stand, 0o755);
    const saved = SYSTEM_BIN.git;
    SYSTEM_BIN.git = stand;
    try {
      expect(designSystemCommit()).toBe("stand-in");
    } finally {
      SYSTEM_BIN.git = saved;
    }
    expect(designSystemCommit()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("an app missing from the registry needs --paths", () => {
    const run = cli("--app", "no-such-app", "--out-dir", mkdtempSync(join(tmpdir(), "codemod-out-")), "propose");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('apps.json has no app "no-such-app"');
  });
});

describe("propose: sequence-studio pilot (its index.css at d5d70a4)", () => {
  const rows = () => reviewRows("pilot/studio.css");
  const on = (list: Row[], line: number) => {
    const found = list.filter((r) => r.file === "review/pilot/studio.css" && r.line === line);
    if (found.length !== 1) throw new Error(`expected one row on studio.css:${line}, got ${found.length}`);
    return found[0];
  };

  test("shadcn-named definitions take the host contract's token before any ΔE pick", () => {
    const list = rows();
    const got = Object.fromEntries([4, 5, 6, 7, 8, 9, 11, 12, 13, 15].map((line) => [line, on(list, line).proposed]));
    expect(got).toEqual({
      4: "color.surface.page", // --background
      5: "color.text.body", // --foreground #111111: ΔE alone picked color.text.ink
      6: "color.surface.panel", // --card
      7: "color.text.ink", // --primary: ink read as a fill; ΔE alone found no role
      8: "color.surface.page", // --primary-foreground
      9: "color.fill.chip", // --secondary
      11: "color.text.muted", // --muted-foreground
      12: "color.status.danger.text", // --destructive
      13: "color.border.default", // --border: ΔE alone picked color.border.strong
      15: "color.focus-ring", // --ring
    });
    for (const line of [4, 5, 13]) {
      expect(on(list, line)).toMatchObject({ method: "role", replacement: expect.stringMatching(/^var\(--ds-color-/), why: expect.stringMatching(/^host contract: --/) });
    }
    // Flagged rows name the token but give no ready replacement: --primary (read as accent-color too),
    // --muted (hover only), --input (focus only), --ring (ΔE 25.8, far from the contract's focus ring).
    for (const line of [7, 10, 14, 15]) expect(on(list, line)).toMatchObject({ method: "role", replacement: null, why: expect.stringContaining("no ready replacement") });
  });

  test("the reason flags an app whose own readers use the name otherwise than the contract's readers do", () => {
    const list = rows();
    // --muted is read only as a hover background; the contract's chip is a resting fill.
    expect(on(list, 10).proposed).toBe("color.fill.chip");
    expect(on(list, 10).why).toContain("usage differs: the app reads --muted only as a hover background");
    expect(on(list, 10).why).toContain("color.fill.hover is the hover fill");
    // --primary is read as a border and an accent-color too, not only as a fill.
    expect(on(list, 7).why).toMatch(/usage differs: the app reads --primary as accent \(.*\) and background \(.*\) and border \(.*\)/);
    // --input only on :focus; the focus ring on :focus-visible is its own state, so --ring is not flagged.
    expect(on(list, 14).why).toContain("usage differs: the app reads --input only as a focus border");
    expect(on(list, 15).why).not.toContain("usage differs");
    // Read as the contract reads them: no flag.
    for (const line of [4, 5, 6, 11, 13]) expect(on(list, line).why).not.toContain("usage differs");
  });

  test("the root's radius and font stack definitions are rows the codemod can replace", () => {
    const list = rows();
    expect(pick(on(list, 16))).toEqual({ proposed: "radius.base", replacement: "var(--ds-radius-base)" }); // --radius: 8px
    expect(pick(on(list, 17))).toEqual({ proposed: "font.family.mono", replacement: "var(--ds-font-family-mono)" }); // --mono
    // The multi-line root font-family is counted; its value starts on the next line, so it is a hand edit.
    expect(on(list, 22)).toMatchObject({ proposed: "font.family.sans", replacement: null });
  });
});

describe("propose: the host contract keeps the codemod's ΔE guard", () => {
  test("canvas studio's pale --accent wash and its --accent-foreground: far from the contract, flagged, no ready replacement", () => {
    const list = reviewRows("pilot/canvas-accent.css");
    const at = (line: number) => list.find((r) => r.file === "review/pilot/canvas-accent.css" && r.line === line)!;
    // --accent: #e8eef8 is a wash the count badge reads at rest; the contract's accent is a solid (ΔE 40.7).
    expect(at(4)).toMatchObject({ proposed: "color.accent", replacement: null, deltaE: 40.7 });
    expect(at(4).why).toContain("visible change (ΔE 40.7): the app's color is far from the contract's; check the role");
    // --accent-foreground: #111111 is ink; the contract's on-solid is white in light (ΔE 82.2), and the app also fills with it.
    expect(at(5)).toMatchObject({ proposed: "color.text.on-solid", replacement: null });
    expect(at(5).why).toContain("visible change (ΔE 82.2)");
    expect(at(5).why).toContain("usage differs: the app reads --accent-foreground as background");
    // Close and read as the contract reads it: a ready replacement.
    expect(at(6)).toMatchObject({ proposed: "color.surface.page", replacement: "var(--ds-color-surface-page)" });
  });
});

describe("propose: review of the pilot fixes", () => {
  const rowAt = (list: Row[], file: string, line: number) => {
    const found = list.filter((r) => r.file === `review/pilot/${file}` && r.line === line);
    if (!found.length) throw new Error(`no row on ${file}:${line}`);
    return found;
  };

  test("stock shadcn on Tailwind v4 reads the names as the contract's readers do: only a hover-only reader is flagged", () => {
    const list = reviewRows("pilot/v4");
    // text-primary, fill-primary (an SVG fill is a background), bg-destructive, dark:bg-input/30: as the contract's readers.
    for (const line of [3, 4, 5]) expect(rowAt(list, "v4/theme.css", line)[0].why).not.toContain("usage differs");
    // Tailwind v4's bg-(--popover) reads the variable.
    expect(rowAt(list, "v4/theme.css", 7)[0].why).toBe("host contract: --popover is color.surface.panel (host-contract.css), ΔE 1.8 in light");
    // hover:bg-accent and group-hover/row:bg-accent: the accent is read only on hover.
    expect(rowAt(list, "v4/theme.css", 6)[0].why).toContain("usage differs: the app reads --accent only as a hover background");
  });

  test("readers a Tailwind v3 config hides give no role: the row says its usage is not checked, not that it differs", () => {
    const [accent] = rowAt(reviewRows("pilot/v3"), "v3/globals.css", 2);
    expect(accent.proposed).toBe("color.accent");
    expect(accent.why).toContain("so its usage is not checked");
    expect(accent.why).not.toContain("usage differs");
  });

  test("a scoped redefinition is not seeded, a selected state is not an interaction, and a row edits its own declaration", () => {
    const list = reviewRows("pilot/scoped.css");
    expect(rowAt(list, "scoped.css", 2)[0].why).not.toStartWith("host contract"); // .toast { --background: #323232 }
    expect(rowAt(list, "scoped.css", 1)[0].why).not.toContain("usage differs"); // .tab.active and [aria-pressed] read --muted
    // `.a { --offset: 4px; border-radius: 4px; }`: the counted radius is the declaration's, not --offset's.
    expect(rowAt(list, "scoped.css", 4).map((r) => r.column)).toEqual([".a { --offset: 4px; border-radius: 4px; }".lastIndexOf("4px") + 1]);
    expect(rowAt(list, "scoped.css", 5).map((r) => r.column)).toEqual([".ds-shell { --ds-layout-gap: 6px; border-radius: 6px; }".lastIndexOf("6px") + 1]);
    // `:root { --offset: 4px; --radius: 4px; }`: the counted definition is --radius.
    expect(rowAt(list, "scoped.css", 6).map((r) => r.column)).toEqual([":root { --offset: 4px; --radius: 4px; }".lastIndexOf("4px") + 1]);
    // A stack that goes on past its line is a hand edit: replacing this line's part would leave the rest.
    expect(pick(rowAt(list, "scoped.css", 8)[0])).toEqual({ proposed: "font.family.sans", replacement: null });
  });

  test("only the root or a theme block is seeded, never a descendant or :host; same-valued hits on a line each find their own declaration", () => {
    const list = reviewRows("pilot/scope.css");
    // :root .toast, body .card, .dark .toast, :host: scoped variables. html.dark: a theme block.
    for (const line of [1, 2, 3, 4]) expect(rowAt(list, "scope.css", line)[0].why).not.toStartWith("host contract");
    expect(rowAt(list, "scope.css", 5)[0]).toMatchObject({ proposed: "color.surface.page", why: expect.stringMatching(/^host contract: --background/) });
    // `:root{--radius:8px}.d{border-radius:8px}` and `:root{--radius-sm:8px;--radius-md:8px}`: two rows, two columns, both replaced.
    for (const [line, text] of [[6, ":root{--radius:8px}.d{border-radius:8px}"], [7, ":root{--radius-sm:8px;--radius-md:8px}"]] as const) {
      const rows = rowAt(list, "scope.css", line);
      expect(rows.map((r) => [r.column, r.replacement])).toEqual([
        [text.indexOf("8px") + 1, "var(--ds-radius-base)"],
        [text.lastIndexOf("8px") + 1, "var(--ds-radius-base)"],
      ]);
    }
  });
});
