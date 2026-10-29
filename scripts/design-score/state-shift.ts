/**
 * R-state-shift: hovering, focusing, selecting or opening a control must not move or resize its neighbours.
 *
 * Per page (first theme, first viewport, after the other checks) up to N controls, one per class
 * signature, get four kinds of state change:
 *   hover   the real mouse moves onto the control's center (JS hover handlers run too)
 *   focus   element.focus({ preventScroll: true })
 *   open    a click on an [aria-haspopup] control (or a config `shift.open` selector), then Escape
 *   select  a click on an unselected [role="tab"], then a click back on the tab that was selected
 * Before and after each change, the layout box of every visible element in the control's neighbourhood
 * (its ancestor up to 3 levels, at most 300 elements) is read twice over: the client rect and the
 * offset-chain box (layout only, so transforms and scrolling never count). A neighbour moved or resized
 * only when both differ by 1px or more. Elements that were not visible before or after (a menu that
 * appears) and elements that move on their own (measured once per page, 300ms apart) are left out.
 * The control's own layout box counts too (a bolder tab that widens, a link that nudges on hover). Transitions are off for the pass.
 *
 * A page can also name `shiftWatch`: elements whose boxes must not change while the page's own actions
 * run (the audit's "opening Status widens the column").
 */
import type { Box, RawFinding } from "./types";

export interface ShiftBox {
  /** Client rect (viewport coordinates). */
  rect: Box;
  /** Offset-chain layout box: no transforms, no scroll. */
  layout: Box;
  visible: boolean;
}

export interface ShiftMove {
  index: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** The largest of |dx|, |dy|, |dw|, |dh| in layout px. */
  size: number;
}

/**
 * Neighbours that moved or resized by `min` px or more between two snapshots of the same element list.
 * Both the client rect and the layout box must change (a transform or a scroll alone is not a shift).
 */
export function diffShift(before: ShiftBox[], after: ShiftBox[], min = 1): ShiftMove[] {
  const out: ShiftMove[] = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i]!;
    const b = after[i]!;
    if (!a.visible || !b.visible) continue;
    const rd = Math.max(Math.abs(b.rect.x - a.rect.x), Math.abs(b.rect.y - a.rect.y), Math.abs(b.rect.w - a.rect.w), Math.abs(b.rect.h - a.rect.h));
    const dx = b.layout.x - a.layout.x;
    const dy = b.layout.y - a.layout.y;
    const dw = b.layout.w - a.layout.w;
    const dh = b.layout.h - a.layout.h;
    const ld = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
    if (rd < min - 1e-6 || ld < min - 1e-6) continue;
    out.push({ index: i, dx: r1(b.rect.x - a.rect.x), dy: r1(b.rect.y - a.rect.y), dw: r1(b.rect.w - a.rect.w), dh: r1(b.rect.h - a.rect.h), size: r1(Math.min(rd, ld)) });
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Drops moves explained by a scroll container's scrollbar appearing or going (content got taller or
 * shorter): a pure width change or sideways move by the scrollbar's width (or half of it, centered
 * content). Headless Chromium draws classic 15px scrollbars; macOS overlays them, so these never show
 * on Ford's desktop. `gutters` are the changes in scrollbar width of the scrollers around the neighbourhood.
 */
export function dropScrollbarMoves(moves: ShiftMove[], gutters: number[]): { kept: ShiftMove[]; dropped: number } {
  const d = gutters.map(Math.abs).filter((g) => g >= 1);
  if (!d.length) return { kept: moves, dropped: 0 };
  const near = (v: number) => d.some((g) => Math.abs(Math.abs(v) - g) <= 0.6 || Math.abs(Math.abs(v) - g / 2) <= 0.6);
  const kept = moves.filter((m) => !(Math.abs(m.dy) < 1 && Math.abs(m.dh) < 1 && (Math.abs(m.dw) < 1 || near(m.dw)) && (Math.abs(m.dx) < 1 || near(m.dx))));
  return { kept, dropped: moves.length - kept.length };
}

// --- in-page helpers (self-contained) ---------------------------------------------------------------

interface PageArg {
  ignore: string[];
  open: string[];
  max: number;
}

/**
 * Picks the candidates into window.__dsShift and marks unstable elements. Self-contained.
 * Returns how many of each kind were picked.
 */
