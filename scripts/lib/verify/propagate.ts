/**
 * `verify:apps --propagate`: prove a token change reaches every live-linked app.
 *
 * The root's design-system gets a sentinel page color (#ff00ff in every theme) and is rebuilt;
 * eligible apps must then paint their page with it. The theme files are journaled first and
 * restored (and the package rebuilt and checked) whatever happens. `--restore` replays the
 * journal after a crash. Builds run in their own process group, so a second Ctrl-C in the
 * terminal cannot kill the restore build; each one records its identity (pid, start time, group) in
 * the journal, so a restore after a crash stops an orphaned build before it restores anything. While
 * a journal is unrestored or a build holds the sentinel, snapshot and verify:apps refuse to run
 * (propagateBlocker).
 *
 * Nothing is written through a symlink: the theme files, tokens/, tokens/themes/, dist/ (every entry)
 * and guide/tokens.md must be real files and directories inside the design-system, checked before
 * journaling and again before every write; theme files are replaced by a rename, never written in place.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { installSignalHandlers } from "../app-runner";
import { OWNER_TREE } from "../owner";
import { appState, describePasses, parseLedger, passCells } from "../progress/ledger";
import type { AppEntry, ConsumeVia, Registry } from "../registry";
import { designSystemIn } from "../registry";
import { safeChildPath } from "../safe-paths";
import { SYSTEM_BIN, SYSTEM_PATH } from "../system-bin";

/** The owner's workspace (scripts/lib/owner.ts). Propagate never rebuilds it. */
export { OWNER_TREE };
export const SENTINEL = "#ff00ff";
export const SENTINEL_COMPUTED = "rgb(255, 0, 255)";
export const SENTINEL_TOKEN = "color.surface.page";
/** Ways of consuming the package that follow a rebuild without a reinstall or a repack. */
export const LIVE_CONSUMERS: readonly ConsumeVia[] = ["workspace", "link", "npm-file", "relative-import"];

const THEMES_DIR = "tokens/themes";
/** Theme token files the build reads (it skips dotfiles such as AppleDouble `._*` copies). */
const THEME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tokens\.json$/;
const MANIFEST = "manifest.json";
/** The running build's identity, written by its own shell before it execs bun. */
const BUILD_IDENTITY = "build.json";
const JOURNAL_LABEL = "propagate journal";

export class Refusal extends Error {}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));

/** A destination under the journal dir, checked before every write or delete: plain segments, no symlinked component, never the owner's tree. */
const journalPath = (journalDir: string, ...segments: string[]) => safeChildPath({ base: journalDir, label: JOURNAL_LABEL }, ...segments);

/** What is at `path`, without following a symlink. */
function entryKind(path: string): "missing" | "symlink" | "dir" | "file" | "other" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
}

/**
 * Refuses unless `rel` under the real design-system dir is a real `want` (lstat: not a symlink) whose real
 * path stays inside it. `single` also refuses a hard-linked file, which a write in place would change
 * for every other name of it. `optional` accepts a missing entry.
 */
function requireReal(dsReal: string, rel: string, want: "dir" | "file", opts: { optional?: boolean; single?: boolean } = {}): void {
  const path = join(dsReal, rel);
  const kind = entryKind(path);
  if (kind === "missing" && opts.optional) return;
  if (kind === "symlink") throw new Refusal(`${rel} in ${dsReal} is a symlink; propagate never writes through one (it could land outside the design-system)`);
  if (kind !== want) throw new Refusal(`${rel} in ${dsReal} is ${kind === "missing" ? "missing" : `not a ${want === "dir" ? "directory" : "regular file"}`}`);
  const resolved = realpathSync(path);
  if (!isInside(resolved, dsReal)) throw new Refusal(`${rel} in ${dsReal} resolves to ${resolved}, outside the design-system`);
  const links = lstatSync(path).nlink;
  if (opts.single && want === "file" && links > 1) throw new Refusal(`${rel} in ${dsReal} is hard-linked (${links} names); the build rewrites it in place, which would change the other copies`);
}

