/**
 * Check fixtures: one check id run against its own small good and bad pages, through runScore (the same
 * code paths as a real run), so every check has a pair that proves it fails the bad page and passes the
 * good one.
 *
 *   design-score/fixtures/<check-id>/good.html, bad.html    tokens only, light by default
 *   design-score/fixtures/<check-id>/good.css, bad.css      a static check's CSS (only CSS files are parsed for rules)
 *   design-score/fixtures/<check-id>/fixture.json           optional: FixtureSpec below
 *   design-score/fixtures/<check-id>/shots/<variant>.png    written by --fixture: the page with the findings boxed
 *
 * A tiny static server serves the design-system checkout (fixtures, dist/, css/, fonts/ only), so a
 * fixture loads ../../../css/fonts.css and ../../../dist/css/tokens.css by relative path. A fixture with
 * "themes": ["light", "dark"] also loads ../theme.js, which sets data-theme from ?theme=.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { CHECKS } from "./checks";
import { markPng } from "./crop";
import { runScore } from "./run";
import { decodePng } from "../lib/png";
import type { AppConfig, CheckStatus, Finding, PageSpec, ThemeSpec } from "./types";

export type Variant = "good" | "bad";
export const VARIANTS: Variant[] = ["good", "bad"];

export interface FixtureSpec {
  /** Themes to run (default ["light"]). "dark" needs the page to load ../theme.js. */
  themes?: Array<"light" | "dark">;
  /** Default 800x600. */
  viewport?: { width: number; height: number };
  /** Page fields for both variants. */
  page?: Pick<PageSpec, "waitFor" | "actions" | "settleMs" | "shiftWatch">;
  /** App config fields (R-align-near-miss handles, R-state-shift shift.open, M-layout-props motionAllow). */
  config?: Pick<AppConfig, "handles" | "ignore" | "shift" | "motionAllow" | "settleMs">;
}

export interface FixtureResult {
  check: string;
  variant: Variant;
  status: CheckStatus;
  fails: number;
  warns: number;
  note?: string;
  findings: Finding[];
  errors: string[];
  /** The run folder (scorecard.json, report.html, crops/). */
  runDir: string;
  /** shots/<variant>.png in the fixture folder, with the findings boxed (null when not written). */
  shot: string | null;
}

const THEMES: Record<"light" | "dark", ThemeSpec> = {
  light: { colorScheme: "light" },
  dark: { colorScheme: "dark", query: { theme: "dark" }, assert: 'html[data-theme="dark"]' },
};

export const fixturesRoot = (designSystem: string) => join(designSystem, "design-score/fixtures");

/** Check ids with a fixture folder (any folder under fixtures/ holding good.html or bad.html). */
export function fixtureIds(designSystem: string): string[] {
  const root = fixturesRoot(designSystem);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory() && VARIANTS.some((v) => existsSync(join(root, d, `${v}.html`))))
    .sort();
}

/** What the bad page must get: "warn" for a check whose rule never fails (its rule text has no "fail"), else "fail". */
export function expectedBad(checkId: string): "fail" | "warn" {
  const check = CHECKS.find((c) => c.id === checkId);
  if (!check) throw new Error(`unknown check id ${checkId}`);
  return /fail/i.test(check.rule) ? "fail" : "warn";
}

