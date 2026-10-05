/**
 * dist/css/host-contract.css: the agent-viewer host contract mapped to design-system tokens.
 *
 * viewer-ui, viewer-shell and prompt-kit read about sixty unprefixed variables from their host
 * (shadcn names, --trace-*, --status-*, --syntax-*, --agentprism-*, --editor-*). Each host used to
 * copy the block by hand (budget kernel.css, gamecube and observatory styles, simple-research-kernel
 * styles.css). This sheet is the one copy, generated from tokens/.
 */
import { cssName, GENERATED_NOTE, type Model, PREFIX, TokenError, themeOrder, themeSelector } from "../build.ts";
import { rgbTriplet } from "./color.ts";

/**
 * How a host contract variable is written, by what its readers do with it:
 * - rgb: "r g b", read as rgb(var(--x)) or rgb(var(--x) / <alpha>)
 * - color: a whole color, read as var(--x)
 * - length: a dimension, read as var(--x)
 */
export type HostFormat = "rgb" | "color" | "length";

export interface HostAlias {
  /** The variable, without "--": "background", "trace-user". */
  name: string;
  /** The token it reads. */
  token: string;
  format: HostFormat;
}

const rgb = (name: string, token: string): HostAlias => ({ name, token, format: "rgb" });
const color = (name: string, token: string): HostAlias => ({ name, token, format: "color" });

/** The contract, grouped as the hosts declare it. Names are the readers' API: never rename one. */
export const HOST_CONTRACT: ReadonlyArray<{ group: string; aliases: HostAlias[] }> = [
  {
    group: "shadcn surfaces and text (viewer-ui, viewer-shell, prompt-kit, annotations)",
    aliases: [
      rgb("background", "color.surface.page"),
      rgb("foreground", "color.text.body"),
      rgb("card", "color.surface.panel"),
      rgb("card-foreground", "color.text.body"),
      rgb("popover", "color.surface.panel"),
      rgb("popover-foreground", "color.text.body"),
      rgb("primary", "color.text.ink"),
      rgb("primary-foreground", "color.surface.page"),
      rgb("secondary", "color.fill.chip"),
      rgb("secondary-foreground", "color.text.ink"),
      rgb("muted", "color.fill.chip"),
      rgb("muted-foreground", "color.text.muted"),
      rgb("accent", "color.accent"),
      rgb("accent-foreground", "color.text.on-solid"),
      rgb("destructive", "color.status.danger.text"),
      rgb("border", "color.border.default"),
      rgb("input", "color.border.default"),
      rgb("ring", "color.focus-ring"),
      { name: "radius", token: "radius.base", format: "length" },
    ],
  },
  {
    group: "trace kinds: one hue per meaning",
    aliases: [
      rgb("trace-container", "color.text.muted"),
      rgb("trace-orchestration", "color.violet.text"),
      rgb("trace-user", "color.blue.text"),
      rgb("trace-assistant", "color.green.text"),
      rgb("trace-tool", "color.orange.text"),
      rgb("trace-lifecycle", "color.gray.text"),
      rgb("trace-meta", "color.gray.text"),
    ],
  },
  {
    group: "status: text, fill and border per state",
    aliases: ["neutral", "success", "warning", "info"].flatMap((state) => [
      rgb(`status-${state}`, `color.status.${state}.text`),
      rgb(`status-${state}-fill`, `color.status.${state}.soft`),
      rgb(`status-${state}-border`, `color.status.${state}.line`),
    ]),
  },
  {
    group: "syntax",
    aliases: ["key", "string", "number", "boolean"].map((part) => rgb(`syntax-${part}`, `color.syntax.${part}`)),
  },
  {
    group: "editor surface (prompt-kit)",
    aliases: [
      color("editor-bg", "color.code.bg"),
      color("editor-fg", "color.code.chip.ink"),
      color("editor-line-number", "color.code.gutter-fg"),
      color("editor-line-number-active", "color.code.header-fg"),
      color("editor-gutter-bg", "color.code.gutter-bg"),
      color("editor-rule", "color.border.subtle"),
      color("editor-guide", "color.border.guide"),
      color("editor-landmark", "color.surface.sunken"),
    ],
  },
  {
    group: "agentprism trace chrome",
    aliases: [
      rgb("agentprism-background", "color.surface.panel"),
      rgb("agentprism-foreground", "color.text.ink"),
      rgb("agentprism-muted", "color.fill.chip"),
      rgb("agentprism-muted-foreground", "color.text.muted"),
      rgb("agentprism-border-subtle", "color.border.default"),
      rgb("agentprism-code-base", "color.fill.chip"),
      rgb("agentprism-badge-agent-foreground", "color.blue.text"),
      rgb("agentprism-badge-chain-foreground", "color.teal.text"),
      rgb("agentprism-badge-llm-foreground", "color.green.text"),
      rgb("agentprism-badge-tool-foreground", "color.orange.text"),
    ],
  },
  {
    group: "trace tree and selection colors (the viewer-shell style engine may override them)",
    aliases: [
      rgb("tree-caret", "color.text.muted"),
      rgb("tree-connector", "color.border.strong"),
      rgb("selection-color", "color.accent"),
      rgb("zebra-color", "color.text.ink"),
    ],
  },
];

