import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";

// Round-3 close (R3-B3): whole bindings and reads, interpolated or concatenated, load in order.
const DS = dirname(require.resolve("@codecaine-ai/design-system/package.json"));
const fonts = await fsp.readFile(join(DS, "css/fonts.css"), "utf8");
const tokens = await Bun.file(join(DS, "dist/css/tokens-dark-first.css")).text();
const both = `${fonts}
${tokens}`;

export function page(): string {
  return `<!doctype html>
<html><head>
<style>${fonts}</style>
<style>${"/* tokens */\n" + tokens + "\n"}</style>
<style>${both}</style>
<style>${readFileSync(join(DS, "css/fonts.css"), "utf8")}</style>
</head><body>home</body></html>` + "<style>" + tokens + "</style>";
}
