/**
 * Shot sets on disk, and the exact pixel diff between two of them.
 *
 *   <out-dir>/<app>/shots/<set>/<route>-<theme>.png   one PNG per shot
 *   <out-dir>/<app>/shots/<set>/manifest.json          SetManifest
 *   <out-dir>/<app>/diffs/<a>-vs-<b>/                  snapshot:diff output
 *   <out-dir>/<app>/sheets/<a>-vs-<b>.html (+ dir)     snapshot:sheet output
 *
 * Every path under the out dir goes through safeChildPath (setPath, diffPath, sheetPath): each segment
 * is one plain name, and no component on the way may be a symlink.
 *
 * Pixels compare exactly: any RGBA channel that differs is a changed pixel. Pixels inside a mask box
 * never count, unless the two images differ in size: then every pixel outside the smaller image is
 * changed. Only the mask selectors the current apps.json lists for the route count; their boxes come
 * from each set's manifest.
 *
 * The sets are judged against the current registry entry, never against what a manifest says: the
 * expected shots (every route x theme), gating, reasons, darkDiffers and mask selectors all come from
 * apps.json. The pixel gate (`ok`) also fails on anything that makes the comparison meaningless: a set
 * without a manifest, an incomplete set (its capture never finished), a set captured with a different
 * capture spec of the app, a set whose runs broke isolation (violations, start or stop errors, an
 * unproven profile, no sandbox, a request to an owner port), an expected shot missing or failed, a
 * partial set compared without a matching `--only`, shots captured from different trees (mixed
 * provenance, including uncommitted content), a B set the tree being gated no longer matches (its app
 * HEAD, uncommitted content or design-system files changed since capture), a shot without content provenance, a shot that never
 * settled, a PNG the manifest does not list, a registry mask with no recorded boxes, mask boxes that
 * differ between A and B, and a dark shot identical to its light shot on a route that sets `darkDiffers`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { guardVerdict } from "./app-runner";
import { routeThemes, shotKey } from "./capture";
import { decodePng, type RgbaImage } from "./png";
import { staleFields, type TreeState } from "./provenance";
import { REGISTRY_PATH, type AppEntry, type RouteSpec } from "./registry";
import { safeChildPath } from "./safe-paths";

export type Theme = "light" | "dark";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a shot came from. Two shots of one set must share everything but `capturedAt`. */
export interface ShotProvenance {
  /** The app repo's HEAD, and the sha256 of its `git status --porcelain` output (uncommitted paths). */
  appHead: string;
  appStatusSha256: string;
  /** Uncommitted paths in the app repo. */
  appDirty: number;
  /**
   * sha256 of the app repo's uncommitted content: `git diff --binary HEAD`, then each untracked file
   * under the app's root and scan paths with the sha256 of its content. Older manifests lack it.
   */
  appContentSha256?: string;
  /** HEAD of the design-system the app renders with (inside --root). */
  designSystemHead: string;
  /** sha256 of that design-system's dist/css/tokens.css. */
  tokensCssSha256: string | null;
  /** sha256 over every file of that design-system's dist/, css/ and fonts/ (path and content). Older manifests lack it. */
  designSystemFilesSha256?: string;
  capturedAt: string;
}

export interface ShotEntry {
  key: string;
  route: string;
  theme: Theme;
  url?: string;
  viewport?: { width: number; height: number };
  /** false: captured, but a change never fails the pixel gate (the registry gives the reason). */
  gating: boolean;
  reason?: string;
  /** The registry route sets darkDiffers: its dark shot must not equal its light shot. */
  darkDiffers?: boolean;
  /** Mask selectors and the boxes they covered at capture time (CSS px, clipped to the viewport). */
  masks: Array<{ selector: string; boxes: Box[] }>;
  /** false: the capture never settled (no two consecutive frames matched). */
  stable?: boolean;
  /** The capture failed; the set has no PNG for the shot. */
  error?: string;
  provenance?: ShotProvenance;
  [extra: string]: unknown;
}

/** A shot the registry asks for: every route × every theme it requires. */
export interface ExpectedShot {
  key: string;
  route: string;
  theme: Theme;
  gating: boolean;
  darkDiffers?: boolean;
}

/** The apps.json a set was captured from: its path, the file's sha256, and the app's capture spec (captureSha256). */
export interface RegistryRecord {
  path: string;
  sha256: string;
  captureSha256: string;
}

