/**
 * Shot sets on disk, and the exact pixel diff between two of them.
 *
 *   <out-dir>/<app>/shots/<set>/<route>-<theme>.png   one PNG per shot
 *   <out-dir>/<app>/shots/<set>/manifest.json          SetManifest
 *   <out-dir>/<app>/diffs/<a>-vs-<b>/                  snapshot:diff output
 *   <out-dir>/<app>/sheets/<a>-vs-<b>.html (+ dir)     snapshot:sheet output
 *
 * Pixels compare exactly: any RGBA channel that differs is a changed pixel. Pixels inside a mask box
 * (the boxes of the route's `masks` selectors, recorded per shot in either manifest) never count,
 * unless the two images differ in size: then every pixel outside the smaller image is changed.
 *
 * The pixel gate (`ok`) also fails on anything that makes the comparison meaningless: a set without
 * a manifest or without `expectedKeys`, an expected shot missing or failed, a partial set compared
 * without a matching `--only`, shots captured from different trees (mixed provenance), a shot that
 * never settled, a PNG the manifest does not list, mask boxes that differ between A and B, and a dark
 * shot identical to its light shot on a route that sets `darkDiffers`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodePng, type RgbaImage } from "./png";

export type Theme = "light" | "dark";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a shot came from. Two shots of one set must share everything but `capturedAt`. */
export interface ShotProvenance {
  /** The app repo's HEAD, and the sha256 of its `git status --porcelain` output (uncommitted work). */
  appHead: string;
  appStatusSha256: string;
  /** Uncommitted paths in the app repo. */
  appDirty: number;
  /** HEAD of the design-system the app renders with (inside --root). */
  designSystemHead: string;
  /** sha256 of that design-system's dist/css/tokens.css. */
  tokensCssSha256: string | null;
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

export interface SetManifest {
  app: string;
  set: string;
  /** Keys of every shot the registry asked for when the set was captured (all routes, whatever --only said). */
  expectedKeys?: string[];
  expected?: ExpectedShot[];
  /** The --only routes the set was captured with (merged runs: the union), or null for a full set. */
  only?: string[] | null;
  shots: ShotEntry[];
  [extra: string]: unknown;
}

export const SET_NAME = /^[A-Za-z0-9._-]+$/;

export function defaultOutDir(): string {
  return process.env.DS_RUN || join(tmpdir(), "ds-rollout");
}

export function setDir(outDir: string, app: string, set: string): string {
  return join(outDir, app, "shots", set);
}

export function diffDir(outDir: string, app: string, a: string, b: string): string {
  return join(outDir, app, "diffs", `${a}-vs-${b}`);
}

export function readManifest(dir: string): SetManifest | null {
  const path = join(dir, "manifest.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SetManifest) : null;
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
  return `app ${p.appHead.slice(0, 12)}${p.appDirty ? ` +${p.appDirty} uncommitted (${p.appStatusSha256.slice(0, 8)})` : ""}, design-system ${p.designSystemHead.slice(0, 12)}, tokens.css ${(p.tokensCssSha256 ?? "none").slice(0, 12)}`;
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
  /** The diff's --only selection, or null for every shot. */
  only: string[] | null;
  /** The --only each set was captured with (null: a full set). */
  setOnly: { a: string[] | null; b: string[] | null };
  /**
   * The --exact gate: at least one shot compared, no set-level problem, and no gating shot changed,
   * went missing, failed, or has a problem.
   */
  ok: boolean;
  /** Problems with a whole set (no manifest, no expectedKeys, partial without --only, mixed provenance). */
  problems: string[];
  warnings: string[];
  totals: { shots: number; identical: number; changed: number; missing: number; gatingFailures: number; changedPixels: number; problems: number };
  shots: ShotDiff[];
  /** Per key, the diff image (only for keys present in both sets). */
  images: Map<string, PixelDiff>;
}

/** Bad arguments for a diff (same set twice, unknown --only id, a missing set): the CLIs exit 2. */
export class DiffUsageError extends Error {}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

interface Side {
  label: "A" | "B";
  name: string;
  dir: string;
  manifest: SetManifest | null;
  pngs: Set<string>;
  entries: Map<string, ShotEntry>;
  expected: Map<string, ExpectedShot>;
}

function readSide(label: "A" | "B", outDir: string, app: string, name: string): Side {
  const dir = setDir(outDir, app, name);
  if (!existsSync(dir)) throw new DiffUsageError(`no such shot set: ${dir}`);
  const manifest = readManifest(dir);
  const expected = new Map<string, ExpectedShot>();
  for (const shot of manifest?.expected ?? []) expected.set(shot.key, shot);
  for (const key of manifest?.expectedKeys ?? []) if (!expected.has(key)) expected.set(key, { ...(splitKey(key) as { route: string; theme: Theme }), key, gating: true });
  return { label, name, dir, manifest, pngs: new Set(setKeys(dir)), entries: new Map((manifest?.shots ?? []).map((shot) => [shot.key, shot])), expected };
}

/** Set-level problems of one side, for the selected keys. */
function sideProblems(side: Side, keys: string[], diffOnly: string[] | null): string[] {
  const problems: string[] = [];
  const { label, name, manifest } = side;
  if (!manifest) return [`${label} (${name}) has no manifest.json: nothing says what was captured or how`];
  if (!manifest.expectedKeys) problems.push(`${label} (${name}): the manifest has no expectedKeys (an older snapshot); capture the set again`);
  if (manifest.only?.length && !diffOnly)
    problems.push(`${label} (${name}) is a partial set (captured with --only ${manifest.only.join(",")}); compare it with a matching --only`);
  const provenances = new Map<string, string[]>();
  const unproven: string[] = [];
  for (const key of keys) {
    const entry = side.entries.get(key);
    if (!entry || entry.error) continue;
    if (!entry.provenance) {
      unproven.push(key);
      continue;
    }
    const id = provenanceKey(entry.provenance);
    provenances.set(id, [...(provenances.get(id) ?? []), key]);
  }
  if (unproven.length) problems.push(`${label} (${name}): ${unproven.length} shot(s) record no provenance (${unproven.slice(0, 3).join(", ")}); capture the set again`);
  if (provenances.size > 1) {
    const list = [...provenances].map(([id, ks]) => `${id}: ${ks.slice(0, 3).join(", ")}${ks.length > 3 ? ` (+${ks.length - 3})` : ""}`);
    problems.push(`${label} (${name}) mixes captures of different trees: ${list.join(" | ")}`);
  }
  return problems;
}

function maskProblems(shotA: ShotEntry | undefined, shotB: ShotEntry | undefined): string[] {
  if (!shotA || !shotB) return [];
  const boxes = (shot: ShotEntry) => new Map((shot.masks ?? []).map((mask) => [mask.selector, JSON.stringify(mask.boxes)]));
  const a = boxes(shotA);
  const b = boxes(shotB);
  const problems: string[] = [];
  for (const selector of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (a.get(selector) === b.get(selector)) continue;
    const count = (json: string | undefined) => (json === undefined ? "no entry" : `${(JSON.parse(json) as Box[]).length} box(es)`);
    problems.push(`mask ${selector} covers different boxes in A (${count(a.get(selector))}) and B (${count(b.get(selector))})`);
  }
  return problems;
}

/**
 * Diffs every key in either set or either manifest's expectedKeys. `only` selects routes or keys;
 * an id that names neither is a usage error, and so are `a === b` and a missing set.
 */
export function diffSets(outDir: string, app: string, a: string, b: string, only?: string[]): SetDiff {
  if (a === b) throw new DiffUsageError(`--a and --b are the same set (${a}): a set always matches itself`);
  const A = readSide("A", outDir, app, a);
  const B = readSide("B", outDir, app, b);
  const diffOnly = only?.length ? only : null;

  const routeOf = (key: string) => {
    const known = B.entries.get(key) ?? A.entries.get(key) ?? B.expected.get(key) ?? A.expected.get(key);
    return splitKey(key, known);
  };
  // Keys come from the PNGs, both manifests' shots and both manifests' expected keys.
  const universe = [...new Set([...A.pngs, ...B.pngs, ...A.entries.keys(), ...B.entries.keys(), ...A.expected.keys(), ...B.expected.keys()])].sort();
  if (diffOnly) {
    const unknown = diffOnly.filter((id) => !universe.some((key) => key === id || routeOf(key).route === id));
    if (unknown.length) throw new DiffUsageError(`--only names no route or shot of ${app} in ${a} or ${b}: ${unknown.join(", ")}`);
  }
  const keys = universe.filter((key) => !diffOnly || diffOnly.includes(key) || diffOnly.includes(routeOf(key).route));

  const problems = [...sideProblems(A, keys, diffOnly), ...sideProblems(B, keys, diffOnly)];
  const warnings: string[] = [];
  const shots: ShotDiff[] = [];
  const images = new Map<string, PixelDiff>();
  for (const key of keys) {
    const shotA = A.entries.get(key);
    const shotB = B.entries.get(key);
    const { route, theme } = routeOf(key);
    // A shot is non-gating only when the set being judged (B, else A, else the registry) says so.
    const judge = shotB ?? shotA ?? B.expected.get(key) ?? A.expected.get(key);
    const gating = judge ? judge.gating !== false : true;
    const masks = [...(shotA?.masks ?? []), ...(shotB?.masks ?? [])].flatMap((mask) => mask.boxes);
    const shotProblems: string[] = [];
    const shotWarnings: string[] = [];
    for (const side of [A, B]) {
      const entry = side.entries.get(key);
      if (side.pngs.has(key) && !entry) shotProblems.push(`${side.label} has ${key}.png but its manifest does not list the shot`);
      if (entry && !entry.error && entry.stable === false) shotProblems.push(`${side.label}: the capture never settled (stable: false)`);
    }
    shotProblems.push(...maskProblems(shotA, shotB));
    const base = { key, route, theme, gating, ...(judge && "reason" in judge && judge.reason ? { reason: judge.reason as string } : {}), masks, problems: shotProblems, warnings: shotWarnings };
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

  // Dark identical to light: expected before a migration (A), a failure after it (B) where the route says dark differs.
  for (const shot of shots.filter((s) => s.theme === "dark")) {
    const lightKey = keys.find((key) => key !== shot.key && routeOf(key).route === shot.route && routeOf(key).theme === "light");
    if (!lightKey) continue;
    for (const side of [A, B]) {
      if (!side.pngs.has(shot.key) || !side.pngs.has(lightKey)) continue;
      if (sha(readFileSync(join(side.dir, `${shot.key}.png`))) !== sha(readFileSync(join(side.dir, `${lightKey}.png`)))) continue;
      const darkDiffers = Boolean(side.entries.get(shot.key)?.darkDiffers ?? side.expected.get(shot.key)?.darkDiffers);
      const message = `${side.label} (${side.name}): ${shot.key} is byte-identical to ${lightKey}`;
      if (side.label === "B" && darkDiffers) shot.problems.push(`${message}, but the route sets darkDiffers`);
      else shot.warnings.push(message);
    }
  }
  for (const shot of shots) warnings.push(...shot.warnings.map((w) => `${shot.key}: ${w}`));

  const failures = shots.filter((shot) => shot.gating && (shot.status !== "identical" || shot.problems.length > 0));
  return {
    app,
    a,
    b,
    generatedAt: new Date().toISOString(),
    comparison: "exact RGBA outside masks",
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
