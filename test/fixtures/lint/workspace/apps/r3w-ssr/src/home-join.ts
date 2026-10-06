import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DS = dirname(require.resolve("@codecaine-ai/design-system/package.json"));
const fonts = await Bun.file(join(DS, "css/fonts.css")).text();
const tokens = readFileSync(join(DS, "dist", "css", "tokens-dark-first.css"), "utf8");
const head = fonts + "\n" + tokens;

export function page(): string {
  return "<!doctype html><html><head><style>" + head + "</style></head><body>home</body></html>";
}
