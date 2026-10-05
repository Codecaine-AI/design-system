/**
 * `verify:apps --propagate`: prove a token change reaches every live-linked app.
 *
 * The root's design-system gets a sentinel page color (#ff00ff in every theme) and is rebuilt;
 * eligible apps must then paint their page with it. The theme files are journaled first and
 * restored (and the package rebuilt and checked) whatever happens. `--restore` replays the
 * journal after a crash.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { installSignalHandlers } from "../app-runner";
import type { AppEntry, ConsumeVia, Registry } from "../registry";
import { passesDone, readLedger } from "./ledger";

/** The owner's workspace. Propagate never rebuilds it. */
export const OWNER_TREE = "/Users/Ford/workspace";
export const SENTINEL = "#ff00ff";
export const SENTINEL_COMPUTED = "rgb(255, 0, 255)";
export const SENTINEL_TOKEN = "color.surface.page";
/** Ways of consuming the package that follow a rebuild without a reinstall or a repack. */
export const LIVE_CONSUMERS: readonly ConsumeVia[] = ["workspace", "link", "npm-file", "relative-import"];

const THEMES_DIR = "tokens/themes";
const MANIFEST = "manifest.json";

export class Refusal extends Error {}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));

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
  const ds = join(rootReal, "design-system");
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
}

export function readJournal(journalDir: string): JournalManifest | null {
  const path = join(journalDir, MANIFEST);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JournalManifest) : null;
}

function writeManifest(journalDir: string, manifest: JournalManifest) {
  const tmp = join(journalDir, `${MANIFEST}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, join(journalDir, MANIFEST));
}

function pageValue(text: string): unknown {
  return (JSON.parse(text) as any)?.color?.surface?.page?.$value;
}

/**
 * Copies every theme token file into the journal and writes the manifest, before anything changes.
 * Refuses when an unrestored journal exists or a theme already holds the sentinel.
 */
export function writeJournal(dsDir: string, journalDir: string): JournalManifest {
  const active = readJournal(journalDir);
  if (active && !active.restoredAt) {
    throw new Refusal(`an unrestored propagate journal from ${active.createdAt} is at ${journalDir}; run \`bun run verify:apps --restore --root <root>\` first`);
  }
  const dsReal = realpathSync(dsDir);
  const rels = readdirSync(join(dsReal, THEMES_DIR))
    .filter((name) => name.endsWith(".tokens.json"))
    .sort()
    .map((name) => `${THEMES_DIR}/${name}`);
  if (rels.length === 0) throw new Refusal(`no theme token files in ${join(dsReal, THEMES_DIR)}`);
  const files = rels.map((rel) => {
    const data = readFileSync(join(dsReal, rel));
    if (String(pageValue(data.toString("utf8"))).toLowerCase() === SENTINEL) {
      throw new Refusal(`${rel} already sets ${SENTINEL_TOKEN} to the sentinel ${SENTINEL}; restore it before propagating`);
    }
    return { rel, data };
  });
  rmSync(journalDir, { recursive: true, force: true });
  for (const { rel, data } of files) {
    const target = join(journalDir, "files", rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (sha256(readFileSync(target)) !== sha256(data)) throw new Error(`journal copy of ${rel} does not match the original`);
  }
  const manifest: JournalManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    dsDir: dsReal,
    files: files.map(({ rel, data }) => ({ rel, sha256: sha256(data) })),
  };
  writeManifest(journalDir, manifest);
  return manifest;
}

/** Sets color.surface.page to the sentinel in every journaled theme file. */
export function setSentinel(manifest: JournalManifest): void {
  for (const { rel } of manifest.files) {
    const path = join(manifest.dsDir, rel);
    const json = JSON.parse(readFileSync(path, "utf8"));
    if (!json?.color?.surface?.page) throw new Error(`${rel} has no ${SENTINEL_TOKEN}`);
    json.color.surface.page.$value = SENTINEL;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
}

export interface CommandResult {
  command: string;
  ok: boolean;
  status: number | null;
  output: string;
}

/** `bun run <script>` in a design-system directory. */
export function runPackageScript(dsDir: string, script: string): CommandResult {
  const result = spawnSync(process.execPath, ["run", script], { cwd: dsDir, encoding: "utf8", env: process.env });
  return {
    command: `bun run ${script} (in ${dsDir})`,
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

export interface RestoreResult {
  dsDir: string;
  /** Files copied back from the journal; empty when the journal was already restored. */
  restored: string[];
  build: CommandResult;
  check: CommandResult;
  ok: boolean;
}

/**
 * Copies the journaled theme files back (verified by hash), marks the journal restored, then rebuilds
 * and runs `bun run check`. Rebuilds even when the journal was already restored, so a crash between
 * the copy and the build is repaired too. Throws when there is no journal or a copy does not verify.
 */
export function restoreFromJournal(journalDir: string): RestoreResult {
  const manifest = readJournal(journalDir);
  if (!manifest) throw new Refusal(`no propagate journal at ${journalDir}`);
  const restored: string[] = [];
  if (!manifest.restoredAt) {
    for (const { rel, sha256: expected } of manifest.files) {
      const saved = readFileSync(join(journalDir, "files", rel));
      if (sha256(saved) !== expected) throw new Error(`journal copy of ${rel} is corrupt (sha256 mismatch); restore it by hand from ${journalDir}`);
      const target = join(manifest.dsDir, rel);
      writeFileSync(target, saved);
      if (sha256(readFileSync(target)) !== expected) throw new Error(`restored ${target} does not match the journal`);
      restored.push(rel);
    }
    writeManifest(journalDir, { ...manifest, restoredAt: new Date().toISOString() });
  }
  const build = runPackageScript(manifest.dsDir, "build");
  const check = runPackageScript(manifest.dsDir, "check");
  return { dsDir: manifest.dsDir, restored, build, check, ok: build.ok && check.ok };
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
    console.error(`verify:apps: ${what} in ${result.dsDir}; build ${result.build.ok ? "ok" : "FAILED"}, check ${result.check.ok ? "ok" : "FAILED"}`);
  });
  let value: T | undefined;
  let failure: unknown;
  try {
    setSentinel(manifest);
    const build = runPackageScript(manifest.dsDir, "build");
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
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Apps the sentinel must reach: those listed, or else every ledger app whose passes are all done
 * (or n/a) that runs (run mode not none) and consumes the package live.
 */
export function eligibleApps(registry: Registry, listed: string[], stateMd: string | null): Eligibility {
  if (listed.length) {
    return { apps: listed.map((id) => registry.apps.find((a) => a.id === id) ?? fail(`apps.json: no app "${id}"`)), skipped: [] };
  }
  if (stateMd === null) throw new Refusal("--propagate without app ids reads the app_ledger in $DS_RUN/STATE.md, which is missing; list the apps");
  const apps: AppEntry[] = [];
  const skipped: Eligibility["skipped"] = [];
  for (const row of readLedger(stateMd)) {
    if (!passesDone(row)) continue;
    const app = registry.apps.find((a) => a.id === row.id);
    if (!app) skipped.push({ id: row.id, reason: "done in the ledger but not in apps.json" });
    else if (app.run.mode === "none") skipped.push({ id: app.id, reason: `run mode none: ${app.run.reason ?? "no reason"}` });
    else if (!LIVE_CONSUMERS.includes(app.consume.via)) skipped.push({ id: app.id, reason: `consumes the package via ${app.consume.via}, not live` });
    else apps.push(app);
  }
  return { apps, skipped };
}

function fail(message: string): never {
  throw new Refusal(message);
}
