/**
 * The motion checks: M-duration, M-layout-props, M-press-scale, M-reduced-motion.
 *
 * A recorder (installed before any page script) polls document.getAnimations() every frame while it is
 * on and keeps each new Animation's timing, properties and target: CSS transitions, CSS animations and
 * Web Animations alike. Motion is read in two ways:
 *   1. while the page's actions run (a menu, popover, dialog or panel opening);
 *   2. per control: CDP CSS.forcePseudoState puts :hover, then :hover:active, on up to N controls
 *      (one per class signature), so transitions start without any click reaching the app. After
 *      :active, the control's running animations are finished and its scale read (M-press-scale).
 */
import type { RawFinding } from "./types";

export interface MotionRecord {
  phase: string;
  type: string;
  name: string;
  props: string[];
  duration: number;
  delay: number;
  iterations: number;
  easing: string;
  pseudo: string | null;
  selector: string;
  kind: "dialog" | "menu" | "panel" | "control" | "other";
  box: { x: number; y: number; w: number; h: number } | null;
  /** data-ds-probe of the control the target sits in, or null. */
  probe: string | null;
  /** The motionAllow entry whose selector the target matches (its props are then allowed), or absent. */
  allowed?: { name: string; props: string[] } | null;
}

/** A motionAllow entry as the in-page helpers take it. */
export interface AllowArg {
  name: string;
  selector: string;
  props: string[];
}