/** Refuses a symlink, an entry resolving outside the design-system, or a hard-linked file anywhere under `rel`. */
function requireRealTree(dsReal: string, rel: string): void {
  for (const entry of readdirSync(join(dsReal, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    const kind = entryKind(join(dsReal, child));
    requireReal(dsReal, child, kind === "dir" ? "dir" : "file", { single: true });
    if (kind === "dir") requireRealTree(dsReal, child);
  }
}

/**
 * The theme files of a design-system whose propagate writes all stay inside it, or a Refusal: tokens/,
 * tokens/themes/ and dist/ are real directories, every theme file is a regular file, nothing under dist/
 * is a symlink or a hard link (the build rewrites those files in place), and neither is guide/tokens.md.
 * scripts/build.ts is not a symlink either: it builds the directory above its real path.
 */
function checkTree(dsReal: string): string[] {
  for (const rel of ["tokens", THEMES_DIR, "dist"]) requireReal(dsReal, rel, "dir");
  requireRealTree(dsReal, "dist");
  requireReal(dsReal, "guide", "dir", { optional: true });
  requireReal(dsReal, "guide/tokens.md", "file", { optional: true, single: true });
  requireReal(dsReal, "scripts", "dir", { optional: true });
  requireReal(dsReal, "scripts/build.ts", "file", { optional: true });
  const rels = readdirSync(join(dsReal, THEMES_DIR))
    .filter((name) => THEME_FILE.test(name))
    .sort()
    .map((name) => `${THEMES_DIR}/${name}`);
  for (const rel of rels) requireReal(dsReal, rel, "file");
  return rels;
}

/**
 * Replaces a theme file without following a link: re-checks, just before, that the design-system and
 * tokens/themes/ still resolve where they did and the file is not a symlink, writes a temp file beside it
 * (exclusive create) and renames it over the file. Returns the file's path.
 */
function replaceThemeFile(dsDir: string, rel: string, data: string | Buffer): string {
  const name = rel.slice(THEMES_DIR.length + 1);
  if (!rel.startsWith(`${THEMES_DIR}/`) || !THEME_FILE.test(name)) throw new Refusal(`${JSON.stringify(rel)} is not a theme file under ${THEMES_DIR}/`);
  const dir = join(dsDir, THEMES_DIR);
  const sameDir = () => {
    const now = realpathSync(dir);
    if (now !== dir) throw new Refusal(`${dir} now resolves to ${now}; refusing to write ${rel} there`);
  };
  sameDir();
  requireReal(dsDir, "tokens", "dir");
  requireReal(dsDir, THEMES_DIR, "dir");
  requireReal(dsDir, rel, "file", { optional: true });
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.propagate-tmp`);
  rmSync(tmp, { force: true }); // a leftover (or a planted link) is removed, never followed
  writeFileSync(tmp, data, { flag: "wx" });
  try {
    sameDir();
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return target;
}

/**
 * The real root a propagate or restore may rebuild: refuses a missing --root, the owner's tree
 * (directly, inside it, or through a symlink) and a root without a design-system.
 */
export function checkPropagateRoot(root: string | undefined, flag = "--propagate"): string {
  if (!root) throw new Refusal(`${flag} needs --root <dir>: it rebuilds that tree's design-system, never the default tree`);
  if (!existsSync(root)) throw new Refusal(`${flag}: --root ${root} does not exist`);
  const owner = real(OWNER_TREE);
  const rootReal = realpathSync(root);
  if (isInside(rootReal, owner)) throw new Refusal(`${flag} refuses the owner's tree (${rootReal}); pass the mirror or a scratch copy`);
  const ds = designSystemIn(rootReal);
  if (!existsSync(join(ds, THEMES_DIR))) throw new Refusal(`${flag}: no design-system with ${THEMES_DIR}/ under ${rootReal}`);
  if (isInside(realpathSync(ds), owner)) throw new Refusal(`${flag}: ${ds} resolves into the owner's tree (${realpathSync(ds)})`);
  return rootReal;
}

export interface JournalManifest {
  version: 1;
  createdAt: string;
  /** Real path of the design-system whose files were journaled. */
  dsDir: string;
  files: Array<{ rel: string; sha256: string }>;
  restoredAt?: string;
  /** sha256 of the build's inputs when the journal was written (buildInputsSha256): no build runs once they changed. */
  buildInputs?: string;
  /** Set while a build runs (recorded before it starts); `identity` is the file in the journal holding its pid, group and start time. */
  activeBuild?: { script: string; identity: string; requestedAt: string };
}

export function readJournal(journalDir: string): JournalManifest | null {
  const path = join(journalDir, MANIFEST);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JournalManifest) : null;
}

function writeManifest(journalDir: string, manifest: JournalManifest) {
  const tmp = journalPath(journalDir, `${MANIFEST}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, journalPath(journalDir, MANIFEST));
}

/** Files whose content decides what `bun run <script>` executes in the design-system. */
const BUILD_INPUT_FILES = ["package.json", "bunfig.toml", "tsconfig.json"];

/**
 * sha256 over the code a design-system build runs: package.json (its scripts), bunfig.toml and
 * tsconfig.json (preloads, import paths) and every entry under scripts/ (a symlink by its target). An app
 * that rewrote them while it ran under propagate would otherwise have its code run by the restore build.
 */
export function buildInputsSha256(dsDir: string): string {
  const lines: string[] = [];
  const entry = (rel: string) => {
    const path = join(dsDir, rel);
    const kind = entryKind(path);
    if (kind === "missing") return `${rel}\0missing\n`;
    if (kind === "symlink") return `${rel}\0symlink:${readlinkSync(path)}\n`;
    if (kind === "file") return `${rel}\0${sha256(readFileSync(path))}\n`;
    return `${rel}\0${kind}\n`;
  };
  for (const rel of BUILD_INPUT_FILES) lines.push(entry(rel));
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dsDir, rel)).sort()) {
      const child = `${rel}/${name}`;
      if (entryKind(join(dsDir, child)) === "dir") walk(child);
      else lines.push(entry(child));
    }
  };
  if (entryKind(join(dsDir, "scripts")) === "dir") walk("scripts");
  else lines.push(entry("scripts"));
  return sha256(lines.join(""));
}

function pageValue(text: string): unknown {
  return (JSON.parse(text) as any)?.color?.surface?.page?.$value;
}

/**
 * Copies every theme token file into the journal and writes the manifest, before anything changes.
 * Refuses when an unrestored journal exists, a theme already holds the sentinel, or a write could leave
 * the design-system through a symlink (checkTree), before the journal dir or any file is touched.
 */
export function writeJournal(dsDir: string, journalDir: string): JournalManifest {
  const active = readJournal(journalDir);
  if (active && !active.restoredAt) {
    throw new Refusal(`an unrestored propagate journal from ${active.createdAt} is at ${journalDir}; run \`bun run verify:apps --restore --root <root>\` first`);
  }
  const dsReal = realpathSync(dsDir);
  const rels = checkTree(dsReal);
  if (rels.length === 0) throw new Refusal(`no theme token files in ${join(dsReal, THEMES_DIR)}`);
  const files = rels.map((rel) => {
    const data = readFileSync(join(dsReal, rel));
    if (String(pageValue(data.toString("utf8"))).toLowerCase() === SENTINEL) {
      throw new Refusal(`${rel} already sets ${SENTINEL_TOKEN} to the sentinel ${SENTINEL}; restore it before propagating`);
    }
    return { rel, data };
  });
  rmSync(safeChildPath({ base: dirname(journalDir), label: JOURNAL_LABEL }, basename(journalDir)), { recursive: true, force: true });
  for (const { rel, data } of files) {
    const target = journalPath(journalDir, "files", ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: "wx" });
    if (sha256(readFileSync(target)) !== sha256(data)) throw new Error(`journal copy of ${rel} does not match the original`);
  }
  const manifest: JournalManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    dsDir: dsReal,
    files: files.map(({ rel, data }) => ({ rel, sha256: sha256(data) })),
    buildInputs: buildInputsSha256(dsReal),
  };
  writeManifest(journalDir, manifest);
  return manifest;
}

