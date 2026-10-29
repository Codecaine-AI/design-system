/**
 * Frame strips for check fixtures. A still screenshot cannot show motion, so this plays one step on a
 * fixture page and writes a few frames of the motion it starts side by side, one PNG per variant.
 *
 *   bun scripts/design-score/frames.ts <check-id>[,<check-id>...]
 *
 * The fixture folder holds frames.json:
 *   step      one step: {"hover": sel}, {"press": sel} (hover + active), {"focus": sel} (focus + focus-visible),
 *             {"click": sel} or {"js": "code"}
 *   times     frame times in ms after the step, e.g. [0, 100, 200, 300]
 *   clip      selector whose box (plus pad, default 12px) each frame shows (default body)
 *   reduced   true: run with prefers-reduced-motion: reduce
 *   viewport  default 800x600
 *
 * The document timeline is stopped (CDP Animation.setPlaybackRate 0) before the step, so every animation
 * the step starts is paused and seeked to each time exactly: the frames do not depend on machine speed.
 * Writes shots/<variant>-frames.png.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { launch } from "./browser";
import { fixturesRoot, serveFixtures, VARIANTS } from "./fixture";
import { DESIGN_SYSTEM_ROOT, workspaceRoot } from "../lib/registry";

interface FramesSpec {
  step: { hover?: string; press?: string; focus?: string; click?: string; js?: string };
  times: number[];
  clip?: string;
  pad?: number;
  reduced?: boolean;
  viewport?: { width: number; height: number };
}

const ids = (process.argv[2] ?? "").split(",").filter(Boolean);
if (!ids.length) {
  console.error("usage: bun scripts/design-score/frames.ts <check-id>[,<check-id>...]");
  process.exit(2);
}

const server = serveFixtures(DESIGN_SYSTEM_ROOT);
const { browser } = await launch(workspaceRoot());
let ok = true;
try {
  for (const id of ids) {
    const dir = join(fixturesRoot(DESIGN_SYSTEM_ROOT), id);
    const specPath = join(dir, "frames.json");
    if (!existsSync(specPath)) {
      console.log(`${id}: no frames.json`);
      ok = false;
      continue;
    }
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as FramesSpec;
    mkdirSync(join(dir, "shots"), { recursive: true });
    for (const variant of VARIANTS) {
      const ctx = await browser.newContext({ viewport: spec.viewport ?? { width: 800, height: 600 }, deviceScaleFactor: 2, reducedMotion: spec.reduced ? "reduce" : "no-preference", colorScheme: "light" });
      try {
        const page = await ctx.newPage();
        await page.goto(`${server.url}design-score/fixtures/${id}/${variant}.html`);
        await page.evaluate(() => document.fonts.ready);
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Animation.enable");
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
        const s = spec.step;
        const pseudo = s.hover ? ["hover"] : s.press ? ["hover", "active"] : s.focus ? ["focus", "focus-visible"] : null;
        if (pseudo) {
          await cdp.send("DOM.enable");
          await cdp.send("CSS.enable");
          const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: (s.hover ?? s.press ?? s.focus)! });
          if (!nodeId) throw new Error(`no element for ${JSON.stringify(s)}`);
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: pseudo });
        } else if (s.click) await page.click(s.click);
        else if (s.js) await page.evaluate(s.js);
        const pad = spec.pad ?? 12;
        // The union of every element the clip selector matches (".toolbar, .menu" takes in a popup).
        const box = await page.evaluate((sel: string) => {
          const rs = [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect());
          if (!rs.length) throw new Error(`no element for clip ${sel}`);
          const x = Math.min(...rs.map((r) => r.left));
          const y = Math.min(...rs.map((r) => r.top));
          return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y };
        }, spec.clip ?? "body");
        const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad };
        const frames: string[] = [];
        let count = 0;
        for (const t of spec.times) {
          count = Math.max(count, await page.evaluate((ms: number) => {
            const all = document.getAnimations();
            for (const a of all) {
              a.pause();
              a.currentTime = ms;
            }
            return all.length;
          }, t));
          const png: Buffer = await page.screenshot({ clip, animations: "allow" });
          frames.push(png.toString("base64"));
        }
        // Lay the frames out in one row, each labelled with its time, and shoot that row.
        const strip = await ctx.newPage();
        await strip.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${server.url}css/fonts.css"><link rel="stylesheet" href="${server.url}dist/css/tokens.css"><style>
          body { margin: 0; background: var(--ds-color-surface-page); font-family: var(--ds-font-family-sans); color: var(--ds-color-text-muted); font-size: var(--ds-font-size-ui-sm); }
          .strip { display: inline-flex; gap: var(--ds-space-3); padding: var(--ds-space-3); }
          figure { margin: 0; display: flex; flex-direction: column; gap: var(--ds-space-1); }
          img { display: block; width: ${clip.width}px; border: 1px solid var(--ds-color-border-default); border-radius: var(--ds-radius-base); }
          figcaption { font-variant-numeric: tabular-nums; }
        </style></head><body><div class="strip">${frames.map((f, i) => `<figure><img src="data:image/png;base64,${f}"><figcaption>${spec.times[i]}ms</figcaption></figure>`).join("")}</div></body></html>`);
        await strip.evaluate(() => document.fonts.ready);
        const out = join(dir, "shots", `${variant}-frames.png`);
        writeFileSync(out, await strip.locator(".strip").screenshot());
        console.log(`${id} ${variant}: ${spec.times.length} frames, ${count} animations\n  ${out}`);
      } catch (error) {
        ok = false;
        console.log(`${id} ${variant}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      } finally {
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
process.exit(ok ? 0 : 1);
