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

test("a font-family value goes on past its line only while it is a list (ends with a comma): indented Sass ends at the line", () => {
  const sass = [".a", "  font-family: Georgia", "  border-radius: var(--radius)", ".b", "  font-family: Menlo, monospace"].join("\n");
  expect(hitsOf(sass, "css")).toEqual(["2 fontFamily georgia", "5 fontFamily menlo"]);
  // In markup only the CSS property name reads over lines: `fontFamily:` in a Vue script is code.
  expect(hitsOf('<script>\nconst s = { fontFamily:\n  props.font }\n</script>\n<style>\n.a {\n  font-family:\n    "Inter", sans-serif;\n}\n</style>', "html")).toEqual(["7 fontFamily inter"]);
});

test("definitions end at their style attribute, a Tailwind arbitrary property or a selector is none, and a <style> stack runs over lines", () => {
  const html = ['<div style="--radius: 4px"></div>', '<div style="--radius: 10px"></div>', '<p style="--gap: 8px">x</p>', '<i class="p-4 [--radius:8px] mt-2"></i>'].join("\n");
  expect(hitsOf(html, "html")).toEqual(["1 radius def 4px", "2 radius def 10px", "3 pxSpacing def 8px"]);
  expect(hitsOf('[style*="--radius: 8px"] { color: inherit; }')).toEqual([]);
  expect(hitsOf('<template><b /></template>\n<style>\n:root {\n  --font-sans:\n    "Inter",\n    sans-serif;\n}\n</style>', "html")).toEqual(["4 fontFamily def inter"]);
});

test("a definition read only as a color or a shadow, a Tailwind sub-property, a zero and a font-display value are not counted", () => {
  const src = [
    ":root {",
    "  --buttons-shadow-blur-radius: 5px;",
    "  --glow-radius: 6px;",
    '  --font-sans--font-feature-settings: "cv11", "ss01";',
    "  --text-sm--line-height: 1.25rem;",
    "  --card-corner-radius: 0.0rem;",
    "  --font-display: swap;",
    "  --font-heading: Fraunces;",
    "}",
    ".a { box-shadow: 0 0 var(--buttons-shadow-blur-radius) black; font-size: calc(14px + 0.3vw); }",
  ].join("\n");
  expect(hitsOf(src).filter((h) => !h.includes("namedColor"))).toEqual(["8 fontFamily def fraunces", "10 pxFontSize 14px"]);
});