/** Sets color.surface.page to the sentinel in every journaled theme file (each replaced by a rename, after a re-check). */
export function setSentinel(manifest: JournalManifest): void {
  for (const { rel } of manifest.files) {
    requireReal(manifest.dsDir, rel, "file");
    const json = JSON.parse(readFileSync(join(manifest.dsDir, rel), "utf8"));
    if (!json?.color?.surface?.page) throw new Error(`${rel} has no ${SENTINEL_TOKEN}`);
    json.color.surface.page.$value = SENTINEL;
    replaceThemeFile(manifest.dsDir, rel, `${JSON.stringify(json, null, 2)}\n`);
  }
}

export interface CommandResult {
  command: string;
  ok: boolean;
  status: number | null;
  output: string;
}

/** Package script names this module runs; the name is written into the build identity as is. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * The build's own shell ($0 bun, $1 script, $2 identity file, $3 its temp file) records its pid, group
 * and start time atomically (exclusive create, then rename), then execs bun, which keeps that pid and
 * start time. A build whose identity cannot be recorded does not run. ps, rm and mv are the system
 * binaries by absolute path (SYSTEM_BIN), never whatever PATH finds.
 */
function recordAndExec(): string {
  const ps = shellWord(SYSTEM_BIN.ps);
  return `pg=$(LC_ALL=C ${ps} -o pgid= -p $$) && st=$(LC_ALL=C ${ps} -o lstart= -p $$) && [ -n "$pg" ] && [ -n "$st" ] && /bin/rm -f "$3" && set -C && printf '{"pid":%s,"pgid":%s,"started":"%s","script":"%s"}\\n' "$$" $pg "$st" "$1" > "$3" && /bin/mv -f "$3" "$2" || { echo "propagate: could not record the build identity in $2; not building" >&2; exit 97; }
exec "$0" run "$1"`;
}

