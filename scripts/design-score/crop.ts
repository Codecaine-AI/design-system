/**
 * Finding crops: a region of a state screenshot around the element, scaled up (nearest neighbor, so a
 * 1px offset stays a crisp step), with the element boxed in magenta, a second element in cyan, and for
 * alignment findings a guide line through each compared edge or center.
 */
import { decodePng, encodePng, type RgbaImage } from "../lib/png";
import type { Box } from "./types";

const MAGENTA: [number, number, number] = [255, 0, 200];
const CYAN: [number, number, number] = [0, 190, 255];

export interface CropSpec {
  box: Box | null;
  other?: Box | null;
  guides?: { axis: "x" | "y"; a: number; b: number };
  /** Context around the boxes in CSS px (default 32; alignment 20). */
  margin?: number;
  /** Scale factor (default 2; alignment 4). */
  scale?: number;
}

/** Decoded screenshots, by path, so many crops of one shot decode it once. */
export class ShotCache {
  private cache = new Map<string, RgbaImage>();
  get(key: string, png: () => Uint8Array): RgbaImage {
    let img = this.cache.get(key);
    if (!img) {
      img = decodePng(png());
      this.cache.set(key, img);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    }
    return img;
  }
}

export function cropPng(src: RgbaImage, spec: CropSpec): Uint8Array | null {
  const boxes = [spec.box, spec.other].filter((b): b is Box => !!b && b.w >= 0 && b.h >= 0);
  if (!boxes.length) return null;
  const align = !!spec.guides;
  const margin = spec.margin ?? (align ? 28 : 48);
  const scale = spec.scale ?? (align ? 4 : 2);
  let x0 = Math.min(...boxes.map((b) => b.x)) - margin;
  let y0 = Math.min(...boxes.map((b) => b.y)) - margin;
  let x1 = Math.max(...boxes.map((b) => b.x + b.w)) + margin;
  let y1 = Math.max(...boxes.map((b) => b.y + b.h)) + margin;
  // Keep big crops readable: at most 700x420 CSS px (around the first box).
  const maxW = align ? 360 : 700;
  const maxH = align ? 220 : 420;
  if (x1 - x0 > maxW) {
    const c = boxes[0]!.x + Math.min(boxes[0]!.w, maxW) / 2;
    x0 = c - maxW / 2;
    x1 = c + maxW / 2;
  }
  if (y1 - y0 > maxH) {
    const c = boxes[0]!.y + Math.min(boxes[0]!.h, maxH) / 2;
    y0 = c - maxH / 2;
    y1 = c + maxH / 2;
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(src.width, Math.ceil(x1));
  y1 = Math.min(src.height, Math.ceil(y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return null;
  const out: RgbaImage = { width: w * scale, height: h * scale, data: new Uint8Array(w * scale * h * scale * 4) };
  for (let y = 0; y < h * scale; y++) {
    const sy = y0 + Math.floor(y / scale);
    for (let x = 0; x < w * scale; x++) {
      const sx = x0 + Math.floor(x / scale);
      const si = (sy * src.width + sx) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = 255;
    }
  }
  const draw = painter(out, x0, y0, scale);
  if (spec.guides) {
    draw.guide(spec.guides.axis, spec.guides.a, MAGENTA);
    draw.guide(spec.guides.axis, spec.guides.b, CYAN);
  } else {
    if (spec.box) draw.rect(spec.box, MAGENTA);
    if (spec.other) draw.rect(spec.other, CYAN);
  }
  return encodePng(out);
}

/** Box and guide drawing on `out`, an image of the source region from (x0, y0) scaled by `scale`. */
function painter(out: RgbaImage, x0: number, y0: number, scale: number) {
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    out.data[i] = c[0];
    out.data[i + 1] = c[1];
    out.data[i + 2] = c[2];
    out.data[i + 3] = 255;
  };
  // A rectangle drawn just outside the box (a 2px gap), so it never covers the edge being judged.
  const rect = (b: Box, c: [number, number, number]) => {
    const gap = 2 * scale;
    const left = Math.round((b.x - x0) * scale) - gap;
    const top = Math.round((b.y - y0) * scale) - gap;
    const right = Math.round((b.x + b.w - x0) * scale) + gap - 1;
    const bottom = Math.round((b.y + b.h - y0) * scale) + gap - 1;
    for (let t = 0; t < 2; t++) {
      for (let x = left - t; x <= right + t; x++) {
        set(x, top - t, c);
        set(x, bottom + t, c);
      }
      for (let y = top - t; y <= bottom + t; y++) {
        set(left - t, y, c);
        set(right + t, y, c);
      }
    }
  };
  // A dashed guide across the image at one CSS px position.
  const guide = (axis: "x" | "y", at: number, c: [number, number, number]) => {
    const p = Math.round((at - (axis === "x" ? x0 : y0)) * scale);
    const len = axis === "x" ? out.height : out.width;
    const thick = Math.max(1, Math.floor(scale / 2));
    for (let i = 0; i < len; i++) {
      if (i % 12 >= 8) continue;
      for (let t = 0; t < thick; t++) {
        if (axis === "x") set(p + t, i, c);
        else set(i, p + t, c);
      }
    }
  };
  return { rect, guide };
}

/**
 * A whole screenshot with every finding boxed (magenta, the second element cyan), scaled up, trimmed to
 * the painted content plus `margin` CSS px (pixels that differ from the top-left corner's color).
 */
export function markPng(src: RgbaImage, marks: Array<{ box: Box | null; other?: { box: Box } | null }>, opts: { scale?: number; margin?: number } = {}): Uint8Array {
  const scale = opts.scale ?? 2;
  const margin = opts.margin ?? 24;
  const bg = [src.data[0], src.data[1], src.data[2]];
  let minX = src.width, minY = src.height, maxX = -1, maxY = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (src.data[i] === bg[0] && src.data[i + 1] === bg[1] && src.data[i + 2] === bg[2]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  for (const m of marks) for (const b of [m.box, m.other?.box]) if (b) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (maxX < 0) {
    minX = minY = 0;
    maxX = src.width - 1;
    maxY = src.height - 1;
  }
  const x0 = Math.max(0, Math.floor(minX - margin));
  const y0 = Math.max(0, Math.floor(minY - margin));
  const x1 = Math.min(src.width, Math.ceil(maxX + 1 + margin));
  const y1 = Math.min(src.height, Math.ceil(maxY + 1 + margin));
  const w = x1 - x0;
  const h = y1 - y0;
  const out: RgbaImage = { width: w * scale, height: h * scale, data: new Uint8Array(w * scale * h * scale * 4) };
  for (let y = 0; y < out.height; y++) {
    const si0 = ((y0 + Math.floor(y / scale)) * src.width + x0) * 4;
    for (let x = 0; x < out.width; x++) {
      const si = si0 + Math.floor(x / scale) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = 255;
    }
  }
  const draw = painter(out, x0, y0, scale);
  for (const m of marks) {
    if (m.box) draw.rect(m.box, MAGENTA);
    if (m.other) draw.rect(m.other.box, CYAN);
  }
  return encodePng(out);
}
