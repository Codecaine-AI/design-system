/**
 * Shared fixtures for the verify:apps tests: the fixture pages, the web fonts they load, the
 * Playwright root, and a registry entry whose probes cover page, panel, text, border and font.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { playwrightUnavailable } from "../scripts/lib/playwright.ts";
import { type AppEntry, DESIGN_SYSTEM_ROOT, type VerifySpec } from "../scripts/lib/registry.ts";

export const FIXTURES = join(import.meta.dir, "fixtures/verify");
/** Playwright and the fonts resolve from the mirror, like every rollout tool. */
export const MIRROR = process.env.DS_MIRROR ?? "/Users/Ford/workspace-ds";
export const FONT_FILES = ["Inter-Regular.woff2", "IBMPlexMono-Regular.woff2"] as const;

/** Where Inter and IBM Plex Mono woff2 files live: the package once it ships them, else text-measure in the mirror. */
export const FONT_DIR = [
  join(DESIGN_SYSTEM_ROOT, "fonts"),
  join(DESIGN_SYSTEM_ROOT, "css/fonts"),
  join(MIRROR, "codecaine/core/canvas/packages/text-measure/fonts"),
].find((dir) => FONT_FILES.every((file) => existsSync(join(dir, file))));

/** Why the browser tests cannot run here, or null. */
export const browserSkip: string | null =
  playwrightUnavailable(MIRROR) ?? (FONT_DIR ? null : `no ${FONT_FILES.join(" / ")} in the package or the mirror's text-measure`);
if (browserSkip) console.warn(`skipping the verify:apps browser tests: ${browserSkip}`);

export const PROBES: VerifySpec["probes"] = [
  { selector: "body", property: "background-color", token: "color.surface.page" },
  { selector: ".panel", property: "background-color", token: "color.surface.panel" },
  { selector: "body", property: "color", token: "color.text.body" },
  { selector: ".panel", property: "border-top-color", token: "color.border.default" },
  { selector: "body", property: "font-family", token: "font.family.sans" },
];

export const FIXTURE_VERIFY: VerifySpec = {
  probes: PROBES,
  darkSwitch: { kind: "attribute" },
  sidebar: { storageKey: "fixture.sidebar" },
};

/** Serves the fixture pages, the build's tokens.css and the fonts. */
export function fixtureResponse(pathname: string): Response {
  if (pathname === "/tokens.css") return new Response(readFileSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css")), { headers: { "content-type": "text/css" } });
  if (pathname.startsWith("/fonts/") && FONT_DIR) return new Response(Bun.file(join(FONT_DIR, pathname.slice("/fonts/".length))), { headers: { "content-type": "font/woff2" } });
  const page = join(FIXTURES, pathname.slice(1));
  if (pathname.endsWith(".html") && existsSync(page)) return new Response(Bun.file(page), { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
}

/** A registry entry for a fixture app; tests override what they exercise. */
export function fixtureApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    id: "verify-fixture",
    name: "verify fixture",
    shell: true,
    theme: { rule: "light-dark" },
    verify: FIXTURE_VERIFY,
    routes: [{ id: "home", path: "/" }],
    ...overrides,
  } as AppEntry;
}

/** A workspace root under `parent` with the stand-in server (fixtures/verify/serve.ts) serving the good page at app/. */
export function makeFixtureRoot(parent: string): string {
  const root = mkdtempSync(join(parent, "root-"));
  const app = join(root, "app");
  mkdirSync(join(app, "fonts"), { recursive: true });
  cpSync(join(FIXTURES, "serve.ts"), join(app, "serve.ts"));
  cpSync(join(FIXTURES, "good.html"), join(app, "index.html"));
  writeFileSync(join(app, "tokens.css"), readFileSync(join(DESIGN_SYSTEM_ROOT, "dist/css/tokens.css")));
  for (const file of FONT_FILES) copyFileSync(join(FONT_DIR!, file), join(app, "fonts", file));
  return root;
}

/** A registry entry the real runner can start from a makeFixtureRoot root. */
export function runnableFixtureApp(ports: Record<string, number>, path = "/"): AppEntry {
  return fixtureApp({
    // The fixture's own dark-mode button, reached through registry steps.
    verify: { ...FIXTURE_VERIFY, darkSwitch: { kind: "steps", steps: [{ action: "click", target: ".theme-toggle" }] } },
    root: "app",
    commands: { cwd: "app" },
    routes: [{ id: "home", path }],
    gates: { verify: { required: true } } as AppEntry["gates"],
    consume: { via: "relative-import", detail: "app/tokens.css" },
    run: { mode: "browser", cwd: "app", start: "bun serve.ts", readyPattern: "Local:\\s+(http://127\\.0\\.0\\.1:\\d+/?)" },
    runProfile: {
      env: { NO_COLOR: "1", FIXTURE_PORT: "{port:ui}" },
      unsetEnv: [],
      tempHome: true,
      fixtures: [],
      flags: [],
      ports,
      proof: { status: "proven", method: "test fixture" },
    },
  });
}