/** A path as one shell word (single-quoted unless plain). */
const shellWord = (value: string) => (/^[A-Za-z0-9_\/.:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/**
 * `bun run <script>` in a design-system directory, in its own process group: a Ctrl-C in the terminal
 * reaches this process (whose handler restores) but not the build, which always runs to the end.
 * With a journal, the manifest records the build (activeBuild) before it starts and the build records
 * its identity in `<journal>/build.json`, so a restore after a crash can stop it; both are cleared
 * when it returns. Synchronous on purpose: the signal handler's restore relies on it.
 */
export function runPackageScript(dsDir: string, script: string, journalDir?: string): CommandResult {
  const options = { cwd: dsDir, encoding: "utf8", env: process.env, detached: true } as Parameters<typeof spawnSync>[2] & { encoding: "utf8" };
  const finish = (result: ReturnType<typeof spawnSync>): CommandResult => ({
    command: `bun run ${script} (in ${dsDir})`,
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  });
  if (journalDir === undefined) return finish(spawnSync(process.execPath, ["run", script], options));
  if (!SCRIPT_NAME.test(script)) throw new Error(`package script name ${JSON.stringify(script)} does not match ${SCRIPT_NAME}`);
  const manifest = readJournal(journalDir);
  if (!manifest) throw new Refusal(`no propagate journal at ${journalDir} to record the build in`);
  // The apps ran while the sentinel build was live: a build script they changed never runs.
  if (manifest.buildInputs && buildInputsSha256(dsDir) !== manifest.buildInputs) {
    throw new Refusal(
      `${dsDir}: package.json, bunfig.toml, tsconfig.json or scripts/ changed since the propagate journal was written; refusing to run \`bun run ${script}\`. Check them, then rebuild by hand`,
    );
  }
  const identity = journalPath(journalDir, BUILD_IDENTITY);
  rmSync(identity, { force: true });
  writeManifest(journalDir, { ...manifest, activeBuild: { script, identity: BUILD_IDENTITY, requestedAt: new Date().toISOString() } });
  try {
    return finish(spawnSync(SYSTEM_BIN.sh, ["-c", recordAndExec(), process.execPath, script, identity, journalPath(journalDir, `${BUILD_IDENTITY}.tmp`)], options));
  } finally {
    clearActiveBuild(journalDir);
  }
}

function clearActiveBuild(journalDir: string): void {
  const manifest = readJournal(journalDir);
  if (manifest?.activeBuild) {
    const { activeBuild: _, ...rest } = manifest;
    writeManifest(journalDir, rest);
  }
  for (const name of [BUILD_IDENTITY, `${BUILD_IDENTITY}.tmp`]) rmSync(journalPath(journalDir, name), { force: true });
}

// -- stopping a build a crashed run left behind ------------------------------------------

const normalizeStart = (text: string) => text.trim().split(/\s+/).join(" ");

function ps(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(SYSTEM_BIN.ps, args, { encoding: "utf8", env: { ...process.env, PATH: SYSTEM_PATH, LC_ALL: "C" } });
  return { ok: result.status === 0, out: result.stdout ?? "" };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process's group and start time (whitespace normalized), or null once it is gone. `ps` is retried while the pid exists. */
function processIdentity(pid: number): { pgid: number; started: string } | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [pgid, ...started] = ps(["-o", "pgid=,lstart=", "-p", String(pid)]).out.trim().split(/\s+/);
    if (pgid && started.length && Number.isInteger(Number(pgid))) return { pgid: Number(pgid), started: started.join(" ") };
    if (!alive(pid)) return null;
    Bun.sleepSync(50);
  }
  throw new Error(`ps cannot read pid ${pid}, which exists; refusing to restore while it may be the build`);
}

/** Live (not zombie) members of a process group. An empty `ps -A` (never true: it lists this process) is a failure. */
function groupMembers(pgid: number): number[] {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { ok, out } = ps(["-A", "-o", "pid=,pgid=,stat="]);
    const rows = out
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 3 && Number.isInteger(Number(cols[0])));
    if (ok && rows.length) return rows.filter(([, group, stat]) => Number(group) === pgid && !stat!.startsWith("Z")).map(([pid]) => Number(pid));
    Bun.sleepSync(50);
  }
  throw new Error("ps -A failed; cannot tell whether the recorded build still runs");
}

