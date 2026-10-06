import { readFileSync } from "node:fs";
import fonts from "@codecaine-ai/design-system/fonts.css?raw";

const tokens = readFileSync(require.resolve("@codecaine-ai/design-system/tokens-dark-first.css"), "utf8");

export function page(): string {
  return `<!doctype html>
<html><head>
<style>${fonts}</style>
<style>
${tokens}
body { color: var(--ds-color-text-body); }
</style>
</head><body>home</body></html>`;
}
