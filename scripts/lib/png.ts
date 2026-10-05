/**
 * Minimal, dependency-free PNG codec for the screenshot tools (copied from verification/docs-system/lib/png.ts).
 *
 * Decoding is exact (zlib inflate + PNG unfiltering), so snapshot:diff compares the
 * real pixel bytes Chromium wrote, with no canvas color management or
 * premultiplied-alpha rounding in between. Supports what screenshots use:
 * 8-bit, non-interlaced, color types 0 (gray), 2 (RGB), 3 (palette),
 * 4 (gray + alpha) and 6 (RGBA). Anything else throws.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  /** width * height * 4 bytes, row-major RGBA. */
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(input: Uint8Array): RgbaImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (input[i] !== SIGNATURE[i]) throw new Error("Not a PNG file (bad signature)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (offset < input.length) {
    const length = readU32(input, offset);
    const type = String.fromCharCode(input[offset + 4]!, input[offset + 5]!, input[offset + 6]!, input[offset + 7]!);
    const body = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = readU32(body, 0);
      height = readU32(body, 4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      transparency = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8 is supported)`);
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported");

  let total = 0;
  for (const part of idat) total += part.length;
  const compressed = new Uint8Array(total);
  let cursor = 0;
  for (const part of idat) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]!;
      const left = x >= channels ? pixels[dst + x - channels]! : 0;
      const up = y > 0 ? pixels[prev + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prev + x - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Unknown PNG filter ${filter} on row ${y}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    switch (colorType) {
      case 6:
        data[o] = pixels[p]!; data[o + 1] = pixels[p + 1]!; data[o + 2] = pixels[p + 2]!; data[o + 3] = pixels[p + 3]!;
        break;
      case 2:
        data[o] = pixels[p]!; data[o + 1] = pixels[p + 1]!; data[o + 2] = pixels[p + 2]!;
        data[o + 3] = transparency && transparency.length >= 6 &&
          readU16(transparency, 0) === pixels[p] && readU16(transparency, 2) === pixels[p + 1] && readU16(transparency, 4) === pixels[p + 2]
          ? 0 : 255;
        break;
      case 0:
        data[o] = data[o + 1] = data[o + 2] = pixels[p]!;
        data[o + 3] = transparency && transparency.length >= 2 && readU16(transparency, 0) === pixels[p] ? 0 : 255;
        break;
      case 4:
        data[o] = data[o + 1] = data[o + 2] = pixels[p]!;
        data[o + 3] = pixels[p + 1]!;
        break;
      case 3: {
        if (!palette) throw new Error("Palette PNG without a PLTE chunk");
        const index = pixels[p]!;
        data[o] = palette[index * 3]!; data[o + 1] = palette[index * 3 + 1]!; data[o + 2] = palette[index * 3 + 2]!;
        data[o + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
        break;
      }
    }
  }
  return { width, height, data };
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encodes an RGBA image (8-bit, color type 6) with per-row adaptive filtering. */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const candidates = [0, 1, 2, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let c = 0; c < 4; c++) {
      const filter = [0, 1, 2, 4][c]!;
      const line = candidates[c]!;
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const value = data[row + x]!;
        const left = x >= 4 ? data[row + x - 4]! : 0;
        const up = y > 0 ? data[prev + x]! : 0;
        const upLeft = y > 0 && x >= 4 ? data[prev + x - 4]! : 0;
        const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : paeth(left, up, upLeft);
        const encoded = (value - predicted) & 0xff;
        line[x] = encoded;
        score += encoded < 128 ? encoded : 256 - encoded;
      }
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    raw[y * (stride + 1)] = [0, 1, 2, 4][best]!;
    raw.set(candidates[best]!, y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 6 }))), chunk("IEND", new Uint8Array(0))];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
