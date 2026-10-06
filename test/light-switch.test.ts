/**
 * verify.lightSwitch without a browser: themePlan writes a storage lightSwitch in every light shot of a
 * light-dark entry and nothing else (other kinds and dark-first entries get the plan they had before);
 * entries without one get exactly the old plan; the capture spec (captureSha256) includes it only when set.
 */
import { expect, test } from "bun:test";

import { themePlan } from "../scripts/lib/capture.ts";
import { type AppEntry, lightSeed, type ThemeSwitch } from "../scripts/lib/registry.ts";
import { captureSha256 } from "../scripts/lib/snapshot-set.ts";

const darkSwitch: ThemeSwitch = { kind: "storage", key: "mode", value: "dark" };
const lightSwitch = { kind: "storage" as const, key: "mode", value: "light" };
const app = (rule: "light-dark" | "dark-first", light?: unknown) =>
  ({ id: "demo", repo: "app", root: "app", theme: { rule }, routes: [{ id: "home", path: "/" }], verify: { probes: [], darkSwitch, ...(light ? { lightSwitch: light } : {}) } }) as unknown as AppEntry;

const plan = (rule: "light-dark" | "dark-first", theme: "light" | "dark", light?: unknown) => {
  const p = themePlan(app(rule, light), theme);
  return { keys: Object.keys(p).sort(), method: p.method, init: p.init ?? null };
};
const OLD_KEYS = ["afterLoad", "method", "url", "verify"];

test("without a lightSwitch, themePlan returns the old plan, with the old keys", () => {
  expect(plan("light-dark", "light")).toEqual({ keys: OLD_KEYS, method: "default", init: null });
  expect(plan("light-dark", "dark")).toEqual({ keys: [...OLD_KEYS, "init"].sort(), method: "storage", init: { storage: { mode: "dark" } } });
  expect(plan("dark-first", "light")).toEqual({ keys: OLD_KEYS, method: "prefers-color-scheme", init: null });
  expect(plan("dark-first", "dark")).toEqual({ keys: OLD_KEYS, method: "default", init: null });
});

test("a storage lightSwitch is written in every light shot of a light-dark entry; dark is unchanged", () => {
  expect(plan("light-dark", "light", lightSwitch)).toEqual({ keys: [...OLD_KEYS, "init"].sort(), method: "storage", init: { storage: { mode: "light" } } });
  expect(plan("light-dark", "dark", lightSwitch)).toEqual(plan("light-dark", "dark"));
});

test("no tool applies a lightSwitch of another kind, or one on a dark-first entry (validation rejects both)", () => {
  for (const other of [{ kind: "attribute" }, { kind: "query", param: "mode", value: "light" }, { kind: "click", selector: "#light" }, { kind: "steps", steps: [{ action: "click", target: "#light" }] }]) {
    expect([other.kind, lightSeed(app("light-dark", other))]).toEqual([other.kind, undefined]);
    expect(plan("light-dark", "light", other)).toEqual(plan("light-dark", "light"));
  }
  expect(lightSeed(app("dark-first", lightSwitch))).toBeUndefined();
  expect(plan("dark-first", "light", lightSwitch)).toEqual(plan("dark-first", "light"));
  expect(lightSeed(app("light-dark", lightSwitch))).toEqual(lightSwitch);
});

test("the capture spec includes lightSwitch only when set", () => {
  const without = app("light-dark");
  expect(captureSha256({ ...without, verify: { ...without.verify!, lightSwitch: undefined } })).toBe(captureSha256(without));
  expect(captureSha256(app("light-dark", lightSwitch))).not.toBe(captureSha256(without));
  expect(captureSha256(app("light-dark", lightSwitch))).not.toBe(captureSha256(app("light-dark", { ...lightSwitch, value: '{"theme":"light"}' })));
});
