/**
 * The vendoring contract (`bun run pack`): the tgz an app vendors carries the CSS, the font files and every file
 * package.json exports, the hash it prints is the hash of the tokens.css inside that tgz, and a stale build never packs.
 * The system `tar` is the independent reader: it checks both the tgz and readTgz, which the conformance linter uses.
 * npm runs with none of the caller's environment. A checkout outside the owner's tree never writes into it, a checkout
 * inside it may (the owner's own vendoring flow); every owner tree here is a temp dir, never the real one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { realHome, UnsafePathError } from "../scripts/lib/safe-paths.ts";
import { sandboxUnavailable } from "../scripts/lib/sandbox.ts";
import { defaultOutDir, pack, packOutput, readTgz, tgzProblems, tokensCssSha256 } from "../scripts/pack.ts";
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

  test("the tgz carries nothing from test/, scripts/, verification/, apps/, prompts/, skill/, apps.json, node_modules/ or .env*", () => {
    const mustNotShip = /^package\/(test|scripts|verification|apps|prompts|skill)\/|^package\/apps\.json$|(^|\/)node_modules\/|(^|\/)\.env/;
    expect(listed.filter((name) => mustNotShip.test(name))).toEqual([]);
  });

  test("tgzProblems refuses the rollout's own files in a vendored copy: apps/, apps.json, prompts/, skill/ and .env* at any depth", () => {
    const files = readTgz(tgz);
    expect(tgzProblems(files)).toEqual([]);
    const extra = ["package/apps.json", "package/apps/x.json", "package/prompts/p.md", "package/skill/SKILL.md", "package/.env", "package/css/.env.local", "package/dist/.env/key"];
    for (const name of extra) files.set(name, new Uint8Array([1]));
    expect(tgzProblems(files)).toEqual([...extra].sort().map((name) => `${name} must not ship`));
  });

  test("readTgz returns the files and bytes tar extracts; tokensCssSha256 matches the printed hash", () => {
    const files = readTgz(tgz);
    expect([...files.keys()].sort()).toEqual([...listed].sort());
    for (const [name, bytes] of files) expect(Buffer.from(bytes).equals(readFileSync(join(extracted, name)))).toBe(true);
    expect(`tokens.css sha256: ${tokensCssSha256(tgz)}`).toBe(result.stdout.split("\n")[1]);
  });

  test("packing the same build again leaves the tgz as it is and says unchanged", () => {
    const before = statSync(tgz);
    const bytes = readFileSync(tgz);
    const again = runPack(PKG, "--out", out);
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
    expect(again.stdout.split("\n")).toEqual([...result.stdout.split("\n"), "unchanged: a tgz with the same files and bytes was already at this path"]);
    expect(readFileSync(tgz).equals(bytes)).toBe(true);
    expect(statSync(tgz).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(out)).toEqual([basename(tgz)]);
  });

  /** A folder holding `bytes` under the tgz's name, for a repack to meet. */
  function vendorWith(name: string, bytes: Uint8Array): string {
    const dir = mkdtempSync(join(tmp, `${name}-`));
    writeFileSync(join(dir, basename(tgz)), bytes);
    return dir;
  }

  test("a tgz with the same files but other gzip bytes (another npm or zlib) is unchanged: kept as it is, exit 0", () => {
    const regzipped = gzipSync(gunzipSync(readFileSync(tgz)), { level: 1 });
    expect(regzipped.equals(readFileSync(tgz))).toBe(false);
    const dir = vendorWith("regzipped", regzipped);
    const again = runPack(PKG, "--out", dir);
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
    expect(again.stdout.split("\n")[2]).toBe("unchanged: a tgz with the same files and bytes was already at this path");
    expect(readFileSync(join(dir, basename(tgz))).equals(regzipped)).toBe(true);
  });

  test("a tgz of the same name with other content is never overwritten: exit 1, its bytes kept, nothing else written", () => {
    // One byte of tokens.css changed inside the archive (file data, not a header): the same names, other content.
    const tar = Buffer.from(gunzipSync(readFileSync(tgz)));
    const at = tar.indexOf("--ds-color-surface-page");
    expect(at).toBeGreaterThan(0);
    tar[at + 2] = "X".charCodeAt(0);
    const changed = gzipSync(tar);
    for (const [label, bytes] of [["changed", changed], ["not-a-tgz", Buffer.concat([readFileSync(tgz), Buffer.from("trailing")]).subarray(4)]] as const) {
      const dir = vendorWith(label, bytes);
      const refused = runPack(PKG, "--out", dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(`${join(dir, basename(tgz))} already exists with different content; refusing to overwrite it`);
      expect(refused.stderr).toContain("Bump the patch version in package.json");
      expect(readFileSync(join(dir, basename(tgz))).equals(bytes)).toBe(true);
      expect(readdirSync(dir)).toEqual([basename(tgz)]);
    }
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

/** An executable `#!/bin/sh` script at `path`. */
function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("npm and node: never from a plantable PATH dir, and npm only inside the sandbox", () => {
  test.each(["npm", "node"])("a %s planted in a user-writable dir before the nvm dir on PATH never runs: exit 1, nothing created", (name) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "design-system-pack-planted-")));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const marker = join(dir, "ran.txt");
      // Answers like a working tool would (npm prints a tgz name), so only the refusal can stop it.
      script(join(bin, name), `echo "$0 $*" >> '${marker}'\necho '[{"filename":"x.tgz"}]'`);
      const out = join(dir, "out");
      const result = run(process.execPath, ["scripts/pack.ts", "--out", out], PKG, { PATH: `${bin}:${process.env.PATH ?? ""}` });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`refusing to run ${name}: the first ${name} on PATH is ${join(bin, name)}, in a directory this user can write, before the nvm dir`);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!!sandboxUnavailable())("npm runs inside the sandbox: no write outside its staging folder and HOME, no network", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "design-system-pack-sandbox-")));
    // A listener in its own process (this one blocks in spawnSync while npm runs), counting hits in a file.
    const port = 46944;
    writeFileSync(join(dir, "listener.mjs"), `import { appendFileSync } from "node:fs";\nBun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => (appendFileSync("hits.txt", "x"), new Response("")) });\n`);
    const listener = Bun.spawn([process.execPath, "--no-env-file", "listener.mjs"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    try {
      for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)); i++) await Bun.sleep(50);
      rmSync(join(dir, "hits.txt"), { force: true }); // the readiness probe's own hit
      // A home whose ~/.nvm holds the npm and node pack takes: an npm that tries to escape, then fails.
      const home = join(dir, "home");
      const bin = join(home, ".nvm/versions/node/v0/bin");
      mkdirSync(bin, { recursive: true });
      const outside = join(dir, "outside.txt");
      script(join(bin, "npm"), `echo planted > '${outside}'\n/usr/bin/curl -s -m 3 http://127.0.0.1:${port}/ >/dev/null\nexit 7`);
      script(join(bin, "node"), "exit 9");
      await expect(pack({ out: join(dir, "out"), home, pathEnv: `${bin}:/usr/bin:/bin` })).rejects.toThrow("npm pack exited 7");
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(dir, "hits.txt"))).toBe(false);
    } finally {
      listener.kill("SIGKILL");
      await listener.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the default destination ($DS_RUN/pack, else under the temp base) refuses a TMPDIR that is the home itself", () => {
  expect(defaultOutDir({ DS_RUN: "/run/folder" })).toBe("/run/folder/pack");
  expect(() => defaultOutDir({ TMPDIR: realHome() })).toThrow("is the home directory itself");
});