/** The pinned triplet variable for a theme token: --ds-dark-rgb-color-surface-page. */
export function rgbVarName(token: string, theme: string): string {
  return `--${PREFIX}-${theme}-rgb-${token.split(".").join("-")}`;
}

function hostValue(model: Model, alias: HostAlias, theme: string): string {
  if (alias.format === "rgb") return `var(${rgbVarName(alias.token, theme)})`;
  if (alias.format === "color") return `var(${cssName(alias.token, theme)})`;
  return `var(${cssName(alias.token)})`;
}

/** Every alias's token exists, with a type that fits its format. Throws TokenError listing the problems. */
function checkContract(model: Model): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { aliases } of HOST_CONTRACT) {
    for (const alias of aliases) {
      if (seen.has(alias.name)) problems.push(`host contract: --${alias.name} is listed twice`);
      seen.add(alias.name);
      const themed = model.theme[model.themes[0]].get(alias.token);
      const token = themed ?? model.base.get(alias.token);
      if (!token) problems.push(`host contract: --${alias.name} reads ${alias.token}, which is not a token`);
      else if (alias.format === "length" ? token.type !== "dimension" || themed : token.type !== "color" || !themed) {
        problems.push(`host contract: --${alias.name} needs a ${alias.format === "length" ? "base dimension" : "theme color"}, but ${alias.token} is a ${themed ? "theme" : "base"} ${token.type}`);
      }
    }
  }
  if (problems.length) throw new TokenError(problems);
}

/** dist/css/host-contract.css (`first` = the default theme) or host-contract-dark-first.css (`first` = "dark"). */
export function renderHostContractCss(model: Model, first: string = model.themes[0]): string {
  checkContract(model);
  const order = themeOrder(model, first);
  const rgbTokens = [...new Set(HOST_CONTRACT.flatMap(({ aliases }) => aliases.filter((a) => a.format === "rgb").map((a) => a.token)))];
  const lines = [
    "/*",
    ` * @codecaine-ai/design-system agent-viewer host contract${first === model.themes[0] ? "" : `, ${first} first`}.`,
    ` * ${GENERATED_NOTE}`,
    " *",
    ` * Load after ${first === model.themes[0] ? "tokens.css" : `tokens-${first}-first.css`}. It declares the unprefixed variables viewer-ui, viewer-shell and`,
    " * prompt-kit read from their host, mapped to design-system tokens, and follows the same theme",
    ` * switch (:root gets ${first}). It replaces a host's hand-copied contract block.`,
    " *",
    " * Formats, as the readers use them today:",
    " *   RGB triplet \"r g b\": the shadcn names, --trace-*, --status-*, --syntax-*, --agentprism-*,",
    " *     --tree-caret, --tree-connector, --selection-color, --zebra-color. Read as rgb(var(--x) / <alpha>).",
    " *   Color: --editor-*. Read as var(--x).",
    " *   Length: --radius, the one design-system radius.",
    " *",
    " * A triplet cannot be computed from a var() in CSS, so the build writes it from the token's resolved",
    ` * value as --${PREFIX}-<theme>-rgb-<path> on :root. A runtime override of a --${PREFIX}-<theme>-* color does not`,
    " * reach those; change the token and rebuild.",
    " *",
    " * Tailwind v3 hosts map a triplet as rgb(var(--background) / <alpha-value>); Tailwind v4 hosts as",
    " * --color-background: rgb(var(--background)). Map shadcn's --radius-sm/-md/-lg to var(--radius):",
    " * calc(var(--radius) - 4px) is below zero at the 2px radius.",
    " */",
    "",
    ":root {",
  ];
  for (const theme of order) {
    lines.push(`  /* ${theme} triplets */`);
    for (const token of rgbTokens) {
      const value = model.resolved.theme[theme].get(token)!;
      let triplet: string;
      try {
        triplet = rgbTriplet(String(value));
      } catch (error) {
        throw new TokenError([`host contract: ${token} (${theme}): ${(error as Error).message}`]);
      }
      lines.push(`  ${rgbVarName(token, theme)}: ${triplet};`);
    }
  }
  lines.push("}");
  for (const theme of order) {
    lines.push("", `${themeSelector(theme, first)} {`);
    for (const { group, aliases } of HOST_CONTRACT) {
      lines.push(`  /* ${group} */`);
      for (const alias of aliases) lines.push(`  --${alias.name}: ${hostValue(model, alias, theme)};`);
    }
    lines.push("}");
  }
  return `${lines.join("\n")}\n`;
}
