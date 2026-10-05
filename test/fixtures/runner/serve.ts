/**
 * Stand-in server for the app-runner tests (not an app). It writes the environment it received to
 * $HOME/env.json, starts a helper child that listens on a second port, then prints a Vite-style
 * colored ready line. GET / returns a page that requests its own port, the helper port, a port the
 * run never started (stray), a named profile port nothing binds (dead), and a non-loopback host, and
 * records which requests succeeded. GET /themed is a
 * page that turns dark through data-theme, localStorage, ?theme=dark, a #dark button, or (with
 * ?follow=system) prefers-color-scheme. GET /csp is a page under `style-src 'self'` with a 2 s transition.
 */
const port = Number(process.env.FIXTURE_PORT);
const helperPort = Number(process.env.FIXTURE_HELPER_PORT);
const strayPort = Number(process.env.FIXTURE_STRAY_PORT);
const deadPort = Number(process.env.FIXTURE_DEAD_PORT ?? 46938);

await Bun.write(`${process.env.HOME}/env.json`, JSON.stringify(process.env));

Bun.spawn(
  ["bun", "-e", `Bun.serve({ hostname: "127.0.0.1", port: ${helperPort}, fetch: () => new Response("helper", { headers: { "access-control-allow-origin": "*" } }) }); setInterval(() => {}, 1e6);`],
  { stdio: ["ignore", "inherit", "inherit"] },
);
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${helperPort}/`).then(() => true, () => false)) break;
  await Bun.sleep(50);
}

const page = `<!doctype html><html><body><script>
  const targets = {
    own: "/ping",
    helper: "http://127.0.0.1:${helperPort}/",
    stray: "http://127.0.0.1:${strayPort}/",
    dead: "http://127.0.0.1:${deadPort}/",
    external: "http://example.invalid/",
  };
  window.results = Promise.all(Object.entries(targets).map(([name, url]) =>
    fetch(url).then(() => [name, "ok"], () => [name, "failed"]))).then(Object.fromEntries);
</script></body></html>`;

const themed = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; background: #fff; }
  html[data-theme="dark"] body { background: #000; }
  @media (prefers-color-scheme: dark) { html.follow-system body { background: #000; } }
  #dark { position: absolute; right: 0; bottom: 0; width: 8px; height: 8px; padding: 0; border: 0; }
</style></head><body><button id="dark"></button><script>
  const params = new URLSearchParams(location.search);
  const root = document.documentElement;
  if (params.get("follow") === "system") root.classList.add("follow-system");
  if (localStorage.getItem("theme") === "dark" || params.get("theme") === "dark") root.setAttribute("data-theme", "dark");
  document.getElementById("dark").onclick = () => root.setAttribute("data-theme", "dark");
</script></body></html>`;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/ping") return new Response("pong");
    // A page under a strict CSP (like a server that sends `style-src 'self'`) with a slow transition.
    if (pathname === "/csp")
      return new Response(`<!doctype html><link rel="stylesheet" href="/slow.css"><div id="box">box</div>`, {
        headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; style-src 'self'" },
      });
    if (pathname === "/slow.css") return new Response("#box { transition: opacity 2s; }", { headers: { "content-type": "text/css" } });
    return new Response(pathname === "/themed" ? themed : page, { headers: { "content-type": "text/html" } });
  },
});
console.log(`\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m${port}\u001b[22m/\u001b[39m`);