/** addInitScript: the recorder. Self-contained. */
export function installMotionRecorder(): void {
  const w = window as unknown as { __dsMotion?: unknown };
  if (w.__dsMotion) return;
  const st = { on: false, phase: "", seen: new WeakSet<Animation>(), list: [] as Array<Record<string, unknown>>, els: [] as Element[] };
  w.__dsMotion = st;
  const propsOf = (a: Animation): string[] => {
    const t = (a as Animation & { transitionProperty?: string }).transitionProperty;
    if (t) return [t];
    try {
      const keys = new Set<string>();
      for (const k of (a.effect as KeyframeEffect | null)?.getKeyframes() ?? []) for (const p of Object.keys(k)) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) keys.add(p);
      return [...keys];
    } catch {
      return [];
    }
  };
  const tick = () => {
    if (st.on) {
      for (const a of document.getAnimations()) {
        if (st.seen.has(a)) continue;
        st.seen.add(a);
        const effect = a.effect as KeyframeEffect | null;
        const t = effect?.getTiming() ?? {};
        const target = effect?.target ?? null;
        st.list.push({
          phase: st.phase,
          type: a.constructor?.name ?? "Animation",
          name: (a as Animation & { animationName?: string }).animationName ?? (a as Animation & { transitionProperty?: string }).transitionProperty ?? a.id ?? "",
          props: propsOf(a),
          duration: typeof t.duration === "number" ? t.duration : 0,
          delay: t.delay ?? 0,
          iterations: t.iterations ?? 1,
          easing: t.easing ?? "",
          pseudo: effect?.pseudoElement ?? null,
          target: target ? st.els.push(target) - 1 : -1,
        });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function setRecording(arg: { on: boolean; phase: string; reset?: boolean }): void {
  const st = (window as unknown as { __dsMotion?: { on: boolean; phase: string; list: unknown[]; els: unknown[]; seen: WeakSet<object> } }).__dsMotion;
  if (!st) return;
  if (arg.reset) {
    st.list = [];
    st.els = [];
  }
  // Animations already running when recording starts are not this phase's.
  if (arg.on && !st.on) for (const a of document.getAnimations()) st.seen.add(a);
  st.on = arg.on;
  st.phase = arg.phase;
}

/** Reads the recorder's list with each target described. Self-contained. */
export function readMotion(allow: AllowArg[] = []): MotionRecord[] {
  const st = (window as unknown as { __dsMotion?: { list: Array<Record<string, unknown>>; els: Element[] } }).__dsMotion;
  if (!st) return [];
  const simple = (c: string) => /^[a-zA-Z_][\w-]*$/.test(c) && c.length <= 32;
  const seg = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `${tag}#${el.id}`;
    return tag + [...el.classList].filter(simple).slice(0, 2).map((c) => "." + c).join("");
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
  const interactive = 'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]';
  const kindOf = (el: Element): MotionRecord["kind"] => {
    if (el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return "dialog";
    if (el.closest('[role="menu"], [role="listbox"], [role="tooltip"], [popover], [data-radix-popper-content-wrapper]')) return "menu";
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= window.innerWidth * window.innerHeight * 0.15) return "panel";
    if (el.closest(interactive)) return "control";
    return "other";
  };
  return st.list.map((rec) => {
    const el = typeof rec.target === "number" && rec.target >= 0 ? st.els[rec.target] : undefined;
    const r = el?.getBoundingClientRect();
    return {
      phase: String(rec.phase),
      type: String(rec.type),
      name: String(rec.name),
      props: rec.props as string[],
      duration: Number(rec.duration),
      delay: Number(rec.delay),
      iterations: Number(rec.iterations),
      easing: String(rec.easing),
      pseudo: (rec.pseudo as string | null) ?? null,
      selector: el ? selectorOf(el) + (rec.pseudo ? String(rec.pseudo) : "") : "(gone)",
      kind: el ? kindOf(el) : "other",
      box: r && r.width > 0 ? { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } : null,
      probe: null,
      allowed: el ? (() => {
        for (const a of allow) {
          try {
            if (el.matches(a.selector)) return { name: a.name, props: a.props };
          } catch {
            // a bad selector allows nothing
          }
        }
        return null;
      })() : null,
    };
  });
}

/** Finishes the probe control's animations and reads its effective scale. Self-contained. */
export function readScale(probe: string): { scale: number; selector: string; box: { x: number; y: number; w: number; h: number } } | null {
  const el = (window as unknown as { __dsProbe?: Element[] }).__dsProbe?.[Number(probe)];
  if (!el || !el.isConnected) return null;
  for (const a of el.getAnimations()) {
    try {
      if (Number.isFinite(Number(a.effect?.getTiming().iterations))) a.finish();
    } catch {
      // an infinite animation cannot finish
    }
  }
  const s = getComputedStyle(el);
  let scale = 1;
  if (s.scale && s.scale !== "none") scale *= Number(s.scale.split(/\s+/)[0]) || 1;
  // matrix(a, b, ...) and matrix3d(m11, m12, m13, ...): the x scale is the length of the first column,
  // z included for matrix3d, so a rotateY on press is not read as shrinking.
  const m = /^matrix(3d)?\(([^)]+)\)/.exec(s.transform);
  if (m) {
    const v = m[2]!.split(",").map(Number);
    scale *= m[1] ? Math.hypot(v[0]!, v[1]!, v[2]!) : Math.hypot(v[0]!, v[1]!);
  }
  const r = el.getBoundingClientRect();
  const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30);
  return { scale, selector: `${el.tagName.toLowerCase()}${[...el.classList].slice(0, 2).map((c) => "." + c).join("")} "${label}"`, box: { x: r.left, y: r.top, w: r.width, h: r.height } };
}

/** Visible elements whose computed transition names a layout property. Self-contained. */
export function declaredLayoutTransitions(allow: AllowArg[] = []): Array<{ selector: string; props: string[]; box: { x: number; y: number; w: number; h: number }; allowed?: { name: string; props: string[] } | null }> {
  const LAYOUT = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset(-.*)?|margin(-.*)?|padding(-.*)?|gap|row-gap|column-gap|grid-template-(columns|rows)|flex(-basis|-grow)?)$/;
  const out: Array<{ selector: string; props: string[]; box: { x: number; y: number; w: number; h: number }; allowed?: { name: string; props: string[] } | null }> = [];
  const seen = new Set<string>();
  for (const el of document.body.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (s.transitionProperty === "all" || s.transitionProperty === "none") continue;
    const props = s.transitionProperty.split(",").map((p) => p.trim());
    const durs = s.transitionDuration.split(",").map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000));
    const hits = props.filter((p, i) => LAYOUT.test(p) && (durs[i % durs.length] ?? 0) > 0);
    if (!hits.length) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const sel = el.tagName.toLowerCase() + [...el.classList].filter((c) => /^[a-zA-Z_][\w-]*$/.test(c)).slice(0, 2).map((c) => "." + c).join("");
    if (seen.has(sel + hits.join())) continue;
    seen.add(sel + hits.join());
    let allowed: { name: string; props: string[] } | null = null;
    for (const a of allow) {
      try {
        if (el.matches(a.selector)) {
          allowed = { name: a.name, props: a.props };
          break;
        }
      } catch {
        // a bad selector allows nothing
      }
    }
    out.push({ selector: sel, props: hits, box: { x: r.left, y: r.top, w: r.width, h: r.height }, allowed });
  }
  return out;
}