/** One capture run of a set (an --only merge holds several): how it ran, and what the guard blocked. */
export interface RunRecord {
  mode: string;
  startedAt?: string;
  finishedAt?: string;
  baseUrl?: string;
  ports?: Record<string, number>;
  startedPorts?: number[];
  logPath?: string;
  unproven?: boolean;
  unsandboxed?: boolean;
  /** Isolation violations the runner recorded (egress, owner ports). */
  violations?: string[];
  startError?: string;
  stopError?: string;
  blockedRequests?: string[];
  expectedBlocked?: string[];
  [extra: string]: unknown;
}

export interface SetManifest {
  app: string;
  set: string;
  /** true while a capture runs: a set whose capture died never loses it. The final manifest has no field. */
  incomplete?: boolean;
  startedAt?: string;
  /** Keys of every shot the registry asked for when the set was captured (all routes, whatever --only said). */
  expectedKeys?: string[];
  expected?: ExpectedShot[];
  /** The --only routes the set was captured with (merged runs: the union), or null for a full set. */
  only?: string[] | null;
  registry?: RegistryRecord;
  /** Every run whose shots the set holds; `run` is the latest. */
  runs?: RunRecord[];
  run?: RunRecord;
  blockedRequests?: string[];
  expectedBlocked?: string[];
  shots: ShotEntry[];
  [extra: string]: unknown;
}

export const SET_NAME = /^[A-Za-z0-9._-]+$/;

export function defaultOutDir(): string {
  return process.env.DS_RUN || join(tmpdir(), "ds-rollout");
}

/** `<out>/<app>/shots/<set>[/<file>]`, every component checked (safeChildPath). */
export function setPath(outDir: string, app: string, set: string, ...file: string[]): string {
  return safeChildPath({ base: outDir, label: "shot set" }, app, "shots", set, ...file);
}

/** `<out>/<app>/diffs/<a>-vs-<b>[/<file>...]`, every component checked. */
export function diffPath(outDir: string, app: string, a: string, b: string, ...file: string[]): string {
  return safeChildPath({ base: outDir, label: "diff" }, app, "diffs", `${a}-vs-${b}`, ...file);
}

/** `<out>/<app>/sheets/<name...>`, every component checked. */
export function sheetPath(outDir: string, app: string, ...name: string[]): string {
  return safeChildPath({ base: outDir, label: "sheet" }, app, "sheets", ...name);
}

