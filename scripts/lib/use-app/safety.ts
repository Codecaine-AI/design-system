/**
 * What `use:app` may click, and what it hovers (APP_BRIEF step 5: navigation and view controls only).
 *
 * use:app clicks only the registry's own navigation steps (a route's `steps`, a `click` or `steps`
 * darkSwitch) and the sidebar toggle. Before each click, and before each Enter or Space press, the
 * target is described in the page (describeElement) and the step is refused, never run, when:
 *   - its selector names a write (save, delete, remove, send, submit, sync, publish, deploy);
 *   - the element (or the control it sits in) is a submit control or sits in a <form>;
 *   - its aria-label, title, value or visible text names a write.
 * Hovers go to visible, enabled buttons and links outside any form, in document order, at most
 * MAX_HOVERS per route and theme. A hover never activates anything, so a "Delete" button is hovered.
 */
import type { Step } from "../capture";

/** Words that name a write. A word start is enough: "Saved", "Sending" and "Deployment" count too. */
export const UNSAFE_WORDS = /\b(?:save|delete|remove|send|submit|sync|publish|deploy)/i;

/** The elements use:app hovers. */
export const HOVER_SELECTOR = 'a[href], button, [role="button"], [role="link"], [role="tab"]';

/** Hovers per route and theme. */
export const MAX_HOVERS = 30;

/** One element as the page shows it: what the safety rules read. */
export interface ElementInfo {
  /** Short name for the log: tag, id or first class, and its first label. */
  name: string;
  /** A submit control: input type submit or image, or a button that submits its form. */
  submit: boolean;
  /** Inside a <form>, or owned by one through the form attribute. */
  inForm: boolean;
  /** aria-label, title, value and visible text of the element and of the control it sits in. */
  labels: string[];
  /** Has a box a scroll can reach, and is not display:none or visibility:hidden. */
  visible: boolean;
  /** Not :disabled and not aria-disabled. */
  enabled: boolean;
}

/**
 * Page function (pass to locator.evaluate or handle.evaluate): the element's ElementInfo. It reads the
 * element and the nearest control it sits in (a click on a span inside a submit button submits).
 * Self-contained: Playwright sends its source to the page.
 */
export function describeElement(el: any): ElementInfo {
  const control = el.closest?.('button, input, select, textarea, a[href], summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"]') ?? el;
  const clip = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const labels: string[] = [];
  for (const node of control === el ? [el] : [el, control]) {
    const value = String(node.tagName).toLowerCase() === "input" ? node.value : null;
    for (const text of [node.getAttribute?.("aria-label"), node.getAttribute?.("title"), value, node.innerText ?? node.textContent]) {
      const label = clip(text);
      if (label && !labels.includes(label)) labels.push(label);
    }
  }
  const tag = String(control.tagName ?? "").toLowerCase();
  const type = String(control.getAttribute?.("type") ?? "").toLowerCase();
  const owner = control.form ?? null;
  const submit = (tag === "input" && (type === "submit" || type === "image")) || (tag === "button" && Boolean(owner) && (type === "" || type === "submit"));
  const win = globalThis as any;
  const style = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  // A box no scroll can reach: above or left of the page, or fixed outside the viewport (a hidden skip link).
  const reachable =
    rect.bottom + win.scrollY > 0 &&
    rect.right + win.scrollX > 0 &&
    (style.position !== "fixed" || (rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth));
  const id = el.id ? `#${el.id}` : "";
  const cls = !id && typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "";
  return {
    name: `${String(el.tagName).toLowerCase()}${id}${cls}${labels[0] ? ` "${labels[0].slice(0, 60)}"` : ""}`,
    submit,
    inForm: Boolean(el.closest?.("form") || control.closest?.("form") || owner),
    labels,
    visible: rect.width > 0 && rect.height > 0 && reachable && style.visibility !== "hidden" && style.display !== "none",
    enabled: !control.matches?.(":disabled") && control.getAttribute?.("aria-disabled") !== "true",
  };
}

/** Why clicking (or pressing Enter on) this element could write, or null. */
export function unsafeReason(info: ElementInfo): string | null {
  if (info.submit) return `${info.name} is a submit control`;
  if (info.inForm) return `${info.name} is inside a <form>`;
  const label = info.labels.find((text) => UNSAFE_WORDS.test(text));
  return label ? `${info.name}: "${label.slice(0, 60)}" names a write (save, delete, remove, send, submit, sync, publish, deploy)` : null;
}

/** The key a press step sends. */
function pressedKey(step: Step): string {
  return String(step.target && step.value !== undefined ? step.value : (step.value ?? step.target ?? ""));
}

/** Whether the step activates an element: a click, or an Enter or Space press (with or without modifiers). */
export function activates(step: Step): boolean {
  if (step.action === "click") return true;
  if (step.action !== "press") return false;
  const key = pressedKey(step);
  const last = key.length > 1 ? (key.split("+").filter(Boolean).pop() ?? key) : key;
  return /^(?:Enter|NumpadEnter|Space| )$/i.test(last);
}

/** The selector of the element an activating step acts on; null for a key press on the focused element. */
export function stepSelector(step: Step): string | null {
  if (step.action === "click") return step.target ?? null;
  return step.action === "press" && step.target && step.value !== undefined ? step.target : null;
}

/**
 * Why use:app refuses the step, or null when it may run. `target` is the element the step acts on (the
 * focused element for a key press without a target), or null before the page was asked. Hover, scroll and
 * wait steps never activate anything and always pass.
 */
export function stepRefusal(step: Step, target: ElementInfo | null): string | null {
  if (!activates(step)) return null;
  const selector = stepSelector(step);
  if (selector && UNSAFE_WORDS.test(selector)) return `the selector ${selector} names a write (save, delete, remove, send, submit, sync, publish, deploy)`;
  return target ? unsafeReason(target) : null;
}

/** The elements to hover, as indexes into `infos` (document order): visible, enabled, outside any form, at most `cap`. */
export function hoverTargets(infos: Array<ElementInfo | null>, cap = MAX_HOVERS): number[] {
  const chosen: number[] = [];
  infos.forEach((info, i) => {
    if (chosen.length < cap && info && info.visible && info.enabled && !info.inForm && !info.submit) chosen.push(i);
  });
  return chosen;
}
