/**
 * The in-page probe for the DOM-measured runtime checks. `probePage` runs inside the page (page.evaluate),
 * so it must stay self-contained: no imports, no outer helpers.
 *
 * Every check measures only elements that are visible and intersect the viewport, so each finding has
 * evidence in the state screenshot. Checks prefer missing a finding to guessing: anything whose value
 * cannot be measured with confidence (text over an image, a background from a pseudo-element, a
 * background inside the same faded group as the text) is skipped.
 */

export interface ProbeOptions {
  ignore: string[];
  handles: string[];
  /** Spacing values (px) that are on the grid besides multiples of 4: the space tokens (2, 6). */
  spaceTokens: number[];
  /** The design system's radius tokens (px) other than none and pill: nested pairs both on one of them pass R-concentric-radius. */
  baseRadii?: number[];
}

export interface ProbeFinding {
  check: string;
  severity: "fail" | "warn";
  selector: string;
  box: { x: number; y: number; w: number; h: number };
  other?: { selector: string; box: { x: number; y: number; w: number; h: number } } | null;
  measured: string;
  expected: string;
  message?: string;
  guides?: { axis: "x" | "y"; a: number; b: number };
  /** Dedupe key: one finding per key. */
  key?: string;
  /** Grouped findings: how many elements it stands for, and the group (component) key. */
  count?: number;
  group?: string;
}

