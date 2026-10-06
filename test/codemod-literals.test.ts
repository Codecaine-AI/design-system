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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { applyTable } from "../scripts/lib/codemod/apply.ts";
import { tokenAllowed } from "../scripts/lib/codemod/color-role.ts";
import { applyRoot, tableDir } from "../scripts/lib/codemod/paths.ts";
import { DEFAULT_CATEGORIES, propose } from "../scripts/lib/codemod/propose.ts";
import { lineSha, summarize, type Row, type Table } from "../scripts/lib/codemod/table.ts";
import { loadTokens } from "../scripts/lib/codemod/tokens.ts";
import { PKG } from "./support.ts";

const FIXTURES = join(PKG, "test/fixtures/codemod");
const SRC = "app/src";

function proposeIn(root: string): Row[] {
  return propose(loadTokens(), { root, paths: [SRC], exclude: [] }, { appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES) }).rows;
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

const tableOf = (root: string, list: Row[]): Table => ({
  tool: "codemod-literals",
  version: 1,
  app: "fixture",
  root,
  createdAt: "2026-10-05T00:00:00.000Z",
  designSystem: { root: PKG, commit: null },
  scan: { paths: [SRC], exclude: [], categories: DEFAULT_CATEGORIES },
  summary: summarize(list),
  rows: list,
});

