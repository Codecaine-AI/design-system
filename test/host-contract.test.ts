/**
 * dist/css/host-contract.css: the variables viewer-ui, viewer-shell and prompt-kit read from their host,
 * mapped to tokens. The names and formats are the readers' API; the token behind each name is the
 * design decision. Both are listed here once, so a rename or a remap is a visible change to this table.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOutputs, ROOT, readSources, TokenError } from "../scripts/build.ts";
import { evaluateColor } from "../scripts/lib/color.ts";
import { cascade, type El, parseCss, readJson, readText, type Theme, workspaceRoot } from "./support.ts";

type Format = "rgb" | "color" | "length";

/** Every contract variable: [name, format, token]. */
const CONTRACT: Array<[string, Format, string]> = [
  // shadcn names
  ["background", "rgb", "color.surface.page"],
  ["foreground", "rgb", "color.text.body"],
  ["card", "rgb", "color.surface.panel"],
  ["card-foreground", "rgb", "color.text.body"],
  ["popover", "rgb", "color.surface.panel"],
  ["popover-foreground", "rgb", "color.text.body"],
  ["primary", "rgb", "color.text.ink"],
  ["primary-foreground", "rgb", "color.surface.page"],
  ["secondary", "rgb", "color.fill.chip"],
  ["secondary-foreground", "rgb", "color.text.ink"],
  ["muted", "rgb", "color.fill.chip"],
  ["muted-foreground", "rgb", "color.text.muted"],
  ["accent", "rgb", "color.accent"],
  ["accent-foreground", "rgb", "color.text.on-solid"],
  ["destructive", "rgb", "color.status.danger.text"],
  ["border", "rgb", "color.border.default"],
  ["input", "rgb", "color.border.default"],
  ["ring", "rgb", "color.focus-ring"],
  ["radius", "length", "radius.base"],
  // trace kinds
  ["trace-container", "rgb", "color.text.muted"],
  ["trace-orchestration", "rgb", "color.violet.text"],
  ["trace-user", "rgb", "color.blue.text"],
  ["trace-assistant", "rgb", "color.green.text"],
  ["trace-tool", "rgb", "color.orange.text"],
  ["trace-lifecycle", "rgb", "color.gray.text"],
  ["trace-meta", "rgb", "color.gray.text"],
  // status
  ...["neutral", "success", "warning", "info"].flatMap((s): Array<[string, Format, string]> => [
    [`status-${s}`, "rgb", `color.status.${s}.text`],
    [`status-${s}-fill`, "rgb", `color.status.${s}.soft`],
    [`status-${s}-border`, "rgb", `color.status.${s}.line`],
  ]),
  // syntax
  ["syntax-key", "rgb", "color.syntax.key"],
  ["syntax-string", "rgb", "color.syntax.string"],
  ["syntax-number", "rgb", "color.syntax.number"],
  ["syntax-boolean", "rgb", "color.syntax.boolean"],
  // editor surface
  ["editor-bg", "color", "color.code.gutter-bg"],
  ["editor-fg", "color", "color.code.chip.ink"],
  ["editor-line-number", "color", "color.code.gutter-fg"],
  ["editor-line-number-active", "color", "color.code.header-fg"],
  ["editor-gutter-bg", "color", "color.code.gutter-bg"],
  ["editor-rule", "color", "color.border.subtle"],
  ["editor-guide", "color", "color.border.guide"],
  ["editor-landmark", "color", "color.surface.sunken"],
  // agentprism
  ["agentprism-background", "rgb", "color.surface.panel"],
  ["agentprism-foreground", "rgb", "color.text.ink"],
  ["agentprism-muted", "rgb", "color.fill.chip"],
  ["agentprism-muted-foreground", "rgb", "color.text.muted"],
  ["agentprism-border-subtle", "rgb", "color.border.default"],
  ["agentprism-code-base", "rgb", "color.fill.chip"],
  ["agentprism-badge-agent-foreground", "rgb", "color.blue.text"],
  ["agentprism-badge-chain-foreground", "rgb", "color.teal.text"],
  ["agentprism-badge-llm-foreground", "rgb", "color.green.text"],
  ["agentprism-badge-tool-foreground", "rgb", "color.orange.text"],
  // trace tree and selection
  ["tree-caret", "rgb", "color.text.muted"],
  ["tree-connector", "rgb", "color.border.strong"],
  ["selection-color", "rgb", "color.accent"],
  ["zebra-color", "rgb", "color.text.ink"],
];

/** Opaque sRGB channels of a resolved token color: #rrggbb, or color-mix(in srgb, ...) of two of them. */
function channels(value: string): number[] {
  const hex = /^#([0-9a-f]{6})$/.exec(value);
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16));
  const mix = /^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})(?: (\d+)%)?\)$/.exec(value);
  if (!mix) throw new Error(`the test cannot evaluate ${value}`);
  const p = Number(mix[2]);
  const q = mix[4] === undefined ? 100 - p : Number(mix[4]);
  const [a, b] = [channels(mix[1]), channels(mix[3])];
  return a.map((c, i) => (c * p + b[i] * q) / (p + q));
}