export function probePage(o: ProbeOptions): { findings: ProbeFinding[]; stats: Record<string, number> } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const findings: ProbeFinding[] = [];
  const stats: Record<string, number> = {};
  const seenKeys = new Set<string>();
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const boxOf = (r: DOMRect | { left: number; top: number; width: number; height: number }) => ({ x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) });
  const push = (f: ProbeFinding) => {
    if (f.key) {
      if (seenKeys.has(f.check + "|" + f.key)) return;
      seenKeys.add(f.check + "|" + f.key);
    }
    findings.push(f);
  };
  const csCache = new Map<Element, CSSStyleDeclaration>();
  const cs = (el: Element) => {
    let s = csCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      csCache.set(el, s);
    }
    return s;
  };
  const px = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  // --- selectors -----------------------------------------------------------
  const simpleClass = (c: string) => /^[a-zA-Z_][\w-]*$/.test(c) && c.length <= 32;
  const segment = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `${tag}#${el.id}`;
    const classes = [...el.classList].filter(simpleClass).slice(0, 2);
    let seg = tag + classes.map((c) => "." + c).join("");
    const label = el.getAttribute("aria-label");
    if (!classes.length && label && label.length <= 30) seg += `[aria-label="${label.replace(/"/g, "'")}"]`;
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return seg;
  };
  const selectorOf = (el: Element) => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && cur !== document.body && depth < 5; depth++) {
      const seg = segment(cur);
      parts.unshift(seg);
      if (seg.includes("#")) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  /** Class signature without positions: repeated rows (nav items, list rows) share it. */
  const signature = (el: Element) => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && cur !== document.body && depth < 3; depth++) {
      parts.unshift(cur.tagName.toLowerCase() + [...cur.classList].filter(simpleClass).slice(0, 2).map((c) => "." + c).join(""));
      cur = cur.parentElement;
    }
    return parts.join(">");
  };
  const textSnippet = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);

  // --- visibility ------------------------------------------------------------
  const ignored = (el: Element) => o.ignore.some((s) => {
    try {
      return !!el.closest(s);
    } catch {
      return false;
    }
  });
  const inView = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const visible = (el: Element) => {
    const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
    if (anyEl.checkVisibility && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    return true;
  };
  const clipCache = new Map<Element, DOMRect | null>();
  /** The rect `r` survives every clipping ancestor (overflow not visible) with at least half its area. */
  const unclipped = (el: Element, r: DOMRect) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      if (s.overflowX === "visible" && s.overflowY === "visible" && s.clipPath === "none") continue;
      let ar = clipCache.get(a);
      if (ar === undefined) {
        ar = a.getBoundingClientRect();
        clipCache.set(a, ar);
      }
      if (!ar) continue;
      const ix = Math.min(r.right, ar.right) - Math.max(r.left, ar.left);
      const iy = Math.min(r.bottom, ar.bottom) - Math.max(r.top, ar.top);
      if (ix <= 0 || iy <= 0 || ix * iy < (r.width * r.height) / 2) return false;
    }
    return true;
  };
  const srOnly = (r: DOMRect) => r.width <= 2 || r.height <= 2;

  // --- colors ----------------------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const colorCache = new Map<string, [number, number, number, number]>();
  const rgba = (css: string): [number, number, number, number] => {
    // Callers adjust the alpha, so hand out a copy: the cached tuple must stay as parsed.
    let c = colorCache.get(css);
    if (c) return [...c];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    c = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    colorCache.set(css, c);
    return [...c];
  };
  const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
  ];
  const lum = (c: [number, number, number]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const hex = (c: [number, number, number]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  // --- element sets ------------------------------------------------------------
  // An open modal makes the rest of the page inert and covered: measure only inside it.
  const modal = [...document.querySelectorAll('dialog, [aria-modal="true"]')].reverse().find((d) => {
    try {
      return d.matches(":modal") || d.getAttribute("aria-modal") === "true";
    } catch {
      return d.getAttribute("aria-modal") === "true";
    }
  });
  stats.modal = modal ? 1 : 0;
  const scope: Element = modal ?? document.body;
  const all = [...scope.querySelectorAll("*")].filter((el) => {
    if (el.closest("script,style,template,noscript,head")) return false;
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return false;
    return !ignored(el);
  });
  type Atom = { el: Element; kind: "text" | "box"; r: DOMRect; left: number; right: number; top: number; bottom: number; cy: number; lineH: number };
  const rectCache = new Map<Element, DOMRect>();
  const rectOf = (el: Element) => {
    let r = rectCache.get(el);
    if (!r) {
      r = el.getBoundingClientRect();
      rectCache.set(el, r);
    }
    return r;
  };
  const directText = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0) as Text[];
  const range = document.createRange();
  const textRects = (nodes: Text[]) => {
    const rects: DOMRect[] = [];
    for (const n of nodes) {
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0.5 && r.height > 0.5) rects.push(r);
    }
    return rects;
  };
  const shown = all.filter((el) => {
    const r = rectOf(el);
    return inView(r) && visible(el);
  });
  stats.elements = shown.length;

  const textEls: Array<{ el: Element; nodes: Text[]; rects: DOMRect[] }> = [];
  for (const el of shown) {
    const nodes = directText(el);
    if (!nodes.length) continue;
    const rects = textRects(nodes).filter((r) => inView(r));
    if (!rects.length) continue;
    const er = rectOf(el);
    if (srOnly(er) || cs(el).clip === "rect(0px, 0px, 0px, 0px)" || el.matches(".sr-only, .visually-hidden")) continue;
    if (!unclipped(el, rects[0]!)) continue;
    textEls.push({ el, nodes, rects });
  }
  stats.textElements = textEls.length;

  const interactiveSel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], [tabindex]:not([tabindex="-1"])';
  const interactive = shown.filter((el) => {
    if (!el.matches(interactiveSel)) return false;
    if ((el as HTMLElement).isContentEditable && !el.matches("button,a,[role]")) return false;
    if (el.closest('[contenteditable="true"]') && !el.matches('[contenteditable="true"]')) return false;
    if (cs(el).pointerEvents === "none") return false;
    if (el.matches(":disabled, [aria-disabled='true']")) return false;
    // A nested interactive inside another one (an icon in a button) is the parent's hit area.
    const parent = el.parentElement?.closest(interactiveSel);
    if (parent && parent !== el && shown.includes(parent) && parent.matches("button,a[href],[role=button],[role=link],summary")) return false;
    const r = rectOf(el);
    return !srOnly(r) && unclipped(el, r);
  });
  stats.interactive = interactive.length;

  const bgOf = (el: Element) => rgba(cs(el).backgroundColor);
  const hasChrome = (el: Element) => {
    const s = cs(el);
    const bw = px(s.borderTopWidth) + px(s.borderBottomWidth) + px(s.borderLeftWidth) + px(s.borderRightWidth);
    if (bw > 0 && rgba(s.borderTopColor)[3] > 0.05 && s.borderTopStyle !== "none") return true;
    if (s.boxShadow && s.boxShadow !== "none") return true;
    const bg = bgOf(el);
    if (bg[3] < 0.05) return false;
    const parentBg = el.parentElement ? effectiveBg(el.parentElement) : [255, 255, 255];
    if (!parentBg) return true;
    const mixed = over(bg, parentBg as [number, number, number]);
    return Math.abs(mixed[0] - parentBg[0]!) + Math.abs(mixed[1] - parentBg[1]!) + Math.abs(mixed[2] - parentBg[2]!) > 6;
  };
  /** The opaque color painted behind an element by its ancestors (null when an image or gradient is involved). */
  function effectiveBg(el: Element): [number, number, number] | null {
    const layers: Array<[number, number, number, number]> = [];
    for (let a: Element | null = el; a; a = a.parentElement) {
      const s = cs(a);
      if (s.backgroundImage !== "none") return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.999) break;
    }
    let base: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i]!, base);
    return base;
  }

  // --- R-contrast ------------------------------------------------------------
  for (const { el, rects } of textEls) {
    const s = cs(el);
    if (el.closest("svg, [aria-disabled='true'], :disabled")) continue;
    if (s.webkitTextFillColor && rgba(s.webkitTextFillColor)[3] === 0) continue; // gradient text
    if (s.mixBlendMode !== "normal") continue;
    const first = rects[0]!;
    const cx = first.left + Math.min(first.width / 2, 8);
    const cy = first.top + first.height / 2;
    const stack = document.elementsFromPoint(cx, cy);
    const idx = stack.findIndex((x) => x === el || el.contains(x));
    if (idx < 0) continue; // covered, or not hit-testable
    // Something painted over the text (a translucent overlay)?
    let covered = false;
    for (let i = 0; i < idx; i++) {
      const x = stack[i]!;
      if (x.contains(el)) continue;
      if (bgOf(x)[3] > 0.05 || cs(x).backgroundImage !== "none") covered = true;
    }
    if (covered) continue;
    const layers: Array<[number, number, number, number]> = [];
    let uncertain = false;
    let opacity = 1;
    const faded: Element[] = [];
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const o = px(cs(a).opacity) || (cs(a).opacity === "0" ? 0 : 1);
      if (o < 1) faded.push(a);
      opacity *= o;
    }
    for (let i = idx; i < stack.length; i++) {
      const x = stack[i]!;
      const xs = cs(x);
      if (xs.backgroundImage !== "none" || x.tagName === "IMG" || x.tagName === "VIDEO" || x.tagName === "CANVAS" || x.tagName === "IFRAME") {
        uncertain = true;
        break;
      }
      if (xs.backdropFilter && xs.backdropFilter !== "none") {
        uncertain = true;
        break;
      }
      const c = rgba(xs.backgroundColor);
      // A background inside the faded group fades with the text: the group's colors are not read here.
      if (c[3] > 0 && faded.some((f) => f.contains(x))) {
        uncertain = true;
        break;
      }
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.999) break;
    }
    if (uncertain) continue;
    let bg: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i]!, bg);
    const fgRaw = rgba(s.webkitTextFillColor && s.webkitTextFillColor !== s.color ? s.webkitTextFillColor : s.color);
    if (opacity < 1) fgRaw[3] *= opacity;
    if (fgRaw[3] < 0.02) continue;
    const fg = over(fgRaw, bg);
    const size = px(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got + 0.005 < need) {
      push({
        check: "R-contrast",
        severity: "fail",
        selector: selectorOf(el),
        box: boxOf(first),
        measured: `${got.toFixed(2)}:1 (${hex(fg)} on ${hex(bg)}, ${size}px/${weight}) "${textSnippet(el)}"`,
        expected: `>= ${need}:1${large ? " (large text)" : ""}`,
        key: `${hex(fg)}|${hex(bg)}|${signature(el)}`,
      });
    }
  }

  // --- R-hit-target --------------------------------------------------------
  const targetRects = interactive.map((el) => {
    let r = rectOf(el);
    // A label that wraps (or points at) an input is part of its hit area.
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      for (const l of labels) {
        const lr = l.getBoundingClientRect();
        if (lr.width * lr.height > r.width * r.height) r = lr;
      }
    }
    return { el, r };
  });
  function inTextLine(el: Element, r: DOMRect): boolean {
    const block = el.parentElement;
    if (!block) return false;
    const bs = cs(block);
    const line = bs.lineHeight === "normal" ? px(bs.fontSize) * 1.25 : px(bs.lineHeight);
    if (r.height > line + 1) return false;
    let words = block.textContent ?? "";
    for (const target of block.querySelectorAll("a, button, input, select, textarea, [role=button]")) words = words.replace(target.textContent ?? "", "");
    return (words.match(/[\p{L}\p{N}]/gu) ?? []).length >= 4;
  }
  // One finding per component (tag + class list) and band: 140 identical breadcrumbs are one finding.
  type HitGroup = { band: "fail" | "spaced" | "warn-band"; first: Element; r: DOMRect; n: number; minW: number; maxW: number; minH: number; maxH: number; label: string };
  const hitGroups = new Map<string, HitGroup>();
  for (const { el, r } of targetRects) {
    const s = cs(el);
    // Inline links in running text are exempt (WCAG 2.5.8).
    if (el.matches("a") && s.display === "inline") {
      const block = el.parentElement;
      if (block && (block.textContent ?? "").trim().length > (el.textContent ?? "").trim().length + 3) continue;
    }
    // So is an inline-flex or inline-block link set in a line of words and no taller than that line
    // (a meta line under a title): WCAG 2.5.8's line-height exception. Separators alone (breadcrumbs) are not words.
    if (el.matches("a") && s.display.startsWith("inline-") && inTextLine(el, r)) continue;
    const w = r.width;
    const h = r.height;
    const min = Math.min(w, h);
    if (min >= 32) continue;
    let band: HitGroup["band"] = min < 24 ? "fail" : "warn-band";
    if (band === "fail") {
      // Spacing exception (WCAG 2.5.8): a 24px circle on its center touches no other target, and
      // no other undersized target's circle (two such centers under 24px apart).
      const cx = r.left + w / 2;
      const cy = r.top + h / 2;
      const crowded = targetRects.some(({ el: other, r: or }) => {
        if (other === el || other.contains(el) || el.contains(other)) return false;
        const nx = Math.max(or.left, Math.min(cx, or.right));
        const ny = Math.max(or.top, Math.min(cy, or.bottom));
        if ((nx - cx) ** 2 + (ny - cy) ** 2 < 144) return true;
        if (Math.min(or.width, or.height) >= 24) return false;
        return (or.left + or.width / 2 - cx) ** 2 + (or.top + or.height / 2 - cy) ** 2 < 576;
      });
      if (!crowded) band = "spaced";
    }
    const classes = [...el.classList].filter(simpleClass).sort();
    const component = el.tagName.toLowerCase() + (classes.length ? classes.map((c) => "." + c).join("") : `[${signature(el)}]`) + (el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "");
    const gk = `${band}|${component}`;
    const g = hitGroups.get(gk);
    if (g) {
      g.n++;
      g.minW = Math.min(g.minW, w);
      g.maxW = Math.max(g.maxW, w);
      g.minH = Math.min(g.minH, h);
      g.maxH = Math.max(g.maxH, h);
    } else {
      hitGroups.set(gk, { band, first: el, r, n: 1, minW: w, maxW: w, minH: h, maxH: h, label: textSnippet(el) || el.getAttribute("aria-label") || "" });
    }
  }
  for (const [gk, g] of hitGroups) {
    const range = (a: number, b: number) => (Math.round(a) === Math.round(b) ? `${r1(a)}` : `${r1(a)}-${r1(b)}`);
    const size = `${range(g.minW, g.maxW)}x${range(g.minH, g.maxH)}px`;
    push({
      check: "R-hit-target",
      severity: g.band === "fail" ? "fail" : "warn",
      selector: selectorOf(g.first),
      box: boxOf(g.r),
      measured: `${g.n > 1 ? `${g.n} elements, ` : ""}${size}${g.band === "spaced" ? " (under 24px but spaced: no target within 12px of its center)" : g.band === "warn-band" ? " (warn band 24-32px)" : ""} "${g.label}"`,
      expected: g.band === "warn-band" ? ">= 32x32px (warn band)" : ">= 24x24px",
      count: g.n,
      group: gk,
      key: gk,
    });
  }

  // --- R-tabular-nums ------------------------------------------------------
  for (const { el, nodes, rects } of textEls) {
    const text = nodes.map((n) => n.textContent).join("").trim();
    if (!/^[\s\d.,:%+\-−–/$€£×]*$/.test(text)) continue;
    if ((text.match(/\d/g) ?? []).length < 2) continue;
    const s = cs(el);
    if (/tabular-nums/.test(s.fontVariantNumeric) || /tnum/.test(s.fontFeatureSettings)) continue;
    if (/mono/i.test(s.fontFamily)) continue;
    push({
      check: "R-tabular-nums",
      severity: "warn",
      selector: selectorOf(el),
      box: boxOf(rects[0]!),
      measured: `"${text.slice(0, 24)}" font-variant-numeric: ${s.fontVariantNumeric}`,
      expected: "font-variant-numeric: tabular-nums",
      key: signature(el),
    });
  }

  // --- R-min-font ------------------------------------------------------------
  for (const { el, nodes, rects } of textEls) {
    const s = cs(el);
    const size = px(s.fontSize);
    if (size >= 12 || size <= 1) continue;
    if (el.closest("sup, sub, svg")) continue;
    const text = nodes.map((n) => n.textContent).join("").trim();
    const upper = s.textTransform === "uppercase" || (/[A-Z]/.test(text) && text === text.toUpperCase());
    const severity = upper && size >= 10 ? "warn" : "fail";
    push({
      check: "R-min-font",
      severity,
      selector: selectorOf(el),
      box: boxOf(rects[0]!),
      measured: `${size}px${upper ? " uppercase" : ""} "${text.slice(0, 30)}"`,
      expected: ">= 12px",
      key: `${signature(el)}|${size}`,
    });
  }

  // --- R-line-length ----------------------------------------------------------
  const measureCtx = document.createElement("canvas").getContext("2d")!;
  for (const { el, rects } of textEls) {
    const s = cs(el);
    if (/mono/i.test(s.fontFamily) || el.closest("pre, code, table")) continue;
    if (s.display === "inline") continue;
    const tops = new Set(rects.map((r) => Math.round(r.top)));
    if (tops.size < 2) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 120) continue;
    measureCtx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const sample = text.slice(0, 400);
    const avg = measureCtx.measureText(sample).width / sample.length;
    const r = rectOf(el);
    const content = r.width - px(s.paddingLeft) - px(s.paddingRight) - px(s.borderLeftWidth) - px(s.borderRightWidth);
    const chars = content / avg;
    if (chars > 80) {
      push({
        check: "R-line-length",
        severity: "warn",
        selector: selectorOf(el),
        box: boxOf(r),
        measured: `~${Math.round(chars)} characters per line (${Math.round(content)}px at ${s.fontSize})`,
        expected: "<= 80 characters (60-75 reads best)",
        key: signature(el),
      });
    }
  }

  // --- R-text-clip --------------------------------------------------------------
  for (const { el, rects } of textEls) {
    const s = cs(el);
    if (el.matches("input, textarea, select, option")) continue;
    const textRight = Math.max(...rects.map((r) => r.right));
    const textBottom = Math.max(...rects.map((r) => r.bottom));
    // Text past the edge of a box that scrolls on that axis is reached by scrolling, so the walk ends there on that axis.
    let scrolledX = false;
    let scrolledY = false;
    for (let a: Element | null = el, depth = 0; a && depth < 4 && a !== document.body; a = a.parentElement, depth++) {
      const as = cs(a);
      const scrollsX = as.overflowX === "auto" || as.overflowX === "scroll";
      const scrollsY = as.overflowY === "auto" || as.overflowY === "scroll";
      if (scrollsX || scrollsY) {
        const ar = rectOf(a);
        if (scrollsX && textRight > ar.left + a.clientLeft + a.clientWidth + 1) scrolledX = true;
        if (scrollsY && textBottom > ar.top + a.clientTop + a.clientHeight + 2) scrolledY = true;
        if (scrolledX && scrolledY) break;
      }
      const clipX = !scrolledX && (as.overflowX === "hidden" || as.overflowX === "clip");
      const clipY = !scrolledY && (as.overflowY === "hidden" || as.overflowY === "clip");
      if (!clipX && !clipY) continue;
      const ar = rectOf(a);
      if (srOnly(ar)) break;
      const innerRight = ar.right - px(as.borderRightWidth);
      const innerBottom = ar.bottom - px(as.borderBottomWidth);
      const ellipsis = as.textOverflow === "ellipsis" || s.textOverflow === "ellipsis";
      const clamp = (as as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp;
      const clamped = clamp && clamp !== "none";
      if (clipX && !ellipsis && textRight > innerRight + 1) {
        push({
          check: "R-text-clip",
          severity: "fail",
          selector: selectorOf(el),
          box: boxOf(rects[0]!),
          other: a !== el ? { selector: selectorOf(a), box: boxOf(ar) } : null,
          measured: `text runs ${r1(textRight - innerRight)}px past the right edge of ${a === el ? "its box" : "an overflow:hidden ancestor"}, no ellipsis "${textSnippet(el)}"`,
          expected: "text fits, wraps, or ends in an ellipsis",
          key: signature(el),
        });
        break;
      }
      if (clipY && !clamped && textBottom > innerBottom + 2 && rects[0]!.top < innerBottom) {
        push({
          check: "R-text-clip",
          severity: "fail",
          selector: selectorOf(el),
          box: boxOf(rects[0]!),
          other: a !== el ? { selector: selectorOf(a), box: boxOf(ar) } : null,
          measured: `text runs ${r1(textBottom - innerBottom)}px below the bottom of ${a === el ? "its box" : "an overflow:hidden ancestor"} "${textSnippet(el)}"`,
          expected: "text fits, or is clamped with -webkit-line-clamp",
          key: signature(el) + "|y",
        });
        break;
      }
      break;
    }
  }

  // --- R-h-scroll -----------------------------------------------------------------
  const doc = document.scrollingElement ?? document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    push({ check: "R-h-scroll", severity: "fail", selector: "html", box: { x: 0, y: 0, w: vw, h: vh }, measured: `document is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px viewport`, expected: "no sideways scroll" });
  }
  for (const el of document.querySelectorAll('main, [role="main"], #ds-main, .ds-content, .ds-main')) {
    const s = cs(el);
    if (!(s.overflowX === "auto" || s.overflowX === "scroll")) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      push({ check: "R-h-scroll", severity: "fail", selector: selectorOf(el), box: boxOf(rectOf(el)), measured: `content is ${el.scrollWidth}px wide in a ${el.clientWidth}px main area`, expected: "the main area never scrolls sideways", key: selectorOf(el) });
    }
  }

  // --- R-spacing-grid --------------------------------------------------------------
  const onGrid = (v: number) => {
    if (v < 0.5) return true;
    const near = (x: number) => Math.abs(x - Math.round(x)) < 0.05;
    if (near(v / 4)) return true;
    return o.spaceTokens.some((t) => Math.abs(t - v) < 0.05);
  };
  for (const el of shown) {
    if (el.tagName.toLowerCase() === "svg") continue;
    const s = cs(el);
    if (s.display === "inline" || s.display === "contents") continue;
    const sides: Array<[string, number, number]> = [
      ["padding-top", px(s.paddingTop), px(s.borderTopWidth)],
      ["padding-right", px(s.paddingRight), px(s.borderRightWidth)],
      ["padding-bottom", px(s.paddingBottom), px(s.borderBottomWidth)],
      ["padding-left", px(s.paddingLeft), px(s.borderLeftWidth)],
    ];
    const bad: string[] = [];
    for (const [prop, v, border] of sides) if (v > 0 && !onGrid(v) && !onGrid(v + border)) bad.push(`${prop} ${r1(v)}px`);
    if (/flex|grid/.test(s.display)) {
      const rg = px(s.rowGap);
      const cg = px(s.columnGap);
      // One value for both axes is the `gap` shorthand: name it so, since a one-row flex has no row gap to see.
      if (rg > 0 && rg === cg && !onGrid(rg)) bad.push(`gap ${r1(rg)}px`);
      else {
        if (rg > 0 && !onGrid(rg)) bad.push(`row-gap ${r1(rg)}px`);
        if (cg > 0 && !onGrid(cg)) bad.push(`column-gap ${r1(cg)}px`);
      }
    }
    if (!bad.length) continue;
    push({
      check: "R-spacing-grid",
      severity: "warn",
      selector: selectorOf(el),
      box: boxOf(rectOf(el)),
      measured: [...new Set(bad)].join(", "),
      expected: "multiples of 4px (or the 2px/6px space tokens)",
      key: `${signature(el)}|${bad.join(",")}`,
    });
  }

  // --- R-concentric-radius ------------------------------------------------------------
  for (const parent of shown) {
    const ps = cs(parent);
    const rp = px(ps.borderTopLeftRadius);
    if (!rp || /%/.test(ps.borderTopLeftRadius)) continue;
    const pr = rectOf(parent);
    if (rp >= Math.min(pr.width, pr.height) / 2 - 1) continue; // pill
    if (!hasChrome(parent)) continue;
    const kids = [...parent.querySelectorAll(":scope > *, :scope > * > *")].slice(0, 30);
    for (const kid of kids) {
      const ks = cs(kid);
      const rc = px(ks.borderTopLeftRadius);
      if (!rc || /%/.test(ks.borderTopLeftRadius)) continue;
      if (Math.max(rp, rc) < 4) continue;
      // Both on the design system's base radius: the DS has one radius, nesting it is by design.
      const onBase = (v: number) => (o.baseRadii ?? []).some((b) => Math.abs(b - v) < 0.26);
      if (onBase(rp) && onBase(rc)) continue;
      const kr = rectOf(kid);
      if (rc >= Math.min(kr.width, kr.height) / 2 - 1) continue;
      if (!inView(kr) || !hasChrome(kid)) continue;
      const dx = kr.left - pr.left - px(ps.borderLeftWidth);
      const dy = kr.top - pr.top - px(ps.borderTopWidth);
      if (dx < 0.5 || dx > 24 || Math.abs(dx - dy) > 1) continue;
      const inner = rp - px(ps.borderLeftWidth);
      const expected = rc + dx;
      if (Math.abs(inner - expected) > Math.max(2, expected * 0.25)) {
        push({
          check: "R-concentric-radius",
          severity: "warn",
          selector: selectorOf(parent),
          box: boxOf(pr),
          other: { selector: selectorOf(kid), box: boxOf(kr) },
          measured: `outer radius ${r1(rp)}px, inner ${r1(rc)}px inset ${r1(dx)}px`,
          expected: `outer = inner + inset = ${r1(expected + px(ps.borderLeftWidth))}px`,
          key: `${signature(parent)}|${signature(kid)}`,
        });
        break;
      }
    }
  }

  // --- R-control-height ------------------------------------------------------------
  const controls = shown.filter((el) => {
    if (!el.matches('button, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), select, [role="button"], [role="combobox"], a[href]')) return false;
    const r = rectOf(el);
    if (r.height < 16 || r.height > 64 || srOnly(r)) return false;
    if (el.matches("a[href]") && cs(el).display === "inline") return false;
    // A link that spans a row (a list row with a hover fill) is a row, not a control.
    if (el.matches("a[href]") && r.width > 12 * r.height) return false;
    return hasChrome(el) && unclipped(el, r);
  });
  const lca = (a: Element, b: Element) => {
    const up = new Set<Element>();
    for (let x: Element | null = a, d = 0; x && d < 4; x = x.parentElement, d++) up.add(x);
    for (let x: Element | null = b, d = 0; x && d < 4; x = x.parentElement, d++) if (up.has(x)) return x;
    return null;
  };
  for (let i = 0; i < controls.length; i++) {
    for (let j = 0; j < controls.length; j++) {
      if (i === j) continue;
      const a = controls[i]!;
      const b = controls[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const ra = rectOf(a);
      const rb = rectOf(b);
      const gap = rb.left - ra.right;
      if (gap < 0 || gap > 16) continue;
      const overlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlap < Math.min(ra.height, rb.height) * 0.5) continue;
      if (!lca(a, b)) continue;
      const dh = Math.abs(ra.height - rb.height);
      if (dh < 1) continue;
      push({
        check: "R-control-height",
        severity: "fail",
        selector: selectorOf(a),
        box: boxOf(ra),
        other: { selector: selectorOf(b), box: boxOf(rb) },
        measured: `${r1(ra.height)}px next to ${r1(rb.height)}px`,
        expected: "controls in one row share a height",
        guides: { axis: "y", a: r1(ra.bottom), b: r1(rb.bottom) },
        key: `${signature(a)}|${signature(b)}`,
      });
    }
  }

  // --- R-align-near-miss --------------------------------------------------------------
  const atoms: Atom[] = [];
  for (const { el, rects } of textEls) {
    const s = cs(el);
    if (s.display === "inline" || s.display === "contents") continue;
    if (el.closest('[contenteditable="true"]') && !el.matches("p, li, h1, h2, h3, h4, h5, h6, blockquote")) continue;
    const first = rects[0]!;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    atoms.push({ el, kind: "text", r: first, left, right, top, bottom, cy: first.top + first.height / 2, lineH: px(s.lineHeight) || first.height });
  }
  for (const el of shown) {
    const tag = el.tagName.toLowerCase();
    const replaced = tag === "svg" || tag === "img" || tag === "input" || tag === "select" || tag === "textarea" || tag === "video" || tag === "canvas";
    const r = rectOf(el);
    if (r.width < 6 || r.height < 6 || r.width > vw * 0.6 || r.height > vh * 0.6) continue;
    if (!replaced && !hasChrome(el)) continue;
    // Inline boxes (a code chip in running text) sit on the baseline by design.
    if (!replaced && cs(el).display === "inline") continue;
    if (!unclipped(el, r)) continue;
    atoms.push({ el, kind: "box", r, left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: r.top + r.height / 2, lineH: r.height });
  }
  stats.atoms = atoms.length;
  const related = (a: Element, b: Element, depth = 6) => {
    if (a.contains(b) || b.contains(a)) return false;
    const up: Element[] = [];
    for (let x: Element | null = a, d = 0; x && d < depth; x = x.parentElement, d++) up.push(x);
    for (let x: Element | null = b, d = 0; x && d < depth; x = x.parentElement, d++) {
      if (up.includes(x)) return x !== document.body && x !== document.documentElement && !x.matches(".ds-shell, #root, #app");
    }
    return false;
  };
  const inside = (a: Atom, b: Atom) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  const nearMiss = (d: number) => {
    const ad = Math.abs(d);
    return ad >= 1 && ad <= 3;
  };
  /** The nearest ancestor (within 3) that draws a box: a text's chip, button or card. */
  const chromeBox = (el: Element): DOMRect | null => {
    for (let x: Element | null = el, d = 0; x && d < 4; x = x.parentElement, d++) if (hasChrome(x)) return rectOf(x);
    return null;
  };
  /** Two column neighbors that line up some other way: right edges (right-aligned), centers, or their boxes. */
  const alignedOtherwise = (a: Atom, b: Atom) => {
    if (Math.abs(a.right - b.right) < 0.5) return true;
    if (Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 0.5) return true;
    if (a.kind === "text" && b.kind === "text") {
      // Text inside a chip or button lines up through its box, not its glyphs: compare texts only when
      // both are bare, or both sit in the same box. Boxes that miss are the box-box rule's to report.
      const ca = chromeBox(a.el);
      const cb = chromeBox(b.el);
      if ((ca || cb) && ca !== cb) return true;
    }
    return false;
  };
  const describe = (a: Atom) => (a.kind === "text" ? `"${textSnippet(a.el).slice(0, 24)}"` : a.el.tagName.toLowerCase());
  for (const a of atoms) {
    // Column: the nearest atom below, starting within 3px of a's left edge.
    let best: Atom | null = null;
    let bestGap = Infinity;
    for (const b of atoms) {
      if (b === a || b.el === a.el || b.kind !== a.kind) continue;
      const gap = b.top - a.bottom;
      if (gap < -0.5 || gap > 40) continue;
      if (Math.abs(b.left - a.left) > 3.05) continue;
      if (inside(a, b) || inside(b, a)) continue;
      if (gap < bestGap) {
        best = b;
        bestGap = gap;
      }
    }
    if (best && related(a.el, best.el, a.kind === "box" ? 5 : 6) && !alignedOtherwise(a, best)) {
      const dx = best.left - a.left;
      if (nearMiss(Math.round(dx * 10) / 10)) {
        const both = a.kind === "text" && best.kind === "text";
        push({
          check: "R-align-near-miss",
          severity: both ? "fail" : "warn",
          selector: selectorOf(a.el),
          box: boxOf({ left: a.left, top: a.top, width: a.right - a.left, height: a.bottom - a.top }),
          other: { selector: selectorOf(best.el), box: boxOf({ left: best.left, top: best.top, width: best.right - best.left, height: best.bottom - best.top }) },
          measured: `left edges ${r1(a.left)}px vs ${r1(best.left)}px (${dx > 0 ? "+" : ""}${r1(dx)}px): ${describe(a)} above ${describe(best)}`,
          expected: "the same left edge (0px), or a deliberate offset of 4px or more",
          guides: { axis: "x", a: r1(a.left), b: r1(best.left) },
          key: `col|${signature(a.el)}|${signature(best.el)}`,
        });
      }
    }
    // Right edges, for right-aligned text in a column.
    if (a.kind === "text" && /right|end/.test(cs(a.el).textAlign)) {
      for (const b of atoms) {
        if (b === a || b.kind !== "text" || !/right|end/.test(cs(b.el).textAlign)) continue;
        const gap = b.top - a.bottom;
        if (gap < -0.5 || gap > 40) continue;
        const dx = b.right - a.right;
        if (!nearMiss(Math.round(dx * 10) / 10) || !related(a.el, b.el)) continue;
        push({
          check: "R-align-near-miss",
          severity: "warn",
          selector: selectorOf(a.el),
          box: boxOf({ left: a.left, top: a.top, width: a.right - a.left, height: a.bottom - a.top }),
          other: { selector: selectorOf(b.el), box: boxOf({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }) },
          measured: `right edges ${r1(a.right)}px vs ${r1(b.right)}px (${r1(dx)}px)`,
          expected: "the same right edge",
          guides: { axis: "x", a: r1(a.right), b: r1(b.right) },
          key: `right|${signature(a.el)}|${signature(b.el)}`,
        });
        break;
      }
    }
    // Row: the nearest atom to the right, overlapping vertically.
    let row: Atom | null = null;
    let rowGap = Infinity;
    for (const b of atoms) {
      if (b === a || b.el === a.el) continue;
      const gap = b.left - a.right;
      if (gap < -0.5 || gap > 24) continue;
      const ah = a.kind === "text" ? a.r.height : a.bottom - a.top;
      const bh = b.kind === "text" ? b.r.height : b.bottom - b.top;
      if (ah > 64 || bh > 64) continue;
      const at = a.kind === "text" ? a.r.top : a.top;
      const bt = b.kind === "text" ? b.r.top : b.top;
      const overlap = Math.min(at + ah, bt + bh) - Math.max(at, bt);
      if (overlap < Math.min(ah, bh) * 0.6) continue;
      if (gap < rowGap) {
        row = b;
        rowGap = gap;
      }
    }
    if (row && related(a.el, row.el)) {
      // Text next to text aligns by baseline: only judge centers when one side is a box (icon, chip, input).
      const mixed = a.kind !== row.kind || (a.kind === "box" && row.kind === "box");
      const dy = row.cy - a.cy;
      if (mixed && nearMiss(Math.round(dy * 10) / 10)) {
        push({
          check: "R-align-near-miss",
          severity: "warn",
          selector: selectorOf(a.el),
          box: boxOf(a.kind === "text" ? a.r : { left: a.left, top: a.top, width: a.right - a.left, height: a.bottom - a.top }),
          other: { selector: selectorOf(row.el), box: boxOf(row.kind === "text" ? row.r : { left: row.left, top: row.top, width: row.right - row.left, height: row.bottom - row.top }) },
          measured: `vertical centers ${r1(a.cy)}px vs ${r1(row.cy)}px (${dy > 0 ? "+" : ""}${r1(dy)}px): ${describe(a)} beside ${describe(row)}`,
          expected: "centers within 1px",
          guides: { axis: "y", a: r1(a.cy), b: r1(row.cy) },
          key: `row|${signature(a.el)}|${signature(row.el)}`,
        });
      }
    }
  }

  // Handles: a grip's visible center against the first text line of the row it moves.
  const handleSel = [
    ...o.handles,
    '[draggable="true"]',
    "[data-drag-handle]",
    '[aria-label*="drag" i]',
    '[aria-label*="reorder" i]',
    '[class*="drag-handle"]',
    '[class*="grip"]',
  ].join(", ");
  const handles = shown.filter((el) => {
    try {
      return el.matches(handleSel) && !el.parentElement?.closest(handleSel);
    } catch {
      return false;
    }
  });
  stats.handles = handles.length;
  const caretAt = (x: number, y: number): { node: Node; offset: number } | null => {
    const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  };
  for (const h of handles) {
    const hr = rectOf(h);
    // The visible mark inside the handle (its svg), else the handle's box.
    const mark = h.querySelector("svg") ?? h;
    const mr = mark.getBoundingClientRect();
    const hcy = mr.top + mr.height / 2;
    let line: DOMRect | null = null;
    let lineEl: Element | null = null;
    for (let x = hr.right + 4; x < Math.min(vw, hr.right + 320); x += 6) {
      const hit = caretAt(x, hcy);
      if (!hit || hit.node.nodeType !== 3 || !(hit.node.textContent ?? "").trim()) continue;
      const host = hit.node.parentElement;
      if (!host || h.contains(host)) continue;
      // The first line of that block: the first glyph of its first text node.
      const block = host.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, [data-node-view-wrapper], div") ?? host;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.textContent ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
      const firstText = walker.nextNode() as Text | null;
      if (!firstText) continue;
      const start = (firstText.textContent ?? "").search(/\S/);
      range.setStart(firstText, start);
      range.setEnd(firstText, start + 1);
      const gr = range.getBoundingClientRect();
      if (!gr.height) continue;
      line = gr;
      lineEl = block;
      break;
    }
    if (!line || !lineEl) continue;
    const lcy = line.top + line.height / 2;
    const dy = hcy - lcy;
    const lh = px(cs(lineEl).lineHeight) || line.height;
    const ad = Math.abs(Math.round(dy * 10) / 10);
    if (ad >= 1 && ad <= lh / 2) {
      push({
        check: "R-align-near-miss",
        severity: "fail",
        selector: selectorOf(h),
        box: boxOf(mr),
        other: { selector: selectorOf(lineEl), box: boxOf(line) },
        measured: `handle center ${r1(hcy)}px vs first text line center ${r1(lcy)}px (${dy > 0 ? "+" : ""}${r1(dy)}px) "${textSnippet(lineEl).slice(0, 24)}"`,
        expected: "the handle centered on its row's first line (within 1px)",
        guides: { axis: "y", a: r1(hcy), b: r1(lcy) },
        key: `handle|${signature(h)}`,
      });
    }
  }

  return { findings, stats };
}

/** Keeps up to `max` visible controls (one per class signature) in window.__dsProbe for the motion pass. Returns n. */
export function markMotionCandidates(o: { max: number; ignore: string[] }): number {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const picked: Element[] = [];
  (window as unknown as { __dsProbe?: Element[] }).__dsProbe = picked;
  const sel = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], summary, input[type="checkbox"], input[type="radio"], [role="switch"]';
  let n = 0;
  const seen = new Set<string>();
  for (const el of document.querySelectorAll(sel)) {
    if (n >= o.max) break;
    if (o.ignore.some((s) => el.closest(s))) continue;
    if (el.parentElement?.closest(sel)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
    if (anyEl.checkVisibility && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    // One of each kind of control: rows repeat the same classes.
    const sig = el.tagName + "." + [...el.classList].slice(0, 3).join(".");
    if (seen.has(sig)) continue;
    seen.add(sig);
    picked.push(el);
    n++;
  }
  return n;
}
