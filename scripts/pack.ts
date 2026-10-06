#!/usr/bin/env bun
/**
 * Packs the package into a tgz an app can vendor (`"file:vendor/<name>.tgz"`).
 *
 *   bun run pack                    pack into $DS_RUN/pack, else <os tmpdir>/ds-rollout/pack
 *   bun run pack --out <app>/vendor  pack into an app's vendor folder
 *
 * Steps: refuse a stale build (the same check as `bun run check`), run `npm pack --json` from the
 * package root into a temp folder (npm's file name: codecaine-ai-design-system-<version>.tgz), then read
 * the tgz back and verify it carries the CSS, the font files fonts.css names and every file package.json
 * exports, and nothing that must not ship (tgzProblems). Only a complete tgz is copied into the destination.
 *
 * A tgz of the same name already in the destination is never overwritten. The same content (the same files
 * with the same bytes once extracted; the gzip bytes may differ with another npm or zlib): it is left as it
 * is and the output says `unchanged`. Different content: exit 1, because an app's lockfile pins the old
 * bytes by integrity. Every repack of a changed build bumps the patch version in package.json first.
 *
 * Destinations: a checkout outside the owner's tree (the rollout mirror) never writes into the owner's tree
 * (`/Users/Ford/workspace`), directly or through a symlink. A checkout inside the owner's tree (the owner's
 * own design-system after merge) may: `bun run pack --out ../<app>/vendor` is the vendoring flow there.
 * Scratch folders (npm's staging folder, its HOME, cache and TMPDIR) and the default destination go under
 * safeTempBase(): pack refuses (exit 1, nothing created) when TMPDIR resolves into the owner's tree, is the
 * home itself, or lies in ~/Library or a credential store.
 *
 * npm and node: each is resolved once, the first on PATH (absolute entries only), and run by its real path
 * (symlinks resolved). Both must sit in the nvm dir (~/.nvm, which the run sandbox never lets a run write) or
 * in a directory this user cannot write (nor any directory on the way to it): a `npm` or `node` found first
 * in a user-writable PATH dir that comes before the nvm dir (~/.local/bin, ~/.bun/bin, /usr/local/bin on this
 * machine) is refused before anything runs, because an unsandboxed process could have planted it there.
 * npm runs inside the OS sandbox (sandbox.ts packPolicy, decision 31): writes only in its staging folder and its
 * temp HOME, reads under the home only the checkout, those two and the runtimes (~/.nvm), no network at all
 * (no IP, no Unix socket, no bind), credential stores and the owner's tree hidden (the checkout itself stays
 * readable, never writable). Its PATH is pinned to the real dirs of node and npm and the system dirs
 * (SYSTEM_PATH). No sandbox-exec, no pack.
 *
 * On success it prints two lines, and a third when the tgz was already there:
 *   tgz: <absolute path>
 *   tokens.css sha256: <hex of the dist/css/tokens.css bytes inside the tgz>
 *   unchanged: a tgz with the same files and bytes was already at this path
 *
 * The conformance linter imports readTgz, tgzProblems and tokensCssSha256 to check a vendored copy.
 * Zero dependencies: gunzip from node:zlib and a small ustar reader (prefix field, pax and GNU long names).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROOT, staleFiles, TokenError } from "./build.ts";
import { OWNER_TREE } from "./lib/owner.ts";
import { canonicalPath, isWithin, realHome, safeOutputPath, safeTempBase, UnsafePathError } from "./lib/safe-paths.ts";
import { packPolicy, sandboxCommand, SandboxUnavailable } from "./lib/sandbox.ts";
import { SYSTEM_PATH } from "./lib/system-bin.ts";

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

/**
 * What must never ship, beyond package.json's `files` list (the first guard). Folders and files at the
 * package root; node_modules/ and `.env*` (a file or folder) are refused at any depth.
 */
