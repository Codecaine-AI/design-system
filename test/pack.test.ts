/**
 * The vendoring contract (`bun run pack`): the tgz an app vendors carries the CSS, the font files and every file
 * package.json exports, the hash it prints is the hash of the tokens.css inside that tgz, and a stale build never packs.
 * The system `tar` is the independent reader: it checks both the tgz and readTgz, which the conformance linter uses.
 * npm runs with none of the caller's environment, and no destination that resolves into the owner's tree is written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_TREE } from "../scripts/lib/owner.ts";
import { readTgz, tokensCssSha256 } from "../scripts/pack.ts";
import { PKG, readJson, readText } from "./support.ts";

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  // COPYFILE_DISABLE: macOS tar would otherwise add ._* AppleDouble entries for extended attributes.
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1", ...env } });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** `bun scripts/pack.ts ...` with `cwd` as the package root. */
function runPack(cwd: string, ...args: string[]) {
  return run(process.execPath, ["scripts/pack.ts", ...args], cwd);
}

const TGZ_NAME = `codecaine-ai-design-system-${readJson("package.json").version}.tgz`;

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
    // Real path: pack prints the canonical destination it validated and wrote.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "design-system-pack-")));
    out = join(tmp, "vendor");
    result = runPack(PKG, "--out", out);
    tgz = join(out, TGZ_NAME);
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

test("npm sees none of the caller's npm config or HOME, and its temp HOME is gone afterwards", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "design-system-pack-env-")));
  try {
    const [home, tmp, out] = ["home", "tmp", "out"].map((name) => join(dir, name));
    mkdirSync(home);
    mkdirSync(tmp);
    // Planted the way the owner's ~/.npmrc and shell would: if npm read any of it, it would write no tgz.
    writeFileSync(join(home, ".npmrc"), "dry-run=true\n");
    const planted = { HOME: home, npm_config_userconfig: join(home, ".npmrc"), npm_config_dry_run: "true", TMPDIR: tmp };
    // bun itself caches transpiled files under $HOME/Library/Caches; off, so HOME shows only what npm wrote.
    const result = run(process.execPath, ["scripts/pack.ts", "--out", out], PKG, { ...planted, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readdirSync(out)).toEqual([TGZ_NAME]);
    expect(readdirSync(home)).toEqual([".npmrc"]); // no npm cache or logs under the caller's HOME
    expect(readdirSync(tmp).filter((name) => name.startsWith("ds-pack-npm-"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an --out that resolves into the owner's tree through a symlink is refused before anything is created", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-system-pack-owner-"));
  try {
    // Only a link to the owner's tree: the run stats it and must never write there.
    symlinkSync(OWNER_TREE, join(dir, "owner"));
    const name = `ds-pack-refused-${process.pid}`;
    const result = runPack(PKG, "--out", join(dir, "owner", name));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pack --out");
    expect(result.stderr).toContain("resolves into the owner's tree");
    expect(result.stdout).toBe("");
    expect(existsSync(join(OWNER_TREE, name))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
