/**
 * Stand-in server for the app-runner tests (not an app). It writes the environment it received to
 * $HOME/env.json, starts a helper child that listens on a second port, then prints a Vite-style
 * colored ready line. GET / returns a page that requests its own port, the helper port, a port the
 * run never started (stray), a named profile port nothing binds (dead), and a non-loopback host, and
 * records which requests succeeded. GET /themed is a
 * page that turns dark through data-theme, localStorage, ?theme=dark, a #dark button, or (with
 * ?follow=system) prefers-color-scheme; GET /themed-dark boots dark, turns light from localStorage, and links to its next page. GET /csp is a page under `style-src 'self'` with a 2 s transition.
 * GET /ws-probe opens WebSockets to this server's /ws (which greets) and to the stray port, and records
 * which ones opened and greeted. GET /hop?to=<url>&status=<3xx> redirects; GET /redirect-probe?foreign=<port>
 * is a page whose image, fetches and a two-hop chain are redirected to that port, plus one redirect that
 * stays on this server, and records what each fetch got.
 */
const port = Number(process.env.FIXTURE_PORT);
const helperPort = Number(process.env.FIXTURE_HELPER_PORT);
// Not profile env: registry:check's rules refuse a profile that names a port outside its block.
const strayPort = 46939;
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

// GET /themed-dark: boots dark (black) on purpose; light (white) when localStorage mode is "light".
// #next (bottom left) is a plain link to /themed-dark?page=2: a navigation-only route step loads a new document.
const themedDark = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; background: #000; }
  html[data-theme="light"] body { background: #fff; }
  #next { position: absolute; left: 0; bottom: 0; width: 8px; height: 8px; }
</style></head><body><a id="next" href="/themed-dark?page=2"></a><script>
  if (localStorage.getItem("mode") === "light") document.documentElement.setAttribute("data-theme", "light");
</script></body></html>`;

const wsProbe = `<!doctype html><html><body><script>
  const open = (url) => new Promise((done) => {
    const socket = new WebSocket(url);
    socket.onmessage = (event) => (socket.close(), done(event.data === "hello" ? "ok" : "unexpected"));
    socket.onerror = () => done("failed");
    socket.onclose = () => done("failed");
    setTimeout(() => done("timeout"), 3000);
  });
  window.wsResults = Promise.all([open("ws://127.0.0.1:${port}/ws"), open("ws://127.0.0.1:${strayPort}/")])
    .then(([own, stray]) => ({ own, stray }));
</script></body></html>`;

const redirectProbe = (foreign: string) => `<!doctype html><html><body>
<img id="img" src="/hop?status=302&to=${encodeURIComponent(`http://127.0.0.1:${foreign}/img-secret`)}">
<script>
  const hop = (to, status) => "/hop?status=" + status + "&to=" + encodeURIComponent(to);
  const get = (url) => fetch(url).then((r) => r.text(), () => "failed");
  window.redirectResults = Promise.all([
    get(hop("http://127.0.0.1:${foreign}/fetch-secret", 307)),
    get(hop(hop("http://127.0.0.1:${foreign}/chain-secret", 307), 302)),
    get(hop("/ping", 302)),
  ]).then(([foreign, chain, own]) => ({ foreign, chain, own }));
</script></body></html>`;

Bun.serve({
  // FIXTURE_HOST: a test makes the server listen beyond loopback (0.0.0.0).
  hostname: process.env.FIXTURE_HOST ?? "127.0.0.1",
  port,
  websocket: { open: (socket) => socket.send("hello"), message: () => {} },
  fetch: (request, server) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/ws" && server.upgrade(request)) return undefined;
    if (pathname === "/ws-probe") return new Response(wsProbe, { headers: { "content-type": "text/html" } });
    if (pathname === "/ping") return new Response("pong");
    if (pathname === "/hop") {
      const params = new URL(request.url).searchParams;
      return new Response(null, { status: Number(params.get("status") ?? 302), headers: { location: params.get("to") ?? "/" } });
    }
    // A response that never ends (a session event stream read with fetch + body.getReader()).
    if (pathname === "/stream")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first-chunk"));
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    if (pathname === "/stream-probe")
      return new Response(
          `<!doctype html><script>window.streamResult = fetch("/stream").then((r) => r.body.getReader().read()).then(({ value }) => new TextDecoder().decode(value), () => "failed");</script>`,
          { headers: { "content-type": "text/html" } },
        );
    if (pathname === "/redirect-probe") return new Response(redirectProbe(new URL(request.url).searchParams.get("foreign") ?? "0"), { headers: { "content-type": "text/html" } });
    // A page under a strict CSP (like a server that sends `style-src 'self'`) with a slow transition.
    if (pathname === "/csp")
      return new Response(`<!doctype html><link rel="stylesheet" href="/slow.css"><div id="box">box</div>`, {
        headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; style-src 'self'" },
      });
    if (pathname === "/slow.css") return new Response("#box { transition: opacity 2s; }", { headers: { "content-type": "text/css" } });
    if (pathname === "/themed-dark") return new Response(themedDark, { headers: { "content-type": "text/html" } });
    return new Response(pathname === "/themed" ? themed : page, { headers: { "content-type": "text/html" } });
  },
});
console.log(`\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m${port}\u001b[22m/\u001b[39m`);