/** Serves the fixtures and the CSS they load, read-only, on a free loopback port. */
export function serveFixtures(designSystem: string): { url: string; stop: () => void } {
  const base = resolve(designSystem);
  const allowed = ["design-score/fixtures/", "dist/", "css/", "fonts/"];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
      const abs = resolve(base, path);
      if (!abs.startsWith(base + sep) || !allowed.some((p) => path.startsWith(p)) || !existsSync(abs) || !statSync(abs).isFile()) return new Response("not found", { status: 404 });
      return new Response(Bun.file(abs), { headers: { "cache-control": "no-store" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

export interface FixtureRunOptions {
  designSystem: string;
  /** The workspace root (Playwright and axe resolve from it). */
  root: string;
  /** Run folders go here (default <designSystem>/.design-score). */
  outRoot?: string;
  /** Write shots/<variant>.png into the fixture folder (default true). */
  writeShots?: boolean;
  variants?: Variant[];
}

/** Runs `checkId` on its fixture pages: one runScore per variant for a static check, else one run with both pages. */
export async function runFixture(checkId: string, opts: FixtureRunOptions): Promise<Record<Variant, FixtureResult | null>> {
  const check = CHECKS.find((c) => c.id === checkId);
  if (!check) throw new Error(`unknown check id ${checkId} (checks: ${CHECKS.map((c) => c.id).join(", ")})`);
  const dir = join(fixturesRoot(opts.designSystem), checkId);
  if (!existsSync(dir)) throw new Error(`no fixture folder ${dir}`);
  const spec: FixtureSpec = existsSync(join(dir, "fixture.json")) ? JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) : {};
  const variants = (opts.variants ?? VARIANTS).filter((v) => existsSync(join(dir, `${v}.html`)));
  const themes = Object.fromEntries((spec.themes ?? ["light"]).map((t) => [t, THEMES[t]]));
  const others = CHECKS.map((c) => c.id).filter((id) => id !== checkId);
  const outRoot = opts.outRoot ?? join(opts.designSystem, ".design-score");
  const isStatic = check.layer === "static";
  const server = serveFixtures(opts.designSystem);
  const out: Record<Variant, FixtureResult | null> = { good: null, bad: null };
  try {
    const groups = isStatic ? variants.map((v) => [v]) : [variants];
    for (const group of groups) {
      const config: AppConfig = {
        ...spec.config,
        app: `fixture-${checkId}`,
        repo: dir,
        // A static check reads only this variant's files (good.html, good.css, ...).
        sourceDirs: isStatic ? readdirSync(dir).filter((f) => f.startsWith(`${group[0]}.`)).map((f) => join(dir, f)) : [],
        themes,
        viewports: [spec.viewport ?? { width: 800, height: 600 }],
        settleMs: spec.config?.settleMs ?? 200,
        pages: group.map((v) => ({ ...spec.page, id: v, path: `design-score/fixtures/${checkId}/${v}.html`, skip: others, skipReason: `fixture for ${checkId}` })),
      };
      const label = isStatic ? group[0]! : "pair";
      const configDir = join(outRoot, config.app);
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, `config-${label}.json`);
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      const { dir: runDir, scorecard } = await runScore({
        root: opts.root,
        designSystem: opts.designSystem,
        configPath,
        config,
        baseUrl: server.url,
        label,
        outRoot,
        pages: null,
        themes: null,
        viewports: null,
        jobs: 2,
        motion: check.layer === "motion",
        focus: checkId === "R-focus-visible",
        static: isStatic,
        quiet: true,
      });
      for (const page of scorecard.pages) {
        const variant = page.id as Variant;
        const pc = page.checks[checkId] ?? { status: "n/a" as const, fails: 0, warns: 0, cut: 0 };
        const findings = scorecard.findings.filter((f) => f.check === checkId && (f.page === variant || f.page === "*"));
        let shot: string | null = null;
        if (opts.writeShots !== false) {
          mkdirSync(join(dir, "shots"), { recursive: true });
          for (const [i, s] of page.shots.filter((s) => s.kind === "state").entries()) {
            const marks = findings.filter((f) => f.theme === s.theme || f.theme === null);
            const file = join(dir, "shots", i === 0 ? `${variant}.png` : `${variant}-${s.theme}.png`);
            writeFileSync(file, markPng(decodePng(readFileSync(join(runDir, s.file))), marks));
            shot ??= file;
          }
        }
        out[variant] = { check: checkId, variant, status: pc.status, fails: pc.fails, warns: pc.warns, note: pc.note, findings, errors: page.errors, runDir, shot };
      }
    }
  } finally {
    server.stop();
  }
  return out;
}

/** One line per variant, and whether the pair proves the check: bad gets its expected status, good passes. */
export function judgeFixture(checkId: string, res: Record<Variant, FixtureResult | null>): { ok: boolean; lines: string[] } {
  const want = expectedBad(checkId);
  const lines: string[] = [];
  let ok = true;
  for (const v of VARIANTS) {
    const r = res[v];
    if (!r) {
      lines.push(`${checkId} ${v}: missing ${v}.html`);
      ok = false;
      continue;
    }
    const expected = v === "good" ? "pass" : want;
    const good = r.status === expected && (v === "good" || r.findings.length > 0) && !r.errors.length;
    ok &&= good;
    lines.push(`${checkId} ${v}: ${r.status} (want ${expected}) ${good ? "OK" : "WRONG"}, ${r.fails} fail / ${r.warns} warn${r.errors.length ? `, errors: ${r.errors.join("; ")}` : ""}${r.shot ? `\n  ${r.shot}` : ""}`);
    for (const f of r.findings) lines.push(`    ${f.severity} ${f.selector ?? f.file ?? ""}${f.line ? `:${f.line}` : ""}: ${f.measured}`);
  }
  return { ok, lines };
}
