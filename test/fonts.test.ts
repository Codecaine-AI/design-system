/**
 * css/fonts.css: the package ships the Inter and IBM Plex Mono faces itself, and they are the exact
 * faces @codecaine-ai/text-measure measures with, so text laid out in a browser matches canvas measurement.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PKG, parseCss, readJson, workspaceRoot } from "./support.ts";

interface Face {
  family: string;
  weight: string;
  style: string;
  display: string;
  /** Absolute path of the woff2 file the src url() points at. */
  file: string;
}

function faces(cssPath: string): Face[] {
  return parseCss(readFileSync(cssPath, "utf8"))
    .filter((b) => b.prelude === "@font-face")
    .map(({ declarations }) => {
      const d = Object.fromEntries(declarations);
      const url = /^url\("([^"]+)"\) format\("woff2"\)$/.exec(d.src ?? "");
      if (!url) throw new Error(`${cssPath}: unexpected src ${d.src}`);
      return { family: d["font-family"], weight: d["font-weight"], style: d["font-style"], display: d["font-display"], file: resolve(dirname(cssPath), url[1]) };
    });
}

const own = faces(join(PKG, "css/fonts.css"));
const root = workspaceRoot();
const textMeasure = root ? join(root, "codecaine/core/canvas/packages/text-measure") : null;

describe("css/fonts.css", () => {
  test("declares Inter 400-700 and IBM Plex Mono 400-600, each from a woff2 file inside the package", () => {
    expect(own.map((f) => `${f.family} ${f.weight}`)).toEqual([
      '"Inter" 400', '"Inter" 500', '"Inter" 600', '"Inter" 700',
      '"IBM Plex Mono" 400', '"IBM Plex Mono" 500', '"IBM Plex Mono" 600',
    ]);
    // Inside the package, so `npm pack` carries them and a strict CSP app serves them from its own origin.
    expect(own.filter((f) => !f.file.startsWith(join(PKG, "fonts/")) || !existsSync(f.file)).map((f) => f.file)).toEqual([]);
  });

  test("the families are the ones the font tokens name first", () => {
    const base = readJson("dist/json/base.json");
    const unquote = (name: string) => name.trim().replace(/^(["'])(.*)\1$/, "$2");
    const first = (stack: string) => unquote(stack.split(",")[0]);
    expect([...new Set(own.map((f) => unquote(f.family)))]).toEqual([first(base["font.family.sans"]), first(base["font.family.mono"])]);
  });

  test.skipIf(!textMeasure || !existsSync(join(textMeasure, "fonts.css")))(
    "matches @codecaine-ai/text-measure: the same faces, and byte-identical font files (skips without the workspace checkout)",
    () => {
      const theirs = faces(join(textMeasure!, "fonts.css"));
      const shape = (list: Face[]) => list.map(({ file, ...rest }) => ({ ...rest, file: file.split("/").pop() }));
      expect(shape(own)).toEqual(shape(theirs));
      const differ = own.filter((f, i) => !readFileSync(f.file).equals(readFileSync(theirs[i].file))).map((f) => f.file);
      expect(differ).toEqual([]);
    },
  );
});
