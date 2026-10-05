/**
 * Electron preload for app-runner (passed as `-r <this file>`; Playwright skips its own loader when
 * `executablePath` is set). It loads Playwright's loader (Chromium switches, argv cleanup, deferred
 * `ready`), removes its own `-r` pair from process.argv, and holds the app's `ready` event until
 * app-runner calls `globalThis.__ds_release()` after installing the request guard, so the first
 * window's first load is already guarded.
 */
require(process.env.DS_PW_ELECTRON_LOADER);
const self = process.argv.indexOf(__filename);
if (self > 0 && process.argv[self - 1] === "-r") process.argv.splice(self - 1, 2);
const run = globalThis.__playwright_run;
let release;
const released = new Promise((resolve) => (release = resolve));
globalThis.__ds_release = () => release();
globalThis.__playwright_run = async () => {
  await released;
  return run();
};
