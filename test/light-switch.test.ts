/**
 * verify.lightSwitch without a browser: themePlan picks it for every light shot (and nothing changes for
 * entries without one), and the capture spec (captureSha256) includes it only when it is set.
 */
import { expect, test } from "bun:test";

import { themePlan } from "../scripts/lib/capture.ts";
import type { AppEntry, ThemeSwitch } from "../scripts/lib/registry.ts";
import { captureSha256 } from "../scripts/lib/snapshot-set.ts";

const darkSwitch: ThemeSwitch = { kind: "storage", key: "mode", value: "dark" };
const lightSwitch: ThemeSwitch = { kind: "storage", key: "mode", value: "light" };
const app = (rule: "light-dark" | "dark-first", light?: ThemeSwitch) =>
  ({ id: "demo", repo: "app", root: "app", theme: { rule }, routes: [{ id: "home", path: "/" }], verify: { probes: [], darkSwitch, ...(light ? { lightSwitch: light } : {}) } }) as unknown as AppEntry;

test("themePlan applies lightSwitch in every light shot and leaves dark to darkSwitch", () => {
  const plan = (rule: "light-dark" | "dark-first", theme: "light" | "dark", light?: ThemeSwitch) => {
    const p = themePlan(app(rule, light), theme);
    return [p.method, p.switch ?? null, p.init ?? null];
  };
  // Without a lightSwitch: as before.
  expect(plan("light-dark", "light")).toEqual(["default", null, null]);
  expect(plan("light-dark", "dark")).toEqual(["storage", darkSwitch, { storage: { mode: "dark" } }]);
  expect(plan("dark-first", "light")).toEqual(["prefers-color-scheme", null, null]);
  expect(plan("dark-first", "dark")).toEqual(["default", null, null]);
  // With one: light goes through it, on light-dark and dark-first entries alike; dark is unchanged.
  expect(plan("light-dark", "light", lightSwitch)).toEqual(["storage", lightSwitch, { storage: { mode: "light" } }]);
  expect(plan("light-dark", "dark", lightSwitch)).toEqual(["storage", darkSwitch, { storage: { mode: "dark" } }]);
  expect(plan("dark-first", "light", lightSwitch)).toEqual(["storage", lightSwitch, { storage: { mode: "light" } }]);
  expect(plan("dark-first", "dark", lightSwitch)).toEqual(["default", null, null]);
});

test("themePlan's attribute lightSwitch sets data-theme=light", async () => {
  const plan = themePlan(app("light-dark", { kind: "attribute", target: "#root" }), "light");
  const set: Array<[string, string]> = [];
  const page = { locator: (target: string) => ({ first: () => ({ evaluate: async (_fn: unknown, value: string) => set.push([target, value]), getAttribute: async () => "light" }) }) };
  await plan.afterLoad(page, undefined as never);
  await plan.verify(page);
  expect([plan.method, set]).toEqual(["attribute", [["#root", "light"]]]);
});

test("the capture spec includes lightSwitch only when set", () => {
  const without = app("light-dark");
  expect(captureSha256({ ...without, verify: { ...without.verify!, lightSwitch: undefined } })).toBe(captureSha256(without));
  expect(captureSha256(app("light-dark", lightSwitch))).not.toBe(captureSha256(without));
  expect(captureSha256(app("light-dark", lightSwitch))).not.toBe(captureSha256(app("light-dark", { kind: "query", param: "mode", value: "light" })));
});
