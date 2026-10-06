// Vitest config for personal-site's test gate, in place of the app's vite.config.ts: loading that
// config regenerates blog/, public/blog/, the sitemap, robots.txt, legacy-redirects.json and the
// tracked public/resume/ford-lascari-resume.md in the checkout before any test runs.
//
//   ./node_modules/.bin/vitest run --root . --config {ds}/apps/fixtures/personal-site/vitest.config.mjs \
//     --configLoader runner --no-cache
//
// No plugins and no imports: the tests import their modules directly. The app config's only test
// setting is environment "node" (vite.config.ts:45-47). `--configLoader runner` loads this file
// without writing a bundled copy next to it; `--no-cache` turns off the results cache; Vite's
// cacheDir goes under HOME, which the run profile points at the run's temp dir.
const home = process.env.HOME;
if (!home) throw new Error("HOME is unset; run under the run profile (HOME is the run's temp dir)");

export default {
  cacheDir: `${home}/.cache/personal-site-vite`,
  envDir: false,
  test: { environment: "node", watch: false },
};
