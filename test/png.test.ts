/**
 * The PNG codec snapshot:diff trusts to read the exact bytes Chromium wrote.
 * Decoding is checked against PNGs built here straight from the spec (every scanline filter, RGB,
 * RGBA, palette), so an unfiltering bug cannot hide behind a matching encoder bug.
 */
import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { decodePng, encodePng, type RgbaImage } from "../scripts/lib/png.ts";

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Spec filter of one scanline (PNG 9.2), given the previous unfiltered line. */
function filterLine(type: number, line: number[], prev: number[], bpp: number): number[] {
  return line.map((x, i) => {
    const a = i >= bpp ? line[i - bpp]! : 0;
    const b = prev[i] ?? 0;
    const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
    const p = a + b - c;
    const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
    const predicted = [0, a, b, (a + b) >> 1, paeth][type]!;
    return (x - predicted) & 0xff;
  });
}

/** A PNG whose row y uses filter y % 5. */
function buildPng(width: number, rows: number[][], colorType: number, bpp: number, extra: Buffer[] = []): Buffer {
  const raw: number[] = [];
  rows.forEach((line, y) => raw.push(y % 5, ...filterLine(y % 5, line, rows[y - 1] ?? [], bpp)));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Five rows (one per filter) of busy pixels: every channel varies along x and y. */
function busyRgba(width: number, height: number): number[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => [(x * 37 + y * 11) & 0xff, (x * x + y * 53) & 0xff, (x * y * 7 + 200) & 0xff, (255 - x * 13 - y) & 0xff]).flat(),
  );
}

describe("decodePng", () => {
  test("unfilters every filter type in an RGBA image", () => {
    const rows = busyRgba(6, 5);
    const image = decodePng(buildPng(6, rows, 6, 4));
    expect([image.width, image.height]).toEqual([6, 5]);
    expect([...image.data]).toEqual(rows.flat());
  });

  test("expands RGB to opaque RGBA", () => {
    const rgba = busyRgba(4, 5);
    const rgb = rgba.map((line) => line.filter((_, i) => i % 4 !== 3));
    const image = decodePng(buildPng(4, rgb, 2, 3));
    expect([...image.data]).toEqual(rgba.flat().map((value, i) => (i % 4 === 3 ? 255 : value)));
  });

  test("looks palette indices up, with tRNS alpha", () => {
    const plte = chunk("PLTE", Buffer.from([10, 20, 30, 200, 100, 0]));
    const trns = chunk("tRNS", Buffer.from([128]));
    const image = decodePng(buildPng(3, [[0, 1, 0]], 3, 1, [plte, trns]));
    expect([...image.data]).toEqual([10, 20, 30, 128, 200, 100, 0, 255, 10, 20, 30, 128]);
  });

});

describe("encodePng", () => {
  test("round-trips through decodePng byte for byte", () => {
    const width = 64;
    const height = 40;
    const data = new Uint8Array(width * height * 4);
    // Flat areas, gradients in both directions and noise, so every adaptive filter choice occurs.
    let seed = 7;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        seed = (seed * 1103515245 + 12345) >>> 0;
        const region = (x >> 4) + (y >> 4) * 4;
        data[o] = region % 3 === 0 ? 240 : region % 3 === 1 ? x * 4 : seed >>> 24;
        data[o + 1] = region % 2 === 0 ? y * 6 : (x + y) * 3;
        data[o + 2] = (seed >>> 16) & 0xff;
        data[o + 3] = region === 5 ? 0 : 255;
      }
    }
    const image: RgbaImage = { width, height, data };
    const decoded = decodePng(encodePng(image));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect(Buffer.from(decoded.data).equals(Buffer.from(data))).toBe(true);
  });
});
