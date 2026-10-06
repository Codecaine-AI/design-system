/**
 * Electron preload for app-runner (passed as `-r <this file>`; Playwright skips its own loader when
 * `executablePath` is set). It loads Playwright's loader (Chromium switches, argv cleanup, deferred
 * `ready`), removes its own `-r` pair from process.argv, and holds the app's `ready` event until
 * app-runner calls `globalThis.__ds_release()` after installing the request guard, so the first
 * window's first load is already guarded.
 *
 * Profile isolation: on macOS Electron ignores $HOME for its app paths (it asks the OS for the real
 * user's Application Support), so without this every run would read and write the owner's
 * `~/Library/Application Support/Electron`. Before `ready`, userData, sessionData, logs, crashDumps
 * and appData move under `$HOME/electron-user-data` (HOME is the run's temp dir). app-runner also
 * passes `--user-data-dir=<same dir>`, which this file removes from process.argv again so the app
 * sees the argv it was written for. A HOME that is missing or is the real user's home exits the app.
 */
const { app } = require("electron");
const { userInfo } = require("node:os");
const { join, resolve } = require("node:path");
const { mkdirSync } = require("node:fs");

const home = process.env.HOME;
if (!home || resolve(home) === resolve(userInfo().homedir)) {
  console.error(`[ds electron-loader] refusing to start: HOME (${home ?? "unset"}) is not a run temp dir`);
  process.exit(70);
}
const userData = join(home, "electron-user-data");
mkdirSync(userData, { recursive: true });
app.setPath("appData", join(userData, "appData"));
for (const name of ["userData", "sessionData", "logs", "crashDumps"]) app.setPath(name, name === "userData" ? userData : join(userData, name));

require(process.env.DS_PW_ELECTRON_LOADER);
const self = process.argv.indexOf(__filename);
if (self > 0 && process.argv[self - 1] === "-r") process.argv.splice(self - 1, 2);
const switchAt = process.argv.indexOf(`--user-data-dir=${userData}`);
if (switchAt > 0) process.argv.splice(switchAt, 1);
const run = globalThis.__playwright_run;
let release;
const released = new Promise((resolve) => (release = resolve));
globalThis.__ds_release = () => release();
globalThis.__playwright_run = async () => {
  await released;
  return run();
};