/**
 * A temp "owner tree" (never the real one) holding a copy of this checkout at design-system/ with a fresh
 * build, and a mirror beside it holding another copy: the two places pack runs from.
 */
describe("owner-tree destinations", () => {
  let dir: string;
  let owner: string;
  let mirror: string;
  const copyCheckout = (to: string) => {
    for (const path of ["package.json", "tokens", "scripts", "dist", "css", "fonts", "templates", "AGENTS.md", "README.md"]) cpSync(join(PKG, path), join(to, path), { recursive: true });
    mkdirSync(join(to, "guide"));
    for (const name of readdirSync(join(PKG, "guide")).filter((n) => n.endsWith(".md"))) cpSync(join(PKG, "guide", name), join(to, "guide", name));
    expect(run(process.execPath, ["scripts/build.ts"], to).status).toBe(0);
  };

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "design-system-pack-owner-")));
    owner = join(dir, "workspace");
    mirror = join(dir, "workspace-ds");
    mkdirSync(join(owner, "app"), { recursive: true });
    copyCheckout(join(owner, "design-system"));
    copyCheckout(join(mirror, "design-system"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a checkout inside the owner's tree packs into an app's vendor folder there (the owner's own flow)", async () => {
    const vendor = join(owner, "app", "vendor");
    const result = await pack({ root: join(owner, "design-system"), out: vendor, ownerTree: owner });
    expect(result.tgz).toBe(join(vendor, TGZ_NAME));
    expect(result.unchanged).toBe(false);
    expect(readdirSync(vendor)).toEqual([TGZ_NAME]);
    expect(tgzProblems(readTgz(result.tgz))).toEqual([]);
  });

  test("a checkout outside the owner's tree is refused every destination in it, directly or through a symlink, before anything is created", async () => {
    symlinkSync(owner, join(dir, "link-to-owner"));
    for (const out of [join(owner, "app", "vendor-from-mirror"), join(dir, "link-to-owner", "app", "vendor-via-link")]) {
      expect(() => packOutput(out, { root: join(mirror, "design-system"), ownerTree: owner })).toThrow(UnsafePathError);
      await expect(pack({ root: join(mirror, "design-system"), out, ownerTree: owner })).rejects.toThrow("resolves into the owner's tree");
    }
    expect(readdirSync(join(owner, "app")).filter((name) => name.startsWith("vendor-"))).toEqual([]);
    // The mirror itself, and a temp dir, stay open to it.
    expect(packOutput(join(mirror, "app", "vendor"), { root: join(mirror, "design-system"), ownerTree: owner })).toBe(join(mirror, "app", "vendor"));
  });

  test("with TMPDIR inside the owner's tree, pack refuses before it creates a staging folder or an npm HOME there", async () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(owner, "tmp");
    try {
      mkdirSync(join(owner, "tmp"), { recursive: true });
      await expect(pack({ root: join(owner, "design-system"), out: join(dir, "out"), ownerTree: owner })).rejects.toThrow("resolves into the owner's tree");
      expect(readdirSync(join(owner, "tmp"))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});
