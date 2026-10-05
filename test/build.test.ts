/**
 * The build contract: committed outputs match a fresh build, `--check` catches drift, `bun run build`
 * repairs it, and the same tokens always produce the same bytes.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOutputs, duplicateKeys, ROOT, readSources, staleFiles, TokenError } from "../scripts/build.ts";

/** The problems readSources reports for a package root; fails the test when it accepts the files. */
function sourceProblems(root: string): string[] {
  try {
    readSources(root);
  } catch (error) {
    if (error instanceof TokenError) return error.problems;
    throw error;
  }
  throw new Error("readSources accepted the files");
}

/** Runs the build CLI (`bun scripts/build.ts ...`) with `cwd` as the package root. */
function runBuild(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["scripts/build.ts", ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr.trim() };
}

describe("committed outputs", () => {
  test("dist/ and guide/tokens.md match a fresh build; `--check` exits 0", () => {
    expect(staleFiles(ROOT)).toEqual([]);
    expect(runBuild(ROOT, "--check")).toEqual({ status: 0, stderr: "" });
  });
});

describe("on a temp copy of the package", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "design-system-test-"));
    for (const path of ["tokens", "scripts", "dist"]) cpSync(join(ROOT, path), join(dir, path), { recursive: true });
    mkdirSync(join(dir, "guide"));
    cpSync(join(ROOT, "guide/tokens.md"), join(dir, "guide/tokens.md"));
    // Start from outputs built in the copy, so these tests do not depend on the committed dist/ being fresh.
    const build = runBuild(dir);
    if (build.status !== 0) throw new Error(`build of the temp copy failed:\n${build.stderr}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setLightPage(value: string) {
    const file = join(dir, "tokens/themes/light.tokens.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.color.surface.page.$value = value;
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }

  test("a changed token value makes dist/css/tokens.css stale and `--check` exit 1", () => {
    setLightPage("#fefefe");
    expect(staleFiles(dir)).toContainEqual(expect.stringMatching(/^dist\/css\/tokens\.css\b/));
    const check = runBuild(dir, "--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("dist/css/tokens.css");
  });

  test("missing and leftover dist files are stale; `bun scripts/build.ts` rewrites, restores and removes them", () => {
    setLightPage("#fefefe");
    rmSync(join(dir, "dist/json/dark.json"));
    writeFileSync(join(dir, "dist/css/old.css"), ":root {}\n");
    expect(staleFiles(dir)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^dist\/css\/old\.css\b/),
        expect.stringMatching(/^dist\/css\/tokens\.css\b/),
        expect.stringMatching(/^dist\/json\/dark\.json\b/),
      ]),
    );
    expect(runBuild(dir).status).toBe(0);
    expect(staleFiles(dir)).toEqual([]);
  });

  test("dotfiles (Finder's .DS_Store, ._* AppleDouble files) are ignored in dist/ and tokens/", () => {
    for (const path of ["dist/.DS_Store", "dist/css/.DS_Store", "dist/css/._tokens.css", "tokens/.DS_Store", "tokens/base/._space.tokens.json"]) {
      writeFileSync(join(dir, path), "\0\u0005\u0016\u0007");
    }
    expect(staleFiles(dir)).toEqual([]);
    expect(runBuild(dir, "--check")).toEqual({ status: 0, stderr: "" });
    expect(runBuild(dir).status).toBe(0);
    // The build neither reads nor removes them.
    expect(existsSync(join(dir, "dist/.DS_Store"))).toBe(true);
    expect(existsSync(join(dir, "dist/css/.DS_Store"))).toBe(true);
  });

  test("a key repeated inside one JSON object fails the build, with its path and line", () => {
    const text = [
      "{",
      '  "extra": {',
      '    "a": { "$type": "number", "$value": 1 },',
      '    "a": { "$type": "number", "$value": 2 },',
      '    "b": { "$type": "number", "$value": 1, "$value": 2 }',
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(dir, "tokens/base/extra.tokens.json"), text);
    expect(sourceProblems(dir).sort()).toEqual([
      'tokens/base/extra.tokens.json: extra.a: duplicate key "a" on line 4 (JSON.parse keeps only the last)',
      'tokens/base/extra.tokens.json: extra.b.$value: duplicate key "$value" on line 5 (JSON.parse keeps only the last)',
    ]);
    const check = runBuild(dir, "--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('duplicate key "a"');
  });

  test("a .json file under tokens/ that the build would not read fails it; other files are left alone", () => {
    writeFileSync(join(dir, "tokens/base/colors.json"), "{}\n");
    mkdirSync(join(dir, "tokens/extra"));
    writeFileSync(join(dir, "tokens/extra/brand.tokens.json"), "{}\n");
    writeFileSync(join(dir, "tokens/README.md"), "notes\n");
    expect(sourceProblems(dir).sort()).toEqual([
      expect.stringMatching(/^tokens\/base\/colors\.json: not read by the build\b/),
      expect.stringMatching(/^tokens\/extra\/brand\.tokens\.json: not read by the build\b/),
    ]);
    const check = runBuild(dir, "--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("tokens/base/colors.json");
  });

  test("invalid tokens fail the build and `--check` with exit 1 and leave dist/ untouched", () => {
    const before = readFileSync(join(dir, "dist/css/tokens.css"), "utf8");
    setLightPage("#FFF");
    for (const args of [[], ["--check"]]) {
      const result = runBuild(dir, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("color.surface.page");
    }
    expect(readFileSync(join(dir, "dist/css/tokens.css"), "utf8")).toBe(before);
  });
});

describe("duplicateKeys", () => {
  test("finds a key repeated in one object, at any depth and inside arrays", () => {
    expect(duplicateKeys('{"a": {"x": 1, "y": 2, "x": 3}}')).toEqual([{ path: "a", key: "x", line: 1 }]);
    expect(duplicateKeys('{"k": 1,\n"k": 2}')).toEqual([{ path: "", key: "k", line: 2 }]);
    expect(duplicateKeys('{"list": [{"x": 1}, {"x": 1, "x": 2}]}')).toEqual([{ path: "list.1", key: "x", line: 1 }]);
    // Keys compare after unescaping.
    expect(duplicateKeys('{"\\u0061": 1, "a": 2}')).toEqual([{ path: "", key: "a", line: 1 }]);
  });

  test("ignores the same key in sibling objects and braces, commas or quotes inside strings", () => {
    expect(duplicateKeys('{"a": {"x": 1}, "b": {"x": 1}}')).toEqual([]);
    expect(duplicateKeys('{"a": "}{,\\"x\\":", "x": ["{", "}"], "b\\"": 1, "b": 2}')).toEqual([]);
  });
});

describe("determinism", () => {
  test("two builds produce identical outputs, whatever the clock says", () => {
    try {
      setSystemTime(new Date("2001-02-03T04:05:06Z"));
      const first = buildOutputs();
      setSystemTime(new Date("2032-12-31T23:59:59Z"));
      const second = buildOutputs();
      expect([...second.keys()]).toEqual([...first.keys()]);
      expect([...first.keys()].filter((path) => second.get(path) !== first.get(path))).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});