describe("propose: role first", () => {
  test.each([
    // [file, line, literal, proposed token, replacement]
    ["theme.css", 3, "#f5f3ef", "color.surface.page", "var(--ds-color-surface-page)"], // --background: a definition becomes an alias
    ["theme.css", 4, "#62666d", "color.text.muted", "var(--ds-color-text-muted)"], // --muted-foreground
    ["theme.css", 7, "#e03e3e", "color.status.danger.solid", "var(--ds-color-status-danger-solid)"], // --destructive
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
    ["widgets.tsx", 7, '"white"', "color.text.on-solid", '"var(--ds-color-text-on-solid)"'],
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
    expect(row("widgets.tsx", 12, '"#0078df"')).toMatchObject({ proposed: "color.accent", method: "nearest", deltaE: 0 });
  });

  test("rows it cannot map say why, and rows that map but must not change get no replacement", () => {
    const unmapped: Array<[string, number, string, string]> = [
      ["theme.css", 8, "hsl(222 47% 11%)", "not found on the line as written"], // shadcn channel triplet
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
    expect(row("widgets.tsx", 19, '"white"')).toMatchObject({ proposed: "color.text.on-solid", replacement: null });
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
    const [a, b] = [row("widgets.tsx", 6, "text-white", 0), row("widgets.tsx", 6, "text-white", 1)];
    expect([a.replacement, b.replacement]).toEqual(["text-on-solid", "text-on-solid"]);
    expect(a.column).toBeLessThan(b.column!);
  });
});

/** Rows for the review fixtures (test/fixtures/codemod/review): light default, or dark-first, or a v3 app. */
function reviewRows(path: string, opts: { theme?: "light" | "dark"; tailwind?: "v3" | "v4" } = {}): Row[] {
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
    // --ring is named for the focus ring, but #aeb8c6 is ΔE 25.8 from it: the border family takes it.
    const ring = row("theme.css", 6, "#aeb8c6");
    expect(ring.proposed).toBe("color.border.guide");
    expect(ring.why).toContain("focus ring: color.focus-ring ΔE 25.8");
    expect(row("theme.css", 45, "rgb(174 184 198 / 35%)").proposed).toBe("color.border.default");
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
    const list = propose(loadTokens(), { root, paths: ["review/attrs.tsx", "review/plain-attrs.tsx"], exclude: [] }, {
      appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES),
    }).rows.map((r) => ({ ...r, approve: r.replacement === null ? "" : "yes" }));
    expect(at(list, "attrs.tsx", 6, '"#e6e5e3"').replacement).toBe('{dsVar("color.border.default")}');
    expect(at(list, "attrs.tsx", 9, '"#ebebe9"').replacement).toBe('dsVar("color.fill.chip")');
    expect(at(list, "plain-attrs.tsx", 2, '"#e6e5e3"').replacement).toBe('"var(--ds-color-border-default)"');
    const result = applyTable(tableOf(root, list), realpathSync(root));
    expect(result.skipped).toEqual([]);
    for (const file of ["attrs.tsx", "plain-attrs.tsx"]) {
      const out = join(root, "out", file);
      const build = spawnSync(process.execPath, ["build", join(root, "review", file), "--outfile", out, "--packages", "external"], { encoding: "utf8" });
      expect({ file, status: build.status, stderr: build.stderr }).toEqual({ file, status: 0, stderr: "" });
    }
  });
});

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

  test("changes only approved rows, skips stale and replacement-less rows, and dry-run writes nothing", () => {
    const root = tempRoot();
    const fresh = proposeIn(root);
    const wanted = new Set(["#f5f3ef", "text-white", "w-[320px]", "13", "#c62121", "#ffffff"]);
    const list = approved(fresh, (r) => wanted.has(r.literal));
    // Line 20 (.error-text) changes after propose: its row is stale.
    const theme = join(root, SRC, "theme.css");
    const before = readFileSync(theme, "utf8").split("\n");
    before[19] = "  color: #c00000;";
    writeFileSync(theme, before.join("\n"));
    const widgets = join(root, SRC, "widgets.tsx");
    const original = readFileSync(widgets, "utf8");

    const dry = applyTable(tableOf(root, list), root, { dryRun: true });
    expect(readFileSync(widgets, "utf8")).toBe(original);

    const result = applyTable(tableOf(root, list), root);
    expect(result.applied.length).toBe(dry.applied.length);
    expect(result.unapproved).toBe(list.length - list.filter((r) => r.approve === "yes").length);
    const themeLines = readFileSync(theme, "utf8").split("\n");
    const widgetLines = readFileSync(widgets, "utf8").split("\n");
    expect(themeLines[2]).toBe("  --background: var(--ds-color-surface-page);");
    expect(themeLines[3]).toBe("  --muted-foreground: #62666d;"); // not approved
    expect(themeLines[19]).toBe("  color: #c00000;"); // stale: left alone
    expect(widgetLines[3]).toContain('className="w-80 text-[11px]');
    expect(widgetLines[5]).toContain("text-on-solid text-on-solid"); // both occurrences on one line
    expect(widgetLines[6]).toContain('fontSize: "var(--ds-font-size-ui-sm)"');
    expect(widgetLines[15]).toBe('  ctx.fillStyle = "#ffffff";'); // canvas row has no replacement
    expect(result.skipped.map((s) => [s.row.literal, s.reason.split(":")[0]])).toEqual([
      ["#c62121", "stale"],
      ["#ffffff", "no replacement"],
    ]);
  });

  test("an edited replacement wins; a row whose line changed at all is stale, never searched for", () => {
    const root = tempRoot();
    const list = approved(proposeIn(root), (r) => r.literal === "#f9f9f9" || r.literal === "#f8f8f7");
    list.find((r) => r.literal === "#f9f9f9")!.replacement = "var(--ds-color-surface-panel)";
    const theme = join(root, SRC, "theme.css");
    // Line 41 keeps its literal at a new column: the old codemod found it "once anywhere on the line".
    writeFileSync(theme, readFileSync(theme, "utf8").replace("  background: var(--card-bg, #f8f8f7);", "    background:   var(--card-bg, #f8f8f7);"));
    const result = applyTable(tableOf(root, list), root);
    expect(result.applied.map((r) => r.literal)).toEqual(["#f9f9f9"]);
    expect(result.skipped.map((s) => [s.row.literal, s.reason])).toEqual([["#f8f8f7", "stale: line 41 changed since propose"]]);
    const text = readFileSync(theme, "utf8");
    expect(text.split("\n")[15]).toBe("  background: var(--ds-color-surface-panel);");
    expect(text).toContain("    background:   var(--card-bg, #f8f8f7);");
  });

  test("lines shifted down by an edit above: the row is stale, and the line that moved into its place is untouched", () => {
    const root = tempRoot();
    const file = join(root, SRC, "shift.css");
    writeFileSync(file, ".btn {\n  color: #f9f9f9;\n}\n.card {\n  background: #f9f9f9;\n}\n");
    const list = approved(proposeIn(root), (r) => r.file.endsWith("shift.css") && r.line === 5);
    expect(list.filter((r) => r.approve === "yes").map((r) => r.literal)).toEqual(["#f9f9f9"]);
    // Three lines above push `.btn`'s color onto line 5.
    const shifted = `/* a */\n/* b */\n/* c */\n${readFileSync(file, "utf8")}`;
    writeFileSync(file, shifted);
    const result = applyTable(tableOf(root, list), root);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["stale: line 5 changed since propose"]);
    expect(readFileSync(file, "utf8")).toBe(shifted);
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

  test("an app missing from the registry needs --paths", () => {
    const run = cli("--app", "no-such-app", "--out-dir", mkdtempSync(join(tmpdir(), "codemod-out-")), "propose");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('apps.json has no app "no-such-app"');
  });
});
