/**
 * The shared write-destination validator: every tool calls it before it creates anything, so a
 * destination that reaches the owner's tree by any spelling must be refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath, safeAppId, safeChildPath, safeOutputPath, safeSegment, safeTempBase, UnsafePathError } from "../scripts/lib/safe-paths.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ds-safe-paths-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in owner tree, a mirror next to it whose name shares its prefix, and links into the owner. */
const owner = join(scratch, "workspace");
const mirror = join(scratch, "workspace-ds");
mkdirSync(join(owner, "design-system"), { recursive: true });
mkdirSync(mirror);
symlinkSync(join(owner, "design-system"), join(mirror, "linked"));
symlinkSync(join(owner, "not-yet"), join(mirror, "dangling"));

describe("canonicalPath", () => {
  test("resolves the nearest existing ancestor and keeps the part that does not exist yet", () => {
    expect(canonicalPath(join(mirror, "linked", "out", "run"))).toBe(join(owner, "design-system", "out", "run"));
  });

  test("follows a dangling symlink to where a write through it would land", () => {
    expect(canonicalPath(join(mirror, "dangling", "file"))).toBe(join(owner, "not-yet", "file"));
  });
});

describe("safeOutputPath", () => {
  test.each([
    ["the owner's tree itself", owner],
    ["a dir inside it", join(owner, "design-system", "out")],
    ["a symlink into it", join(mirror, "linked", "out")],
    ["a dangling symlink into it", join(mirror, "dangling")],
    ["a case variant", join(scratch, "WORKSPACE", "Design-System")],
    ["a traversal", join(mirror, "..", "workspace", "x")],
  ])("refuses %s", (_, dest) => {
    expect(() => safeOutputPath(dest, { ownerTree: owner, label: "--out-dir" })).toThrow(UnsafePathError);
  });

  test("returns the canonical path of a destination outside the owner's tree, including a sibling sharing its prefix", () => {
    expect(safeOutputPath(join(mirror, "rollout", "shots"), { ownerTree: owner })).toBe(join(mirror, "rollout", "shots"));
  });

  test("allows the owner's tree when --root is that tree", () => {
    expect(safeOutputPath(join(owner, "out"), { ownerTree: owner, root: join(scratch, "WORKSPACE") })).toBe(join(owner, "out"));
    expect(() => safeOutputPath(join(owner, "out"), { ownerTree: owner, root: mirror })).toThrow(UnsafePathError);
  });

  test("an owner run from the codebases root may write in the owner's tree, never in its private dirs", () => {
    const codebases = join(owner, "codebases");
    mkdirSync(join(owner, "knowledge-base"), { recursive: true });
    mkdirSync(join(owner, "docs"), { recursive: true });
    mkdirSync(codebases, { recursive: true });
    expect(safeOutputPath(join(owner, "out"), { ownerTree: owner, root: codebases })).toBe(join(owner, "out"));
    expect(safeChildPath({ base: join(codebases, "run"), ownerTree: owner, root: codebases }, "x")).toBe(join(codebases, "run", "x"));
    for (const priv of ["knowledge-base", "docs"]) {
      for (const root of [codebases, owner]) {
        expect(() => safeOutputPath(join(owner, priv, "out"), { ownerTree: owner, root })).toThrow(/private dir/);
      }
    }
    expect(() => safeOutputPath(join(codebases, "out"), { ownerTree: owner, root: join(codebases, "apps") })).toThrow(/owner's tree/);
  });

  test("the default owner tree is refused by its firmlink spelling and in another case (metadata reads only)", () => {
    for (const dest of ["/Users/Ford/workspace/ds-out", "/System/Volumes/Data/Users/Ford/workspace/ds-out", "/users/ford/WORKSPACE/ds-out"]) {
      expect(() => safeOutputPath(dest, { root: mirror })).toThrow(/owner's tree/);
    }
  });
});

describe("path segments", () => {
  test.each(["../x", "a/b", "", ".hidden", "Upper", "a b"])("safeAppId refuses %p", (id) => {
    expect(() => safeAppId(id)).toThrow(UnsafePathError);
  });

  test.each(["..", ".", "a/b", "../../etc", ".git", ""])("safeSegment refuses %p", (name) => {
    expect(() => safeSegment(name, "--set")).toThrow(UnsafePathError);
  });

  test("accepts registry ids and set names", () => {
    expect(safeAppId("canvas-studio")).toBe("canvas-studio");
    expect(safeSegment("before_v2.1", "--set")).toBe("before_v2.1");
  });
});

describe("safeChildPath", () => {
  const out = join(mirror, "out");
  mkdirSync(join(out, "app", "shots"), { recursive: true });
  writeFileSync(join(out, "app", "notes.txt"), "");
  const elsewhere = join(scratch, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(out, "app", "linked")); // planted after the base was validated
  writeFileSync(join(elsewhere, "target.png"), "");
  symlinkSync(join(elsewhere, "target.png"), join(out, "app", "shots", "home-light.png"));
  const at = (...segments: string[]) => safeChildPath({ base: out, ownerTree: owner }, ...segments);

  test("returns the nested path under the canonical base, existing or not", () => {
    expect(at("app", "shots", "set-a", "home-dark.png")).toBe(join(out, "app", "shots", "set-a", "home-dark.png"));
    expect(at("app", "notes.txt")).toBe(join(out, "app", "notes.txt"));
  });

  test.each([
    ["a traversal segment", ["app", "..", "x"]],
    ["a segment with a separator", ["app", "shots/../../x"]],
    ["a hidden segment", ["app", ".git"]],
    ["no segment", []],
  ])("refuses %s", (_, segments) => {
    expect(() => at(...segments)).toThrow(UnsafePathError);
  });

  test("refuses a symlinked directory on the way, even one that points outside the owner's tree", () => {
    expect(() => at("app", "linked", "x.png")).toThrow(/is a symlink/);
  });

  test("refuses a symlink as the final component (a write would follow it)", () => {
    expect(() => at("app", "shots", "home-light.png")).toThrow(/is a symlink/);
  });

  test("refuses a file where a directory must be", () => {
    expect(() => at("app", "notes.txt", "x")).toThrow(/not a directory/);
  });

  test("refuses a base in the owner's tree unless --root is that tree", () => {
    expect(() => safeChildPath({ base: join(owner, "design-system"), ownerTree: owner }, "out")).toThrow(/owner's tree/);
    expect(() => safeChildPath({ base: join(mirror, "dangling"), ownerTree: owner }, "out")).toThrow(/owner's tree/);
    expect(safeChildPath({ base: join(owner, "design-system"), ownerTree: owner, root: owner }, "out")).toBe(join(owner, "design-system", "out"));
  });
});

describe("safeTempBase", () => {
  const home = join(scratch, "home");
  mkdirSync(join(home, "Library", "Caches"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  const check = (tmp: string) => safeTempBase({ tmp, home, ownerTree: owner });

  test("returns the canonical spelling of a system temp dir", () => {
    expect(check(tmpdir())).toBe(realpathSync(tmpdir()));
  });

  test.each([
    ["the owner's tree", () => join(owner, "design-system")],
    ["a symlink into the owner's tree", () => join(mirror, "linked")],
    ["~/Library/Caches", () => join(home, "Library", "Caches")],
    ["a credential store", () => join(home, ".ssh")],
    ["the home dir itself", () => home],
    ["a missing dir", () => join(scratch, "missing")],
  ])("refuses %s", (_, dir) => {
    expect(() => check(dir())).toThrow(UnsafePathError);
  });

  test("an ordinary dir under home that is not forbidden is accepted", () => {
    expect(check(join(home, "tmp"))).toBe(join(home, "tmp"));
  });
});
