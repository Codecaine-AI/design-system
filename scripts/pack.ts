#!/usr/bin/env bun
/**
 * Packs the package into a tgz an app can vendor (`"file:vendor/<name>.tgz"`).
 *
 *   bun run pack                    pack into $DS_RUN/pack, else <os tmpdir>/ds-rollout/pack
 *   bun run pack --out <app>/vendor  pack into an app's vendor folder
 *
 * Steps: refuse a stale build (the same check as `bun run check`), run `npm pack --json` from the
 * package root (npm's file name: codecaine-ai-design-system-<version>.tgz), then read the tgz back
 * and verify it carries the CSS, the font files fonts.css names and every file package.json exports,
 * and nothing from test/, scripts/, verification/ or node_modules/. A tgz that fails is deleted.
 *
 * On success it prints exactly two lines:
 *   tgz: <absolute path>
 *   tokens.css sha256: <hex of the dist/css/tokens.css bytes inside the tgz>
 *
 * The conformance linter imports readTgz, tgzProblems and tokensCssSha256 to check a vendored copy.
 * Zero dependencies: gunzip from node:zlib and a small ustar reader (prefix field, pax and GNU long names).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROOT, staleFiles, TokenError } from "./build.ts";

/** Every path in an npm-packed tgz starts with this folder. */
export const TGZ_ROOT = "package/";
export const TOKENS_CSS_ENTRY = `${TGZ_ROOT}dist/css/tokens.css`;
export const FONTS_CSS_ENTRY = `${TGZ_ROOT}css/fonts.css`;

/** Files a vendored copy must carry, beyond what package.json exports and fonts.css references. */
export const REQUIRED_ENTRIES = [
  "package.json",
  "dist/css/tokens.css",
  "css/fonts.css",
  "css/layout.css",
  "dist/tailwind/preset-v3.cjs",
].map((path) => `${TGZ_ROOT}${path}`);

/** Package folders that must never ship. node_modules is refused at any depth. */
export const FORBIDDEN_DIRS = ["test/", "scripts/", "verification/"];

export class PackError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}\n${problems.map((p) => `  ${p}`).join("\n")}` : message);
    this.name = "PackError";
  }
}

// ---------------------------------------------------------------------------
// Reading a tgz
// ---------------------------------------------------------------------------

const BLOCK = 512;
const utf8 = new TextDecoder();

/** A NUL-terminated header field. */
function field(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return utf8.decode(end === -1 ? slice : slice.subarray(0, end));
}

/** A numeric header field: octal text, or GNU base-256 when the high bit of the first byte is set. */
function numeric(bytes: Uint8Array, start: number, length: number): number {
  if (bytes[start] & 0x80) {
    let value = bytes[start] & 0x7f;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + bytes[i];
    return value;
  }
  const text = field(bytes, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/** The header checksum: the byte sum with the checksum field itself counted as eight spaces. */
function checksumOk(header: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === numeric(header, 148, 8);
}

/** pax extended header records: `<length> <key>=<value>\n`, where length counts the whole record in bytes. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const length = space === -1 ? Number.NaN : Number.parseInt(utf8.decode(data.subarray(pos, space)), 10);
    if (!(length > 0) || pos + length > data.length) throw new Error(`malformed pax record at byte ${pos}`);
    const record = utf8.decode(data.subarray(space + 1, pos + length - 1));
    const eq = record.indexOf("=");
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    pos += length;
  }
  return records;
}

/** Regular files in an uncompressed tar, path -> bytes. Directories and links are skipped. */
export function readTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const global = new Map<string, string>();
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    if (!checksumOk(header)) throw new Error(`bad tar header checksum at byte ${offset}`);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const paxSize = pax?.get("size"); // set only for the entry after an "x" header
    const size = paxSize !== undefined ? Number(paxSize) : numeric(header, 124, 12);
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new Error(`tar entry at byte ${offset} runs past the end of the archive`);
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (type === "g") {
      for (const [key, value] of paxRecords(data)) global.set(key, value);
      continue;
    }
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    let name = field(header, 0, 100);
    // POSIX ustar ("ustar\0") splits long paths into a 155-byte prefix; GNU ("ustar ") uses those bytes for other fields.
    if (field(header, 257, 6) === "ustar") {
      const prefix = field(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = pax?.get("path") ?? longName ?? global.get("path") ?? name;
    if (type === "0" || type === "7") files.set(name, data.slice());
    pax = null;
    longName = null;
  }
  return files;
}

/** Regular files in a .tgz on disk, path (`package/...`) -> bytes. Throws with the path on a corrupt archive. */
export function readTgz(path: string): Map<string, Uint8Array> {
  try {
    return readTar(gunzipSync(readFileSync(path)));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of the dist/css/tokens.css a packed tgz carries. Throws when it carries none. */
export function tokensCssSha256(tgzPath: string): string {
  const bytes = readTgz(tgzPath).get(TOKENS_CSS_ENTRY);
  if (!bytes) throw new Error(`${tgzPath}: no ${TOKENS_CSS_ENTRY}`);
  return sha256(bytes);
}

// ---------------------------------------------------------------------------
// Checking a tgz
// ---------------------------------------------------------------------------

/** Every string target under an `exports` value (condition objects nest). */
function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

/** Whether the tgz satisfies one exports target. `./fonts/*` needs at least one file under fonts/. */
function carriesTarget(files: Map<string, Uint8Array>, target: string): boolean {
  const path = `${TGZ_ROOT}${posix.normalize(target)}`;
  const star = path.indexOf("*");
  if (star === -1) return files.has(path);
  const [head, tail] = [path.slice(0, star), path.slice(star + 1)];
  return [...files.keys()].some((name) => name.length > head.length + tail.length && name.startsWith(head) && name.endsWith(tail));
}