export function shiftCandidates(o: PageArg): { hover: number; open: number; tabs: number; neutral: [number, number] | null } {
  const w = window as unknown as { __dsShift?: { hover: Element[]; open: Element[]; tabs: Array<{ tab: Element; back: Element }>; unstable: WeakSet<Element>; list: Element[]; control: Element | null } };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ignored = (el: Element) => o.ignore.some((s) => {
    try {
      return !!el.closest(s);
    } catch {
      return false;
    }
  });
  const modal = [...document.querySelectorAll('dialog, [aria-modal="true"]')].reverse().find((d) => {
    try {
      return d.matches(":modal") || d.getAttribute("aria-modal") === "true";
    } catch {
      return d.getAttribute("aria-modal") === "true";
    }
  });
  const scope: Element = modal ?? document.body;
  const fullyInView = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) return false;
    const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
    if (anyEl.checkVisibility && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    // The control is what the pointer reaches at its center (not under a header or overlay).
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  };
  const usable = (el: Element) => !ignored(el) && !el.matches(":disabled, [aria-disabled='true']") && !el.closest('[contenteditable="true"]') && fullyInView(el);
  const sigOf = (el: Element) => el.tagName + "." + [...el.classList].sort().join(".") + "|" + (el.getAttribute("role") ?? "");

  const controlSel = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], summary, input:not([type="hidden"]), select, textarea';
  const hover: Element[] = [];
  const seen = new Set<string>();
  for (const el of scope.querySelectorAll(controlSel)) {
    if (hover.length >= o.max) break;
    if (el.parentElement?.closest(controlSel)) continue;
    const sig = sigOf(el);
    if (seen.has(sig) || !usable(el)) continue;
    seen.add(sig);
    hover.push(el);
  }

  const openSel = ['[aria-haspopup]:not([aria-haspopup="false"])', ...o.open].join(", ");
  const open: Element[] = [];
  const seenOpen = new Set<string>();
  let openEls: Element[] = [];
  try {
    openEls = [...scope.querySelectorAll(openSel)];
  } catch {
    openEls = [...scope.querySelectorAll('[aria-haspopup]:not([aria-haspopup="false"])')];
  }
  for (const el of openEls) {
    if (open.length >= Math.max(2, Math.floor(o.max / 3))) break;
    if (el.getAttribute("aria-expanded") === "true" || el.matches("select, input, textarea")) continue;
    const sig = sigOf(el) + "|" + (el.getAttribute("aria-label") ?? "");
    if (seenOpen.has(sig) || !usable(el)) continue;
    seenOpen.add(sig);
    open.push(el);
  }

  const tabs: Array<{ tab: Element; back: Element }> = [];
  for (const list of scope.querySelectorAll('[role="tablist"]')) {
    if (tabs.length >= 3) break;
    const all = [...list.querySelectorAll('[role="tab"]')];
    const back = all.find((t) => t.getAttribute("aria-selected") === "true");
    const tab = all.find((t) => t.getAttribute("aria-selected") !== "true" && usable(t));
    if (back && tab && usable(back)) tabs.push({ tab, back });
  }

  // A resting point for the mouse: over nothing interactive.
  const interactive = controlSel + ', [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  let neutral: [number, number] | null = null;
  for (const [x, y] of [[vw - 3, vh - 3], [vw / 2, vh - 3], [vw - 3, vh / 2], [vw * 0.75, vh * 0.75], [vw / 2, vh / 2], [3, vh - 3]] as Array<[number, number]>) {
    const hit = document.elementFromPoint(x, y);
    if (hit && !hit.closest(interactive) && !hit.closest("[role=row], li, tr")) {
      neutral = [Math.round(x), Math.round(y)];
      break;
    }
  }

  // Elements that move on their own are marked by shiftStability.
  w.__dsShift = { hover, open, tabs, unstable: new WeakSet(), list: [], control: null };
  return { hover: hover.length, open: open.length, tabs: tabs.length, neutral };
}

/** Reads every element's layout box twice (call it twice, `phase` 0 then 1); phase 1 marks the unstable ones. Self-contained. */
export function shiftStability(phase: number): number {
  const w = window as unknown as { __dsShift?: { unstable: WeakSet<Element> }; __dsShiftStable?: Map<Element, string> };
  const st = w.__dsShift;
  if (!st) return 0;
  const key = (el: Element) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  };
  const els = [...document.body.querySelectorAll("*")].slice(0, 6000);
  if (phase === 0) {
    w.__dsShiftStable = new Map(els.map((el) => [el, key(el)]));
    return els.length;
  }
  let n = 0;
  const prev = w.__dsShiftStable ?? new Map();
  for (const el of els) {
    const k = prev.get(el);
    if (k !== undefined && k !== key(el)) {
      st.unstable.add(el);
      n++;
    }
  }
  return n;
}