export const FORBIDDEN_DIRS = ["test/", "scripts/", "verification/", "apps/", "prompts/", "skill/"];
export const FORBIDDEN_FILES = ["apps.json"];

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
 * and nothing from test/, scripts/, verification/, apps/, prompts/, skill/, apps.json, node_modules/ or `.env*`.
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
    else if (
      FORBIDDEN_DIRS.some((dir) => inner.startsWith(dir)) ||
      FORBIDDEN_FILES.includes(inner) ||
      inner.split("/").some((part) => part === "node_modules" || part.startsWith(".env"))
    ) {
      problems.push(`${name} must not ship`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * `$DS_RUN/pack` during the rollout, else `ds-rollout/pack` under the temp base, which must pass
 * safeTempBase (TMPDIR outside the owner's tree, not the home itself, not in ~/Library or a credential
 * store). Never a git checkout by default. Throws UnsafePathError.
 */
export function defaultOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DS_RUN ? join(env.DS_RUN, "pack") : join(safeTempBase({ tmp: env.TMPDIR || tmpdir() }), "ds-rollout", "pack");
}

export interface PackOptions {
  /** Destination folder; created when missing. Default: defaultOutDir(). */
  out?: string;
  /** The design-system checkout to pack. Default: the one this script runs from. */
  root?: string;
  /** The owner's tree; tests pass a temp dir. Default OWNER_TREE. */
  ownerTree?: string;
  /** The real home (its ~/.nvm is where npm and node may live); tests pass a temp dir. Default realHome(). */
  home?: string;
  /** The PATH npm and node are resolved through. Default process.env.PATH. */
  pathEnv?: string;
}

// ---------------------------------------------------------------------------
// npm and node: resolved once, refused from a plantable place, run sandboxed
// ---------------------------------------------------------------------------

/** A tool found on PATH. */
export interface ResolvedTool {
  name: string;
  /** The PATH entry it was found in, canonical. */
  dir: string;
  /** `<entry>/<name>` as found. */
  found: string;
  /** Its real path (symlinks resolved): what runs. */
  real: string;
}

/**
 * Whether this user could replace `path`: it, or a directory on the way up to `/`, is owned by this user or
 * writable by them (an owner can chmod; a writable parent can rename the entry away).
 */
export function userWritable(path: string): boolean {
  const uid = process.getuid?.();
  for (let current = path; ; current = dirname(current)) {
    try {
      if (uid !== undefined && statSync(current).uid === uid) return true;
      accessSync(current, constants.W_OK);
      return true;
    } catch {
      // not ours, not writable: look further up
    }
    if (dirname(current) === current) return false;
  }
}

/**
 * The first `name` on `pathEnv` (absolute entries only: a relative entry names another dir in every cwd),
 * with its real path. Throws PackError, before anything runs, when it or its real path sits in a directory
 * this user can write that is not inside the nvm dir (`<home>/.nvm`): there, an unsandboxed process could
 * have planted it ahead of the nvm one. Also when PATH holds no `name`.
 */
export function resolveTool(name: "npm" | "node", opts: { pathEnv: string; home: string }): ResolvedTool {
  const nvm = canonicalPath(join(opts.home, ".nvm"));
  const entries = opts.pathEnv.split(":").filter((entry) => isAbsolute(entry));
  const nvmEntry = entries.find((entry) => isWithin(entry, nvm));
  for (const entry of entries) {
    const found = join(entry, name);
    let real: string;
    try {
      if (!statSync(found).isFile()) continue;
      accessSync(found, constants.X_OK);
      real = realpathSync(found);
    } catch {
      continue;
    }
    const dir = canonicalPath(entry);
    const trusted = (path: string) => isWithin(path, nvm) || !userWritable(path);
    if (!trusted(dir) || !trusted(real)) {
      const where = nvmEntry === undefined ? `PATH has no entry in the nvm dir ${nvm}` : entries.indexOf(entry) < entries.indexOf(nvmEntry) ? `before the nvm dir ${nvmEntry} on PATH` : `not the nvm dir ${nvmEntry}`;
      throw new PackError(
        `design-system: refusing to run ${name}: the first ${name} on PATH is ${found}${real === found ? "" : ` (really ${real})`}, in a directory this user can write, ${where}. ` +
          `An unsandboxed process could have planted it there. Remove it, or put the nvm bin dir first on PATH; nothing packed`,
      );
    }
    return { name, dir, found, real };
  }
  throw new PackError(`design-system: ${name} is not on PATH (absolute entries); nothing packed`);
}

/** Whether `file` is a script node runs (`.js`, or a `#!` line naming node): npm-cli.js is one. */
function nodeScript(file: string): boolean {
  if (/\.[cm]?js$/.test(file)) return true;
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(128);
    const n = readSync(fd, head, 0, head.length, 0);
    return /^#!.*\bnode\b/.test(head.subarray(0, n).toString("utf8").split("\n")[0] ?? "");
  } finally {
    closeSync(fd);
  }
}

