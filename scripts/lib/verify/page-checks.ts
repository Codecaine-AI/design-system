/**
 * Runtime assertions on a loaded page: token probes, the dark switch, web fonts and sidebar persistence.
 *
 * Everything here takes a Playwright Page that already shows the verify route; starting the app and
 * guarding its requests is the runner's job (scripts/lib/app-runner.ts).
 */
import { runSteps } from "../capture";
import type { AppEntry, PassId, VerifySpec } from "../registry";
import { type Assertion, fail, pass, type ResponseLog } from "./assertions";
import { fontAssertions, readFonts } from "./fonts";
import { checkSidebar } from "./sidebar";
import { type BuildValues, buildValue, sameComputedValue, type Theme, tokenCssVar } from "./tokens";

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
    case "steps":
      await runSteps(page, darkSwitch.steps);
      return false;
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
    // Probes whose token differs between the themes; the switch may apply asynchronously (a saved setting, a re-render).
    const watch = firstReadings
      .filter((r) => r.found && r.buildValue !== buildValue(opts.values, r.token, "dark"))
      .map((r) => ({ selector: r.selector, property: r.property, before: r.actual! }));
    const reloaded = await switchToDark(page, verify.darkSwitch);
    if (reloaded && opts.prepare) await opts.prepare(page);
    if (watch.length) {
      await page
        .waitForFunction(
          (items: typeof watch) =>
            items.some((item) => {
              const element = document.querySelector(item.selector);
              return element !== null && getComputedStyle(element).getPropertyValue(item.property).trim() !== item.before;
            }),
          watch,
          { timeout: 3_000 },
        )
        .catch(() => undefined); // nothing changed: the dark assertions report it
    }
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
