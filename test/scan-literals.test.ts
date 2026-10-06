/**
 * scan-literals' JS lexer (scripts/scan-literals.ts): what it reads as code, strings and regexes
 * decides which literals the scan, the linter and the codemod see.
 */
import { expect, test } from "bun:test";
import { lexJs, scanText } from "../scripts/scan-literals";

test("a JSX closing tag does not start a regex: literals after it on the same line are still found", () => {
  const src = [
    "export function Note() {",
    '  return <p><b>Note</b> <span style={{ color: "#ff0000", padding: "13px" }}>x</span><>y</> <i style={{ color: "#00ff00" }} /></p>;',
    "}",
  ].join("\n");
  expect(scanText(src, "js").map((h) => h.value)).toEqual(expect.arrayContaining(["#ff0000", "13px", "#00ff00"]));
});

test("a regex after `<` is still a regex: its contents are not read as a string", () => {
  const src = 'const ok = a < /"x"/.test(b) ? "#ff0000" : "";';
  const { inStr } = lexJs(src);
  // The quotes inside the regex do not open a string; the one after `?` does.
  expect(inStr[src.indexOf('"x"') + 1]).toBe(0);
  expect(inStr[src.indexOf("#ff0000")]).toBe(1);
});

// ---------------------------------------------------------------------------
// Values the scan missed in the sequence-studio pilot (its pre-migration index.css, d5d70a4).

const hitsOf = (src: string, kind: "css" | "js" | "html" = "css") =>
  scanText(src, kind).map((h) => `${h.line} ${h.category}${h.def ? " def" : ""} ${h.value}`);

const STUDIO_ROOT = [
  ":root {",
  "  --radius: 8px;",
  '  --mono: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;',
  "  font-family:",
  "    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,",
  '    "Segoe UI", sans-serif;',
  "}",
  ".btn { border-radius: calc(var(--radius) - 2px); }",
  ".card { border-radius: calc(var(--radius) + 2px); }",
].join("\n");

test("the studio's root counts: a font-family over several lines, a font stack and a radius in definitions, radii in calc(var())", () => {
  expect(hitsOf(STUDIO_ROOT)).toEqual([
    "2 radius def 8px",
    "3 fontFamily def sfmono-regular",
    "4 fontFamily inter",
    "8 radius calc(var(--radius) - 2px)",
    "9 radius calc(var(--radius) + 2px)",
  ]);
});

test("a multi-line font-family counts in CSS strings and style objects in JS too", () => {
  const src = ["const css = `", ".a {", "  font-family:", '    "IBM Plex Sans", sans-serif;', "}`;", "const style = {", "  fontFamily:", "    '\"Inter\", sans-serif',", "};"].join("\n");
  expect(hitsOf(src, "js")).toEqual(["3 fontFamily ibm plex sans", "7 fontFamily inter"]);
});

test("a definition counts by how the file reads it, then by its name; lengths keep their hard and soft categories", () => {
  const src = [
    ":root {",
    "  --corner: 6px;",
    "  --font-size-sm: 12px;",
    "  --text-lg: 1.125rem;",
    "  --blog-heading-size: 24px;",
    "  --content-pad-x: 14px;",
    "  --brand: Inter;",
    "}",
    ".a { border-radius: var(--corner); font-family: var(--brand); padding: 0 var(--content-pad-x); }",
  ].join("\n");
  expect(hitsOf(src)).toEqual([
    "2 radius def 6px",
    "3 pxFontSize def 12px",
    "4 otherFontSize def 1.125rem",
    "5 pxFontSize def 24px",
    "6 pxSpacing def 14px",
    "7 fontFamily def inter",
  ]);
});

test("definitions that are not a font stack or a counted length stay out", () => {
  const src = [
    ":root {",
    "  --transition-props: opacity, transform;",
    "  --font-mono: var(--ds-font-family-mono);",
    "  --tr-mono: var(--docs-font-code, ui-monospace, monospace);",
    "  --font-weight-bold: 700;",
    "  --font-display: swap;",
    "  --workspace-height: calc(100vh - 32px);",
    "  --sidebar-width: 240px;",
    "  --radius-reset: 0;",
    "}",
    // A var() fallback is already behind a token, so its length does not count.
    ".a { border-radius: var(--r, 8px); font-size: var(--fs, 13px); }",
    // calc() without a literal length is a token expression.
    ".b { border-radius: calc(var(--radius) * 2); }",
  ].join("\n");
  expect(hitsOf(src)).toEqual([]);
});

test("shell-scoped --ds-layout-* overrides are not literals (decision 32), in a stylesheet or a style attribute", () => {
  const css = ".ds-shell { --ds-layout-sidebar-width: 280px; --ds-layout-content-padding-x: 24px; }";
  expect(hitsOf(css)).toEqual([]);
  expect(hitsOf('<div class="ds-shell" style="--ds-layout-content-padding-x: 24px"></div>', "html")).toEqual([]);
});

test("a definition in a style attribute ends at the attribute's quote", () => {
  expect(hitsOf('<div style="--radius: 8px">x</div>\n<p class="a">y</p>', "html")).toEqual(["1 radius def 8px"]);
});
