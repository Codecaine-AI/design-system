/**
 * verify:apps font assertions without a browser. The regular face (400, normal) must be one the page
 * loaded itself, judged on the statuses read before the check forced anything: Inter is never forced;
 * IBM Plex Mono is force-loaded only when the route does not render it, and then passes as "available,
 * not rendered" when the face comes from the package. The winning @font-face rule's url() must be the
 * design-system package's font, or a byte copy declared in the package's fonts.css (decision 20).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESIGN_SYSTEM_ROOT } from "../scripts/lib/registry.ts";
import type { ResponseLog } from "../scripts/lib/verify/assertions.ts";
import { fontSourceJudge } from "../scripts/lib/verify/font-source.ts";
import { type FaceStatus, fontAssertions, type FontReading, type FontSourceJudge, weightCovers } from "../scripts/lib/verify/fonts.ts";
import { MIRROR } from "./verify-support.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-verify-fonts-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FONTS = join(DESIGN_SYSTEM_ROOT, "fonts");
const FONTS_CSS = join(DESIGN_SYSTEM_ROOT, "css/fonts.css");
const TEXT_MEASURE_CSS = join(MIRROR, "codecaine/core/canvas/packages/text-measure/fonts.css");

const PKG_400 = "http://127.0.0.1:47000/@fs/pkg/Inter-Regular.woff2";
const PKG_700 = "http://127.0.0.1:47000/@fs/pkg/Inter-Bold.woff2";
const OTHER_400 = "http://127.0.0.1:47000/@fs/text-measure/Inter-Regular.woff2";
const COPY_400 = "http://127.0.0.1:47000/assets/Inter-Regular-3f2a.woff2";
const PKG_CSS = "http://127.0.0.1:47000/vendor/design-system/fonts.css";
const OTHER_CSS = "http://127.0.0.1:47000/vendor/text-measure/fonts.css";

const ok = (urls: string[]): ResponseLog => new Map(urls.map((url) => [url, { status: 200, type: "font" }]));
/** The package's fonts/ count from any sheet; a copy under /assets/ counts only from the package's fonts.css. */
const judge: FontSourceJudge = (url, sheet) =>
  url.includes("/@fs/pkg/") || (url.includes("/assets/") && sheet === PKG_CSS) ? { ok: true, how: "the package's" } : { ok: false, how: "not the package's", path: url };

const face = (weight: string, status = "loaded"): FaceStatus => ({ weight, style: "normal", status });
const rule = (weight: string, urls: string[], opts: { local?: boolean; sheet?: string | null } = {}) => ({
  weight,
  style: "normal",
  src: "",
  urls,
  local: opts.local ?? false,
  sheet: opts.sheet ?? null,
});
/** A reading where the check forced nothing: the faces after are the faces before. */
function reading(rules: FontReading["rules"], before: FaceStatus[], over: Partial<FontReading> = {}): FontReading {
  return { family: "Inter", before, after: before, forced: null, probedBy: [], rules, unreadableSheets: 0, ...over };
}
const verdict = (r: FontReading, responses: ResponseLog) => {
  const [a] = fontAssertions([r], responses, judge);
  return [a!.status, a!.message];
};

