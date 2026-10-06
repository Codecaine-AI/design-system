/**
 * Where a fetched font file came from, for the font assertions (fonts.ts).
 *
 * A url() counts when the file it maps to is inside the `fonts/` directory of the design-system
 * package the app resolves, whatever stylesheet declares it (a dev server inlines CSS into <style>).
 * Where the app copies the package's files (consume.via copy) or a build bundles them (a static build
 * in the run's temp dir, a data: URL), a byte-identical copy of one of the build's own font files
 * counts only when the winning @font-face rule sits in the package's fonts.css (decision 20): a
 * stylesheet that is the resolved package's css/fonts.css, or a byte copy of the build's. Anything
 * else fails: the same font from another package (text-measure's fonts/), and the same font files
 * declared by another package's fonts.css, an inline <style> or a bundled stylesheet.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunningApp, servedDiskPath } from "../app-runner";
import { isInside } from "../lint/workspace";
import type { FontSourceJudge } from "./fonts";

const sha256 = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");
const real = (path: string) => (existsSync(path) ? realpathSync(path) : null);
const isFile = (path: string) => statSync(path).isFile();

export interface FontSourceOptions {
  /** Real paths of the design-system packages whose fonts/ directory counts (the one the app resolves). */
  packageDirs: string[];
  /** The build's fonts directory (DESIGN_SYSTEM_ROOT/fonts): byte copies of its files count in `copyDirs`. */
  buildFontsDir: string;
  /** The build's fonts.css (DESIGN_SYSTEM_ROOT/css/fonts.css): a stylesheet with its bytes is the package's fonts.css. */
  buildFontsCss: string;
  /** Directories where a byte copy counts: the run's temp dir (bundled builds), the app root for consume.via copy. */
  copyDirs: string[];
  /** A served URL to its file on disk, or null. */
  diskPath: (url: string) => string | null;
}

function buildFontHashes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (isFile(path)) out.set(sha256(readFileSync(path)), name);
  }
  return out;
}

export function fontSourceJudge(opts: FontSourceOptions): FontSourceJudge {
  const buildFonts = buildFontHashes(opts.buildFontsDir);
  const fontDirs = opts.packageDirs.map((dir) => real(join(dir, "fonts"))).filter((dir): dir is string => dir !== null);
  const packageCss = opts.packageDirs.map((dir) => real(join(dir, "css/fonts.css"))).filter((path): path is string => path !== null);
  const buildCssHash = existsSync(opts.buildFontsCss) ? sha256(readFileSync(opts.buildFontsCss)) : null;
  const copyDirs = opts.copyDirs.map(real).filter((dir): dir is string => dir !== null);
  const copyOf = (data: Buffer | Uint8Array) => buildFonts.get(sha256(data));

  /** The package fonts.css the winning rule sits in, or why it is not there. */
  const packageSheet = (sheet: string | null): { ok: true; path: string } | { ok: false; how: string } => {
    const not = "the winning @font-face rule is not in the design-system package's fonts.css (decision 20)";
    if (sheet === null) return { ok: false, how: `${not}: it is in an inline <style> or a constructed stylesheet` };
    const disk = opts.diskPath(sheet);
    const path = disk ? real(disk) : null;
    if (!path || !isFile(path)) return { ok: false, how: `${not}: its stylesheet ${sheet} maps to no file on disk` };
    if (packageCss.includes(path)) return { ok: true, path };
    if (buildCssHash !== null && sha256(readFileSync(path)) === buildCssHash) return { ok: true, path };
    return { ok: false, how: `${not}: it is in ${path}` };
  };

  return (url, sheet) => {
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const data = /;base64$/i.test(url.slice(0, comma)) ? Buffer.from(url.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
      const name = copyOf(data);
      if (!name) return { ok: false, how: "an inlined font that is not one of the package's font files" };
      const css = packageSheet(sheet);
      return css.ok ? { ok: true, how: `an inlined copy of the package's fonts/${name}, declared in the package's fonts.css (${css.path})` } : { ok: false, how: css.how };
    }
    const disk = opts.diskPath(url);
    if (!disk) return { ok: false, how: "the URL maps to no file on disk" };
    const path = real(disk);
    if (!path) return { ok: false, how: `it maps to ${disk}, which does not exist`, path: disk };
    const inPackage = fontDirs.find((dir) => isInside(path, dir));
    if (inPackage) return { ok: true, how: `the package's fonts/ (${inPackage})`, path };
    if (copyDirs.some((dir) => isInside(path, dir))) {
      const name = copyOf(readFileSync(path));
      if (name) {
        const css = packageSheet(sheet);
        return css.ok ? { ok: true, how: `a copy of the package's fonts/${name}, declared in the package's fonts.css (${css.path})`, path } : { ok: false, how: css.how, path };
      }
    }
    const expected = fontDirs.length ? fontDirs.join(", ") : "no resolved package";
    return { ok: false, how: `not from the design-system package's fonts/ (${expected})`, path };
  };
}

/** The file a fetched font URL names: a file: URL (Electron) directly, else the runner's served-path mapping. */
export function fontDiskPath(running: RunningApp, url: string): string | null {
  return url.startsWith("file:") ? fileURLToPath(url) : servedDiskPath(running, url);
}