function waitGroupGone(pgid: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  for (;;) {
    if (groupMembers(pgid).length === 0) return true;
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(100);
  }
}

export interface StoppedBuild {
  /** The recorded pid (0 when no identity was recorded). */
  pid: number;
  script: string;
  /** What happened: stopped (and how), already exited, a different process now, or no identity. */
  outcome: string;
}

/**
 * Stops the build a journal records as running, when its pid still names the same process (start time
 * and group match): SIGTERM to its group, up to 10 s, then SIGKILL while any member remains, up to 5 s.
 * A pid whose start time or group differs was reused and is never signalled. Never signals this process,
 * its group or a group id <= 1. Throws when the build cannot be stopped.
 */
function stopRecordedBuild(journalDir: string, active: NonNullable<JournalManifest["activeBuild"]>): StoppedBuild {
  const path = journalPath(journalDir, BUILD_IDENTITY);
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) Bun.sleepSync(50);
  const none = (why: string): StoppedBuild => ({ pid: 0, script: active.script, outcome: `${why}; nothing signalled` });
  if (!existsSync(path)) return none(`no ${BUILD_IDENTITY} 2 s after the build was requested (it never started)`);
  let id: { pid?: unknown; pgid?: unknown; started?: unknown };
  try {
    id = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return none(`${BUILD_IDENTITY} is not JSON`);
  }
  const { pid, pgid, started } = id;
  if (!Number.isInteger(pid) || !Number.isInteger(pgid) || typeof started !== "string") return none(`${BUILD_IDENTITY} has no pid, pgid and started`);
  const result = (outcome: string): StoppedBuild => ({ pid: pid as number, script: active.script, outcome });
  const now = processIdentity(pid as number);
  if (!now) return result("already exited");
  if (now.started !== normalizeStart(started) || now.pgid !== pgid) {
    return result(`not signalled: pid ${pid} is another process now (started ${now.started}, group ${now.pgid}; the build started ${normalizeStart(started)} in group ${pgid})`);
  }
  const own = processIdentity(process.pid)?.pgid;
  if (pid === process.pid || (pgid as number) <= 1 || pgid === own) {
    throw new Error(`the recorded build (pid ${pid}, group ${pgid}) is this process or its group; stop it by hand, then restore`);
  }
  try {
    process.kill(-(pgid as number), "SIGTERM");
  } catch {
    // the group ended between the check and the signal
  }
  if (waitGroupGone(pgid as number, 10_000)) return result(`stopped: SIGTERM to group ${pgid}`);
  // A group id is not reused while a member remains, so -pgid still names the build's group.
  const killDeadline = Date.now() + 5_000;
  for (let members = groupMembers(pgid as number); members.length; members = groupMembers(pgid as number)) {
    if (Date.now() >= killDeadline) throw new Error(`the recorded build's group ${pgid} survives SIGKILL (pids ${members.join(", ")}); not restoring`);
    try {
      process.kill(-(pgid as number), "SIGKILL");
    } catch {
      // the last member exited between the check and the signal
    }
    Bun.sleepSync(100);
  }
  return result(`stopped: SIGKILL to group ${pgid} after SIGTERM did not end it in 10 s`);
}