/**
 * Snapshots the neighbourhood of a candidate. `pick` names it ("hover:3", "open:1", "tab:0", "watch:<selector>")
 * on the first call (stores the element list); `pick: null` re-reads the stored list. Self-contained.
 */
export function shiftSnapshot(arg: { pick: string | null; ignore: string[] }): { boxes: Array<{ rect: { x: number; y: number; w: number; h: number }; layout: { x: number; y: number; w: number; h: number }; visible: boolean }>; control: { x: number; y: number; w: number; h: number } | null; gutters: number[] } {
  const st = (window as unknown as { __dsShift?: { hover: Element[]; open: Element[]; tabs: Array<{ tab: Element; back: Element }>; unstable: WeakSet<Element>; list: Element[]; control: Element | null; scrollers?: Element[] } }).__dsShift;
  if (!st) return { boxes: [], control: null, gutters: [] };
  const ignored = (el: Element) => arg.ignore.some((s) => {
    try {
      return !!el.closest(s);
    } catch {
      return false;
    }
  });
  if (arg.pick !== null) {
    const [kind, rest] = [arg.pick.slice(0, arg.pick.indexOf(":")), arg.pick.slice(arg.pick.indexOf(":") + 1)];
    let control: Element | null = null;
    let containers: Element[] = [];
    if (kind === "watch") {
      containers = [...document.querySelectorAll(rest)];
    } else {
      control = kind === "hover" || kind === "focus" ? st.hover[Number(rest)] ?? null : kind === "open" ? st.open[Number(rest)] ?? null : st.tabs[Number(rest)]?.tab ?? null;
      if (!control) return { boxes: [], control: null, gutters: [] };
      if (kind === "tab") {
        const list = control.closest('[role="tablist"]');
        containers = list ? [list] : [];
      } else {
        let c: Element = control;
        const vwh = window.innerWidth * window.innerHeight;
        for (let i = 0; i < 3 && c.parentElement && c.parentElement !== document.body; i++) {
          const r = c.parentElement.getBoundingClientRect();
          if (r.width * r.height > vwh * 0.6) break;
          c = c.parentElement;
        }
        containers = [c];
      }
    }
    const list: Element[] = [];
    const add = (el: Element) => {
      if (list.length >= 300 || list.includes(el)) return;
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return;
      if (el.closest("script,style,template")) return;
      if (control && (el === control || control.contains(el))) return;
      if (st.unstable.has(el) || ignored(el)) return;
      list.push(el);
    };
    for (const c of containers) {
      if (kind === "watch" || kind === "tab") add(c);
      for (const el of c.querySelectorAll("*")) add(el);
    }
    st.list = list;
    st.control = control;
    // The scroll containers around the neighbourhood (their scrollbar may come or go).
    const scrollers: Element[] = [];
    for (let a: Element | null = containers[0] ?? null; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowY;
      if (a === document.documentElement || o === "auto" || o === "scroll") scrollers.push(a);
    }
    st.scrollers = scrollers;
  }
  const gutters = (st.scrollers ?? []).map((a) => (a === document.documentElement ? window.innerWidth - a.clientWidth : (a as HTMLElement).offsetWidth - a.clientWidth));
  const layoutOf = (el: Element) => {
    const h = el as HTMLElement;
    if (typeof h.offsetLeft !== "number") return null;
    let x = 0;
    let y = 0;
    for (let cur: HTMLElement | null = h; cur; cur = cur.offsetParent as HTMLElement | null) {
      x += cur.offsetLeft + (cur !== h ? cur.clientLeft : 0);
      y += cur.offsetTop + (cur !== h ? cur.clientTop : 0);
    }
    return { x, y, w: h.offsetWidth, h: h.offsetHeight };
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const boxes = st.list.map((el) => {
    const r = el.getBoundingClientRect();
    const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
    const shown = el.isConnected && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && (!anyEl.checkVisibility || anyEl.checkVisibility({ visibilityProperty: true }));
    const layout = layoutOf(el);
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      layout: layout ?? { x: r.left, y: r.top, w: r.width, h: r.height },
      visible: shown && !!layout,
    };
  });
  const c = st.control;
  const cl = c ? layoutOf(c) : null;
  return { boxes, control: cl && c?.isConnected ? { x: cl.x, y: cl.y, w: cl.w, h: cl.h } : null, gutters };
}

