/**
 * Stand-in server for the app-runner tests (not an app). It writes the environment it received to
 * $HOME/env.json, starts a helper child that listens on a second port, then prints a Vite-style
 * colored ready line. GET / returns a page that requests its own port, the helper port, a port the
 * run never started, and a non-loopback host, and records which requests succeeded.
 */
const port = Number(process.env.FIXTURE_PORT);
const helperPort = Number(process.env.FIXTURE_HELPER_PORT);
const strayPort = Number(process.env.FIXTURE_STRAY_PORT);

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
    external: "http://example.invalid/",
  };
  window.results = Promise.all(Object.entries(targets).map(([name, url]) =>
    fetch(url).then(() => [name, "ok"], () => [name, "failed"]))).then(Object.fromEntries);
</script></body></html>`;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (request) =>
    new URL(request.url).pathname === "/ping"
      ? new Response("pong")
      : new Response(page, { headers: { "content-type": "text/html" } }),
});
console.log(`\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m${port}\u001b[22m/\u001b[39m`);