export interface RestoreResult {
  dsDir: string;
  /** Files copied back from the journal; empty when the journal was already restored. */
  restored: string[];
  /** The build the journal recorded as running (a crashed run's), and what was done about it before restoring. */
  stoppedBuild?: StoppedBuild;
  build: CommandResult;
  check: CommandResult;
  ok: boolean;
}

/**
 * Stops a build the journal records as running (stopRecordedBuild), copies the journaled theme files back
 * (verified by hash, each replaced by a rename after a re-check), marks the journal restored, then rebuilds
 * and runs `bun run check`. Rebuilds even when the journal was already restored, so a crash between the
 * copy and the build is repaired too. Throws when there is no journal, a recorded build cannot be stopped,
 * a copy does not verify, or a write could leave the design-system through a symlink.
 */
export function restoreFromJournal(journalDir: string): RestoreResult {
  let manifest = readJournal(journalDir);
  if (!manifest) throw new Refusal(`no propagate journal at ${journalDir}`);
  let stoppedBuild: StoppedBuild | undefined;
  if (manifest.activeBuild) {
    stoppedBuild = stopRecordedBuild(journalDir, manifest.activeBuild);
    clearActiveBuild(journalDir);
    manifest = readJournal(journalDir)!;
  }
  const restored: string[] = [];
  if (!manifest.restoredAt) {
    for (const { rel, sha256: expected } of manifest.files) {
      const saved = readFileSync(journalPath(journalDir, "files", ...rel.split("/")));
      if (sha256(saved) !== expected) throw new Error(`journal copy of ${rel} is corrupt (sha256 mismatch); restore it by hand from ${journalDir}`);
      const target = replaceThemeFile(manifest.dsDir, rel, saved);
      if (sha256(readFileSync(target)) !== expected) throw new Error(`restored ${target} does not match the journal`);
      restored.push(rel);
    }
    writeManifest(journalDir, { ...manifest, restoredAt: new Date().toISOString() });
  }
  checkTree(manifest.dsDir);
  const build = runPackageScript(manifest.dsDir, "build", journalDir);
  const check = runPackageScript(manifest.dsDir, "check", journalDir);
  return { dsDir: manifest.dsDir, restored, ...(stoppedBuild ? { stoppedBuild } : {}), build, check, ok: build.ok && check.ok };
}

/**
 * Journals the root's theme files, sets the sentinel, rebuilds, runs `check` (the apps), then restores,
 * rebuilds and runs `bun run check`, also when the build or `check` throws, or on an interrupt
 * (through the app runner's installSignalHandlers).
 */
export async function withSentinel<T>(dsDir: string, journalDir: string, check: () => Promise<T>): Promise<{ value: T; restore: RestoreResult }> {
  const manifest = writeJournal(dsDir, journalDir);
  // On Ctrl-C the runner's handler runs this, then stops every app, then exits 130.
  const removeStep = installSignalHandlers(() => {
    const result = restoreFromJournal(journalDir);
    const what = result.restored.length ? `restored ${result.restored.join(", ")}` : "theme files already restored";
    const stopped = result.stoppedBuild ? `; earlier build ${result.stoppedBuild.script} (pid ${result.stoppedBuild.pid}): ${result.stoppedBuild.outcome}` : "";
    console.error(`verify:apps: ${what} in ${result.dsDir}${stopped}; build ${result.build.ok ? "ok" : "FAILED"}, check ${result.check.ok ? "ok" : "FAILED"}`);
  });
  let value: T | undefined;
  let failure: unknown;
  try {
    setSentinel(manifest);
    checkTree(manifest.dsDir);
    const build = runPackageScript(manifest.dsDir, "build", journalDir);
    if (!build.ok) throw new Error(`${build.command} with the sentinel failed:\n${build.output}`);
    value = await check();
  } catch (error) {
    failure = error;
  }
  let restore: RestoreResult;
  try {
    restore = restoreFromJournal(journalDir);
  } catch (restoreError) {
    const message = `RESTORE FAILED: ${(restoreError as Error).message}. Run \`bun run verify:apps --restore --root <root>\` (journal: ${journalDir}).`;
    throw new Error(failure ? `${message}\nEarlier failure: ${(failure as Error)?.message ?? failure}` : message);
  } finally {
    removeStep();
  }
  if (failure) throw failure;
  return { value: value as T, restore };
}

