/**
 * verify:apps font assertions without a browser: the regular face (400, normal) of each family must be
 * loaded from the url() of the @font-face rule that wins, and that file must be the design-system
 * package's own font (or a byte copy where the app copies or bundles it). A fetched 700 face next to a
 * local() 400 face, the same font from another package, or a lookalike copy all fail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import type { ResponseLog } from "../scripts/lib/verify/assertions.ts";
import { fontSourceJudge } from "../scripts/lib/verify/font-source.ts";
import { fontAssertions, type FontReading, type FontSourceJudge, weightCovers } from "../scripts/lib/verify/fonts.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-fonts-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FONTS = join(DESIGN_SYSTEM_ROOT, "fonts");
const PKG_400 = "http://127.0.0.1:47000/@fs/pkg/Inter-Regular.woff2";
const PKG_700 = "http://127.0.0.1:47000/@fs/pkg/Inter-Bold.woff2";
const OTHER_400 = "http://127.0.0.1:47000/@fs/text-measure/Inter-Regular.woff2";

const ok = (urls: string[]): ResponseLog => new Map(urls.map((url) => [url, { status: 200, type: "font" }]));
/** Every url under /@fs/pkg/ is the package's; anything else is not. */
const judge: FontSourceJudge = (url) => (url.includes("/@fs/pkg/") ? { ok: true, how: "the package's fonts/" } : { ok: false, how: "not from the design-system package's fonts/", path: url });

function reading(rules: FontReading["rules"], faces: FontReading["faces"]): FontReading {
  return { family: "Inter", faces, rules, unreadableSheets: 0 };
}
const rule = (weight: string, urls: string[], local = false) => ({ weight, style: "normal", src: "", urls, local });
const face = (weight: string, status = "loaded") => ({ weight, style: "normal", status });
const verdict = (r: FontReading, responses: ResponseLog) => {
  const [a] = fontAssertions([r], responses, judge);
  return [a!.status, a!.message];
};

describe("fontAssertions", () => {
  test("the regular face loaded from the package's url() passes", () => {
    expect(verdict(reading([rule("400", [PKG_400]), rule("700", [PKG_700])], [face("400"), face("700")]), ok([PKG_400]))).toEqual([
      "pass",
      `regular face loaded from ${PKG_400} (the package's fonts/)`,
    ]);
  });

  test("a local() regular face does not pass because a 700 face was fetched", () => {
    const r = reading([rule("400", [], true), rule("700", [PKG_700])], [face("400"), face("700")]);
    expect(verdict(r, ok([PKG_700]))).toEqual(["fail", expect.stringMatching(/regular face's @font-face lists only local\(\) sources/)]);
  });

  test("of two rules for the regular face the last one wins: the same font from another package fails", () => {
    const r = reading([rule("400", [PKG_400]), rule("400", [OTHER_400])], [face("400"), face("400")]);
    expect(verdict(r, ok([PKG_400, OTHER_400]))).toEqual(["fail", `the regular face loads from ${OTHER_400}: not from the design-system package's fonts/`]);
  });

  test("a family with only a bold face, or a regular face that never loaded, fails", () => {
    expect(verdict(reading([rule("700", [PKG_700])], [face("700")]), ok([PKG_700]))).toEqual(["fail", expect.stringMatching(/no regular face \(400, normal\)/)]);
    expect(verdict(reading([rule("400", [PKG_400])], [face("400", "error")]), ok([]))).toEqual(["fail", expect.stringMatching(/declared but not loaded/)]);
    // Loaded, but the url() was never fetched: a local() source listed first won.
    expect(verdict(reading([rule("400", [PKG_400], true)], [face("400")]), ok([]))).toEqual(["fail", expect.stringMatching(/none of its url\(\)s was fetched/)]);
  });

  test.each([
    ["400", true],
    ["normal", true],
    ["", true],
    ["100 900", true],
    ["500 700", false],
    ["bold", false],
  ])("font-weight %p covers 400: %p", (descriptor, covers) => {
    expect(weightCovers(descriptor)).toBe(covers);
  });
});

describe("fontSourceJudge", () => {
  const pkg = join(scratch, "pkg");
  const otherPkg = join(scratch, "text-measure");
  const bundle = join(scratch, "run-tmp");
  for (const dir of [join(pkg, "fonts"), join(otherPkg, "fonts"), bundle]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(FONTS, "Inter-Regular.woff2"), join(pkg, "fonts/Inter-Regular.woff2"));
  copyFileSync(join(FONTS, "Inter-Regular.woff2"), join(otherPkg, "fonts/Inter-Regular.woff2"));
  copyFileSync(join(FONTS, "Inter-Regular.woff2"), join(bundle, "Inter-Regular-3f2a.woff2"));
  writeFileSync(join(bundle, "Inter-Lookalike-9c1d.woff2"), "not a package font");
  const fromDisk = fontSourceJudge({
    packageDirs: [pkg],
    buildFontsDir: FONTS,
    copyDirs: [bundle],
    diskPath: (url) => (url.startsWith("http://x/") ? join(scratch, new URL(url).pathname) : null),
  });

  test("a file in the resolved package's fonts/ passes; the identical file in another package does not", () => {
    expect(fromDisk("http://x/pkg/fonts/Inter-Regular.woff2")).toMatchObject({ ok: true, how: expect.stringContaining("the package's fonts/") });
    expect(fromDisk("http://x/text-measure/fonts/Inter-Regular.woff2")).toMatchObject({ ok: false, how: expect.stringContaining("not from the design-system package's fonts/") });
  });

  test("a byte copy of a package font counts where the run bundles fonts; a lookalike does not", () => {
    expect(fromDisk("http://x/run-tmp/Inter-Regular-3f2a.woff2")).toMatchObject({ ok: true, how: "a copy of the package's fonts/Inter-Regular.woff2" });
    expect(fromDisk("http://x/run-tmp/Inter-Lookalike-9c1d.woff2")).toMatchObject({ ok: false });
    expect(fromDisk("http://x/run-tmp/missing.woff2")).toMatchObject({ ok: false, how: expect.stringContaining("does not exist") });
    expect(fromDisk("http://elsewhere/font.woff2")).toEqual({ ok: false, how: "the URL maps to no file on disk" });
  });

  test("an inlined data: font passes only when it is a package font", () => {
    const data = readFileSync(join(FONTS, "Inter-Regular.woff2")).toString("base64");
    expect(fromDisk(`data:font/woff2;base64,${data}`)).toEqual({ ok: true, how: "an inlined copy of the package's fonts/Inter-Regular.woff2" });
    expect(fromDisk(`data:font/woff2;base64,${Buffer.from("other").toString("base64")}`)).toMatchObject({ ok: false });
  });
});
