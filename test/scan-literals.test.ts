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
