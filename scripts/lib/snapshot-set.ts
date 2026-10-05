/**
 * Shot sets on disk, and the exact pixel diff between two of them.
 *
 *   <out-dir>/<app>/shots/<set>/<route>-<theme>.png   one PNG per shot
 *   <out-dir>/<app>/shots/<set>/manifest.json          SetManifest
 *   <out-dir>/<app>/diffs/<a>-vs-<b>/                  snapshot:diff output
 *   <out-dir>/<app>/sheets/<a>-vs-<b>.html (+ dir)     snapshot:sheet output
 *
 * Pixels compare exactly: any RGBA channel that differs is a changed pixel. Pixels inside a mask box
 * (the boxes of the route's `masks` selectors, recorded per shot in either manifest) never count.
 */
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

export interface ShotEntry {
  key: string;
  route: string;
  theme: Theme;
  url?: string;
  viewport?: { width: number; height: number };
  /** false: captured, but a change never fails the pixel gate (the registry gives the reason). */
  gating: boolean;
  reason?: string;
  /** Mask selectors and the boxes they covered at capture time (CSS px, clipped to the viewport). */
  masks: Array<{ selector: string; boxes: Box[] }>;
  [extra: string]: unknown;
}

export interface SetManifest {
  app: string;
  set: string;
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
export function splitKey(key: string, entry?: ShotEntry): { route: string; theme: Theme | "unknown" } {
  if (entry) return { route: entry.route, theme: entry.theme };
  const match = /^(.*)-(light|dark)$/.exec(key);
  return match ? { route: match[1]!, theme: match[2] as Theme } : { route: key, theme: "unknown" };
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
 * magenta, and masked pixels light blue. Pixels outside one image's bounds count as changed.
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
      if (masks.length && inBoxes(x, y, masks)) {
        masked++;
        out.set(MASKED, o);
        continue;
      }
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
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

export type ShotStatus = "identical" | "changed" | "missing-in-a" | "missing-in-b";

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
  /** Changed pixels outside masks. */
  changedPixels: number;
  maskedPixels: number;
  totalPixels: number;
  percentChanged: number;
  maxChannelDelta: number;
  bbox?: Box;
  masks: Box[];
}

export interface SetDiff {
  app: string;
  a: string;
  b: string;
  generatedAt: string;
  comparison: "exact RGBA outside masks";
  /** True when at least one shot compared and no gating shot changed or went missing (the --exact gate). */
  ok: boolean;
  totals: { shots: number; identical: number; changed: number; missing: number; gatingFailures: number; changedPixels: number };
  shots: ShotDiff[];
  /** Per key, the diff image (only for keys present in both sets). */
  images: Map<string, PixelDiff>;
}

/** Diffs every key in either set. `only` filters by route id or key. */
export function diffSets(outDir: string, app: string, a: string, b: string, only?: string[]): SetDiff {
  const dirA = setDir(outDir, app, a);
  const dirB = setDir(outDir, app, b);
  for (const dir of [dirA, dirB]) if (!existsSync(dir)) throw new Error(`no such shot set: ${dir}`);
  const manifestA = readManifest(dirA);
  const manifestB = readManifest(dirB);
  const entry = (manifest: SetManifest | null, key: string) => manifest?.shots.find((shot) => shot.key === key);
  const keysA = new Set(setKeys(dirA));
  const keysB = new Set(setKeys(dirB));
  const selected = (key: string) => {
    if (!only?.length) return true;
    const { route } = splitKey(key, entry(manifestB, key) ?? entry(manifestA, key));
    return only.includes(key) || only.includes(route);
  };
  const keys = [...new Set([...keysA, ...keysB])].filter(selected).sort();

  const shots: ShotDiff[] = [];
  const images = new Map<string, PixelDiff>();
  for (const key of keys) {
    const shotA = entry(manifestA, key);
    const shotB = entry(manifestB, key);
    const { route, theme } = splitKey(key, shotB ?? shotA);
    // A shot is non-gating only when the set being judged (B, else A) says so.
    const judge = shotB ?? shotA;
    const gating = judge ? judge.gating !== false : true;
    const masks = [...(shotA?.masks ?? []), ...(shotB?.masks ?? [])].flatMap((mask) => mask.boxes);
    const base = { key, route, theme, gating, ...(judge?.reason ? { reason: judge.reason } : {}), masks };
    if (!keysA.has(key) || !keysB.has(key)) {
      shots.push({
        ...base,
        status: keysA.has(key) ? "missing-in-b" : "missing-in-a",
        sizeMatch: false,
        changedPixels: 0,
        maskedPixels: 0,
        totalPixels: 0,
        percentChanged: 100,
        maxChannelDelta: 0,
      });
      continue;
    }
    const imageA = decodePng(readFileSync(join(dirA, `${key}.png`)));
    const imageB = decodePng(readFileSync(join(dirB, `${key}.png`)));
    const diff = diffImages(imageA, imageB, masks);
    images.set(key, diff);
    shots.push({
      ...base,
      status: diff.changed === 0 ? "identical" : "changed",
      sizeMatch: imageA.width === imageB.width && imageA.height === imageB.height,
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
  const failures = shots.filter((shot) => shot.status !== "identical" && shot.gating);
  return {
    app,
    a,
    b,
    generatedAt: new Date().toISOString(),
    comparison: "exact RGBA outside masks",
    ok: shots.length > 0 && failures.length === 0,
    totals: {
      shots: shots.length,
      identical: shots.filter((shot) => shot.status === "identical").length,
      changed: shots.filter((shot) => shot.status === "changed").length,
      missing: shots.filter((shot) => shot.status.startsWith("missing")).length,
      gatingFailures: failures.length,
      changedPixels: shots.reduce((sum, shot) => sum + shot.changedPixels, 0),
    },
    shots,
    images,
  };
}
