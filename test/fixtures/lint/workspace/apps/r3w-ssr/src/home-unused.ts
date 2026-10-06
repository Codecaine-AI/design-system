import { readFileSync } from "node:fs";
import tokensUrl from "@codecaine-ai/design-system/tokens-dark-first.css?url";

// Read but never put in a <style>; a URL is not the stylesheet's text.
const fonts = readFileSync(require.resolve("@codecaine-ai/design-system/fonts.css"), "utf8");
console.log(fonts.length);

export function page(): string {
  return `<!doctype html>
<html><head><style>${tokensUrl}</style></head><body><pre>${fonts}</pre></body></html>`;
}