/**
 * What a vendored copy of the package is missing or must not carry. Empty when it is complete:
 * every required file, every font file fonts.css references, every file package.json exports,
 * and nothing from test/, scripts/, verification/ or node_modules/.
 */
export function tgzProblems(files: Map<string, Uint8Array>): string[] {
  const problems: string[] = [];
  for (const path of REQUIRED_ENTRIES) if (!files.has(path)) problems.push(`missing ${path}`);

  const fontsCss = files.get(FONTS_CSS_ENTRY);
  if (fontsCss) {
    const refs = [...utf8.decode(fontsCss).matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((m) => m[2]);
    if (!refs.length) problems.push(`${FONTS_CSS_ENTRY} references no font files`);
    for (const ref of refs) {
      const path = posix.normalize(posix.join(posix.dirname(FONTS_CSS_ENTRY), ref));
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || !path.startsWith(TGZ_ROOT)) problems.push(`${FONTS_CSS_ENTRY} references ${ref}, outside the package`);
      else if (!files.has(path)) problems.push(`missing ${path} (referenced by ${FONTS_CSS_ENTRY})`);
    }
  }

  const manifest = files.get(`${TGZ_ROOT}package.json`);
  if (manifest) {
    const exports = (JSON.parse(utf8.decode(manifest)) as { exports?: unknown }).exports;
    for (const target of [...new Set(exportTargets(exports))].sort()) {
      if (!carriesTarget(files, target)) problems.push(`missing ${target} (named in package.json exports)`);
    }
  }

  for (const name of [...files.keys()].sort()) {
    const inner = name.startsWith(TGZ_ROOT) ? name.slice(TGZ_ROOT.length) : null;
    if (inner === null) problems.push(`${name} is outside ${TGZ_ROOT}`);
    else if (FORBIDDEN_DIRS.some((dir) => inner.startsWith(dir)) || inner.split("/").includes("node_modules")) {
      problems.push(`${name} must not ship`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/** `$DS_RUN/pack` during the rollout, else a temp folder. Never a git checkout by default. */
export function defaultOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DS_RUN ? join(env.DS_RUN, "pack") : join(tmpdir(), "ds-rollout", "pack");
}

export interface PackOptions {
  /** Destination folder; created when missing. Default: defaultOutDir(). */
  out?: string;
}

export interface PackResult {
  /** Absolute path of the tgz. */
  tgz: string;
  /** sha256 of the dist/css/tokens.css bytes inside the tgz. */
  tokensCssSha256: string;
}

/** Builds-checks, packs and verifies. Throws PackError (after deleting a bad tgz) when anything fails. */
export async function pack(opts: PackOptions = {}): Promise<PackResult> {
  let stale: string[];
  try {
    stale = staleFiles(ROOT);
  } catch (error) {
    if (error instanceof TokenError) throw new PackError("design-system: the tokens do not build; nothing packed:", error.problems);
    throw error;
  }
  if (stale.length) throw new PackError("design-system: build outputs are stale (run `bun run build`); nothing packed:", stale);

  const out = resolve(opts.out ?? defaultOutDir());
  mkdirSync(out, { recursive: true });
  const npm = spawnSync("npm", ["pack", "--pack-destination", out, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  });
  if (npm.error) throw new PackError(`design-system: could not run npm: ${npm.error.message}`);
  if (npm.status !== 0) throw new PackError(`design-system: npm pack exited ${npm.status}:\n${npm.stderr.trim()}`);
  let filename: unknown;
  try {
    filename = (JSON.parse(npm.stdout) as Array<{ filename?: unknown }>)[0]?.filename;
  } catch {
    // reported below
  }
  if (typeof filename !== "string") throw new PackError(`design-system: npm pack printed no file name:\n${npm.stdout.trim()}`);
  const tgz = join(out, filename);

  const files = readTgz(tgz);
  const problems = tgzProblems(files);
  const packed = files.get(TOKENS_CSS_ENTRY);
  if (packed && sha256(packed) !== sha256(readFileSync(join(ROOT, "dist/css/tokens.css")))) {
    problems.push(`${TOKENS_CSS_ENTRY} differs from dist/css/tokens.css (it changed while packing)`);
  }
  if (problems.length || !packed) {
    rmSync(tgz, { force: true });
    throw new PackError(`design-system: ${tgz} is incomplete; deleted it:`, problems);
  }
  return { tgz, tokensCssSha256: sha256(packed) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: bun run pack [--out <dir>]";

export function parseArgs(argv: string[]): PackOptions {
  const opts: PackOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1] !== undefined) opts.out = argv[++i];
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else throw new PackError(`design-system: unknown or incomplete argument "${arg}"\n${USAGE}`);
    if (!opts.out) throw new PackError(`design-system: --out needs a folder\n${USAGE}`);
  }
  return opts;
}

export async function cli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await pack(parseArgs(argv));
    console.log(`tgz: ${result.tgz}`);
    console.log(`tokens.css sha256: ${result.tokensCssSha256}`);
    return 0;
  } catch (error) {
    if (error instanceof PackError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(await cli());
