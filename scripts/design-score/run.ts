/**
 * One design:score run: static checks, then per page each theme x viewport (state screenshot, DOM
 * probes, axe, focus), then the motion and reduced-motion passes, then the scorecard and report.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { runAxe } from "./axe";
import { findAxe, launch, type AxeSource } from "./browser";
import { CHECKS, STATIC_IDS } from "./checks";
import { cropPng, ShotCache } from "./crop";
import { focusPass } from "./focus";
import { analyzeMotion, analyzeReducedMotion, declaredLayoutTransitions, installMotionRecorder, readMotion, readScale, setRecording, type MotionRecord } from "./motion";
import { markMotionCandidates, probePage, type ProbeFinding } from "./probes";
import { writeReport } from "./report";
import { loadRuleMap } from "./rules";
import { appAreas, appScore, checkTotals, markNa, pageAreas, pageScore, SCORING, statusOf, tally } from "./score";
import { keepScroll, stateShiftPass, watchAfter, watchBefore, type ShiftBox } from "./state-shift";
import { runStaticChecks } from "./static-checks";
import { judgeRun } from "./judge";
import { decodePng } from "../lib/png";
import type { Action, AllowedFinding, AppConfig, Box, Finding, PageCheck, PageResult, PageSpec, RawFinding, Scorecard, Shot, ThemeSpec } from "./types";

export interface RunOptions {
  root: string;
  designSystem: string;
  configPath: string;
  config: AppConfig;
  baseUrl: string;
  label: string | null;
  outRoot: string;
  pages: string[] | null;
  themes: string[] | null;
  viewports: Array<{ width: number; height: number }> | null;
  jobs: number;
  motion: boolean;
  focus: boolean;
  static: boolean;
  quiet: boolean;
  /** One theme (the first) and one viewport (the first): for fast hill-climbing. */
  quick?: boolean;
  /** V-judge: write judge/pack.md for an agent to judge the state screenshots. */
  judgePack?: boolean;
}

