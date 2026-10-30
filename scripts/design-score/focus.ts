/**
 * R-focus-visible: Tab through the first N focusables; each must change the pixels around it.
 *
 * For each Tab stop: capture a clip around the focused element, blur it, capture the same clip again
 * (nothing focused, so a neighbour's ring cannot change the clip) and count changed pixels, then focus
 * the element again and press Tab from it. Transitions and smooth scrolling are switched off for the
 * pass, so both captures are settled and no Tab scroll is still running when the pass returns. When the element moved between the captures, the computed style decides instead: an
 * outline or a changed box-shadow counts as visible.
 * Tabbing stops at a contenteditable (Tab may edit there), when focus cycles, or after N stops.
 */
import { decodePng } from "../lib/png";
import type { Box, RawFinding } from "./types";

interface Stop {
  selector: string;
  label: string;
  box: Box;
  outline: string;
  shadow: string;
  editable: boolean;
  frame: boolean;
  key: string;
}

/** Describes document.activeElement. Self-contained. */
function activeInfo(): Stop | null {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const simple = (c: string) => /^[a-zA-Z_][\w-]*$/.test(c) && c.length <= 32;
  const seg = (e: Element) => {
    const tag = e.tagName.toLowerCase();
    if (e.id && /^[a-zA-Z][\w-]*$/.test(e.id)) return `${tag}#${e.id}`;
    let s = tag + [...e.classList].filter(simple).slice(0, 2).map((c) => "." + c).join("");
    const p = e.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.tagName === e.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
    }
    return s;
  };
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let d = 0; cur && cur !== document.body && d < 5; d++) {
    const s = seg(cur);
    parts.unshift(s);
    if (s.includes("#")) break;
    cur = cur.parentElement;
  }
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}` : "none";
  // Remember it (no DOM mutation: editors watch their attributes), so it can be found after the next Tab.
  const w = window as unknown as { __dsFocus?: Element[] };
  const list = (w.__dsFocus ??= []);
  let index = list.indexOf(el);
  if (index < 0) index = list.push(el) - 1;
  const key = String(index);
  return {
    selector: parts.join(" > "),
    label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
    box: { x: r.left, y: r.top, w: r.width, h: r.height },
    outline,
    shadow: s.boxShadow,
    editable: (el as HTMLElement).isContentEditable,
    frame: el.tagName === "IFRAME",
    key,
  };
}

function styleOf(key: string): { box: Box; outline: string; shadow: string } | null {
  const el = (window as unknown as { __dsFocus?: Element[] }).__dsFocus?.[Number(key)];
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}` : "none";
  return { box: { x: r.left, y: r.top, w: r.width, h: r.height }, outline, shadow: s.boxShadow };
}

/** Blurs the focused element (inside open shadow roots too) and remembers it. Self-contained. */
function blurActive(): void {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  (window as unknown as { __dsBlurred?: Element | null }).__dsBlurred = el;
  (el as HTMLElement | null)?.blur?.();
}

/** Focuses the element blurActive blurred, without scrolling. Self-contained. */
function refocusBlurred(): void {
  ((window as unknown as { __dsBlurred?: Element | null }).__dsBlurred as HTMLElement | null)?.focus?.({ preventScroll: true });
}

const NO_MOTION = "*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }";

function clipFor(box: Box, vw: number, vh: number, pad = 6) {
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(vw, Math.ceil(box.x + box.w + pad));
  const bottom = Math.min(vh, Math.ceil(box.y + box.h + pad));
  return right - x >= 2 && bottom - y >= 2 ? { x, y, width: right - x, height: bottom - y } : null;
}

function changedPixels(a: Uint8Array, b: Uint8Array): { count: number; width: number; height: number } {
  const ia = decodePng(a);
  const ib = decodePng(b);
  if (ia.width !== ib.width || ia.height !== ib.height) return { count: Number.POSITIVE_INFINITY, width: ia.width, height: ia.height };
  let count = 0;
  for (let i = 0; i < ia.data.length; i += 4) {
    const d = Math.max(Math.abs(ia.data[i]! - ib.data[i]!), Math.abs(ia.data[i + 1]! - ib.data[i + 1]!), Math.abs(ia.data[i + 2]! - ib.data[i + 2]!));
    if (d > 24) count++;
  }
  return { count, width: ia.width, height: ia.height };
}

