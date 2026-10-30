/**
 * R-focus-visible: Tab through the first N focusables; each must change the pixels around it.
 *
 * For each Tab stop: capture a clip around the focused element, blur it, capture the same clip again
 * (nothing focused, so a neighbour's ring cannot change the clip) and count changed pixels, then focus
 * the element again and press Tab from it. Transitions and smooth scrolling are switched off for the
 * pass, so both captures are settled and no Tab scroll is still running when the pass returns. When the element moved between the captures, the computed style decides instead: an
 * outline or a changed box-shadow counts as visible.
 * A ring drawn on a wrapper counts too: when an ancestor's computed paint (or a pseudo-element's, such as a ::after
 * stretched over a tile) changes on blur, the clip grows to that box and is captured blurred, then focused again.
 * In that wider clip the pixels decide, not the styles: each state is captured again with everything outside the
 * control's chain hidden (the chain: its ancestors' own paint, the control, its subtree and their pseudo-elements),
 * and a changed pixel counts only where both captures match the chain's own. So a change a sibling paints, or wrapper
 * paint that cannot show (covered, zero-width), never rescues a control.
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

/** One box in the focused element's chain: the element, then each ancestor up to the body. */
interface Layer {
  box: Box;
  /** The paint of the element itself, and of its ::before and ::after. */
  paint: string;
  pseudo: string;
  /** A pseudo-element is absolutely positioned, so it can paint over its holder's box. */
  floats: boolean;
  /** Index of the nearest layer at or above this one that holds an absolute pseudo (its containing block), or -1. */
  holder: number;
}

/**
 * The paint of the focused element's chain, compared focused and blurred to find which boxes the focus may light.
 * Only a hint for where to look: whether the change shows is left to the pixels. Self-contained.
 */
function layersOf(key: string): Layer[] | null {
  const el = (window as unknown as { __dsFocus?: Element[] }).__dsFocus?.[Number(key)];
  if (!el || !el.isConnected) return null;
  const paintOf = (s: CSSStyleDeclaration) =>
    [s.outline, s.outlineOffset, s.borderTop, s.borderRight, s.borderBottom, s.borderLeft, s.borderImageSource, s.boxShadow, s.backgroundColor, s.backgroundImage, s.color, s.opacity, s.filter].join("|");
  // The box an absolute descendant fills: Chromium makes one for each of these (checked in Chromium 153).
  // A plain inline box takes only position and the filters, and an internal table box takes no containment.
  const holds = (s: CSSStyleDeclaration) => {
    if (s.display === "contents" || s.display === "none") return false;
    const will = s.willChange.split(/,\s*/);
    const set = (props: string[]) => props.some((p) => !["", "none"].includes(s.getPropertyValue(p)) || will.includes(p));
    if (s.position !== "static" || will.includes("position") || set(["filter", "backdrop-filter"])) return true;
    if (s.display === "inline") return false;
    if (s.transformStyle === "preserve-3d" || set(["transform", "translate", "rotate", "scale", "perspective", "offset-path"])) return true;
    return !/^table-(row|column|header|footer)/.test(s.display) && (/layout|paint|strict|content/.test(s.contain) || s.contentVisibility !== "visible" || will.includes("contain"));
  };
  const layers: Layer[] = [];
  let holder = -1;
  const chain: Element[] = [];
  for (let cur: Element | null = el; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) chain.push(cur);
  // Walk from the top, so each layer knows the nearest box at or above it that holds an absolute pseudo.
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i]!;
    const s = getComputedStyle(e);
    if (holds(s)) holder = i;
    const pseudos = ["::before", "::after"].map((p) => getComputedStyle(e, p));
    const r = e.getBoundingClientRect();
    layers[i] = {
      box: { x: r.left, y: r.top, w: r.width, h: r.height },
      paint: paintOf(s),
      pseudo: pseudos.map((p) => (p.content === "none" || p.display === "none" ? "none" : `${p.content}|${paintOf(p)}`)).join("||"),
      floats: pseudos.some((p) => p.content !== "none" && p.position === "absolute"),
      holder,
    };
  }
  return layers;
}

/**
 * The boxes the focus lights besides the control's own: an ancestor whose paint changes on blur, and the
 * box an element's changed pseudo-element can cover. A change on an element outside the chain never counts.
 */
function litBoxes(focused: Layer[], blurred: Layer[]): Box[] {
  const boxes: Box[] = [];
  for (let i = 0; i < Math.min(focused.length, blurred.length); i++) {
    const f = focused[i]!;
    if (i > 0 && f.paint !== blurred[i]!.paint) boxes.push(f.box);
    if (f.pseudo !== blurred[i]!.pseudo) {
      if (i > 0) boxes.push(f.box);
      if (f.floats && f.holder > 0) boxes.push(focused[f.holder]!.box);
    }
  }
  return boxes;
}

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
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

/**
 * With a key, hides everything but the element's chain: its ancestors keep their own paint, the element keeps its
 * subtree, and each keeps its pseudo-elements. With null, undoes it. An adopted sheet does it, so the page's DOM is
 * untouched. A Tab stop is always in the document (a shadow root's control stops as its host), so one sheet is enough.
 * Self-contained.
 */
