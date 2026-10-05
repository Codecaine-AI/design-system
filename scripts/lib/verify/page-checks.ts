/**
 * Runtime assertions on a loaded page: token probes, the dark switch, web fonts and sidebar persistence.
 *
 * Everything here takes a Playwright Page that already shows the verify route; starting the app and
 * guarding its requests is the runner's job (scripts/lib/app-runner.ts).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppEntry, PassId, VerifySpec } from "../registry";
import { type BuildValues, buildValue, sameComputedValue, type Theme, tokenCssVar } from "./tokens";

export type Status = "pass" | "fail" | "n/a";

export interface Assertion {
  id: string;
  status: Status;
  message: string;
  detail?: Record<string, unknown>;
}

export const pass = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "pass", message, detail });
export const fail = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "fail", message, detail });
export const na = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "n/a", message, detail });

/** Responses the page received: URL → HTTP status. Filled by `trackResponses`. */
export type ResponseLog = Map<string, number>;

export function trackResponses(page: any): ResponseLog {
  const log: ResponseLog = new Map();
  page.on("response", (response: any) => log.set(response.url(), response.status()));
  page.on("requestfailed", (request: any) => {
    if (!log.has(request.url())) log.set(request.url(), 0);
  });
  return log;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fonts settled and two frames painted; styles are final (the context disables transitions). */
export async function settle(page: any): Promise<void> {
  await page
    .evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    })
    .catch(() => undefined);
  await sleep(150);
}

// -- token probes ---------------------------------------------------------------

export interface ProbeReading {
  selector: string;
  property: string;
  token: string;
  cssVar: string;
  found: boolean;
  /** The element's computed value. */
  actual?: string;
  /** The build's value, computed by a probe element in the element's scope. */
  build?: string;
  buildValue?: string;
  /** var(--ds-<token>) computed by a probe element in the element's scope; what the app's tokens.css says. */
  tokenVar?: string;
  tokenDefined?: boolean;
}

/**
 * Reads each probe in the browser. Both expected sides are computed by hidden probe elements placed
 * in the element's scope (inside it, or in its nearest HTML parent for void and SVG elements), so
 * aliases, `color-mix()` and inherited theme scopes resolve the way they do for the element.
 */
export async function readProbes(page: any, probes: VerifySpec["probes"], values: BuildValues, theme: Theme): Promise<ProbeReading[]> {
  const input = probes.map((probe) => ({ ...probe, cssVar: tokenCssVar(probe.token), buildValue: buildValue(values, probe.token, theme) }));
  return page.evaluate((items: Array<VerifySpec["probes"][number] & { cssVar: string; buildValue: string }>) => {
    const VOID = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "SOURCE", "TRACK", "WBR", "TEXTAREA", "SELECT", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "OBJECT", "SCRIPT", "STYLE"]);
    return items.map((item) => {
      const base = { selector: item.selector, property: item.property, token: item.token, cssVar: item.cssVar, buildValue: item.buildValue };
      const element = document.querySelector(item.selector);
      if (!element) return { ...base, found: false };
      let host: Element | null = element;
      while (host && (!(host instanceof HTMLElement) || VOID.has(host.tagName))) host = host.parentElement;
      host ??= document.documentElement;
      const compute = (value: string) => {
        const probe = document.createElement("div");
        probe.style.setProperty("display", "none", "important");
        probe.style.setProperty(item.property, value);
        host!.appendChild(probe);
        const computed = getComputedStyle(probe).getPropertyValue(item.property).trim();
        probe.remove();
        return computed;
      };
      return {
        ...base,
        found: true,
        actual: getComputedStyle(element).getPropertyValue(item.property).trim(),
        build: compute(item.buildValue),
        tokenVar: compute(`var(${item.cssVar})`),
        tokenDefined: getComputedStyle(element).getPropertyValue(item.cssVar).trim() !== "",
      };
    });
  }, input);
}

/** One assertion per probe: the element computes to the build's value, through a defined, current token. */
export function probeAssertions(readings: ProbeReading[], theme: Theme, label: string = theme): Assertion[] {
  return readings.map((r) => {
    const id = `token.${label}: ${r.selector} ${r.property}`;
    const detail = { ...r, theme };
    if (!r.found) return fail(id, `${r.selector} is not on the page`, detail);
    if (!sameComputedValue(r.actual!, r.build!)) {
      return fail(id, `computes to ${r.actual}; the build's ${r.token} (${theme}) is ${r.build}`, detail);
    }
    if (!r.tokenDefined) return fail(id, `matches, but ${r.cssVar} is not defined there: the value does not come from tokens.css`, detail);
    if (!sameComputedValue(r.tokenVar!, r.build!)) {
      return fail(id, `${r.cssVar} computes to ${r.tokenVar}, the build's ${r.token} (${theme}) is ${r.build}: a stale tokens.css`, detail);
    }
    return pass(id, `${r.actual} = ${r.token} (${theme})`, detail);
  });
}