/** Describes elements of the stored list, and the control. Self-contained. */
export function shiftDescribe(indices: number[]): { items: Array<{ selector: string; box: { x: number; y: number; w: number; h: number } }>; control: { selector: string; label: string; sig: string; box: { x: number; y: number; w: number; h: number } } | null } {
  const st = (window as unknown as { __dsShift?: { list: Element[]; control: Element | null } }).__dsShift;
  const simple = (c: string) => /^[a-zA-Z_][\w-]*$/.test(c) && c.length <= 32;
  const seg = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `${tag}#${el.id}`;
    let s = tag + [...el.classList].filter(simple).slice(0, 2).map((c) => "." + c).join("");
    const label = el.getAttribute("aria-label");
    if (!el.classList.length && label && label.length <= 30) s += `[aria-label="${label.replace(/"/g, "'")}"]`;
    const p = el.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
  };
  const selectorOf = (el: Element) => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let d = 0; cur && cur !== document.body && d < 5; d++) {
      const s = seg(cur);
      parts.unshift(s);
      if (s.includes("#")) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  const boxOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    const k = (n: number) => Math.round(n * 10) / 10;
    return { x: k(r.left), y: k(r.top), w: k(r.width), h: k(r.height) };
  };
  const items = indices.map((i) => st?.list[i]).filter((el): el is Element => !!el).map((el) => ({ selector: selectorOf(el), box: boxOf(el) }));
  const c = st?.control ?? null;
  return {
    items,
    control: c ? { selector: selectorOf(c), label: (c.getAttribute("aria-label") || c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30), sig: c.tagName.toLowerCase() + [...c.classList].sort().map((x) => "." + x).join(""), box: boxOf(c) } : null,
  };
}

/** Runs one in-page action on a candidate. Self-contained. */
export function shiftAct(arg: { kind: "focus" | "blur" | "box" | "tab-back"; i: number }): { x: number; y: number; w: number; h: number } | null {
  const st = (window as unknown as { __dsShift?: { hover: Element[]; open: Element[]; tabs: Array<{ tab: Element; back: Element }> } }).__dsShift;
  if (!st) return null;
  if (arg.kind === "focus") {
    (st.hover[arg.i] as HTMLElement | undefined)?.focus({ preventScroll: true });
    return null;
  }
  if (arg.kind === "blur") {
    (document.activeElement as HTMLElement | null)?.blur?.();
    return null;
  }
  const el = arg.kind === "tab-back" ? st.tabs[arg.i]?.back : arg.kind === "box" ? st.open[arg.i] : null;
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

// --- the pass (Node) ----------------------------------------------------------------------------------

const NO_MOTION = "*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; }";

export interface ShiftOptions {
  ignore: string[];
  open: string[];
  max: number;
}

export interface ShiftHit {
  finding: RawFinding & { count?: number; group?: string };
  /** Take the crop from a screenshot of this moment (the state with the shift). */
  png: Uint8Array | null;
}

/** Measures one change: snapshot, act, settle, snapshot, diff; returns the finding (or null). */
async function measure(page: any, pick: string, ignore: string[], act: () => Promise<void>, verb: string, undo: () => Promise<void>, stats: { scrollbar: number }): Promise<ShiftHit | null> {
  const before = await page.evaluate(shiftSnapshot, { pick, ignore });
  if (!before.boxes.length && !before.control) return null;
  await act();
  await page.waitForTimeout(90);
  const after = await page.evaluate(shiftSnapshot, { pick: null, ignore });
  const gutterDelta = before.gutters.map((g: number, i: number) => (after.gutters[i] ?? g) - g);
  const { kept: moves, dropped } = dropScrollbarMoves(diffShift(before.boxes, after.boxes), gutterDelta);
  if (dropped) stats.scrollbar++;
  // The control's layout box (offsets ignore transforms, so a hover scale or nudge by transform is allowed),
  // with the same scrollbar filter as its neighbours: a scrollbar that goes moves centered content too.
  const ownMove = before.control && after.control ? { index: -1, dx: after.control.x - before.control.x, dy: after.control.y - before.control.y, dw: after.control.w - before.control.w, dh: after.control.h - before.control.h, size: 0 } : null;
  const own = ownMove && dropScrollbarMoves([ownMove], gutterDelta).kept.length ? Math.max(Math.abs(ownMove.dx), Math.abs(ownMove.dy), Math.abs(ownMove.dw), Math.abs(ownMove.dh)) : 0;
  let hit: ShiftHit | null = null;
  if (moves.length || own >= 1) {
    moves.sort((a, b) => b.size - a.size);
    const top = moves.slice(0, 1);
    const desc = await page.evaluate(shiftDescribe, top.map((m) => m.index));
    const png: Uint8Array | null = await page.screenshot().catch(() => null);
    const c = desc.control;
    const m = top[0];
    const item = desc.items[0];
    const b = m ? before.boxes[m.index]!.rect : null;
    const what = c ? `${verb} ${c.sig}${c.label ? ` "${c.label}"` : ""}` : verb;
    const parts: string[] = [];
    if (own >= 1 && before.control && after.control) parts.push(`moves or resizes the control ${r1(before.control.w)}x${r1(before.control.h)} at ${r1(before.control.x)},${r1(before.control.y)} → ${r1(after.control.w)}x${r1(after.control.h)} at ${r1(after.control.x)},${r1(after.control.y)}px`);
    if (m && item) parts.push(`moves ${moves.length} neighbour${moves.length === 1 ? "" : "s"}; most: ${[m.dx && `dx ${m.dx}`, m.dy && `dy ${m.dy}`, m.dw && `dw ${m.dw}`, m.dh && `dh ${m.dh}`].filter(Boolean).join(", ")}px`);
    hit = {
      finding: {
        check: "R-state-shift",
        severity: "fail",
        selector: item?.selector ?? c?.selector ?? null,
        box: item?.box ?? c?.box ?? null,
        // The neighbour's box before the change, so the crop shows both.
        other: b && item ? { selector: `${item.selector} (before)`, box: { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) } } : c ? { selector: c.selector, box: c.box } : null,
        measured: `${what}: ${parts.join("; ")}`,
        expected: "state changes (hover, focus, select, open) never move or resize neighbours (shift < 1px)",
        message: c ? `control ${c.selector}` : undefined,
        // One finding per component and verb; popups and tabs differ by label (each opens its own thing).
        group: `${verb}|${c?.sig ?? pick}${verb === "opening" || verb === "selecting" ? `|${c?.label ?? ""}` : ""}`,
      },
      png,
    };
  }
  await undo();
  return hit;
}

