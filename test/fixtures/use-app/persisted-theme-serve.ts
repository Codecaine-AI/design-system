/**
 * Stand-in for an app that saves its theme on its server (docs-workbench's global theme), not an app:
 * serves its own directory on $FIXTURE_PORT ("/" is index.html) and prints a Vite-style ready line.
 *
 *   GET  /api/theme   404 until a theme was saved (the app renders light then), else { dark }
 *   POST /api/theme   { dark } saves it in memory: every later load, in any browser context, gets it
 *   GET  /api/writes  how many saves there were
 *
 * index.html reads the saved theme on load and sets html[data-theme]; its "Colors" button reveals the
 * "Dark mode" checkbox, which applies and saves the theme on every change, the way the workbench's
 * style rail does. A click on that checkbox toggles; it never sets one theme.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = process.cwd();
const port = Number(process.env.FIXTURE_PORT);
let saved: { dark: boolean } | null = null;
let writes = 0;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/theme") {
      if (request.method === "POST") {
        saved = { dark: Boolean((await request.json()).dark) };
        writes += 1;
        return Response.json(saved);
      }
      return saved ? Response.json(saved) : new Response("no theme saved", { status: 404 });
    }
    if (url.pathname === "/api/writes") return Response.json({ writes });
    let file = resolve(dir, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dir)) return new Response("not found", { status: 404 });
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: { "content-type": file.endsWith(".html") ? "text/html" : "application/octet-stream" } });
  },
});
console.log(`  Local:   http://127.0.0.1:${port}/`);
