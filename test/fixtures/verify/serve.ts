/**
 * Stand-in app server for the verify:apps tests (not an app): serves its own directory on
 * $FIXTURE_PORT ("/" is index.html) and prints a Vite-style ready line.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = process.cwd();
const port = Number(process.env.FIXTURE_PORT);
const TYPES: Record<string, string> = { html: "text/html", css: "text/css", woff2: "font/woff2", js: "text/javascript" };

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    let file = resolve(dir, `.${pathname}`);
    if (!file.startsWith(dir)) return new Response("not found", { status: 404 });
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: { "content-type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream" } });
  },
});
console.log(`  Local:   http://127.0.0.1:${port}/`);