/**
 * Saves the window's and every scroll container's scroll position. The returned function blurs the
 * focused element and puts every saved position back: run it before stateShiftPass, so the pass picks
 * its controls from the view the page state left (the focus pass scrolls to reach later Tab stops).
 */
export async function keepScroll(page: any): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const saved: Array<[Element, number, number]> = [];
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      const scrolls = el === document.scrollingElement || /auto|scroll|hidden/.test(s.overflowX + s.overflowY);
      if (scrolls && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) saved.push([el, el.scrollLeft, el.scrollTop]);
    }
    (window as unknown as { __dsScroll?: unknown }).__dsScroll = { x: window.scrollX, y: window.scrollY, saved };
  });
  return async () => {
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      const st = (window as unknown as { __dsScroll?: { x: number; y: number; saved: Array<[Element, number, number]> } }).__dsScroll;
      if (!st) return;
      // Instant, so a page with scroll-behavior: smooth is back in place before the shift pass picks controls.
      for (const [el, left, top] of st.saved) el.scrollTo({ left, top, behavior: "instant" });
      window.scrollTo({ left: st.x, top: st.y, behavior: "instant" });
    });
  };
}

/** The R-state-shift pass on an open page. */
export async function stateShiftPass(page: any, o: ShiftOptions): Promise<{ hits: ShiftHit[]; note: string }> {
  const style = await page.addStyleTag({ content: NO_MOTION });
  const hits: ShiftHit[] = [];
  const stats = { scrollbar: 0 };
  let tried = 0;
  const startUrl: string = page.url();
  try {
    await page.evaluate(shiftAct, { kind: "blur", i: 0 });
    const picked = await page.evaluate(shiftCandidates, { ignore: o.ignore, open: o.open, max: o.max });
    await page.evaluate(shiftStability, 0);
    await page.waitForTimeout(300);
    const unstable = await page.evaluate(shiftStability, 1);
    const rest = picked.neutral;
    const park = async () => {
      if (rest) await page.mouse.move(rest[0], rest[1]);
    };
    await park();
    const seen = new Set<string>();
    const keep = (h: ShiftHit | null) => {
      if (!h) return;
      const g = h.finding.group ?? "";
      if (seen.has(g)) return;
      seen.add(g);
      hits.push(h);
    };
    for (let i = 0; i < picked.hover; i++) {
      tried++;
      keep(await measure(page, `hover:${i}`, o.ignore, async () => {
        const box = await page.evaluate((k: number) => {
          const el = (window as unknown as { __dsShift?: { hover: Element[] } }).__dsShift?.hover[k];
          if (!el || !el.isConnected) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, i);
        if (box) await page.mouse.move(box.x, box.y);
      }, "hovering", park, stats));
      tried++;
      keep(await measure(page, `focus:${i}`, o.ignore, async () => {
        await page.evaluate(shiftAct, { kind: "focus", i });
      }, "focusing", async () => {
        await page.evaluate(shiftAct, { kind: "blur", i: 0 });
      }, stats));
    }
    for (let i = 0; i < picked.open; i++) {
      if (page.url() !== startUrl) break;
      tried++;
      keep(await measure(page, `open:${i}`, o.ignore, async () => {
        const box = await page.evaluate(shiftAct, { kind: "box", i });
        if (box) await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
        await page.waitForTimeout(150);
      }, "opening", async () => {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(60);
        await park();
      }, stats));
    }
    for (let i = 0; i < picked.tabs; i++) {
      if (page.url() !== startUrl) break;
      tried++;
      keep(await measure(page, `tab:${i}`, o.ignore, async () => {
        const box = await page.evaluate((k: number) => {
          const el = (window as unknown as { __dsShift?: { tabs: Array<{ tab: Element }> } }).__dsShift?.tabs[k]?.tab;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, i);
        if (box) await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(150);
      }, "selecting", async () => {
        const back = await page.evaluate(shiftAct, { kind: "tab-back", i });
        if (back) await page.mouse.click(back.x + back.w / 2, back.y + back.h / 2);
        await page.waitForTimeout(150);
        await park();
      }, stats));
    }
    const note = `${tried} state changes on ${picked.hover} controls (hover, focus), ${picked.open} popups, ${picked.tabs} tab lists; ${unstable} elements moved on their own and were left out${stats.scrollbar ? `; ${stats.scrollbar} changes only toggled a classic scrollbar (ignored: macOS overlays scrollbars)` : ""}${page.url() !== startUrl ? "; stopped: a click navigated" : ""}`;
    return { hits, note };
  } finally {
    await style.evaluate((node: Element) => node.remove()).catch(() => undefined);
  }
}

/** The `shiftWatch` part: boxes of the watched elements before the page's actions and after them. */
export async function watchBefore(page: any, selector: string, ignore: string[]): Promise<ShiftBox[] | null> {
  const ok = await page.evaluate(() => {
    const w = window as unknown as { __dsShift?: unknown };
    w.__dsShift = { hover: [], open: [], tabs: [], unstable: new WeakSet(), list: [], control: null };
    return true;
  });
  if (!ok) return null;
  const snap = await page.evaluate(shiftSnapshot, { pick: `watch:${selector}`, ignore });
  return snap.boxes.length ? snap.boxes : null;
}

export async function watchAfter(page: any, before: ShiftBox[], selector: string, ignore: string[], what: string): Promise<ShiftHit | null> {
  const after = await page.evaluate(shiftSnapshot, { pick: null, ignore });
  const moves = diffShift(before, after.boxes).sort((a, b) => b.size - a.size);
  // (A watched state's scrollbar changes are not tracked: watched elements are named by the config.)
  if (!moves.length) return null;
  const desc = await page.evaluate(shiftDescribe, [moves[0]!.index]);
  const item = desc.items[0];
  const m = moves[0]!;
  const b = before[m.index]!.rect;
  return {
    finding: {
      check: "R-state-shift",
      severity: "fail",
      selector: item?.selector ?? selector,
      box: item?.box ?? null,
      other: item ? { selector: `${item.selector} (before)`, box: { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) } } : null,
      measured: `${what} moves ${moves.length} of the watched ${selector} element${moves.length === 1 ? "" : "s"}; most: ${[m.dx && `dx ${m.dx}`, m.dy && `dy ${m.dy}`, m.dw && `dw ${m.dw}`, m.dh && `dh ${m.dh}`].filter(Boolean).join(", ")}px`,
      expected: "the page's state change never moves or resizes these elements (shift < 1px)",
      group: `watch|${selector}`,
    },
    png: null,
  };
}
