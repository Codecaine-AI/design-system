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
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTable } from "../scripts/lib/codemod/apply.ts";
import { DEFAULT_CATEGORIES, propose } from "../scripts/lib/codemod/propose.ts";
import { summarize, type Row, type Table } from "../scripts/lib/codemod/table.ts";
import { loadTokens } from "../scripts/lib/codemod/tokens.ts";
import { PKG } from "./support.ts";

const FIXTURES = join(PKG, "test/fixtures/codemod");
const SRC = "app/src";

function proposeIn(root: string): Row[] {
  return propose(loadTokens(), { root, paths: [SRC], exclude: [] }, { appId: "fixture", defaultTheme: "light", categories: new Set(DEFAULT_CATEGORIES) });
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
    ["theme.css", 6, "#aeb8c6", "color.focus-ring", "var(--ds-color-focus-ring)"], // --ring
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
    ["theme.css", 45, "rgb(174 184 198 / 35%)", "color.focus-ring", "var(--ds-color-focus-ring)"], // 0 0 0 2px ring under :focus-visible
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
    expect(r.why).toMatch(/closest token overall: color\.violet\.\w+ \(ΔE \d+(\.\d)?\)/);
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

  test("a row whose line moved still applies when the literal is unique on it, and an edited replacement wins", () => {
    const root = tempRoot();
    const list = approved(proposeIn(root), (r) => r.literal === "#f9f9f9");
    list.find((r) => r.literal === "#f9f9f9")!.replacement = "var(--ds-color-surface-panel)";
    const theme = join(root, SRC, "theme.css");
    writeFileSync(theme, readFileSync(theme, "utf8").replace("  background: #f9f9f9;", "    background:   #f9f9f9;"));
    const result = applyTable(tableOf(root, list), root);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(theme, "utf8")).toContain("    background:   var(--ds-color-surface-panel);");
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

  test("an app missing from the registry needs --paths", () => {
    const run = cli("--app", "no-such-app", "--out-dir", mkdtempSync(join(tmpdir(), "codemod-out-")), "propose");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('apps.json has no app "no-such-app"');
  });
});
