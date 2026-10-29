import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launch } from "../scripts/design-score/browser";
import { CHECK_IDS, CHECKS } from "../scripts/design-score/checks";
import { analyzeMotion, readScale, type MotionRecord } from "../scripts/design-score/motion";
import { probePage } from "../scripts/design-score/probes";
import { loadRuleMap, loadRules, RULE_AREAS, rulesByCheck } from "../scripts/design-score/rules";
import { focusPass } from "../scripts/design-score/focus";
import { guardReadOnly, selectPages } from "../scripts/design-score/run";
import { AREAS, appAreas, appScore, pageAreas, pageScore, statusOf } from "../scripts/design-score/score";
import { diffShift, dropScrollbarMoves, keepScroll, stateShiftPass, type ShiftBox } from "../scripts/design-score/state-shift";
import { runStaticChecks } from "../scripts/design-score/static-checks";
import type { PageCheck, PageResult, RawFinding } from "../scripts/design-score/types";
import { DESIGN_SYSTEM_ROOT, workspaceRoot } from "../scripts/lib/registry";

function staticFindings(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ds-score-"));
  try {
    mkdirSync(join(dir, "src"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
    const run = runStaticChecks(dir, [join(dir, "src")]);
    return Object.fromEntries(Object.entries(run.results).map(([id, r]) => [id, r.findings.map((f) => `${f.severity} ${f.file}:${f.line}`)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("design:score static checks", () => {
  test("transition shorthands that name no property, and transition-all, animate everything", () => {
    const found = staticFindings({
      "a.css": ".a { transition: 200ms ease; }\n.b { transition: opacity var(--ds-motion-duration-base) var(--ds-motion-easing-standard); }\n",
      "b.tsx": 'export const B = () => <div className="transition-all" />;\n',
    });
    expect(found["S-transition-all"]).toEqual(["fail src/a.css:1", "fail src/b.tsx:1"]);
  });

  test("motion literals fail outside reduced-motion rules and var() fallbacks", () => {
    const found = staticFindings({
      "a.css": ".a { animation: spin 1s linear infinite; }\n.b { transition: opacity var(--ds-motion-duration-base, 150ms); }\n@media (prefers-reduced-motion: reduce) { .a { transition-duration: 1ms; } }\n",
    });
    expect(found["S-motion-literal"]).toEqual(["fail src/a.css:1"]);
  });

  test(":hover counts as guarded only inside @media (hover: hover)", () => {
    const found = staticFindings({ "a.css": ".a:hover { color: var(--x); }\n@media (hover: hover) { .b:hover { color: var(--x); } }\n.c { &:hover { opacity: 0.5; } }\n" });
    expect(found["S-hover-unguarded"]).toEqual(["warn src/a.css:1", "warn src/a.css:3"]);
  });

  test("outline: none passes with a focus rule that shows a ring for the same class", () => {
    const found = staticFindings({
      "a.css": ".field { outline: none; }\n.field:focus { box-shadow: 0 0 0 2px var(--ds-color-focus-ring); }\n.bare:focus { outline: none; }\n",
      "b.tsx": 'export const B = () => <><input className="outline-none" /><input className="outline-none focus-visible:ring-2" /></>;\n',
    });
    expect(found["S-outline-none"]).toEqual(["fail src/a.css:3", "fail src/b.tsx:1"]);
  });
});

describe("design:score scoring", () => {
  const check = (status: PageCheck["status"]): PageCheck => ({ status, fails: 0, warns: 0, cut: 0 });

  test("pass 1, warn 0.5, fail 0; n/a is left out", () => {
    expect(pageScore({ a: check("pass"), b: check("warn"), c: check("fail"), d: check("n/a") })).toBe(50);
    expect(statusOf(1, 5)).toBe("fail");
    expect(statusOf(0, 2)).toBe("warn");
    expect(statusOf(0, 0)).toBe("pass");
  });

  test("the app score is the mean of page scores", () => {
    const page = (score: number | null): PageResult => ({ id: "p", path: "/", score, checks: {}, shots: [], errors: [] });
    expect(appScore([page(80), page(60), page(null)])).toBe(70);
  });
});

describe("design:score v2 logic", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const sb = (rect: ReturnType<typeof box>, layout = rect, visible = true): ShiftBox => ({ rect, layout, visible });

  test("diffShift: a layout move of 1px or more is a shift; transforms, scrolls and sub-pixel moves are not", () => {
    const before = [sb(box(0, 0, 100, 20)), sb(box(0, 30, 100, 20)), sb(box(0, 60, 100, 20)), sb(box(0, 90, 100, 20)), sb(box(0, 120, 50, 20), box(0, 120, 50, 20), false)];
    const after = [
      sb(box(0, 0, 121.5, 20)), // widened 21.5px: shift
      sb(box(0, 28, 100, 20), box(0, 30, 100, 20)), // moved by a transform only (layout box unchanged): no shift
      sb(box(0, 60.6, 100, 20), box(0, 60.6, 100, 20)), // 0.6px: under the threshold
      sb(box(0, 92, 100, 20), box(0, 92, 100, 20)), // pushed down 2px: shift
      sb(box(0, 200, 50, 20)), // was hidden before (a menu that appears): left out
    ];
    const moves = diffShift(before, after);
    expect(moves.map((m) => m.index)).toEqual([0, 3]);
    expect(moves[0]!.dw).toBe(21.5);
    expect(moves[1]!.dy).toBe(2);
  });

  test("dropScrollbarMoves: a width change by the scrollbar that came or went is not a shift; anything else still is", () => {
    const m = (dx: number, dy: number, dw: number, dh: number, index = 0) => ({ index, dx, dy, dw, dh, size: Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh)) });
    const moves = [m(0, 0, 15, 0, 0), m(-7.5, 0, 0, 0, 1), m(0, 2, 15, 0, 2), m(0, 0, 21.5, 0, 3)];
    expect(dropScrollbarMoves(moves, [15]).kept.map((x) => x.index)).toEqual([2, 3]);
    expect(dropScrollbarMoves(moves, [0]).kept.length).toBe(4);
  });

  test("selectPages: exact ids and globs; an unknown id is an error", () => {
    const pages = ["inbox", "docs-editor-hover", "docs-editor-hover-heading", "project"].map((id) => ({ id, path: "/" }));
    expect(selectPages(pages, null).length).toBe(4);
    expect(selectPages(pages, ["docs-*", "inbox"]).map((p) => p.id)).toEqual(["inbox", "docs-editor-hover", "docs-editor-hover-heading"]);
    expect(() => selectPages(pages, ["inbox", "nope"])).toThrow(/unknown page ids: nope/);
  });

  test("design-score/rules/ links each check to its rules (string, list or null)", () => {
    const map = rulesByCheck({ rules: [{ id: "a", check: "R-x" }, { id: "b", check: ["R-x", "R-y"] }, { id: "c", check: null }] });
    expect(map.get("R-x")).toEqual(["a", "b"]);
    expect(map.get("R-y")).toEqual(["b"]);
    expect(map.size).toBe(2);
    // The shipped rules name R-state-shift for ks-no-state-shift, and every check id they name exists.
    const shipped = loadRuleMap(DESIGN_SYSTEM_ROOT).map;
    expect(shipped.get("R-state-shift")).toContain("ks-no-state-shift");
    for (const id of shipped.keys()) expect(CHECK_IDS).toContain(id);
  });

  test("every rule sits in one area file, and a rule with a check sits in its check's area", () => {
    const { rules } = loadRules(DESIGN_SYSTEM_ROOT);
    expect(rules.length).toBe(303);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    const areaOf = new Map(CHECKS.map((c) => [c.id, c.area ?? "judge"]));
    for (const r of rules) {
      expect(RULE_AREAS as readonly string[]).toContain(r.area!);
      for (const c of [r.check ?? []].flat()) expect(`${r.id}: ${r.area}`).toBe(`${r.id}: ${areaOf.get(c)}`);
    }
  });

  test("area sub-scores use the page formula over each area's checks", () => {
    const st = (status: PageCheck["status"]): PageCheck => ({ status, fails: 0, warns: 0, cut: 0 });
    const areas = pageAreas({ "R-align-near-miss": st("pass"), "R-spacing-grid": st("fail"), "R-contrast": st("warn"), "R-axe": st("n/a") });
    expect(areas.layout).toBe(50);
    expect(areas.color).toBe(50);
    expect(areas.accessibility).toBeNull();
    for (const c of CHECKS) if (c.id !== "V-judge") expect(AREAS).toContain(c.area!);
    const page = (a: Record<string, number | null>): PageResult => ({ id: "p", path: "/", score: 1, checks: {}, shots: [], errors: [], areas: a });
    expect(appAreas([page({ layout: 80 }), page({ layout: 60 }), page({ layout: null })]).layout).toBe(70);
  });

  test("M-layout-props: a motionAllow match is reported as allowed and not counted; other props still count", () => {
    const rec = (props: string[], allowed: { name: string; props: string[] } | null): MotionRecord => ({ phase: "actions", type: "CSSTransition", name: props[0]!, props, duration: 260, delay: 0, iterations: 1, easing: "ease", pseudo: null, selector: "div#root > div.ds-shell", kind: "panel", box: box(0, 0, 1440, 900), probe: null, allowed });
    const shell = { name: "ds-shell-sidebar", props: ["grid-template-columns"] };
    const allowedOut: Array<RawFinding & { allowed: string }> = [];
    const out = analyzeMotion([rec(["grid-template-columns"], shell), rec(["width"], shell)], [], [{ selector: "div.ds-shell", props: ["grid-template-columns"], box: box(0, 0, 1440, 900), allowed: shell }], allowedOut);
    expect(out["M-layout-props"]!.map((f) => f.measured)).toEqual(["animates width (260ms) while reaching the page state"]);
    // The declared transition on the same element is the running one: reported once.
    expect(allowedOut.map((f) => `${f.allowed} ${f.severity}`)).toEqual(["ds-shell-sidebar fail"]);
    const declaredOnly: Array<RawFinding & { allowed: string }> = [];
    expect(analyzeMotion([], [], [{ selector: "div.ds-shell", props: ["grid-template-columns"], box: box(0, 0, 1440, 900), allowed: shell }], declaredOnly)["M-layout-props"]!.length).toBe(0);
    expect(declaredOnly.map((f) => `${f.allowed} ${f.severity}`)).toEqual(["ds-shell-sidebar warn"]);
    // Without the entry, the same records count.
    expect(analyzeMotion([rec(["grid-template-columns"], null)], [], [])["M-layout-props"]!.length).toBe(1);
  });
});

describe.skipIf(!!process.env.DS_SKIP_BROWSER)("design:score v2 in a browser", () => {
  let browser: any;
  let page: any;
  beforeAll(async () => {
    browser = (await launch(workspaceRoot())).browser;
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  });
  afterAll(async () => {
    await browser?.close();
  });
  const probe = (baseRadii: number[] = []) => page.evaluate(probePage, { ignore: [], handles: [], spaceTokens: [2, 6], baseRadii });

  test("R-hit-target groups one component into one finding with a count, and keeps the warn band apart", async () => {
    await page.setContent(`<body style="margin:0;font:14px sans-serif">
      <nav>${Array.from({ length: 5 }, (_, i) => `<a class="crumb" href="#${i}" style="display:inline-block;height:18px;width:16px;margin-right:2px">c${i}</a>`).join("")}</nav>
      <button class="tool" style="height:28px;width:60px;margin:40px">Tool</button></body>`);
    const hits = (await probe()).findings.filter((f: { check: string }) => f.check === "R-hit-target");
    expect(hits.map((f: { severity: string; count: number; group: string }) => `${f.severity} ${f.count} ${f.group}`)).toEqual(["fail 5 fail|a.crumb", "warn 1 warn-band|button.tool"]);
  });

  test("R-hit-target exempts an inline-flex link in a line of words, not a row of breadcrumbs", async () => {
    await page.setContent(`<body style="margin:0;font:12px/18px sans-serif">
      <p class="meta">YouTube · captured Oct 3 · <a class="src" href="#s" style="display:inline-flex">youtube.com · Theo</a></p>
      <nav style="margin-top:40px"><a class="crumb" href="#a" style="display:inline-flex">Areas</a> / <a class="crumb" href="#b" style="display:inline-flex">Making</a></nav></body>`);
    const hits = (await probe()).findings.filter((f: { check: string }) => f.check === "R-hit-target");
    expect(hits.map((f: { group: string }) => f.group.split("|")[1])).toEqual(["a.crumb"]);
  });

  test("R-control-height skips a link that spans a row, and still flags two buttons", async () => {
    await page.setContent(`<style>.row:hover, .row { background: #ddd; } button { border: 1px solid #888; }</style>
      <body style="margin:20px;font:14px sans-serif"><div style="display:flex;gap:8px;align-items:center"><a class="row" href="#r" style="display:block;width:600px;height:32px">Session</a><button style="height:28px">Open</button></div>
      <div style="display:flex;gap:8px;margin-top:40px"><button style="height:32px">A</button><button style="height:28px">B</button></div></body>`);
    const heights = (await probe()).findings.filter((f: { check: string }) => f.check === "R-control-height");
    expect(heights.map((f: { selector: string }) => f.selector).every((sel: string) => !sel.includes("a.row"))).toBe(true);
    expect(heights.length).toBeGreaterThan(0);
  });

  test("R-concentric-radius: a nested pair both on a base radius passes", async () => {
    await page.setContent(`<body style="margin:0;background:#fff"><div style="margin:20px;padding:8px;width:200px;border:1px solid #888;border-radius:6px"><div style="height:40px;border:1px solid #888;border-radius:6px;background:#eee"></div></div></body>`);
    const radius = (r: { findings: Array<{ check: string }> }) => r.findings.filter((f) => f.check === "R-concentric-radius").length;
    expect(radius(await probe([]))).toBe(1);
    expect(radius(await probe([6]))).toBe(0);
  });

  test("R-state-shift: a hover that adds a border fails; a hover transform does not", async () => {
    await page.setContent(`<style>button { border: 1px solid #888; height: 32px; } .grow:hover { border-width: 4px; } .lift:hover { transform: translateY(-2px); }</style>
      <body style="margin:40px"><div class="row" style="display:flex;gap:8px"><button class="grow">Grow</button><span class="next">Next</span></div>
      <div class="row2" style="display:flex;gap:8px;margin-top:40px"><button class="lift">Lift</button><span class="next2">Next</span></div></body>`);
    const { hits } = await stateShiftPass(page, { ignore: [], open: [], max: 8 });
    const measured = hits.map((h) => h.finding.measured);
    expect(measured.length).toBe(1);
    expect(measured[0]).toMatch(/^hovering button\.grow "Grow": moves or resizes the control/);
    expect(hits[0]!.finding.severity).toBe("fail");
  });

  test("R-state-shift: a control that moves itself on hover fails, without resizing or moving a neighbour", async () => {
    await page.setContent(`<style>button { border: 1px solid #888; height: 32px; position: relative; } .nudge:hover { left: 8px; }</style>
      <body style="margin:40px"><div style="display:flex;gap:8px"><button class="nudge">Nudge</button><span>Next</span></div></body>`);
    const { hits } = await stateShiftPass(page, { ignore: [], open: [], max: 8 });
    expect(hits.map((h) => h.finding.measured)).toEqual([expect.stringMatching(/^hovering button\.nudge "Nudge": moves or resizes the control/)]);
  });

  test("R-state-shift: a centered control that moves only because its menu hides the scrollbar passes", async () => {
    await page.setContent(`<style>body { margin: 0; } .wrap { width: 300px; margin: 40px auto; display: flex; gap: 8px; } button { height: 32px; } .tall { height: 2000px; }</style>
      <body><div class="wrap"><button aria-haspopup="menu" class="menu" onclick="document.documentElement.style.overflow='hidden'">Menu</button><span>Next</span></div><div class="tall"></div></body>`);
    const gutter = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);
    const { hits } = await stateShiftPass(page, { ignore: [], open: [], max: 8 });
    expect(gutter).toBeGreaterThan(0);
    expect(hits.map((h) => h.finding.measured)).toEqual([]);
  });

  test("R-contrast: a faded text does not change the color read for the next text", async () => {
    await page.setContent(`<body style="margin:20px;background:#fff;font:16px sans-serif"><p class="faded" style="color:#000;opacity:.3">Faded</p><p class="solid" style="color:#000">Solid</p></body>`);
    const contrast = (await probe()).findings.filter((f: { check: string }) => f.check === "R-contrast");
    expect(contrast.map((f: { selector: string }) => f.selector).some((sel: string) => sel.includes("solid"))).toBe(false);
    expect(contrast.length).toBe(1);
  });

  test("R-contrast: text and a background in one faded group are skipped; a faded text on the page still fails", async () => {
    await page.setContent(`<body style="margin:20px;background:#fff;font:16px sans-serif">
      <div style="background:#000;color:#fff;opacity:.5;padding:8px"><span class="on-dark">White on a faded black panel</span></div>
      <div style="background:#000;padding:8px"><div style="background:#fff;color:#000;opacity:.5;padding:8px"><span class="on-light">Black on a faded white panel</span></div></div>
      <p class="gray" style="color:#666;opacity:.6">Faded gray</p></body>`);
    const contrast = (await probe()).findings.filter((f: { check: string }) => f.check === "R-contrast");
    // Without the skip, the faded white panel would read as 3.95:1 (#808080 on #ffffff): it renders black on #808080.
    expect(contrast.map((f: { selector: string }) => f.selector)).toEqual([expect.stringContaining("gray")]);
  });

  test("R-focus-visible: a control with no focus style fails next to a control with a ring", async () => {
    await page.setContent(`<style>button { width: 80px; height: 32px; border: 1px solid #888; background: #eee; } .bare, .bare:focus { outline: none; } .ring:focus-visible { outline: 3px solid #00f; outline-offset: 1px; }</style>
      <body style="margin:20px;background:#fff"><div style="display:flex;gap:2px"><button class="bare">Bare</button><button class="ring">Ring</button></div></body>`);
    const { findings, stops } = await focusPass(page, 10);
    expect(stops).toBe(2);
    expect(findings.map((f) => f.selector)).toEqual([expect.stringContaining("button.bare")]);
  });

  test("R-state-shift: the shift pass runs on the view the page state left, not where the focus pass scrolled", async () => {
    await page.setContent(`<style>html { scroll-behavior: smooth; } body { margin: 20px; } button { display: block; height: 32px; margin: 8px 0; border: 1px solid #888; } .grow:hover { border-width: 4px; }</style>
      <body><button class="grow">Grow</button>${Array.from({ length: 40 }, (_, i) => `<button class="b">B${i}</button>`).join("")}</body>`);
    const restoreView = await keepScroll(page);
    await focusPass(page, 30);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await restoreView();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const { hits } = await stateShiftPass(page, { ignore: [], open: [], max: 8 });
    expect(hits.map((h) => h.finding.measured)).toContainEqual(expect.stringMatching(/^hovering button\.grow "Grow": moves or resizes the control/));
  });

  test("M-press-scale reads a matrix3d press transform: scale(0.9) translateZ(1px) on :active fails", async () => {
    await page.setContent(`<style>.press { width: 80px; height: 32px; } .press:active { transform: scale(0.9) translateZ(1px); }</style>
      <body style="margin:20px"><button class="press">Press</button></body>`);
    await page.evaluate(() => void ((window as unknown as { __dsProbe: Element[] }).__dsProbe = [document.querySelector(".press")!]));
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      await cdp.send("DOM.getDocument", { depth: 0 });
      const obj = await cdp.send("Runtime.evaluate", { expression: "window.__dsProbe[0]" });
      const { nodeId } = await cdp.send("DOM.requestNode", { objectId: obj.result.objectId });
      const rest = await page.evaluate(readScale, "0");
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover", "active"] });
      const pressed = await page.evaluate(readScale, "0");
      const found = analyzeMotion([], [{ scale: pressed.scale, rest: rest.scale, selector: pressed.selector, box: rest.box }], [])["M-press-scale"]!;
      expect(found.map((f) => f.severity)).toEqual(["fail"]);
    } finally {
      await cdp.detach();
    }
  });

  test("the read-only guard closes every WebSocket before a message reaches its server", async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: (_ws, message) => void received.push(String(message)) },
    });
    const ctx = await browser.newContext();
    try {
      const blocked: string[] = [];
      await guardReadOnly(ctx, blocked);
      const p = await ctx.newPage();
      await p.setContent("<body></body>");
      await p.evaluate((url: string) => new Promise<void>((done) => {
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send("write");
          setTimeout(done, 300);
        };
        ws.onclose = () => done();
      }), `ws://127.0.0.1:${server.port}/`);
      await Bun.sleep(200);
      expect(received).toEqual([]);
      expect(blocked).toEqual([`WebSocket ws://127.0.0.1:${server.port}/`]);
    } finally {
      await ctx.close();
      server.stop(true);
    }
  });
});
