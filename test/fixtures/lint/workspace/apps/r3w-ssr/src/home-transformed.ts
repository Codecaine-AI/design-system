import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import fonts from "@codecaine-ai/design-system/fonts.css?raw";

// Round-3 close (R3-B3): text read, then transformed or never awaited, inside a style block: no load.
const TOKENS = require.resolve("@codecaine-ai/design-system/tokens-dark-first.css");
const tokens = readFileSync(TOKENS, "utf8");
const pending = Bun.file(TOKENS).text();
const later = readFile(TOKENS, "utf8");
const cut = tokens.slice(0, 0);
const meta = { tokens };

export function page(dark: boolean): string {
  return `<!doctype html>
<html><head>
<style>${fonts.slice(0, 0)}${tokens.slice(0, 0)}</style>
<style>${tokens.replace(/[^]/g, "")}</style>
<style>${tokens?.length}</style>
<style>${dark ? tokens : ""}</style>
<style>${pending}</style>
<style>${later}</style>
<style>${cut}</style>
<style>${JSON.stringify(tokens)}</style>
<style>${"" + tokens.slice(0, 0) + ""}</style>
<style>${+tokens}</style>
<style>${meta.tokens}</style>
<style>${Bun.file(TOKENS).text()}</style>
<style>${readFile(TOKENS, "utf8")}</style>
<style>${readFileSync(TOKENS, "utf8").trim().slice(0, 0)}</style>
</head><body>home</body></html>` + "<style>" + (dark && tokens) + "</style>";
}