const triplet = (value: string) => channels(value).map(Math.round).join(" ");

const PAIRS: Array<[host: string, tokens: string, first: Theme]> = [
  ["dist/css/host-contract.css", "dist/css/tokens.css", "light"],
  ["dist/css/host-contract-dark-first.css", "dist/css/tokens-dark-first.css", "dark"],
];

describe("dist/css/host-contract.css", () => {
  test.each(PAIRS)("%s declares exactly the contract names in each theme block, and only pinned triplets on :root", (host) => {
    const blocks = parseCss(readText(host));
    const [root, ...themes] = blocks;
    expect(root.prelude).toBe(":root");
    expect(root.declarations.filter(([name, value]) => !/^--ds-(?:light|dark)-rgb-[a-z0-9-]+$/.test(name) || !/^\d{1,3} \d{1,3} \d{1,3}$/.test(value))).toEqual([]);
    expect(themes).toHaveLength(2);
    for (const block of themes) expect(block.declarations.map(([name]) => name).sort()).toEqual(CONTRACT.map(([name]) => `--${name}`).sort());
  });

  test.each(PAIRS)("%s, loaded after %s: every name computes to its token in the nearest theme (root default %s)", (host, tokens, first) => {
    const sheets = [parseCss(readText(tokens)), parseCss(readText(host))];
    const other: Theme = first === "light" ? "dark" : "light";
    const chains: Array<[El[], Theme]> = [
      [[{ root: true }], first],
      [[{ root: true }, { theme: other }], other],
      [[{ root: true, theme: other }, { className: first }], first],
    ];
    const base = readJson("dist/json/base.json");
    const wrong: string[] = [];
    for (const [chain, theme] of chains) {
      const get = cascade(sheets, chain);
      const values = readJson(`dist/json/${theme}.json`);
      for (const [name, format, token] of CONTRACT) {
        const expected = format === "rgb" ? triplet(values[token]) : format === "color" ? values[token] : base[token];
        const got = get(`--${name}`);
        if (got !== expected) wrong.push(`${theme} --${name}: ${got} (expected ${expected} from ${token})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test.each(PAIRS)("%s: --editor-bg and --editor-gutter-bg compute to opaque colors in both themes (viewer-ui paints a sticky gutter with them)", (host, tokens, first) => {
    const sheets = [parseCss(readText(tokens)), parseCss(readText(host))];
    const other: Theme = first === "light" ? "dark" : "light";
    const translucent: string[] = [];
    for (const chain of [[{ root: true }], [{ root: true }, { theme: other }]] as El[][]) {
      const get = cascade(sheets, chain);
      for (const name of ["--editor-bg", "--editor-gutter-bg"]) {
        const value = get(name);
        if (evaluateColor(value).a !== 1) translucent.push(`${name}: ${value}`);
      }
    }
    expect(translucent).toEqual([]);
  });

  test.each(["editor-bg", "editor-gutter-bg"])("a translucent token behind --%s fails the build, naming the alias and the token", (name) => {
    const sources = readSources(ROOT);
    const light = sources.themes.find((s) => s.file.endsWith("/light.tokens.json"))!.json as any;
    light.color.code["gutter-bg"].$value = "color-mix(in srgb, {color.gray.soft} 30%, transparent)";
    expect(() => buildOutputs(ROOT, sources)).toThrow(new RegExp(`--${name} must be opaque .*color\\.code\\.gutter-bg \\(light\\)`));
  });

  test("a contract triplet on a translucent token fails the build, naming the token", () => {
    const sources = readSources(ROOT);
    const light = sources.themes.find((s) => s.file.endsWith("/light.tokens.json"))!.json as any;
    light.color.fill.chip.$value = "color-mix(in srgb, #1f1f1f 8%, transparent)";
    expect(() => buildOutputs(ROOT, sources)).toThrow(TokenError);
    expect(() => buildOutputs(ROOT, sources)).toThrow(/color\.fill\.chip \(light\).*opaque/);
  });

  const root = workspaceRoot();
  /** Hand-copied contract blocks this sheet replaces. Knobs that are not colors stay with the host or the style engine. */
  const COPIES = [
    "codecaine/core/agent-kernel/examples/simple-research-kernel/src/styles.css",
    "codecaine/core/observatory/src/ui/index.css",
    "harnesses/gamecube-decomp-harness/apps/frontend/src/styles.css",
  ];
  const KNOB = /opacity|width|^--(?:research|style)-/;

  test.skipIf(!root || !COPIES.every((path) => existsSync(join(root, path))))(
    "covers every color variable the hand-copied host blocks declare on :root (skips without the workspace checkout)",
    () => {
      const missing = COPIES.flatMap((path) => {
        // The first :root block of each copy is its contract; the rest of the file is app CSS.
        const text = readFileSync(join(root!, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const body = /:root\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
        const names = [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((name) => !KNOB.test(name));
        return names.filter((name) => !CONTRACT.some(([n]) => `--${n}` === name)).map((name) => `${path}: ${name}`);
      });
      expect(missing).toEqual([]);
    },
  );
});