// ---------------------------------------------------------------------------

const LAYOUT_PROP = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset(-.*)?|margin(-.*)?|padding(-.*)?|gap|row-gap|column-gap|grid-template-(columns|rows)|flex(-basis|-grow)?)$/;
const MOVING_PROP = /^(transform|translate|scale|rotate|top|left|right|bottom|inset(-.*)?|offset(-.*)?|margin(-.*)?|width|height|grid-template-(columns|rows))$/;
const LIMITS: Record<string, number> = { control: 200, menu: 300, dialog: 450, panel: 450 };

const r1 = (n: number) => Math.round(n * 10) / 10;

export function analyzeMotion(
  records: MotionRecord[],
  scales: Array<{ scale: number; rest: number; selector: string; box: { x: number; y: number; w: number; h: number } }>,
  declared: ReturnType<typeof declaredLayoutTransitions>,
  /** Layout findings a motionAllow entry covers go here (with the entry's name) instead of the counted list. */
  allowedOut?: Array<RawFinding & { allowed: string }>,
): Record<string, RawFinding[]> {
  // Splits layout props into the allowed (by the target's motionAllow entry) and the rest.
  const split = (props: string[], allowed: { name: string; props: string[] } | null | undefined) => {
    const ok = allowed ? props.filter((p) => allowed.props.includes(p)) : [];
    return { ok, rest: props.filter((p) => !ok.includes(p)) };
  };
  const out: Record<string, RawFinding[]> = { "M-duration": [], "M-layout-props": [], "M-press-scale": [] };
  const keys = new Set<string>();
  const once = (k: string) => (keys.has(k) ? false : (keys.add(k), true));
  for (const rec of records) {
    if (!Number.isFinite(rec.iterations)) continue; // spinners loop by design
    // Kind: a probe phase is a control's hover/press, whatever the target's size.
    const kind = rec.phase.startsWith("hover:") || rec.phase.startsWith("press:") ? "control" : rec.kind;
    const limit = LIMITS[kind];
    const what = `${rec.type} ${rec.props.join(", ") || rec.name}`;
    if (limit !== undefined && rec.duration > limit && once(`d|${rec.selector}|${rec.props.join()}|${kind}`)) {
      out["M-duration"]!.push({
        check: "M-duration",
        severity: "fail",
        selector: rec.selector,
        box: rec.box,
        measured: `${Math.round(rec.duration)}ms ${what}${rec.delay ? ` (+${Math.round(rec.delay)}ms delay)` : ""} while ${phaseText(rec.phase)}`,
        expected: `<= ${limit}ms for a ${kind === "control" ? "hover/press" : kind} transition`,
      });
    }
    const { ok: allowedLayout, rest: layout } = split(rec.props.filter((p) => LAYOUT_PROP.test(p)), rec.allowed);
    if (allowedLayout.length && rec.duration > 0 && allowedOut && once(`la|${rec.selector}|${allowedLayout.join()}`)) {
      allowedOut.push({
        check: "M-layout-props",
        severity: "fail",
        selector: rec.selector,
        box: rec.box,
        measured: `animates ${allowedLayout.join(", ")} (${Math.round(rec.duration)}ms) while ${phaseText(rec.phase)}`,
        expected: "animate transform/opacity (or a clip/scale technique), never layout properties",
        allowed: rec.allowed!.name,
      });
    }
    if (layout.length && rec.duration > 0 && once(`l|${rec.selector}|${layout.join()}`)) {
      out["M-layout-props"]!.push({
        check: "M-layout-props",
        severity: "fail",
        selector: rec.selector,
        box: rec.box,
        measured: `animates ${layout.join(", ")} (${Math.round(rec.duration)}ms) while ${phaseText(rec.phase)}`,
        expected: "animate transform/opacity (or a clip/scale technique), never layout properties",
      });
    }
  }
  for (const d of declared) {
    if (!once(`l|decl|${d.selector}|${d.props.join()}`)) continue;
    const { ok, rest } = split(d.props, d.allowed);
    const box = { x: r1(d.box.x), y: r1(d.box.y), w: r1(d.box.w), h: r1(d.box.h) };
    if (ok.length && allowedOut && !allowedOut.some((f) => f.selector?.endsWith(d.selector))) {
      allowedOut.push({ check: "M-layout-props", severity: "warn", selector: d.selector, box, measured: `transition-property lists ${ok.join(", ")} (declared, not seen running)`, expected: "transition transform/opacity instead of layout properties", allowed: d.allowed!.name });
    }
    if (!rest.length) continue;
    if (out["M-layout-props"]!.some((f) => f.selector?.endsWith(d.selector))) continue;
    out["M-layout-props"]!.push({
      check: "M-layout-props",
      severity: "warn",
      selector: d.selector,
      box,
      measured: `transition-property lists ${rest.join(", ")} (declared, not seen running)`,
      expected: "transition transform/opacity instead of layout properties",
    });
  }
  for (const s of scales) {
    const rel = s.scale / (s.rest || 1);
    if (rel >= 0.999 || rel <= 0) continue;
    const ok = rel >= 0.95 - 1e-6 && rel <= 0.98 + 1e-6;
    if (ok) continue;
    out["M-press-scale"]!.push({
      check: "M-press-scale",
      severity: rel < 0.95 ? "fail" : "warn",
      selector: s.selector,
      box: { x: r1(s.box.x), y: r1(s.box.y), w: r1(s.box.w), h: r1(s.box.h) },
      measured: `scale ${rel.toFixed(3)} on :active`,
      expected: "0.95-0.98",
    });
  }
  return out;
}

export function analyzeReducedMotion(records: MotionRecord[], matches: boolean): RawFinding[] {
  const out: RawFinding[] = [];
  const seen = new Set<string>();
  if (!matches) return out;
  for (const rec of records) {
    const moving = rec.props.filter((p) => MOVING_PROP.test(p));
    if (!moving.length || rec.duration <= 20) continue;
    const k = `${rec.selector}|${moving.join()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      check: "M-reduced-motion",
      severity: "warn",
      selector: rec.selector,
      box: rec.box,
      measured: `${rec.type} ${moving.join(", ")} still runs ${Math.round(rec.duration)}ms${Number.isFinite(rec.iterations) ? "" : " (infinite)"} with prefers-reduced-motion: reduce, while ${phaseText(rec.phase)}`,
      expected: "no movement under reduced motion (an opacity cross-fade is fine)",
    });
  }
  return out;
}

function phaseText(phase: string): string {
  if (phase.startsWith("hover:")) return "hovering a control";
  if (phase.startsWith("press:")) return "pressing a control";
  if (phase === "actions") return "reaching the page state";
  return phase || "loading";
}