export interface FocusResult {
  findings: RawFinding[];
  stops: number;
  /** For crops: the focused-state clip of each failing stop. */
  clips: Array<{ index: number; png: Uint8Array; clip: { x: number; y: number; width: number; height: number } }>;
}

export async function focusPass(page: any, max = 30): Promise<FocusResult> {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const style = await page.addStyleTag({ content: NO_MOTION });
  const findings: RawFinding[] = [];
  const clips: FocusResult["clips"] = [];
  let stops = 0;
  try {
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      // A blur leaves the Tab starting point at the blurred element, so the first Tab would skip every
      // control before it. Focusing the body once moves the starting point back to the top of the page.
      const body = document.body;
      const had = body.getAttribute("tabindex");
      body.setAttribute("tabindex", "-1");
      body.focus({ preventScroll: true });
      body.blur();
      if (had === null) body.removeAttribute("tabindex");
      else body.setAttribute("tabindex", had);
      (window as unknown as { __dsFocus?: Element[] }).__dsFocus = [];
    });
    await page.keyboard.press("Tab");
    let current: Stop | null = await page.evaluate(activeInfo);
    const first = current?.key;
    for (let i = 0; i < max && current; i++) {
      stops++;
      if (current.frame) break;
      await page.waitForTimeout(40);
      const focusedNow = (await page.evaluate(styleOf, current.key)) ?? { box: current.box, outline: current.outline, shadow: current.shadow };
      const clip = clipFor(focusedNow.box, vp.width, vp.height);
      const focusedPng: Uint8Array | null = clip ? await page.screenshot({ clip }) : null;
      // Never Tab inside an editor (Tab can indent there); its focus shows as the caret. Stop here.
      if (current.editable) break;
      // The unfocused capture has nothing focused (a neighbour's ring would change the same clip).
      await page.evaluate(blurActive);
      await page.waitForTimeout(40);
      const after = await page.evaluate(styleOf, current.key);
      let visible: boolean | null = null;
      let measured = "";
      if (clip && focusedPng && after) {
        const moved = Math.abs(after.box.x - focusedNow.box.x) > 0.5 || Math.abs(after.box.y - focusedNow.box.y) > 0.5;
        if (!moved) {
          const unfocusedPng: Uint8Array = await page.screenshot({ clip });
          const diff = changedPixels(focusedPng, unfocusedPng);
          const perimeter = 2 * (focusedNow.box.w + focusedNow.box.h);
          const need = Math.max(12, perimeter * 0.1);
          visible = diff.count >= need;
          measured = `${diff.count === Number.POSITIVE_INFINITY ? "?" : diff.count} pixels change on focus (need ${Math.round(need)}); outline ${focusedNow.outline}, box-shadow ${focusedNow.shadow === "none" ? "none" : "set"}`;
        }
      }
      if (visible === null && after) {
        visible = focusedNow.outline !== "none" || focusedNow.shadow !== after.shadow;
        measured = `element moved between captures; style: outline ${focusedNow.outline}, box-shadow ${focusedNow.shadow === after.shadow ? "unchanged" : "changes"}`;
      }
      // Focus the control again and Tab on from it, so the Tab order is the page's own.
      await page.evaluate(refocusBlurred);
      await page.keyboard.press("Tab");
      const next: Stop | null = await page.evaluate(activeInfo);
      if (visible === false) {
        findings.push({
          check: "R-focus-visible",
          severity: "fail",
          selector: current.selector,
          box: { x: Math.round(focusedNow.box.x * 10) / 10, y: Math.round(focusedNow.box.y * 10) / 10, w: Math.round(focusedNow.box.w * 10) / 10, h: Math.round(focusedNow.box.h * 10) / 10 },
          measured: `${measured} "${current.label}"`,
          expected: "a visible focus ring (outline or box-shadow) on keyboard focus",
        });
        if (clip && focusedPng) clips.push({ index: findings.length - 1, png: focusedPng, clip });
      }
      if (!next || next.key === first) break;
      current = next;
    }
  } finally {
    await style.evaluate((node: Element) => node.remove()).catch(() => undefined);
  }
  return { findings, stops, clips };
}
