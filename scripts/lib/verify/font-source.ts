/**
 * Where a fetched font file came from, for the font assertions (fonts.ts).
 *
 * A url() counts when the file it maps to is inside the `fonts/` directory of the design-system
 * package the app resolves. Where the app copies the package's files (consume.via copy) or a build
 * bundles them (a static build in the run's temp dir, a data: URL), a byte-identical copy of one of
 * the build's own font files counts too. Anything else fails, the same font from another package
 * (text-measure's fonts/) included.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandPlaceholders, type RunningApp } from "../app-runner";
import { isInside } from "../lint/workspace";
import { resolvePath } from "../registry";
import type { FontSourceJudge } from "./fonts";

const sha256 = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");
const real = (path: string) => (existsSync(path) ? realpathSync(path) : null);

export interface FontSourceOptions {
  /** Real paths of the design-system packages whose fonts/ directory counts (the one the app resolves). */
  packageDirs: string[];
  /** The build's fonts directory (DESIGN_SYSTEM_ROOT/fonts): byte copies of its files count in `copyDirs`. */
  buildFontsDir: string;
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
    if (statSync(path).isFile()) out.set(sha256(readFileSync(path)), name);
  }
  return out;
}

export function fontSourceJudge(opts: FontSourceOptions): FontSourceJudge {
  const buildFonts = buildFontHashes(opts.buildFontsDir);
  const fontDirs = opts.packageDirs.map((dir) => real(join(dir, "fonts"))).filter((dir): dir is string => dir !== null);
  const copyDirs = opts.copyDirs.map(real).filter((dir): dir is string => dir !== null);
  const copyOf = (data: Buffer | Uint8Array) => buildFonts.get(sha256(data));
  return (url) => {
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const data = /;base64$/i.test(url.slice(0, comma)) ? Buffer.from(url.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
      const name = copyOf(data);
      return name ? { ok: true, how: `an inlined copy of the package's fonts/${name}` } : { ok: false, how: "an inlined font that is not one of the package's font files" };
    }
    const disk = opts.diskPath(url);
    if (!disk) return { ok: false, how: "the URL maps to no file on disk" };
    const path = real(disk);
    if (!path) return { ok: false, how: `it maps to ${disk}, which does not exist`, path: disk };
    const inPackage = fontDirs.find((dir) => isInside(path, dir));
    if (inPackage) return { ok: true, how: `the package's fonts/ (${inPackage})`, path };
    if (copyDirs.some((dir) => isInside(path, dir))) {
      const name = copyOf(readFileSync(path));
      if (name) return { ok: true, how: `a copy of the package's fonts/${name}`, path };
    }
    const expected = fontDirs.length ? fontDirs.join(", ") : "no resolved package";
    return { ok: false, how: `not from the design-system package's fonts/ (${expected})`, path };
  };
}

/**
 * The file a served URL maps to, the way servedFromRoot maps it (Vite `/@fs/...`, paths under the
 * serve root, file: URLs). A private copy of app-runner's toDiskPath until app-runner exports it.
 */
export function servedDiskPath(running: RunningApp, entry: string): string | null {
  if (entry.startsWith("file:")) return fileURLToPath(entry);
  const serveRoot =
    running.serveRoot ??
    (running.app.run?.serveRoot
      ? resolvePath(running.root, expandPlaceholders(running.app.run.serveRoot, { root: running.root, tmp: running.tmp, ports: running.ports ?? {} }))
      : resolvePath(running.root, running.app.run?.cwd ?? running.app.commands?.cwd ?? running.app.root));
  const basePath = running.baseUrl ? new URL(running.baseUrl).pathname.replace(/\/+$/, "") : "";
  let path: string;
  try {
    path = decodeURIComponent(new URL(entry).pathname);
  } catch {
    return null;
  }
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || "/";
  if (path.startsWith("/@fs/")) return path.slice("/@fs".length);
  if (path.startsWith("/@") || path.startsWith("/__")) return null;
  const joined = join(serveRoot, path);
  return isAbsolute(joined) ? joined : null;
}