/**
 * npm's argv and PATH: npm's real file run by node's real path when it is a node script (so its
 * `#!/usr/bin/env node` never resolves node through PATH), else npm's real path. PATH is node's and npm's
 * real dirs, then the system dirs, for whatever npm starts in turn.
 */
export function npmCommand(npm: ResolvedTool, node: ResolvedTool): { argv: string[]; path: string } {
  const argv = nodeScript(npm.real) ? [node.real, npm.real] : [npm.real];
  return { argv, path: [...new Set([dirname(node.real), dirname(npm.real)]), SYSTEM_PATH].join(":") };
}

/**
 * The canonical destination for a pack. A checkout inside the owner's tree packs anywhere (the owner's own
 * vendoring flow); a checkout outside it (the rollout mirror) is refused any destination in the owner's
 * tree, directly or through a symlink, case variant or firmlink spelling. Throws UnsafePathError.
 */
export function packOutput(dest: string, opts: { root?: string; ownerTree?: string } = {}): string {
  const ownerTree = opts.ownerTree ?? OWNER_TREE;
  const ownerCheckout = isWithin(opts.root ?? ROOT, ownerTree);
  return safeOutputPath(dest, { label: "pack --out", ownerTree, ...(ownerCheckout ? { root: ownerTree } : {}) });
}

/** Temp homes npmEnv made; removed when the process exits. */
const npmHomes: string[] = [];

/**
 * The only environment npm pack gets: `path` as PATH (npmCommand's pinned one; default the system dirs),
 * LANG and TERM from `from`, and a fresh temp HOME under the validated temp base (removed at exit) holding
 * the XDG dirs, the npm cache, npm's TMPDIR and empty user and global npmrc files. So npm never reads the
 * owner's ~/.npmrc or tokens, never writes ~/.npm or the caller's TMPDIR, never finds a tool through the
 * caller's PATH, and runs no lifecycle scripts.
 */
export function npmEnv(from: NodeJS.ProcessEnv = process.env, base: string = safeTempBase(), path: string = SYSTEM_PATH): Record<string, string> {
  const home = mkdtempSync(join(base, "ds-pack-npm-"));
  if (!npmHomes.length) process.once("exit", () => npmHomes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  npmHomes.push(home);
  const env: Record<string, string> = { PATH: path };
  for (const name of ["LANG", "TERM"]) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  const userconfig = join(home, "npmrc");
  const globalconfig = join(home, "global-npmrc");
  const tmp = join(home, "tmp");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  mkdirSync(tmp);
  return {
    ...env,
    TMPDIR: tmp,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    npm_config_cache: join(home, ".npm"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_ignore_scripts: "true",
  };
}

export interface PackResult {
  /** Absolute path of the tgz. */
  tgz: string;
  /** sha256 of the dist/css/tokens.css bytes inside the tgz. */
  tokensCssSha256: string;
  /** The tgz was already there with exactly these files and bytes (extracted), so nothing was written. */
  unchanged: boolean;
}

/**
 * Builds-checks, packs and verifies. Throws PackError when anything fails, and when `out` already holds a
 * tgz of the same name with different content. Nothing is written to `out` unless the tgz is complete and new.
 * Throws UnsafePathError before creating anything when the destination (packOutput) or the temp base
 * (safeTempBase: TMPDIR inside the owner's tree, the home itself, ~/Library or a credential store) is refused.
 */
export async function pack(opts: PackOptions = {}): Promise<PackResult> {
  const root = opts.root ?? ROOT;
  let stale: string[];
  try {
    stale = staleFiles(root);
  } catch (error) {
    if (error instanceof TokenError) throw new PackError("design-system: the tokens do not build; nothing packed:", error.problems);
    throw error;
  }
  if (stale.length) throw new PackError("design-system: build outputs are stale (run `bun run build`); nothing packed:", stale);

  const home = opts.home ?? realHome();
  // Before anything is created: a planted npm or node refuses the pack.
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const tools = { npm: resolveTool("npm", { pathEnv, home }), node: resolveTool("node", { pathEnv, home }) };
  const out = packOutput(opts.out ?? defaultOutDir(), { root, ownerTree: opts.ownerTree });
  const base = safeTempBase({ ownerTree: opts.ownerTree, home });
  mkdirSync(out, { recursive: true });
  // npm writes into a private folder, so a tgz already in `out` is never overwritten by npm itself.
  const staging = mkdtempSync(join(base, "ds-pack-"));
  try {
    return place(npmPack(root, staging, base, { ...tools, home, ownerTree: opts.ownerTree }), out, root);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Runs `npm pack` from the package root into `dest`, inside the sandbox (packPolicy). Returns the path of the tgz it wrote. */
function npmPack(root: string, dest: string, base: string, tools: { npm: ResolvedTool; node: ResolvedTool; home: string; ownerTree?: string }): string {
  const { argv, path } = npmCommand(tools.npm, tools.node);
  const env = npmEnv(process.env, base, path);
  let command: string[];
  try {
    command = sandboxCommand(packPolicy({ packageRoot: root, staging: dest, npmHome: env.HOME!, home: tools.home, ownerTree: tools.ownerTree }), [
      ...argv,
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      dest,
      "--json",
    ]);
  } catch (error) {
    if (error instanceof SandboxUnavailable) throw new PackError(`design-system: npm runs only inside the OS sandbox: ${error.message}; nothing packed`);
    throw error;
  }
  const npm = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: "utf8", env });
  if (npm.error) throw new PackError(`design-system: could not run npm: ${npm.error.message}`);
  if (npm.status !== 0) throw new PackError(`design-system: npm pack exited ${npm.status}:\n${npm.stderr.trim()}`);
  let filename: unknown;
  try {
    filename = (JSON.parse(npm.stdout) as Array<{ filename?: unknown }>)[0]?.filename;
  } catch {
    // reported below
  }
  if (typeof filename !== "string") throw new PackError(`design-system: npm pack printed no file name:\n${npm.stdout.trim()}`);
  return join(dest, filename);
}

/**
 * Whether two tgz file maps hold the same regular files with the same bytes. Compares what an install
 * extracts, not the gzip stream, which another npm or zlib version compresses differently.
 */
export function sameEntries(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, bytes] of a) {
    const other = b.get(name);
    if (!other || !Buffer.from(other).equals(Buffer.from(bytes))) return false;
  }
  return true;
}