function isolate(key: string | null): void {
  const w = window as unknown as { __dsFocus?: Element[]; __dsIsolated?: CSSStyleSheet };
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== w.__dsIsolated);
  const el = key === null ? null : w.__dsFocus?.[Number(key)];
  if (!el?.isConnected) return;
  // Each chain element as a path from the root, which holds while the DOM is unchanged.
  const paths: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const steps = [];
    for (let e = cur; e.parentElement; e = e.parentElement) steps.unshift(`:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
    paths.push([":root", ...steps].join(" > "));
  }
  const sheet = (w.__dsIsolated = new CSSStyleSheet());
  sheet.replaceSync(`*:not(${paths.join(", ")}, ${paths[0]} *) { visibility: hidden !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

const NO_MOTION ="*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }";

function clipFor(box: Box, vw: number, vh: number, pad = 6) {
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(vw, Math.ceil(box.x + box.w + pad));
  const bottom = Math.min(vh, Math.ceil(box.y + box.h + pad));
  return right - x >= 2 && bottom - y >= 2 ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Pixels that differ between a and b. Given `own` (a and b captured again with only the chain shown), a pixel counts
 * only where each capture matches its own one: there the chain's paint is what shows, so the chain made the change.
 */
function changedPixels(a: Uint8Array, b: Uint8Array, own?: [Uint8Array, Uint8Array]): { count: number; width: number; height: number } {
  const ia = decodePng(a);
  const ib = decodePng(b);
  const io = own?.map(decodePng);
  if ([ib, ...(io ?? [])].some((img) => img.width !== ia.width || img.height !== ia.height)) return { count: Number.POSITIVE_INFINITY, width: ia.width, height: ia.height };
  const differs = (x: Uint8Array, y: Uint8Array, i: number) => Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!)) > 24;
  let count = 0;
  for (let i = 0; i < ia.data.length; i += 4) {
    if (differs(ia.data, ib.data, i) && !(io && (differs(ia.data, io[0]!.data, i) || differs(ib.data, io[1]!.data, i)))) count++;
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
      const focusedLayers: Layer[] | null = await page.evaluate(layersOf, current.key);
      let clip = clipFor(focusedNow.box, vp.width, vp.height);
      let focusedPng: Uint8Array | null = clip ? await page.screenshot({ clip }) : null;
      // Never Tab inside an editor (Tab can indent there); its focus shows as the caret. Stop here.
      if (current.editable) break;
      // The unfocused capture has nothing focused (a neighbour's ring would change the same clip).
      await page.evaluate(blurActive);
      await page.waitForTimeout(40);
      const after = await page.evaluate(styleOf, current.key);
      const blurredLayers: Layer[] | null = await page.evaluate(layersOf, current.key);
      const lit = focusedLayers && blurredLayers ? litBoxes(focusedLayers, blurredLayers) : [];
      let refocused = false;
      let visible: boolean | null = null;
      let measured = "";
      if (clip && focusedPng && after) {
        const moved = Math.abs(after.box.x - focusedNow.box.x) > 0.5 || Math.abs(after.box.y - focusedNow.box.y) > 0.5;
        if (!moved) {
          let unfocusedPng: Uint8Array;
          let own: [Uint8Array, Uint8Array] | undefined;
          const region = lit.length ? clipFor(union([focusedNow.box, ...lit]), vp.width, vp.height) : null;
          if (region) {
            // The focus may light a box beyond the clip (a wrapper's ring): compare that region blurred, then focused
            // again, each also with only the chain shown, so a pixel counts only where the chain's own paint shows.
            clip = region;
            unfocusedPng = await page.screenshot({ clip });
            await page.evaluate(isolate, current.key);
            const ownBlurred: Uint8Array = await page.screenshot({ clip });
            await page.evaluate(refocusBlurred);
            refocused = true;
            await page.waitForTimeout(40);
            own = [await page.screenshot({ clip }), ownBlurred];
            await page.evaluate(isolate, null);
            focusedPng = await page.screenshot({ clip });
          } else {
            unfocusedPng = await page.screenshot({ clip });
          }
          const diff = changedPixels(focusedPng!, unfocusedPng, own);
          const perimeter = 2 * (focusedNow.box.w + focusedNow.box.h);
          const need = Math.max(12, perimeter * 0.1);
          visible = diff.count >= need;
          const where = region ? ` on the control and ${lit.length} box${lit.length === 1 ? "" : "es"} its focus lights` : "";
          measured = `${diff.count === Number.POSITIVE_INFINITY ? "?" : diff.count} pixels change on focus${where} (need ${Math.round(need)}); outline ${focusedNow.outline}, box-shadow ${focusedNow.shadow === "none" ? "none" : "set"}`;
        }
      }
      if (visible === null && after) {
        visible = focusedNow.outline !== "none" || focusedNow.shadow !== after.shadow;
        measured = `element moved between captures; style: outline ${focusedNow.outline}, box-shadow ${focusedNow.shadow === after.shadow ? "unchanged" : "changes"}`;
      }
      // Focus the control again and Tab on from it, so the Tab order is the page's own.
      if (!refocused) await page.evaluate(refocusBlurred);
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
    await page.evaluate(isolate, null).catch(() => undefined);
    await style.evaluate((node: Element) => node.remove()).catch(() => undefined);
  }
  return { findings, stops, clips };
}