export function readManifest(dir: string): SetManifest | null {
  const path = join(dir, "manifest.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SetManifest) : null;
}

/** Writes a set's manifest.json through a temp file and a rename, so a reader never sees half a file. */
export function writeManifest(outDir: string, app: string, set: string, manifest: SetManifest): void {
  const tmp = setPath(outDir, app, set, `manifest.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, setPath(outDir, app, set, "manifest.json"));
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** JSON with every object's keys sorted, so equal values always hash the same. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * sha256 of the part of an app's registry entry that decides what a capture looks like: where the app
 * comes from (id, repo, root), how it runs (run, commands.cwd and .build, the run profile's env,
 * unsetEnv, fixtures, flags, ports and allowedLocalPorts), its theme rule and dark switch, and its routes
 * (path, themes, viewport, waitFor, steps). Two sets compare only when it matches.
 *
 * It leaves out what snapshot:diff reads from the current apps.json anyway (each route's masks, gating,
 * reason and darkDiffers) and what changes during a migration without changing a pixel (literalFloor,
 * verify probes, the profile's proof, passes and checks). A whole-file sha would fail every set
 * captured before such an edit; the manifest records that sha as well, and a difference there alone is
 * a warning.
 */
export function captureSha256(app: AppEntry): string {
  const profile = app.runProfile ?? ({} as Partial<AppEntry["runProfile"]>);
  const spec = {
    id: app.id,
    repo: app.repo,
    root: app.root,
    theme: { rule: app.theme?.rule ?? null },
    verify: { darkSwitch: app.verify?.darkSwitch ?? null },
    run: app.run ?? null,
    commands: { cwd: app.commands?.cwd ?? null, build: app.commands?.build ?? null },
    runProfile: {
      env: profile.env ?? null,
      unsetEnv: profile.unsetEnv ?? null,
      fixtures: profile.fixtures ?? null,
      flags: profile.flags ?? null,
      ports: profile.ports ?? null,
      allowedLocalPorts: profile.allowedLocalPorts ?? null,
    },
    routes: (app.routes ?? []).map(({ masks: _masks, gating: _gating, reason: _reason, darkDiffers: _darkDiffers, ...route }) => route),
  };
  return sha256Hex(sortedJson(spec));
}

/** PNG keys present in a set dir (file names without .png). */
export function setKeys(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .map((name) => name.slice(0, -4))
    .sort();
}

/** Route and theme of a key, from the manifest when it lists the shot. */
export function splitKey(key: string, entry?: { route: string; theme: Theme }): { route: string; theme: Theme | "unknown" } {
  if (entry) return { route: entry.route, theme: entry.theme };
  const match = /^(.*)-(light|dark)$/.exec(key);
  return match ? { route: match[1]!, theme: match[2] as Theme } : { route: key, theme: "unknown" };
}

/** What makes two captures comparable: everything in the provenance but the time. */
export function provenanceKey(p: ShotProvenance): string {
  const short = (value: string | null | undefined, n: number) => (value ?? "none").slice(0, n);
  return (
    `app ${p.appHead.slice(0, 12)}${p.appDirty ? ` +${p.appDirty} uncommitted (${p.appStatusSha256.slice(0, 8)})` : ""}` +
    ` content ${short(p.appContentSha256, 8)}, design-system ${p.designSystemHead.slice(0, 12)}` +
    ` files ${short(p.designSystemFilesSha256, 8)}, tokens.css ${short(p.tokensCssSha256, 12)}`
  );
}

export interface PixelDiff {
  image: RgbaImage;
  changed: number;
  masked: number;
  total: number;
  maxDelta: number;
  bbox?: Box;
}

const CHANGED = [255, 0, 255, 255] as const;
const MASKED = [120, 200, 255, 255] as const;

function inBoxes(x: number, y: number, boxes: Box[]): boolean {
  for (const box of boxes) if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return true;
  return false;
}

/**
 * Exact RGBA diff. The diff image shows unchanged pixels as B faded to light gray, changed pixels
 * magenta, and masked pixels light blue. Pixels outside one image's bounds count as changed, masked
 * or not: a mask never hides a size change.
 */
export function diffImages(a: RgbaImage, b: RgbaImage, masks: Box[] = []): PixelDiff {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = new Uint8Array(width * height * 4);
  let changed = 0;
  let masked = 0;
  let maxDelta = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      if (inA && inB && masks.length && inBoxes(x, y, masks)) {
        masked++;
        out.set(MASKED, o);
        continue;
      }
      let differs = !(inA && inB);
      if (inA && inB) {
        const ia = (y * a.width + x) * 4;
        const ib = (y * b.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          const delta = Math.abs(a.data[ia + c]! - b.data[ib + c]!);
          if (delta > 0) {
            differs = true;
            if (delta > maxDelta) maxDelta = delta;
          }
        }
      }
      if (differs) {
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        out.set(CHANGED, o);
      } else {
        const ib = (y * b.width + x) * 4;
        const gray = 0.299 * b.data[ib]! + 0.587 * b.data[ib + 1]! + 0.114 * b.data[ib + 2]!;
        const faded = Math.round(255 - (255 - gray) * 0.25);
        out[o] = out[o + 1] = out[o + 2] = faded;
        out[o + 3] = 255;
      }
    }
  }
  return {
    image: { width, height, data: out },
    changed,
    masked,
    total: width * height,
    maxDelta: maxDelta || (changed > 0 ? 255 : 0),
    bbox: changed > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined,
  };
}

/** Images side by side on a neutral background, top-aligned, `gap` px apart. */
export function sideBySide(images: RgbaImage[], gap = 16): RgbaImage {
  const width = images.reduce((sum, image) => sum + image.width, 0) + gap * (images.length + 1);
  const height = Math.max(...images.map((image) => image.height)) + gap * 2;
  const data = new Uint8Array(width * height * 4).fill(200);
  let left = gap;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      const src = image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4);
      data.set(src, ((y + gap) * width + left) * 4);
    }
    left += image.width + gap;
  }
  return { width, height, data };
}

/** error-in-x: the set's manifest records a failed capture for the shot (whatever PNG is on disk). */
export type ShotStatus = "identical" | "changed" | "missing-in-a" | "missing-in-b" | "error-in-a" | "error-in-b";

export interface ShotDiff {
  key: string;
  route: string;
  theme: Theme | "unknown";
  status: ShotStatus;
  gating: boolean;
  reason?: string;
  sizeMatch: boolean;
  sizeA?: [number, number];
  sizeB?: [number, number];
  /** Changed pixels outside masks (every pixel outside the smaller image when the sizes differ). */
  changedPixels: number;
  maskedPixels: number;
  totalPixels: number;
  percentChanged: number;
  maxChannelDelta: number;
  bbox?: Box;
  masks: Box[];
  /** The capture error a manifest recorded for this shot. */
  error?: string;
  /** Why the shot cannot pass, besides its status (unstable, unlisted PNG, mask boxes differ, dark equals light). */
  problems: string[];
  /** Reported, never failing (dark equals light on a route without darkDiffers). */
  warnings: string[];
}

export interface SetDiff {
  app: string;
  a: string;
  b: string;
  generatedAt: string;
  comparison: "exact RGBA outside masks";
  /** The apps.json the sets were judged against; `canonical` when it is the checkout's own apps.json. */
  registry: { path: string; sha256: string; captureSha256: string; canonical: boolean };
  /** The tree B was checked against at diff time (--root), and its state then; null when not checked. */
  tree: { root: string; state: TreeState } | null;
  /** The diff's --only selection, or null for every shot. */
  only: string[] | null;
  /** The --only each set was captured with (null: a full set). */
  setOnly: { a: string[] | null; b: string[] | null };
  /**
   * The --exact gate: at least one shot compared, no set-level problem, and no gating shot changed,
   * went missing, failed, or has a problem.
   */
  ok: boolean;
  /** Problems with a whole set (no manifest, incomplete, another capture spec, a run that broke isolation, mixed provenance, ...). */
  problems: string[];
  warnings: string[];
  totals: { shots: number; identical: number; changed: number; missing: number; gatingFailures: number; changedPixels: number; problems: number };
  shots: ShotDiff[];
  /** Per key, the diff image (only for keys present in both sets). */
  images: Map<string, PixelDiff>;
}

/** Bad arguments for a diff (same set twice, unknown --only id, a missing set): the CLIs exit 2. */
export class DiffUsageError extends Error {}

const sha = (data: Buffer) => sha256Hex(data);

interface Side {
  label: "A" | "B";
  name: string;
  dir: string;
  manifest: SetManifest | null;
  pngs: Set<string>;
  entries: Map<string, ShotEntry>;
}

function readSide(label: "A" | "B", outDir: string, app: string, name: string): Side {
  const dir = setPath(outDir, app, name);
  if (!existsSync(dir)) throw new DiffUsageError(`no such shot set: ${dir}`);
  const manifest = readManifest(dir);
  return { label, name, dir, manifest, pngs: new Set(setKeys(dir)), entries: new Map((manifest?.shots ?? []).map((shot) => [shot.key, shot])) };
}

/** A shot the current registry expects: its key, route and theme. */
interface RegistryShot {
  key: string;
  route: RouteSpec;
  theme: Theme;
}

/** Every route x theme of the app in the current registry, by key. */
function registryShots(app: AppEntry): Map<string, RegistryShot> {
  const shots = new Map<string, RegistryShot>();
  for (const route of app.routes ?? []) for (const theme of routeThemes(app, route)) shots.set(shotKey(route, theme), { key: shotKey(route, theme), route, theme });
  return shots;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The runs a manifest records: `runs`, else the single `run` of an older manifest. */
function runsOf(manifest: SetManifest): RunRecord[] {
  return manifest.runs ?? (manifest.run ? [manifest.run] : []);
}

/** Whether a guard entry ("GET http://...", "WS ws://...") went to an owner port on loopback. */
function isOwnerPortRequest(entry: string): boolean {
  try {
    return guardVerdict(new URL(entry.slice(entry.indexOf(" ") + 1)), new Set()) === "owner-port";
  } catch {
    return false;
  }
}

/**
 * Requests the guard blocked as unexpected (a port the run did not start, a host off the machine),
 * anywhere in the manifest: decision 22 treats every listener the run did not start as an owner service.
 * Expected blocks (the profile's own unbound named ports) are not among them.
 */
function unexpectedRequests(manifest: SetManifest): string[] {
  const lists = [manifest.blockedRequests, ...runsOf(manifest).map((run) => run.blockedRequests), ...manifest.shots.map((shot) => shot.blocked)];
  return [...new Set(lists.flatMap(strings))];
}

/** Every blocked request the manifest records, anywhere, that went to an owner port. */
function ownerPortRequests(manifest: SetManifest): string[] {
  const lists = [
    manifest.blockedRequests,
    manifest.expectedBlocked,
    ...runsOf(manifest).flatMap((run) => [run.blockedRequests, run.expectedBlocked]),
    ...manifest.shots.flatMap((shot) => [shot.blocked, shot.expectedBlocked]),
  ];
  return [...new Set(lists.flatMap(strings))].filter(isOwnerPortRequest);
}

/** Why a set's runs make it worthless: no run recorded, isolation violations, start or stop errors, an unproven or unsandboxed run. */
function runProblems(tag: string, manifest: SetManifest): string[] {
  const runs = runsOf(manifest);
  if (runs.length === 0) return [`${tag} records no capture run (an older snapshot); capture again`];
  const problems: string[] = [];
  runs.forEach((run, index) => {
    const which = runs.length > 1 ? `run ${index + 1} of ${runs.length}${run.startedAt ? ` (${run.startedAt})` : ""}` : "its run";
    for (const violation of strings(run.violations)) problems.push(`${tag}: ${which} broke isolation: ${violation}`);
    if (run.startError) problems.push(`${tag}: ${which} failed: ${run.startError}`);
    if (run.stopError) problems.push(`${tag}: ${which} did not stop cleanly: ${run.stopError}`);
    if (run.unproven) problems.push(`${tag}: ${which} used an unproven run profile`);
    if (run.unsandboxed) problems.push(`${tag}: ${which} had no OS sandbox`);
  });
  return problems;
}

interface Judge {
  app: AppEntry;
  registry: { path: string; sha256: string };
  captureSha256: string;
}

/** Whether the set was captured with the app's current capture spec. A different file with the same spec is a warning. */
function registryRecordProblems(tag: string, manifest: SetManifest, judge: Judge, warnings: string[]): string[] {
  const record = manifest.registry;
  if (!record?.captureSha256) return [`${tag} records no registry (an older snapshot); capture again`];
  const short = (value: string | undefined) => (value ?? "none").slice(0, 12);
  if (record.captureSha256 !== judge.captureSha256)
    return [
      `${tag} was captured with a different apps.json entry for ${judge.app.id} (${record.path}, capture spec ${short(record.captureSha256)} vs current ${short(judge.captureSha256)}); capture again`,
    ];
  if (record.sha256 !== judge.registry.sha256)
    warnings.push(`${tag} was captured from ${record.path} (sha256 ${short(record.sha256)}), judged against ${judge.registry.path} (sha256 ${short(judge.registry.sha256)}): the capture spec of ${judge.app.id} is the same`);
  return [];
}

/** Set-level problems of one side, for the selected keys. */
function sideProblems(side: Side, keys: string[], diffOnly: string[] | null, judge: Judge, warnings: string[]): string[] {
  const problems: string[] = [];
  const { label, name, manifest } = side;
  const tag = `${label} (${name})`;
  if (!manifest) return [`${tag} has no manifest.json: nothing says what was captured or how`];
  if (manifest.incomplete) problems.push(`${tag} is incomplete: its capture started ${manifest.startedAt ?? "at an unknown time"} and never finished`);
  if (!manifest.expectedKeys) problems.push(`${label} (${name}): the manifest has no expectedKeys (an older snapshot); capture the set again`);
  if (manifest.only?.length && !diffOnly)
    problems.push(`${tag} is a partial set (captured with --only ${manifest.only.join(",")}); compare it with a matching --only`);
  problems.push(...registryRecordProblems(tag, manifest, judge, warnings), ...runProblems(tag, manifest));
  const list = (items: string[]) => `${items.slice(0, 5).join(", ")}${items.length > 5 ? ` (+${items.length - 5})` : ""}`;
  const owner = ownerPortRequests(manifest);
  if (owner.length) problems.push(`${tag} made request(s) to owner ports: ${list(owner)}`);
  const blocked = unexpectedRequests(manifest).filter((entry) => !owner.includes(entry));
  if (blocked.length) problems.push(`${tag} made request(s) the guard blocked (a port the run did not start, or off the machine): ${list(blocked)}`);
  const provenances = new Map<string, string[]>();
  const unproven: string[] = [];
  const noContent: string[] = [];
  for (const key of keys) {
    const entry = side.entries.get(key);
    if (!entry || entry.error) continue;
    if (!entry.provenance) {
      unproven.push(key);
      continue;
    }
    if (!entry.provenance.appContentSha256 || !entry.provenance.designSystemFilesSha256) noContent.push(key);
    const id = provenanceKey(entry.provenance);
    provenances.set(id, [...(provenances.get(id) ?? []), key]);
  }
  if (unproven.length) problems.push(`${tag}: ${unproven.length} shot(s) record no provenance (${unproven.slice(0, 3).join(", ")}); capture the set again`);
  if (noContent.length) problems.push(`${tag}: ${noContent.length} shot(s) record no content provenance (an older snapshot: ${noContent.slice(0, 3).join(", ")}); capture again`);
  if (provenances.size > 1) {
    const list = [...provenances].map(([id, ks]) => `${id}: ${ks.slice(0, 3).join(", ")}${ks.length > 3 ? ` (+${ks.length - 3})` : ""}`);
    problems.push(`${tag} mixes captures of different trees: ${list.join(" | ")}`);
  }
  return problems;
}

/** The registry selectors' boxes in one shot, by selector (JSON), for the selectors the shot recorded. */
function maskBoxes(shot: ShotEntry, selectors: string[]): Map<string, string> {
  return new Map((shot.masks ?? []).filter((mask) => selectors.includes(mask.selector)).map((mask) => [mask.selector, JSON.stringify(mask.boxes)]));
}

/** Registry mask selectors whose boxes differ between A and B (a selector one side never recorded is reported per side). */
function maskProblems(shotA: ShotEntry | undefined, shotB: ShotEntry | undefined, selectors: string[]): string[] {
  if (!shotA || !shotB) return [];
  const a = maskBoxes(shotA, selectors);
  const b = maskBoxes(shotB, selectors);
  const problems: string[] = [];
  for (const selector of selectors) {
    if (!a.has(selector) || !b.has(selector) || a.get(selector) === b.get(selector)) continue;
    const count = (json: string) => `${(JSON.parse(json) as Box[]).length} box(es)`;
    problems.push(`mask ${selector} covers different boxes in A (${count(a.get(selector)!)}) and B (${count(b.get(selector)!)})`);
  }
  return problems;
}

/** Per side with a PNG and a listed shot: registry selectors it recorded no boxes for (problems), selectors apps.json dropped (warnings). */
function recordedMaskFindings(side: Side, key: string, selectors: string[]): { problems: string[]; warnings: string[] } {
  const entry = side.entries.get(key);
  if (!entry || entry.error || !side.pngs.has(key)) return { problems: [], warnings: [] };
  const recorded = new Set((entry.masks ?? []).map((mask) => mask.selector));
  return {
    problems: selectors.filter((selector) => !recorded.has(selector)).map((selector) => `mask ${selector} from apps.json has no boxes recorded in ${side.label}; capture again`),
    warnings: [...recorded].filter((selector) => !selectors.includes(selector)).map((selector) => `${side.label} recorded mask ${selector}, which apps.json no longer lists; ignored`),
  };
}

/**
 * B shots whose recorded provenance the tree no longer matches (app HEAD, uncommitted content, the
 * design-system's dist/css/fonts): B must show the tree being gated. A is a historical baseline and is
 * never checked against the tree.
 */
function staleProblems(side: Side, keys: string[], tree: { root: string; state: TreeState }): string[] {
  const byField = new Map<string, string[]>();
  for (const key of keys) {
    const entry = side.entries.get(key);
    if (!entry?.provenance || entry.error) continue;
    for (const field of staleFields(entry.provenance, tree.state)) byField.set(field, [...(byField.get(field) ?? []), key]);
  }
  if (byField.size === 0) return [];
  const changed = [...byField].map(([field, ks]) => `${field} (${ks.slice(0, 3).join(", ")}${ks.length > 3 ? ` +${ks.length - 3}` : ""})`);
  return [`${side.label} (${side.name}) no longer matches the tree at ${tree.root}: ${changed.join("; ")} changed since capture; recapture ${side.label}`];
}

/**
 * Diffs two sets of `app` against the current registry entry. The shots compared are the registry's
 * (every route x theme); a key only a set holds is not compared (a warning), but a PNG its manifest
 * does not list is still a problem. `only` selects registry routes or keys; any other id is a usage
 * error, and so are `a === b` and a missing set. `registry` is the apps.json `app` was loaded from.
 * `tree` is the state of the tree being gated (provenance.ts treeState of --root): every B shot must
 * still match it.
 */
export function diffSets(
  outDir: string,
  app: AppEntry,
  a: string,
  b: string,
  only: string[] | undefined,
  registry: { path: string; sha256: string },
  tree: { root: string; state: TreeState } | null = null,
): SetDiff {
  if (a === b) throw new DiffUsageError(`--a and --b are the same set (${a}): a set always matches itself`);
  const judge: Judge = { app, registry, captureSha256: captureSha256(app) };
  const expected = registryShots(app);
  const A = readSide("A", outDir, app.id, a);
  const B = readSide("B", outDir, app.id, b);
  const diffOnly = only?.length ? only : null;
  if (diffOnly) {
    const unknown = diffOnly.filter((id) => !expected.has(id) && !(app.routes ?? []).some((route) => route.id === id));
    if (unknown.length) throw new DiffUsageError(`--only names no route or shot of ${app.id} in ${registry.path}: ${unknown.join(", ")}`);
  }

  const routeOf = (key: string) => {
    const known = expected.get(key);
    return known ? { route: known.route.id, theme: known.theme } : splitKey(key, B.entries.get(key) ?? A.entries.get(key));
  };
  // Keys come from the registry, the PNGs and both manifests' shots; only the registry's are compared.
  const universe = [...new Set([...expected.keys(), ...A.pngs, ...B.pngs, ...A.entries.keys(), ...B.entries.keys()])].sort();
  const selected = universe.filter((key) => !diffOnly || diffOnly.includes(key) || diffOnly.includes(routeOf(key).route));
  const keys = selected.filter((key) => expected.has(key));

  const warnings: string[] = [];
  const problems = [...sideProblems(A, keys, diffOnly, judge, warnings), ...sideProblems(B, keys, diffOnly, judge, warnings), ...(tree ? staleProblems(B, keys, tree) : [])];
  for (const key of selected.filter((k) => !expected.has(k))) {
    warnings.push(`${key}: not a shot of ${app.id} in ${registry.path}; not compared`);
    for (const side of [A, B]) if (side.pngs.has(key) && !side.entries.has(key)) problems.push(`${side.label} has ${key}.png but its manifest does not list the shot`);
  }
  const shots: ShotDiff[] = [];
  const images = new Map<string, PixelDiff>();
  for (const key of keys) {
    const { route: spec, theme } = expected.get(key)!;
    const shotA = A.entries.get(key);
    const shotB = B.entries.get(key);
    // Gating, reason and masks come from the current registry route, never from a manifest.
    const gating = spec.gating !== false;
    const selectors = spec.masks ?? [];
    const masks = [shotA, shotB].flatMap((shot) => (shot?.masks ?? []).filter((mask) => selectors.includes(mask.selector)).flatMap((mask) => mask.boxes));
    const shotProblems: string[] = [];
    const shotWarnings: string[] = [];
    for (const side of [A, B]) {
      const entry = side.entries.get(key);
      if (side.pngs.has(key) && !entry) shotProblems.push(`${side.label} has ${key}.png but its manifest does not list the shot`);
      if (entry && !entry.error && entry.stable === false) shotProblems.push(`${side.label}: the capture never settled (stable: false)`);
      const recorded = recordedMaskFindings(side, key, selectors);
      shotProblems.push(...recorded.problems);
      shotWarnings.push(...recorded.warnings);
    }
    shotProblems.push(...maskProblems(shotA, shotB, selectors));
    const base = { key, route: spec.id, theme, gating, ...(spec.reason ? { reason: spec.reason } : {}), masks, problems: shotProblems, warnings: shotWarnings };
    const errorB = typeof shotB?.error === "string" ? shotB.error : undefined;
    const errorA = typeof shotA?.error === "string" ? shotA.error : undefined;
    if (errorA || errorB || !A.pngs.has(key) || !B.pngs.has(key)) {
      if (!A.pngs.has(key) && !B.pngs.has(key) && !errorA && !errorB) shotProblems.push("missing in both sets");
      shots.push({
        ...base,
        status: errorB ? "error-in-b" : errorA ? "error-in-a" : B.pngs.has(key) ? "missing-in-a" : "missing-in-b",
        ...(errorB || errorA ? { error: errorB ?? errorA } : {}),
        sizeMatch: false,
        changedPixels: 0,
        maskedPixels: 0,
        totalPixels: 0,
        percentChanged: 100,
        maxChannelDelta: 0,
      });
      continue;
    }
    const imageA = decodePng(readFileSync(join(A.dir, `${key}.png`)));
    const imageB = decodePng(readFileSync(join(B.dir, `${key}.png`)));
    const diff = diffImages(imageA, imageB, masks);
    images.set(key, diff);
    const sizeMatch = imageA.width === imageB.width && imageA.height === imageB.height;
    shots.push({
      ...base,
      status: diff.changed === 0 && sizeMatch ? "identical" : "changed",
      sizeMatch,
      sizeA: [imageA.width, imageA.height],
      sizeB: [imageB.width, imageB.height],
      changedPixels: diff.changed,
      maskedPixels: diff.masked,
      totalPixels: diff.total,
      percentChanged: Number(((diff.changed / diff.total) * 100).toFixed(4)),
      maxChannelDelta: diff.maxDelta,
      ...(diff.bbox ? { bbox: diff.bbox } : {}),
    });
  }

  // Dark identical to light: expected before a migration (A), a failure after it (B) where the registry route says dark differs.
  // The light shot comes from the registry, whatever --only selected.
  for (const shot of shots.filter((s) => s.theme === "dark")) {
    const lightKey = [...expected.values()].find((other) => other.route.id === shot.route && other.theme === "light")?.key;
    if (!lightKey) continue;
    const darkDiffers = Boolean(expected.get(shot.key)?.route.darkDiffers);
    for (const side of [A, B]) {
      if (!side.pngs.has(shot.key) || !side.pngs.has(lightKey)) continue;
      if (sha(readFileSync(join(side.dir, `${shot.key}.png`))) !== sha(readFileSync(join(side.dir, `${lightKey}.png`)))) continue;
      const message = `${side.label} (${side.name}): ${shot.key} is byte-identical to ${lightKey}`;
      if (side.label === "B" && darkDiffers) shot.problems.push(`${message}, but the route sets darkDiffers`);
      else shot.warnings.push(message);
    }
  }
  for (const shot of shots) warnings.push(...shot.warnings.map((w) => `${shot.key}: ${w}`));

  const failures = shots.filter((shot) => shot.gating && (shot.status !== "identical" || shot.problems.length > 0));
  // A gate that compared only non-gating shots (an --only of non-gating routes) proves nothing.
  if (shots.length > 0 && !shots.some((shot) => shot.gating)) problems.push(`no gating shot compared (${diffOnly ? `--only ${diffOnly.join(",")} selects` : `${app.id} has`} only non-gating routes)`);
  return {
    app: app.id,
    a,
    b,
    generatedAt: new Date().toISOString(),
    comparison: "exact RGBA outside masks",
    registry: { path: registry.path, sha256: registry.sha256, captureSha256: judge.captureSha256, canonical: resolve(registry.path) === REGISTRY_PATH },
    tree,
    only: diffOnly,
    setOnly: { a: A.manifest?.only ?? null, b: B.manifest?.only ?? null },
    ok: shots.length > 0 && problems.length === 0 && failures.length === 0,
    problems,
    warnings,
    totals: {
      shots: shots.length,
      identical: shots.filter((shot) => shot.status === "identical").length,
      changed: shots.filter((shot) => shot.status === "changed").length,
      missing: shots.filter((shot) => shot.status.startsWith("missing") || shot.status.startsWith("error")).length,
      gatingFailures: failures.length,
      changedPixels: shots.reduce((sum, shot) => sum + shot.changedPixels, 0),
      problems: problems.length + shots.reduce((sum, shot) => sum + shot.problems.length, 0),
    },
    shots,
    images,
  };
}