export interface Eligibility {
  apps: AppEntry[];
  /** Every ledger row that is not eligible, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
  /** Ledger problems the parser reported (missing table, duplicate rows). */
  problems: string[];
}

/**
 * Apps the sentinel must reach: those listed, or else every ledger app that is done (the progress
 * page's rule: every pass apps.json requires is done; a pass it marks n/a does not count), runs (run
 * mode not none) and consumes the package live. Every other ledger row is reported with its reason.
 */
export function eligibleApps(registry: Registry, listed: string[], stateMd: string | null): Eligibility {
  if (listed.length) {
    return { apps: listed.map((id) => registry.apps.find((a) => a.id === id) ?? fail(`apps.json: no app "${id}"`)), skipped: [], problems: [] };
  }
  if (stateMd === null) throw new Refusal("--propagate without app ids reads the app_ledger in $DS_RUN/STATE.md, which is missing; list the apps");
  const ledger = parseLedger(stateMd);
  const apps: AppEntry[] = [];
  const skipped: Eligibility["skipped"] = [];
  for (const row of ledger.rows) {
    const app = registry.apps.find((a) => a.id === row.id);
    const cells = passCells(row, app);
    const state = appState(Object.values(cells));
    if (state !== "done") skipped.push({ id: row.id, reason: `not done (${state}: ${describePasses(cells)})` });
    else if (!app) skipped.push({ id: row.id, reason: "done in the ledger but not in apps.json" });
    else if (app.run.mode === "none") skipped.push({ id: app.id, reason: `run mode none: ${app.run.reason ?? "no reason"}` });
    else if (!LIVE_CONSUMERS.includes(app.consume.via)) skipped.push({ id: app.id, reason: `consumes the package via ${app.consume.via}, not live` });
    else apps.push(app);
  }
  return { apps, skipped, problems: ledger.problems };
}

// -- safety for the other tools -----------------------------------------------------

/** True when a build's dist/json gives color.surface.page the sentinel in any theme. */
export function holdsSentinel(dsDir: string): string | null {
  for (const theme of ["light", "dark"]) {
    const path = join(dsDir, "dist/json", `${theme}.json`);
    if (!existsSync(path)) continue;
    try {
      const value = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[SENTINEL_TOKEN];
      if (String(value).toLowerCase() === SENTINEL) return path;
    } catch {
      // an unreadable build is not the sentinel's business
    }
  }
  return null;
}

/**
 * Why a tool that reads the build (snapshot, verify:apps) must not run now: an unrestored propagate
 * journal in one of the out-dirs, or a design-system build whose page color is the sentinel. Null when clear.
 */
export function propagateBlocker(opts: { outDirs: Array<string | undefined>; dsDirs: string[] }): string | null {
  for (const outDir of new Set(opts.outDirs.filter((dir): dir is string => Boolean(dir)).map((dir) => resolve(dir)))) {
    const journalDir = join(outDir, "propagate-journal");
    const journal = readJournal(journalDir);
    if (journal && !journal.restoredAt) {
      return `an unrestored propagate journal (${journal.createdAt}) is at ${journalDir}: verify:apps --propagate is running or died; run \`bun run verify:apps --restore --root <root>\``;
    }
  }
  for (const dsDir of new Set(opts.dsDirs.map((dir) => resolve(dir)))) {
    const path = holdsSentinel(dsDir);
    if (path) return `${path} sets ${SENTINEL_TOKEN} to the propagate sentinel ${SENTINEL}: restore the theme files and rebuild first`;
  }
  return null;
}

/** sha256 of every file under tokens/themes and dist, by design-system-relative path. */
export function buildHashes(dsDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || (entry.isSymbolicLink() && statSync(full).isFile())) out[relative(dsDir, full)] = sha256(readFileSync(full));
    }
  };
  for (const dir of [THEMES_DIR, "dist"]) walk(join(dsDir, dir));
  return out;
}

/** Paths whose content differs between two buildHashes results: changed, added and removed. */
export function hashChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap((path) =>
    before[path] === after[path] ? [] : [`${path} ${before[path] === undefined ? "added" : after[path] === undefined ? "removed" : "changed"}`],
  );
}

function fail(message: string): never {
  throw new Refusal(message);
}