/** Page ids picked by --pages: exact ids, or globs with `*` (docs-*). Unknown exact ids throw. */
export function selectPages(pages: PageSpec[], wanted: string[] | null): PageSpec[] {
  if (!wanted) return pages;
  const unknown = wanted.filter((w) => !w.includes("*") && !pages.some((p) => p.id === w));
  if (unknown.length) throw new Error(`unknown page ids: ${unknown.join(", ")} (config has ${pages.map((p) => p.id).join(", ")})`);
  const res = wanted.map((w) => new RegExp("^" + w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
  return pages.filter((p) => res.some((r) => r.test(p.id)));
}

const RUNTIME_IDS = CHECKS.filter((c) => c.layer === "runtime").map((c) => c.id);
const MOTION_IDS = CHECKS.filter((c) => c.layer === "motion").map((c) => c.id);

const safe = (s: string) => s.replace(/[^\w.-]+/g, "-");

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function git(dir: string): Record<string, unknown> {
  const run = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const head = run(["rev-parse", "HEAD"]);
  if (head.status !== 0) return { dir, git: null };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const status = run(["status", "--porcelain"]).stdout.split("\n").filter(Boolean);
  return { dir, head: head.stdout.trim(), branch, dirtyFiles: status.length };
}

/** Caps one check's findings for one page variant: fails first. */
function capped(list: RawFinding[], cap: number): { kept: RawFinding[]; fails: number; warns: number; cut: number } {
  const sorted = [...list].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
  return {
    kept: sorted.slice(0, cap),
    fails: list.filter((f) => f.severity === "fail").length,
    warns: list.filter((f) => f.severity === "warn").length,
    cut: Math.max(0, list.length - cap),
  };
}

async function runActions(page: any, actions: Action[] = []): Promise<void> {
  for (const a of actions) {
    const required = a.required !== false;
    try {
      if (a.waitFor) await page.waitForSelector(a.waitFor, { state: "visible", timeout: 10_000 });
      else if (a.click) await page.locator(a.click).first().click({ timeout: 5_000 });
      else if (a.hover) await page.locator(a.hover).first().hover({ timeout: 5_000 });
      else if (a.press) await page.keyboard.press(a.press);
      else if (a.focus) await page.locator(a.focus).first().focus({ timeout: 5_000 });
      else if (a.scrollTo) await page.locator(a.scrollTo).first().scrollIntoViewIfNeeded({ timeout: 5_000 });
      else if (a.mouse) await page.mouse.move(a.mouse[0], a.mouse[1]);
      else if (a.scroll) {
        const [sel, top] = a.scroll;
        const found = await page.evaluate(({ sel, top }: { sel: string; top: number }) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.scrollTop = top;
          return true;
        }, { sel, top });
        if (!found) throw new Error(`no element matches ${sel}`);
      }
      else if (a.wait) await page.waitForTimeout(a.wait);
    } catch (error) {
      if (required) throw new Error(`action ${JSON.stringify(a)} failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  }
}

function urlFor(base: string, path: string, theme: ThemeSpec): string {
  const url = new URL(path, base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(theme.query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Keeps a scored context read-only: anything but a GET, HEAD or OPTIONS request is aborted, and every
 * WebSocket is closed before it reaches its server (no connectToServer). Each one goes into `blocked`.
 */
export async function guardReadOnly(ctx: any, blocked: string[]): Promise<void> {
  await ctx.route("**/*", (route: any) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue();
    blocked.push(`${method} ${req.url()}`);
    return route.abort("blockedbyclient");
  });
  await ctx.routeWebSocket(() => true, (ws: any) => {
    blocked.push(`WebSocket ${ws.url()}`);
    return ws.close({ code: 1008, reason: "design:score is read-only" });
  });
}

export async function runScore(opts: RunOptions): Promise<{ dir: string; scorecard: Scorecard }> {
  const { config } = opts;
  const startedAt = new Date();
  const runId = stamp(startedAt) + (opts.label ? `-${safe(opts.label)}` : "");
  const dir = join(opts.outRoot, safe(config.app), runId);
  mkdirSync(join(dir, "shots"), { recursive: true });
  mkdirSync(join(dir, "crops"), { recursive: true });
  const log = (s: string) => {
    if (!opts.quiet) console.error(`[design:score] ${s}`);
  };
  const cap = config.cap ?? 6;
  const settle = config.settleMs ?? 600;
  let themes = Object.entries(config.themes).filter(([name]) => !opts.themes || opts.themes.includes(name));
  let viewports = opts.viewports ?? config.viewports ?? [{ width: 1440, height: 900 }, { width: 1024, height: 768 }];
  if (opts.quick) {
    themes = themes.slice(0, 1);
    viewports = viewports.slice(0, 1);
  }
  const pages = selectPages(config.pages, opts.pages);
  if (!pages.length) throw new Error(`no pages to score (config has ${config.pages.map((p) => p.id).join(", ")})`);
  const repo = config.repo ? resolve(opts.root, config.repo) : null;

  // Static checks: once per run.
  let staticRun: ReturnType<typeof runStaticChecks> | null = null;
  if (opts.static && repo && config.sourceDirs.length) {
    log(`static checks over ${config.sourceDirs.join(", ")}`);
    staticRun = runStaticChecks(repo, config.sourceDirs.map((d) => resolve(repo, d)), config.excludes ?? [], 25);
  }

  const space = JSON.parse(readFileSync(join(opts.designSystem, "dist/json/base.json"), "utf8")) as Record<string, string>;
  const spaceTokens = Object.entries(space)
    .filter(([k]) => k.startsWith("space."))
    .map(([, v]) => parseFloat(v))
    .filter((v) => Number.isFinite(v) && v % 4 !== 0);
  const baseRadii = Object.entries(space)
    .filter(([k]) => k.startsWith("radius.") && k !== "radius.none" && k !== "radius.pill")
    .map(([, v]) => parseFloat(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  const ruleMap = loadRuleMap(opts.designSystem);
  const motionAllow = (config.motionAllow ?? []).map((a) => ({ name: a.name, selector: a.selector, props: a.props }));
  const allowReason = new Map((config.motionAllow ?? []).map((a) => [a.name, a.reason]));
  const allowedAll: AllowedFinding[] = [];

  const axe: AxeSource | null = findAxe(opts.root);
  if (!axe) log("axe-core not found (set DS_AXE_PATH): R-axe is n/a");
  const { browser, ...browserInfo } = await launch(opts.root);
  // One line about the browser, always (also with --json): which Chromium runs, and why when it is not Playwright's own.
  console.error(`[design:score] ${browserInfo.fallback ? browserInfo.fallbackLine ?? browserInfo.fallback : `Chromium ${browserInfo.version} (Playwright ${browserInfo.playwright})`}`);

  const findings: Finding[] = [];
  const results: PageResult[] = [];
  const shotsCache = new ShotCache();
  const blockedAll: string[] = [];

  const newContext = async (theme: ThemeSpec, themeName: string, viewport: { width: number; height: number }, reducedMotion: "reduce" | "no-preference", recorder: boolean) => {
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: theme.colorScheme ?? (themeName === "dark" ? "dark" : "light"),
      reducedMotion,
      locale: "en-US",
      timezoneId: "UTC",
      serviceWorkers: "block",
      bypassCSP: true,
    });
    if (theme.localStorage && Object.keys(theme.localStorage).length) {
      await ctx.addInitScript((entries: Record<string, string>) => {
        try {
          for (const [k, v] of Object.entries(entries)) window.localStorage.setItem(k, v);
        } catch {
          // opaque origins (about:blank) have no storage
        }
      }, theme.localStorage);
    }
    if (recorder) await ctx.addInitScript(installMotionRecorder);
    await guardReadOnly(ctx, blockedAll);
    return ctx;
  };

  const open = async (ctx: any, spec: PageSpec, theme: ThemeSpec) => {
    const page = await ctx.newPage();
    for (const m of spec.mock ?? []) {
      // Page routes run before the context's write guard; anything but a GET falls through to it.
      await page.route((url: URL) => url.pathname === m.path, async (route: any) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        const json = { ...(await response.json()), ...m.merge };
        for (const [key, items] of Object.entries(m.append ?? {})) json[key] = [...(Array.isArray(json[key]) ? json[key] : []), ...items];
        await route.fulfill({ response, json });
      });
    }
    await page.goto(urlFor(opts.baseUrl, spec.path, theme), { waitUntil: "load", timeout: 30_000 });
    if (spec.waitFor) await page.waitForSelector(spec.waitFor, { state: "visible", timeout: 15_000 });
    if (config.loading?.length) {
      await page
        .waitForFunction((texts: string[]) => !texts.some((t) => document.body.innerText.includes(t)), config.loading, { timeout: 20_000 })
        .catch(() => {
          throw new Error(`still loading after 20s ("${config.loading!.join('", "')}" shows)`);
        });
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(settle);
    if (theme.assert) {
      const ok = await page.$(theme.assert);
      if (!ok) throw new Error(`theme not applied: ${theme.assert} does not match`);
    }
    return page;
  };

  const writeCrop = (rel: string, png: Uint8Array | null): string | undefined => {
    if (!png) return undefined;
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, png);
    return rel;
  };

  const scorePage = async (spec: PageSpec): Promise<PageResult> => {
    const checks: Record<string, PageCheck> = {};
    const shots: Shot[] = [];
    const errors: string[] = [];
    const skip = new Set(spec.skip ?? []);
    let cropN = 0;
    let skipped: string | null = null;
    const record = (check: string, list: RawFinding[], themeName: string | null, vpName: string | null, shotKey: string | null, shotPng: Uint8Array | null) => {
      const { kept, fails, warns, cut } = capped(list, cap);
      tally(checks, check, fails, warns, cut);
      for (const raw of kept) {
        const f: Finding = { ...raw, page: spec.id, theme: themeName, viewport: vpName };
        const pf = raw as RawFinding & { guides?: ProbeFinding["guides"]; key?: string };
        delete (f as Finding & { key?: string }).key;
        if (shotKey && shotPng && raw.box) {
          try {
            const img = shotsCache.get(shotKey, () => shotPng);
            const png = cropPng(img, { box: raw.box, other: raw.other?.box ?? null, guides: pf.guides });
            f.crop = writeCrop(`crops/${safe(spec.id)}/${safe(check)}-${themeName ?? "x"}-${vpName ?? "x"}-${++cropN}.png`, png);
          } catch (error) {
            errors.push(`crop ${check}: ${error instanceof Error ? error.message : error}`);
          }
        }
        findings.push(f);
      }
    };

    const hitBands = { fail: 0, spaced: 0, "warn-band": 0, elements: 0 };
    for (const [ti, [themeName, theme]] of themes.entries()) {
      if (skipped) break;
      for (const [vi, vp] of viewports.entries()) {
        if (skipped) break;
        const vpName = `${vp.width}x${vp.height}`;
        const ctx = await newContext(theme, themeName, vp, "no-preference", false);
        const first = ti === 0 && vi === 0;
        try {
          let page: any;
          let watched: ShiftBox[] | null = null;
          try {
            page = await open(ctx, spec, theme);
            if (first && spec.shiftWatch && !skip.has("R-state-shift")) watched = await watchBefore(page, spec.shiftWatch, config.ignore ?? []).catch(() => null);
            await runActions(page, spec.actions);
          } catch (error) {
            // An optional page that cannot load (or reach its state) is skipped, not an error.
            // A refused connection is the app being down, never a reason to skip.
            if (spec.optional && first && !/net::ERR_/.test(String(error instanceof Error ? error.message : error))) {
              skipped = `${spec.optional} (${error instanceof Error ? error.message.split("\n")[0] : error})`;
              continue;
            }
            throw error;
          }
          await page.waitForTimeout(spec.settleMs ?? settle);
          const shotRel = `shots/${safe(spec.id)}__${themeName}__${vpName}.png`;
          const png: Uint8Array = await page.screenshot({ path: join(dir, shotRel) });
          shots.push({ theme: themeName, viewport: vpName, file: shotRel, kind: "state" });
          const shotKey = `${spec.id}|${themeName}|${vpName}`;
          const watchHit = watched && spec.shiftWatch ? await watchAfter(page, watched, spec.shiftWatch, config.ignore ?? [], "reaching the page state").catch(() => null) : null;

          const probe = await page.evaluate(probePage, { ignore: config.ignore ?? [], handles: config.handles ?? [], spaceTokens, baseRadii });
          for (const f of probe.findings) {
            if (f.check !== "R-hit-target") continue;
            const band = (f.group ?? "fail").split("|")[0] as "fail" | "spaced" | "warn-band";
            if (band in hitBands) hitBands[band]++;
            hitBands.elements += f.count ?? 1;
          }
          const byCheck: Record<string, RawFinding[]> = {};
          for (const id of RUNTIME_IDS) byCheck[id] = [];
          for (const f of probe.findings) byCheck[f.check]!.push(f as unknown as RawFinding);
          for (const id of RUNTIME_IDS) {
            if (id === "R-axe" || id === "R-focus-visible" || skip.has(id)) continue;
            record(id, byCheck[id]!, themeName, vpName, shotKey, png);
          }

          if (!skip.has("R-axe") && axe) {
            try {
              record("R-axe", await runAxe(page, axe, config.ignore ?? []), themeName, vpName, shotKey, png);
            } catch (error) {
              errors.push(`R-axe ${themeName} ${vpName}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
            }
          }

          // The view the page state left, for the shift pass (the focus pass scrolls).
          const restoreView = first && !skip.has("R-state-shift") ? await keepScroll(page) : null;

          // Focus: every theme, first viewport (the ring's color is what changes by theme).
          if (opts.focus && vi === 0 && !skip.has("R-focus-visible")) {
            const focus = await focusPass(page, 30);
            const { kept, fails, warns, cut } = capped(focus.findings, cap);
            tally(checks, "R-focus-visible", fails, warns, cut);
            checks["R-focus-visible"]!.note = `${(checks["R-focus-visible"]!.note ? checks["R-focus-visible"]!.note + "; " : "")}${themeName}: ${focus.stops} Tab stops`;
            for (const raw of kept) {
              const f: Finding = { ...raw, page: spec.id, theme: themeName, viewport: vpName };
              const clip = focus.clips.find((c) => c.index === focus.findings.indexOf(raw));
              if (clip && raw.box) {
                const img = decodePng(clip.png);
                const box: Box = { x: raw.box.x - clip.clip.x, y: raw.box.y - clip.clip.y, w: raw.box.w, h: raw.box.h };
                f.crop = writeCrop(`crops/${safe(spec.id)}/R-focus-visible-${themeName}-${vpName}-${++cropN}.png`, cropPng(img, { box, margin: 8, scale: 3 }));
              }
              findings.push(f);
            }
          }

          // State shift: first theme, first viewport, after everything else measured this state.
          if (first && !skip.has("R-state-shift")) {
            try {
              await restoreView?.();
              const pass = await stateShiftPass(page, { ignore: config.ignore ?? [], open: config.shift?.open ?? [], max: config.shift?.max ?? 16 });
              const hits = watchHit ? [{ ...watchHit, png }, ...pass.hits] : pass.hits;
              const { kept, fails, warns, cut } = capped(hits.map((h) => h.finding), cap);
              tally(checks, "R-state-shift", fails, warns, cut);
              checks["R-state-shift"]!.note = pass.note + (spec.shiftWatch ? `; watched ${spec.shiftWatch} across the page's actions` : "");
              for (const raw of kept) {
                const hit = hits.find((h) => h.finding === raw)!;
                const f: Finding = { ...raw, page: spec.id, theme: themeName, viewport: vpName };
                if (raw.box && hit.png) {
                  try {
                    f.crop = writeCrop(`crops/${safe(spec.id)}/R-state-shift-${themeName}-${vpName}-${++cropN}.png`, cropPng(decodePng(hit.png), { box: raw.box, other: raw.other?.box ?? null }));
                  } catch (error) {
                    errors.push(`crop R-state-shift: ${error instanceof Error ? error.message : error}`);
                  }
                }
                findings.push(f);
              }
            } catch (error) {
              errors.push(`R-state-shift: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
            }
          }
        } catch (error) {
          errors.push(`${themeName} ${vpName}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        } finally {
          await ctx.close().catch(() => undefined);
        }
      }
    }

    if (checks["R-hit-target"]) checks["R-hit-target"].note = `${hitBands.fail} fail, ${hitBands.spaced} spaced (<24px, warn), ${hitBands["warn-band"]} warn-band (24-32px) component groups; ${hitBands.elements} elements`;

    // Motion: first theme, first viewport.
    if (opts.motion && themes.length && !skipped) {
      const [themeName, theme] = themes[0]!;
      const vp = viewports[0]!;
      const vpName = `${vp.width}x${vp.height}`;
      for (const reduced of [false, true]) {
        const ctx = await newContext(theme, themeName, vp, reduced ? "reduce" : "no-preference", true);
        try {
          const page = await open(ctx, spec, theme);
          await page.evaluate(setRecording, { on: true, phase: "actions", reset: true });
          await runActions(page, spec.actions);
          await page.waitForTimeout(spec.settleMs ?? settle);
          await page.evaluate(setRecording, { on: false, phase: "" });
          const shotRel = `shots/${safe(spec.id)}__${themeName}__${vpName}__${reduced ? "reduced-motion" : "motion"}.png`;
          const png: Uint8Array = await page.screenshot({ path: join(dir, shotRel) });
          shots.push({ theme: themeName, viewport: vpName, file: shotRel, kind: reduced ? "reduced-motion" : "motion" });
          const n: number = await page.evaluate(markMotionCandidates, { max: reduced ? 12 : 24, ignore: config.ignore ?? [] });
          const cdp = await ctx.newCDPSession(page);
          await cdp.send("DOM.enable");
          await cdp.send("CSS.enable");
          await cdp.send("DOM.getDocument", { depth: 0 });
          const scales: Array<{ scale: number; rest: number; selector: string; box: Box }> = [];
          for (let i = 0; i < n; i++) {
            const obj = await cdp.send("Runtime.evaluate", { expression: `window.__dsProbe[${i}]` });
            if (!obj.result?.objectId) continue;
            const { nodeId } = await cdp.send("DOM.requestNode", { objectId: obj.result.objectId });
            if (!nodeId) continue;
            const rest = await page.evaluate(readScale, String(i));
            await page.evaluate(setRecording, { on: true, phase: `hover:${i}` });
            await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
            await page.waitForTimeout(110);
            await page.evaluate(setRecording, { on: true, phase: `press:${i}` });
            await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover", "active"] });
            await page.waitForTimeout(110);
            await page.evaluate(setRecording, { on: false, phase: "" });
            const pressed = await page.evaluate(readScale, String(i));
            await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
            if (pressed && rest) scales.push({ scale: pressed.scale, rest: rest.scale, selector: pressed.selector, box: rest.box });
          }
          await page.waitForTimeout(120);
          const records: MotionRecord[] = await page.evaluate(readMotion, motionAllow);
          const shotKey = `${spec.id}|${themeName}|${vpName}|${reduced}`;
          if (!reduced) {
            const declared = await page.evaluate(declaredLayoutTransitions, motionAllow);
            const allowedHere: Array<RawFinding & { allowed: string }> = [];
            const out = analyzeMotion(records, scales, declared, allowedHere);
            for (const a of allowedHere) allowedAll.push({ ...a, page: spec.id, theme: themeName, viewport: vpName, reason: allowReason.get(a.allowed) ?? "" });
            for (const id of ["M-duration", "M-layout-props", "M-press-scale"]) if (!skip.has(id)) record(id, out[id]!, themeName, vpName, shotKey, png);
            if (checks["M-duration"]) checks["M-duration"].note = `${records.length} animations seen, ${n} controls hovered and pressed`;
            if (allowedHere.length && checks["M-layout-props"]) checks["M-layout-props"].note = `${allowedHere.length} allowed (${[...new Set(allowedHere.map((a) => a.allowed))].join(", ")}), not counted`;
            if (checks["M-press-scale"]) checks["M-press-scale"].note = `${scales.filter((x) => x.scale / (x.rest || 1) < 0.999).length} of ${scales.length} controls scale on press`;
          } else if (!skip.has("M-reduced-motion")) {
            const matches: boolean = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
            record("M-reduced-motion", analyzeReducedMotion(records, matches), themeName, vpName, shotKey, png);
            checks["M-reduced-motion"]!.note = `${records.length} animations seen under reduce${matches ? "" : " (the media query did not match)"}`;
          }
        } catch (error) {
          errors.push(`motion${reduced ? " (reduced)" : ""}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        } finally {
          await ctx.close().catch(() => undefined);
        }
      }
    }

    if (skipped) {
      for (const c of CHECKS) checks[c.id] = { status: "n/a", fails: 0, warns: 0, cut: 0, note: "page skipped" };
      const result: PageResult = { id: spec.id, path: spec.path, score: null, checks, shots, errors, skipped, areas: pageAreas(checks) };
      log(`${spec.id}: skipped (${skipped})`);
      return result;
    }

    // Static checks count in every page.
    if (staticRun) {
      for (const id of STATIC_IDS) {
        if (skip.has(id)) continue;
        const r = staticRun.results[id]!;
        checks[id] = { status: statusOf(r.fails ?? 0, r.warns ?? 0), fails: r.fails ?? 0, warns: r.warns ?? 0, cut: r.cut ?? 0 };
      }
    }
    for (const c of CHECKS) {
      if (checks[c.id]) continue;
      if (skip.has(c.id)) markNa(checks, c.id, spec.skipReason ?? "skipped by the page config");
      else if (c.id === "V-judge") markNa(checks, c.id, "not judged");
      else if (c.id === "R-axe" && !axe) markNa(checks, c.id, "axe-core not found");
      else if (c.layer === "static") markNa(checks, c.id, "no sourceDirs, or --no-static");
      else if (c.layer === "motion" && !opts.motion) markNa(checks, c.id, "--no-motion");
      else if (c.id === "R-focus-visible" && !opts.focus) markNa(checks, c.id, "--no-focus");
      else markNa(checks, c.id, errors.length ? "did not run: see errors" : "did not run");
    }
    // A page whose browser checks all failed to run gets no score: the static checks alone would inflate the app score.
    const ranInBrowser = CHECKS.some((c) => c.layer !== "static" && checks[c.id]?.status !== "n/a");
    const result: PageResult = { id: spec.id, path: spec.path, score: ranInBrowser ? pageScore(checks) : null, checks, shots, errors, areas: pageAreas(checks) };
    log(`${spec.id}: ${result.score ?? "-"}${errors.length ? ` (${errors.length} errors: ${errors[0]})` : ""}`);
    return result;
  };

  try {
    const queue = [...pages];
    const workers = Array.from({ length: Math.max(1, Math.min(opts.jobs, queue.length)) }, async () => {
      for (let spec = queue.shift(); spec; spec = queue.shift()) results.push(await scorePage(spec));
    });
    await Promise.all(workers);
  } finally {
    await browser.close().catch(() => undefined);
  }
  results.sort((a, b) => pages.findIndex((p) => p.id === a.id) - pages.findIndex((p) => p.id === b.id));

  // Static findings, once, with page "*".
  if (staticRun) for (const id of STATIC_IDS) for (const raw of staticRun.results[id]!.findings) findings.push({ ...raw, page: "*", theme: null, viewport: null });

  // Every finding carries the design-score/rules/ rules behind its check.
  for (const f of [...findings, ...allowedAll]) {
    const ids = ruleMap.map.get(f.check);
    if (ids?.length) f.rules = ids;
  }

  const configText = readFileSync(opts.configPath, "utf8");
  const scorecard: Scorecard = {
    tool: "design-score",
    version: 1,
    app: config.app,
    label: opts.label,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    config: { path: relative(opts.designSystem, opts.configPath), sha256: createHash("sha256").update(configText).digest("hex") },
    provenance: {
      app: repo ? git(repo) : null,
      designSystem: git(opts.designSystem),
      playwright: browserInfo.playwright,
      browser: { version: browserInfo.version, executable: browserInfo.executable, fallback: browserInfo.fallback },
      axe: axe ? { path: axe.path, version: axe.version, sha256: axe.sha256 } : null,
      themes: themes.map(([n]) => n),
      viewports: viewports.map((v) => `${v.width}x${v.height}`),
      staticFiles: staticRun?.files ?? 0,
      blockedRequests: [...new Set(blockedAll)].slice(0, 50),
      cap,
      quick: !!opts.quick,
      rules: ruleMap.path ? relative(opts.designSystem, ruleMap.path) : null,
    },
    scoring: SCORING,
    score: appScore(results),
    areas: appAreas(results),
    checks: CHECKS,
    checkTotals: checkTotals(results),
    pages: results,
    findings,
    allowed: allowedAll,
    judge: { shots: [], rules: 0, stale: [], pack: null, note: "" },
  };
  // V-judge last, over the state screenshots: the verdicts carried from earlier runs, and the pack.
  judgeRun(scorecard, dir, opts.designSystem, { pack: opts.judgePack });
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(scorecard, null, 2) + "\n");
  writeReport(dir, scorecard, opts.designSystem);
  return { dir, scorecard };
}

export { MOTION_IDS };
