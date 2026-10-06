/**
 * The shared write-destination validator: every tool calls it before it creates anything, so a
 * destination that reaches the owner's tree by any spelling must be refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath, safeAppId, safeOutputPath, safeSegment, UnsafePathError } from "../scripts/lib/safe-paths.ts";

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
