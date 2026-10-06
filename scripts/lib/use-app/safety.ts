/**
 * What `use:app` may click, and what it hovers (APP_BRIEF step 5: navigation and view controls only).
 *
 * use:app clicks only the registry's own navigation steps (a route's `steps`, a `click` or `steps`
 * darkSwitch, verify.lightSteps) and the sidebar toggle. A `check` or `uncheck` step counts as a click. The managing agent reviews those steps; these rules are the second
 * line of defence. A key press is run only for Tab, Escape, the arrows, PageUp/PageDown and Home/End
 * (Shift allowed), or a plain Enter or Space. Before each click, and before each Enter or Space press,
 * the target is described in the page (describeElement) and the step is refused, never run, when:
 *   - its selector names a write (save, delete, remove, send, submit, sync, publish, deploy);
 *   - the element (or the control it sits in) is a submit control or sits in a <form>;
 *   - its aria-label, title or value names a write;
 *   - its visible text names a write, where the text is the control's own short label (at most 3 words
 *     or 30 characters: "Sync now") or starts with the word ("Delete skill …"). A longer text is data
 *     (a list row whose status badge says "In sync") and is not read for words.
 * Hovers go to visible, enabled buttons and links outside any form, in document order, at most
 * MAX_HOVERS per route and theme. A hover never activates anything, so a "Delete" button is hovered.
 */
import type { Step } from "../capture";

/** Words that name a write. A word start is enough: "Saved", "Sending" and "Deployment" count too. */
export const UNSAFE_WORDS = /\b(?:save|delete|remove|send|submit|sync|publish|deploy)/i;
/** ... at the start of a text, after any symbols: "Delete skill and its history", "▧ Sync all". */
const UNSAFE_START = /^[^\p{L}\p{N}]*(?:save|delete|remove|send|submit|sync|publish|deploy)/iu;
/** A visible text this short is the control's own label, read for write words anywhere in it. */
const SHORT_WORDS = 3;
const SHORT_CHARS = 30;

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
  /**
   * The accessible names of the element and of the control it sits in (aria-label, title, aria-labelledby,
   * its <label>s, a wrapping <label>) and an input's value: always read for write words.
   */
  names: string[];
  /** Visible text of the element and of the control it sits in (none for the page body): read when short or at its start. */
  texts: string[];
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
  // A key press with nothing focused lands on the body: the whole page's text is no label.
  const page = (node: any) => node === node.ownerDocument?.body || node === node.ownerDocument?.documentElement;
  const names: string[] = [];
  const texts: string[] = [];
  const push = (list: string[], text: unknown) => {
    const label = clip(text);
    if (label && !list.includes(label)) list.push(label);
  };
  for (const node of control === el ? [el] : [el, control]) {
    push(names, node.getAttribute?.("aria-label"));
    push(names, node.getAttribute?.("title"));
    // The accessible name a user reads: aria-labelledby, the native labels (<label for>, a wrapping
    // <label>) and any wrapping <label> of a non-labelable element. A checkbox's own text is empty.
    for (const id of String(node.getAttribute?.("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
      const label = node.ownerDocument?.getElementById(id);
      if (label) push(names, label.innerText ?? label.textContent);
    }
    for (const label of Array.from((node.labels ?? []) as Iterable<any>)) push(names, label.innerText ?? label.textContent);
    const wrapping = node.closest?.("label");
    if (wrapping) push(names, wrapping.innerText ?? wrapping.textContent);
    if (String(node.tagName).toLowerCase() === "input") push(names, node.value);
    if (!page(node)) push(texts, node.innerText ?? node.textContent);
  }
  const labels = [...names, ...texts];
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
    names,
    texts,
    visible: rect.width > 0 && rect.height > 0 && reachable && style.visibility !== "hidden" && style.display !== "none",
    enabled: !control.matches?.(":disabled") && control.getAttribute?.("aria-disabled") !== "true",
  };
}

/** A visible text short enough to be the control's own label: at most 3 words, or 30 characters. */
const shortText = (text: string) => text.length <= SHORT_CHARS || text.split(" ").length <= SHORT_WORDS;

/** Why clicking (or pressing Enter on) this element could write, or null. */
export function unsafeReason(info: ElementInfo): string | null {
  if (info.submit) return `${info.name} is a submit control`;
  if (info.inForm) return `${info.name} is inside a <form>`;
  const label = info.names.find((text) => UNSAFE_WORDS.test(text)) ?? info.texts.find((text) => (shortText(text) ? UNSAFE_WORDS : UNSAFE_START).test(text));
  return label ? `${info.name}: "${label.slice(0, 60)}" names a write (save, delete, remove, send, submit, sync, publish, deploy)` : null;
}

/** The key a press step sends. */
function pressedKey(step: Step): string {
  return String(step.target && step.value !== undefined ? step.value : (step.value ?? step.target ?? ""));
}

/** Keys that only move focus, scroll or close: run with no target check (Shift is the only modifier allowed). */
const VIEW_KEYS = /^(?:Tab|Escape|Esc|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)$/;
/** Keys that activate the focused or targeted element: run only plain, and only on a checked target. */
const ACTIVATE_KEYS = /^(?:Enter|NumpadEnter|Space| )$/;

/** A press as its modifiers and its key: "Shift+Tab" -> ["Shift"], "Tab"; " " (Space) stays one key. */
function splitKey(key: string): { modifiers: string[]; key: string } {
  if (key.length <= 1) return { modifiers: [], key };
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  // "Control++": the key is "+" itself.
  return last === "" && parts.at(-1) === "" ? { modifiers: parts.slice(0, -1), key: "+" } : { modifiers: parts.filter(Boolean), key: last };
}

/** Why use:app refuses a key press, or null: only view keys, and plain Enter or Space. */
export function keyRefusal(step: Step): string | null {
  if (step.action !== "press") return null;
  const raw = pressedKey(step);
  const { modifiers, key } = splitKey(raw);
  if (VIEW_KEYS.test(key) && modifiers.every((m) => m === "Shift")) return null;
  if (ACTIVATE_KEYS.test(key) && modifiers.length === 0) return null;
  return `the key ${JSON.stringify(raw)} is not a view key (use:app presses only Tab, Escape, the arrows, PageUp/PageDown and Home/End, and a plain Enter or Space on a checked target)`;
}

/** A click, or a check or uncheck (which clicks when the control is not in that state yet). */
const CLICKS = new Set(["click", "check", "uncheck"]);

/** Whether the step activates an element: a click, a check or uncheck, or a plain Enter or Space press. */
export function activates(step: Step): boolean {
  if (CLICKS.has(step.action)) return true;
  if (step.action !== "press") return false;
  const { modifiers, key } = splitKey(pressedKey(step));
  return ACTIVATE_KEYS.test(key) && modifiers.length === 0;
}

/** The selector of the element an activating step acts on; null for a key press on the focused element. */
export function stepSelector(step: Step): string | null {
  if (CLICKS.has(step.action)) return step.target ?? null;
  return step.action === "press" && step.target && step.value !== undefined ? step.target : null;
}

/**
 * Why use:app refuses the step, or null when it may run. `target` is the element the step acts on (the
 * focused element for a key press without a target), or null before the page was asked. A key press
 * other than a view key or a plain Enter or Space is refused outright. Hover, scroll and wait steps
 * never activate anything and always pass.
 */
export function stepRefusal(step: Step, target: ElementInfo | null): string | null {
  const key = keyRefusal(step);
  if (key) return key;
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