// -- theme ------------------------------------------------------------------------

/** Applies the registry's dark switch. Returns true when it reloaded or navigated the page. */
export async function switchToDark(page: any, darkSwitch: VerifySpec["darkSwitch"]): Promise<boolean> {
  switch (darkSwitch.kind) {
    case "attribute":
      await page.evaluate((target: string | null) => {
        const element = target ? document.querySelector(target) : document.documentElement;
        if (!element) throw new Error(`dark switch target ${target} is not on the page`);
        element.setAttribute("data-theme", "dark");
      }, darkSwitch.target ?? null);
      return false;
    case "storage":
      await page.evaluate(([key, value]: [string, string]) => localStorage.setItem(key, value), [darkSwitch.key, darkSwitch.value]);
      await page.reload({ waitUntil: "load", timeout: 60_000 });
      return true;
    case "click":
      await page.locator(darkSwitch.selector).first().click({ timeout: 15_000 });
      return false;
    case "query": {
      const url = new URL(page.url());
      url.searchParams.set(darkSwitch.param, darkSwitch.value);
      await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });
      return true;
    }
  }
}

/** The theme markers on <html> and <body>, for the report. */
export async function themeMarkers(page: any): Promise<Record<string, string | null>> {
  return page.evaluate(() => ({
    htmlDataTheme: document.documentElement.getAttribute("data-theme"),
    htmlClass: document.documentElement.getAttribute("class"),
    bodyDataTheme: document.body?.getAttribute("data-theme") ?? null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));
}

// -- fonts ------------------------------------------------------------------------

export const FONT_FAMILIES = ["Inter", "IBM Plex Mono"] as const;

export interface FontReading {
  family: string;
  faces: Array<{ weight: string; style: string; status: string }>;
  /** @font-face rules for the family: their src, the resolved url()s, and whether a local() source is listed. */
  rules: Array<{ src: string; urls: string[]; local: boolean }>;
  /** Stylesheets whose rules the page could not read (cross-origin). */
  unreadableSheets: number;
}

/** Asks the page to load each family at 400, then lists its faces and the @font-face rules that declare them. */
export async function readFonts(page: any, families: readonly string[] = FONT_FAMILIES): Promise<FontReading[]> {
  return page.evaluate(async (names: string[]) => {
    const clean = (family: string) => family.replace(/["']/g, "").trim();
    await Promise.all(names.map((name) => document.fonts.load(`400 16px "${name}"`).catch(() => undefined)));
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    const rules: Array<{ family: string; src: string; base: string }> = [];
    let unreadableSheets = 0;
    const walk = (list: CSSRuleList, base: string) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSFontFaceRule) {
          rules.push({ family: clean(rule.style.getPropertyValue("font-family")), src: rule.style.getPropertyValue("src"), base });
        } else if (rule instanceof CSSImportRule) {
          try {
            if (rule.styleSheet) walk(rule.styleSheet.cssRules, rule.styleSheet.href ?? base);
          } catch {
            unreadableSheets += 1;
          }
        } else if ("cssRules" in rule) {
          walk((rule as CSSGroupingRule).cssRules, base);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules, sheet.href ?? document.baseURI);
      } catch {
        unreadableSheets += 1;
      }
    }
    return names.map((family) => ({
      family,
      faces: Array.from(document.fonts)
        .filter((face) => clean(face.family) === family)
        .map((face) => ({ weight: face.weight, style: face.style, status: face.status })),
      rules: rules
        .filter((rule) => rule.family === family)
        .map((rule) => ({
          src: rule.src,
          urls: [...rule.src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => {
            try {
              return new URL(m[2], rule.base).href;
            } catch {
              return m[2];
            }
          }),
          local: /local\(/.test(rule.src),
        })),
      unreadableSheets,
    }));
  }, [...families]);
}

function fetched(url: string, responses: ResponseLog): boolean {
  if (url.startsWith("data:")) return true;
  if (url.startsWith("file:")) return existsSync(fileURLToPath(url));
  const status = responses.get(url);
  return status !== undefined && ((status >= 200 && status < 300) || status === 304);
}

/** Each family is a web font the page loaded over the run's server: a loaded face whose @font-face url() was fetched. */
export function fontAssertions(readings: FontReading[], responses: ResponseLog): Assertion[] {
  return readings.map((r) => {
    const id = `font: ${r.family}`;
    const loaded = r.faces.filter((face) => face.status === "loaded");
    const urls = r.rules.flatMap((rule) => rule.urls);
    const got = urls.filter((url) => fetched(url, responses));
    const detail = { ...r, fetched: got };
    if (r.faces.length === 0) return fail(id, `no @font-face for ${r.family}: text renders in a local or fallback font`, detail);
    if (loaded.length === 0) return fail(id, `${r.faces.length} face(s) declared, none loaded (${r.faces.map((f) => `${f.weight} ${f.status}`).join(", ")})`, detail);
    if (got.length > 0) return pass(id, `${loaded.length} face(s) loaded from ${got[0]}${got.length > 1 ? ` (+${got.length - 1})` : ""}`, detail);
    if (r.rules.length > 0 && urls.length === 0) return fail(id, `@font-face lists only local() sources: a local font, not the package's web font`, detail);
    if (r.rules.length === 0) {
      return fail(id, `faces are loaded but no readable @font-face declares ${r.family}${r.unreadableSheets ? ` (${r.unreadableSheets} stylesheet(s) unreadable)` : ""}`, detail);
    }
    return fail(id, `faces are loaded but none of their url()s was fetched (${urls.slice(0, 2).join(", ")}): a local() source won or the request failed`, detail);
  });
}

// -- sidebar ----------------------------------------------------------------------

export interface SidebarOptions {
  /** Toggle selector; default ".ds-sidebar-toggle". */
  toggle: string;
  /** localStorage key; default "<app>.sidebar". */
  storageKey: string;
  /** When .ds-shell does not render: required → fail, otherwise n/a with this reason. */
  required: boolean;
  naReason: string;
  /** Re-runs the route's waitFor and steps after the reload. */
  prepare?: (page: any) => Promise<void>;
}

/** Shell apps: the sidebar toggle changes data-sidebar, stores it under the app's key, and both survive a reload. */
export async function checkSidebar(page: any, opts: SidebarOptions): Promise<Assertion[]> {
  const id = "sidebar";
  const shell = page.locator(".ds-shell").first();
  if ((await page.locator(".ds-shell").count()) === 0) {
    return [opts.required ? fail(id, "no .ds-shell on the page: the app does not render the app shell") : na(id, opts.naReason)];
  }
  const readState = async () => ({
    dataSidebar: (await shell.getAttribute("data-sidebar")) as string | null,
    stored: (await page.evaluate((key: string) => localStorage.getItem(key), opts.storageKey)) as string | null,
  });
  const before = await readState();
  const toggle = page.locator(opts.toggle).first();
  if ((await page.locator(opts.toggle).count()) === 0) return [fail(id, `no sidebar toggle ${opts.toggle} on the page`, { before })];
  await toggle.click({ timeout: 15_000 });
  try {
    await page.waitForFunction((was: string | null) => document.querySelector(".ds-shell")?.getAttribute("data-sidebar") !== was, before.dataSidebar, {
      timeout: 5_000,
    });
  } catch {
    return [fail(id, `clicking ${opts.toggle} left data-sidebar at ${before.dataSidebar}`, { before })];
  }
  const toggled = await readState();
  await page.reload({ waitUntil: "load", timeout: 60_000 });
  await page.locator(".ds-shell").first().waitFor({ state: "attached", timeout: 30_000 });
  if (opts.prepare) await opts.prepare(page);
  const reloaded = await readState();
  const detail = { storageKey: opts.storageKey, before, toggled, reloaded };
  return [
    toggled.stored === toggled.dataSidebar
      ? pass(`${id}.stored`, `toggle stores ${opts.storageKey}=${toggled.stored}`, detail)
      : fail(`${id}.stored`, `after the toggle data-sidebar is ${toggled.dataSidebar} but ${opts.storageKey} is ${toggled.stored}`, detail),
    reloaded.dataSidebar === toggled.dataSidebar && reloaded.stored === toggled.dataSidebar
      ? pass(`${id}.reload`, `data-sidebar=${reloaded.dataSidebar} survives a reload`, detail)
      : fail(`${id}.reload`, `after a reload data-sidebar is ${reloaded.dataSidebar} (was ${toggled.dataSidebar}), ${opts.storageKey} is ${reloaded.stored}`, detail),
  ];
}

// -- one page, every check ----------------------------------------------------------

export interface PageCheckOptions {
  app: Pick<AppEntry, "id" | "shell" | "theme" | "verify">;
  values: BuildValues;
  responses: ResponseLog;
  /** --pass; undefined means every check (final acceptance). */
  pass?: PassId;
  /** The route's waitFor and steps; re-run after anything that reloads the page. */
  prepare?: (page: any) => Promise<void>;
}

/**
 * Every runtime assertion on a page that shows the verify route: token probes in the default theme,
 * web fonts, the dark switch (light-dark apps) and, for shell apps, sidebar persistence.
 */
export async function checkPage(page: any, opts: PageCheckOptions): Promise<Assertion[]> {
  const verify = opts.app.verify;
  if (!verify) return [fail("verify-spec", "apps.json has no verify spec (probes, darkSwitch) for this app")];
  const darkFirst = opts.app.theme.rule === "dark-first";
  const out: Assertion[] = [];
  await settle(page);

  const first: Theme = darkFirst ? "dark" : "light";
  const firstReadings = await readProbes(page, verify.probes, opts.values, first);
  out.push(...probeAssertions(firstReadings, first, darkFirst ? "dark (default)" : "light"));
  out.push(...fontAssertions(await readFonts(page), opts.responses));

  if (!darkFirst) {
    const reloaded = await switchToDark(page, verify.darkSwitch);
    if (reloaded && opts.prepare) await opts.prepare(page);
    await settle(page);
    const darkReadings = await readProbes(page, verify.probes, opts.values, "dark");
    const markers = await themeMarkers(page);
    out.push(...probeAssertions(darkReadings, "dark"));
    const shouldChange = firstReadings.filter((r, i) => r.found && darkReadings[i]?.found && !sameComputedValue(r.build!, darkReadings[i]!.build!));
    const changed = shouldChange.filter((r) => {
      const dark = darkReadings[firstReadings.indexOf(r)]!;
      return !sameComputedValue(r.actual!, dark.actual!);
    });
    out.push(
      shouldChange.length === 0 || changed.length > 0
        ? pass("theme.switch", `${verify.darkSwitch.kind} switch changed ${changed.length} of ${shouldChange.length} probe(s)`, { markers })
        : fail("theme.switch", `the ${verify.darkSwitch.kind} switch changed none of the ${shouldChange.length} probe(s) whose token differs in dark`, { markers }),
    );
  }

  const shellRequired = opts.app.shell && opts.pass !== "1";
  out.push(
    ...(await checkSidebar(page, {
      toggle: verify.sidebar?.toggle ?? ".ds-sidebar-toggle",
      storageKey: verify.sidebar?.storageKey ?? `${opts.app.id}.sidebar`,
      required: shellRequired,
      naReason: opts.app.shell ? "pass 1: the shell arrives in pass 2" : "not a shell app",
      prepare: opts.prepare,
    })),
  );
  return out;
}

// -- propagate ----------------------------------------------------------------------

/**
 * --propagate: the page background computes to the sentinel. Uses the app's color.surface.page probes,
 * else body background-color.
 */
export async function sentinelAssertions(page: any, app: Pick<AppEntry, "verify">, token: string, expected: string): Promise<Assertion[]> {
  await settle(page);
  const probes = app.verify?.probes.filter((probe) => probe.token === token) ?? [];
  const targets = probes.length ? probes : [{ selector: "body", property: "background-color", token }];
  const readings: Array<{ selector: string; property: string; actual: string | null }> = await page.evaluate(
    (items: Array<{ selector: string; property: string }>) =>
      items.map((item) => {
        const element = document.querySelector(item.selector);
        return { ...item, actual: element ? getComputedStyle(element).getPropertyValue(item.property).trim() : null };
      }),
    targets.map(({ selector, property }) => ({ selector, property })),
  );
  return readings.map((r) => {
    const id = `sentinel: ${r.selector} ${r.property}`;
    if (r.actual === null) return fail(id, `${r.selector} is not on the page`);
    return sameComputedValue(r.actual, expected)
      ? pass(id, `computes to the sentinel ${r.actual}`)
      : fail(id, `computes to ${r.actual}, not the sentinel ${expected}: the rebuilt ${token} did not reach the app`);
  });
}