describe("fontAssertions", () => {
  test("Inter passes on a regular face the page loaded itself; one that loaded only after a forced load fails", () => {
    const rules = [rule("400", [PKG_400]), rule("700", [PKG_700])];
    expect(verdict(reading(rules, [face("400"), face("700", "unloaded")]), ok([PKG_400]))).toEqual(["pass", `regular face loaded from ${PKG_400} (the package's)`]);
    // No text on the route uses Inter: only a forced load would load it, and the statuses before decide.
    const forcedOnly = reading(rules, [face("400", "unloaded"), face("700", "unloaded")], { after: [face("400"), face("700", "unloaded")] });
    expect(verdict(forcedOnly, ok([PKG_400]))).toEqual(["fail", expect.stringMatching(/^regular face of Inter: none loaded by the page before the check \(400 normal unloaded\); the check never forces Inter/)]);
  });

  test("IBM Plex Mono not rendered on the route: the forced regular face passes as available, not rendered, only from the package", () => {
    const mono = (url: string) =>
      reading([rule("400", [url])], [face("400", "unloaded"), face("500", "unloaded")], {
        family: "IBM Plex Mono",
        after: [face("400"), face("500", "unloaded")],
        forced: '400 16px "IBM Plex Mono"',
      });
    expect(verdict(mono(PKG_400), ok([PKG_400]))).toEqual(["pass", `available, not rendered on this route: regular face loaded from ${PKG_400} (the package's)`]);
    expect(verdict(mono(OTHER_400), ok([OTHER_400]))).toEqual(["fail", `the regular face loads from ${OTHER_400}: not the package's`]);
    const neverLoaded = { ...mono(PKG_400), after: [face("400", "error")] };
    expect(verdict(neverLoaded, ok([]))).toEqual(["fail", expect.stringMatching(/not rendered on this route, and its regular face did not load when the check forced 400 16px "IBM Plex Mono" \(400 normal error\)/)]);
  });

  test("IBM Plex Mono rendered on the route without a loaded regular face fails, whatever a later load shows", () => {
    const rules = [rule("400", [PKG_400])];
    // A 500 face in use: the route renders Mono, its regular face was never loaded.
    const medium = reading(rules, [face("400", "unloaded"), face("500")], { family: "IBM Plex Mono", after: [face("400"), face("500")] });
    expect(verdict(medium, ok([PKG_400]))).toEqual(["fail", expect.stringMatching(/^regular face of IBM Plex Mono: none loaded by the page before the check \(400 normal unloaded\); IBM Plex Mono renders on this route \(faces 500 normal loaded\)/)]);
    // A text probe's font-family computes to Mono: rendered, even with every face unloaded.
    const probed = reading(rules, [face("400", "unloaded")], { family: "IBM Plex Mono", probedBy: ["pre.code"], after: [face("400")] });
    expect(verdict(probed, ok([PKG_400]))).toEqual(["fail", expect.stringMatching(/IBM Plex Mono renders on this route \(font-family of pre\.code\)/)]);
  });

  test("a local() regular face does not pass because a 700 face was fetched", () => {
    const r = reading([rule("400", [], { local: true }), rule("700", [PKG_700])], [face("400"), face("700")]);
    expect(verdict(r, ok([PKG_700]))).toEqual(["fail", expect.stringMatching(/regular face's @font-face lists only local\(\) sources/)]);
  });

  test("of two rules for the regular face the last one wins, and the judge sees that rule's stylesheet", () => {
    const pkgThenOther = reading([rule("400", [PKG_400]), rule("400", [OTHER_400])], [face("400"), face("400")]);
    expect(verdict(pkgThenOther, ok([PKG_400, OTHER_400]))).toEqual(["fail", `the regular face loads from ${OTHER_400}: not the package's`]);
    // The same copied file, declared first by the package's fonts.css and last by another package's.
    const copies = (last: string) => reading([rule("400", [COPY_400], { sheet: last === PKG_CSS ? OTHER_CSS : PKG_CSS }), rule("400", [COPY_400], { sheet: last })], [face("400"), face("400")]);
    expect(verdict(copies(OTHER_CSS), ok([COPY_400]))[0]).toBe("fail");
    expect(verdict(copies(PKG_CSS), ok([COPY_400]))[0]).toBe("pass");
  });

  test("a family with only a bold face, or a regular face that never loaded, fails", () => {
    expect(verdict(reading([rule("700", [PKG_700])], [face("700")]), ok([PKG_700]))).toEqual(["fail", expect.stringMatching(/no regular face \(400, normal\)/)]);
    expect(verdict(reading([rule("400", [PKG_400])], [face("400", "error")]), ok([]))).toEqual(["fail", expect.stringMatching(/none loaded by the page/)]);
    // Loaded, but the url() was never fetched: a local() source listed first won.
    expect(verdict(reading([rule("400", [PKG_400], { local: true })], [face("400")]), ok([]))).toEqual(["fail", expect.stringMatching(/none of its url\(\)s was fetched/)]);
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
  for (const dir of [join(pkg, "fonts"), join(pkg, "css"), join(otherPkg, "fonts"), bundle]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(FONTS, "Inter-Regular.woff2"), join(pkg, "fonts/Inter-Regular.woff2"));
  copyFileSync(join(FONTS, "Inter-Regular.woff2"), join(otherPkg, "fonts/Inter-Regular.woff2"));
  copyFileSync(join(FONTS, "Inter-Regular.woff2"), join(bundle, "Inter-Regular-3f2a.woff2"));
  writeFileSync(join(bundle, "Inter-Lookalike-9c1d.woff2"), "not a package font");
  // The resolved package's own fonts.css (an older release: its bytes differ from the build's).
  writeFileSync(join(pkg, "css/fonts.css"), `${readFileSync(FONTS_CSS, "utf8")}\n/* 0.0.1 */\n`);
  // Copies in the run's temp dir, as the sequence-renderer fixture makes them: the build's fonts.css and text-measure's.
  copyFileSync(FONTS_CSS, join(bundle, "design-system-fonts.css"));
  if (existsSync(TEXT_MEASURE_CSS)) copyFileSync(TEXT_MEASURE_CSS, join(bundle, "text-measure-fonts.css"));
  else writeFileSync(join(bundle, "text-measure-fonts.css"), readFileSync(FONTS_CSS, "utf8").replace("@codecaine-ai/design-system", "@codecaine-ai/text-measure"));
  const fromDisk = fontSourceJudge({
    packageDirs: [pkg],
    buildFontsDir: FONTS,
    buildFontsCss: FONTS_CSS,
    copyDirs: [bundle],
    diskPath: (url) => (url.startsWith("http://x/") ? join(scratch, new URL(url).pathname) : null),
  });
  const COPY = "http://x/run-tmp/Inter-Regular-3f2a.woff2";
  const DECISION_20 = "the winning @font-face rule is not in the design-system package's fonts.css (decision 20)";

  test("a file in the resolved package's fonts/ passes from any stylesheet, inline included; the identical file in another package does not", () => {
    expect(fromDisk("http://x/pkg/fonts/Inter-Regular.woff2", null)).toMatchObject({ ok: true, how: expect.stringContaining("the package's fonts/") });
    expect(fromDisk("http://x/text-measure/fonts/Inter-Regular.woff2", "http://x/text-measure/fonts.css")).toMatchObject({ ok: false, how: expect.stringContaining("not from the design-system package's fonts/") });
  });

  test("a byte copy under the run's temp dir passes only when the winning rule sits in the package's fonts.css", () => {
    expect(fromDisk(COPY, "http://x/run-tmp/text-measure-fonts.css")).toEqual({ ok: false, how: `${DECISION_20}: it is in ${join(bundle, "text-measure-fonts.css")}`, path: join(bundle, "Inter-Regular-3f2a.woff2") });
    expect(fromDisk(COPY, null)).toMatchObject({ ok: false, how: `${DECISION_20}: it is in an inline <style> or a constructed stylesheet` });
    expect(fromDisk(COPY, "http://elsewhere/fonts.css")).toMatchObject({ ok: false, how: expect.stringContaining(`${DECISION_20}: its stylesheet http://elsewhere/fonts.css maps to no file on disk`) });
    expect(fromDisk(COPY, "http://x/run-tmp/design-system-fonts.css")).toMatchObject({ ok: true, how: expect.stringMatching(/^a copy of the package's fonts\/Inter-Regular\.woff2, declared in the package's fonts\.css/) });
    expect(fromDisk(COPY, "http://x/pkg/css/fonts.css")).toMatchObject({ ok: true });
  });

  test("a lookalike copy, a missing file or an unmapped URL fails", () => {
    expect(fromDisk("http://x/run-tmp/Inter-Lookalike-9c1d.woff2", "http://x/run-tmp/design-system-fonts.css")).toMatchObject({ ok: false });
    expect(fromDisk("http://x/run-tmp/missing.woff2", null)).toMatchObject({ ok: false, how: expect.stringContaining("does not exist") });
    expect(fromDisk("http://elsewhere/font.woff2", null)).toEqual({ ok: false, how: "the URL maps to no file on disk" });
  });

  test("an inlined data: font passes only when it is a package font declared in the package's fonts.css", () => {
    const data = `data:font/woff2;base64,${readFileSync(join(FONTS, "Inter-Regular.woff2")).toString("base64")}`;
    expect(fromDisk(data, null)).toMatchObject({ ok: false, how: expect.stringContaining(DECISION_20) });
    expect(fromDisk(data, "http://x/run-tmp/design-system-fonts.css")).toMatchObject({ ok: true, how: expect.stringMatching(/^an inlined copy of the package's fonts\/Inter-Regular\.woff2/) });
    expect(fromDisk(`data:font/woff2;base64,${Buffer.from("other").toString("base64")}`, "http://x/run-tmp/design-system-fonts.css")).toMatchObject({ ok: false });
  });
});
