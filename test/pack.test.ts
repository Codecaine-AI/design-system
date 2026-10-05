/**
 * The vendoring contract (`bun run pack`): the tgz an app vendors carries the CSS, the font files and every file
 * package.json exports, the hash it prints is the hash of the tokens.css inside that tgz, and a stale build never packs.
 * The system `tar` is the independent reader: it checks both the tgz and readTgz, which the conformance linter uses.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTgz, tokensCssSha256 } from "../scripts/pack.ts";
import { PKG, readJson, readText } from "./support.ts";

function run(command: string, args: string[], cwd: string) {
  // COPYFILE_DISABLE: macOS tar would otherwise add ._* AppleDouble entries for extended attributes.
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** `bun scripts/pack.ts ...` with `cwd` as the package root. */
function runPack(cwd: string, ...args: string[]) {
  return run(process.execPath, ["scripts/pack.ts", ...args], cwd);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every string target under package.json `exports`. */
function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return value && typeof value === "object" ? Object.values(value).flatMap(exportTargets) : [];
}

describe("bun scripts/pack.ts --out <dir>", () => {
  let tmp: string;
  let out: string;
  let result: ReturnType<typeof runPack>;
  let tgz: string;
  /** Regular files `tar` lists in the tgz. */
  let listed: string[] = [];
  /** The tgz, extracted by `tar`. */
  let extracted: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "design-system-pack-"));
    out = join(tmp, "vendor");
    result = runPack(PKG, "--out", out);
    tgz = join(out, `codecaine-ai-design-system-${readJson("package.json").version}.tgz`);
    extracted = join(tmp, "x");
    mkdirSync(extracted);
    if (existsSync(tgz)) {
      listed = run("tar", ["-tzf", tgz], tmp).stdout.split("\n").filter((name) => !name.endsWith("/"));
      run("tar", ["-xzf", tgz, "-C", extracted], tmp);
    }
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("exits 0 and prints the tgz path and the sha256 of the tokens.css inside it, which is the package's", () => {
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const packed = readFileSync(join(extracted, "package/dist/css/tokens.css"));
    expect(packed.equals(readFileSync(join(PKG, "dist/css/tokens.css")))).toBe(true);
    expect(result.stdout.split("\n")).toEqual([`tgz: ${tgz}`, `tokens.css sha256: ${sha256(packed)}`]);
  });

  test("the tgz carries every file package.json exports and every font file fonts.css names", () => {
    const missing = [...new Set(exportTargets(readJson("package.json").exports))].filter((target) => {
      const [head, tail = null] = `package/${target.replace(/^\.\//, "")}`.split("*");
      return tail === null ? !listed.includes(head) : !listed.some((name) => name.startsWith(head) && name.endsWith(tail));
    });
    expect(missing).toEqual([]);
    const fonts = [...readText("css/fonts.css").matchAll(/url\("\.\.\/(fonts\/[^"]+)"\)/g)].map((m) => `package/${m[1]}`);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter((font) => !listed.includes(font))).toEqual([]);
  });

  test("the tgz carries nothing from test/, scripts/, verification/ or node_modules/", () => {
    expect(listed.filter((name) => /^package\/(test|scripts|verification)\/|(^|\/)node_modules\//.test(name))).toEqual([]);
  });

  test("readTgz returns the files and bytes tar extracts; tokensCssSha256 matches the printed hash", () => {
    const files = readTgz(tgz);
    expect([...files.keys()].sort()).toEqual([...listed].sort());
    for (const [name, bytes] of files) expect(Buffer.from(bytes).equals(readFileSync(join(extracted, name)))).toBe(true);
    expect(`tokens.css sha256: ${tokensCssSha256(tgz)}`).toBe(result.stdout.split("\n")[1]);
  });
});

test("readTgz reads pax path headers (paths too long for the ustar fields) and non-ASCII names", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-system-pax-"));
  try {
    const long = `package/${"a".repeat(120)}/${"b".repeat(120)}`;
    mkdirSync(join(dir, long), { recursive: true });
    writeFileSync(join(dir, long, "deep.css"), "a{}");
    writeFileSync(join(dir, "package/naïve.css"), "b{}");
    const archive = join(dir, "pax.tgz");
    expect(run("tar", ["--format", "pax", "-czf", archive, "package"], dir).status).toBe(0);
    const files = new Map([...readTgz(archive)].map(([name, bytes]) => [name.normalize("NFC"), new TextDecoder().decode(bytes)]));
    expect(files).toEqual(new Map([[`${long}/deep.css`, "a{}"], ["package/naïve.css".normalize("NFC"), "b{}"]]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale build refuses to pack: exit 1, the stale file named, no tgz written", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-system-pack-stale-"));
  try {
    for (const path of ["package.json", "tokens", "scripts", "dist", "css", "fonts"]) cpSync(join(PKG, path), join(dir, path), { recursive: true });
    mkdirSync(join(dir, "guide"));
    cpSync(join(PKG, "guide/tokens.md"), join(dir, "guide/tokens.md"));
    // Fresh outputs in the copy first, so only the token edit below makes the build stale.
    expect(run(process.execPath, ["scripts/build.ts"], dir).status).toBe(0);
    const file = join(dir, "tokens/themes/light.tokens.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.color.surface.page.$value = "#fefefe";
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);

    const out = join(dir, "out");
    const result = runPack(dir, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/css/tokens.css (out of date)");
    expect(result.stdout).toBe("");
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