/**
 * Checks the staged tgz, then copies it into `out` under npm's name (codecaine-ai-design-system-<version>.tgz).
 * A file already there is never replaced: the same extracted content leaves it as it is (`unchanged`),
 * different content (or a file that is no readable tgz) refuses, because an app's lockfile pins the old bytes
 * by integrity (consume.md: repack after a token change).
 */
function place(staged: string, out: string, root: string): PackResult {
  const tgz = join(out, basename(staged));
  const files = readTgz(staged);
  const problems = tgzProblems(files);
  const packed = files.get(TOKENS_CSS_ENTRY);
  if (packed && sha256(packed) !== sha256(readFileSync(join(root, "dist/css/tokens.css")))) {
    problems.push(`${TOKENS_CSS_ENTRY} differs from dist/css/tokens.css (it changed while packing)`);
  }
  if (problems.length || !packed) throw new PackError(`design-system: the packed ${basename(tgz)} is incomplete; nothing written to ${out}:`, problems);

  const result = { tgz, tokensCssSha256: sha256(packed) };
  try {
    // COPYFILE_EXCL: the existence check and the create are one step, so a file that appears meanwhile is not replaced either.
    copyFileSync(staged, tgz, constants.COPYFILE_EXCL);
    return { ...result, unchanged: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new PackError(`design-system: could not write ${tgz}: ${(error as Error).message}`);
  }
  let existing: Map<string, Uint8Array> | null = null;
  try {
    if (lstatSync(tgz).isFile()) existing = readTgz(tgz);
  } catch {
    // not a readable tgz: different content
  }
  if (existing && sameEntries(existing, files)) return { ...result, unchanged: true };
  throw new PackError(
    `design-system: ${tgz} already exists with different content; refusing to overwrite it (a lockfile pins the old bytes by integrity). ` +
      "Bump the patch version in package.json (every repack does), run `bun run build`, then pack again. Nothing written.",
  );
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
    if (result.unchanged) console.log("unchanged: a tgz with the same files and bytes was already at this path");
    return 0;
  } catch (error) {
    if (error instanceof PackError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof UnsafePathError) {
      console.error(`design-system: ${error.message}; nothing packed`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(await cli());
