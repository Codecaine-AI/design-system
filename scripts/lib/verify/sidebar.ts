/**
 * Shell apps: the sidebar state survives a reload (guide/layout.md, "Persistence").
 */
import { type Assertion, fail, na, pass } from "./assertions";

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

/** The two states guide/layout.md gives data-sidebar (and the stored value). */
export const SIDEBAR_STATES = ["expanded", "collapsed"] as const;
const valid = (value: string | null): value is (typeof SIDEBAR_STATES)[number] => (SIDEBAR_STATES as readonly (string | null)[]).includes(value);

/**
 * Shell apps: the sidebar toggle moves data-sidebar from one valid state (expanded, collapsed) to the
 * other, stores the new state under the app's key, and both survive a reload. An invalid or missing
 * state fails before anything is compared, so "undefined" stored and restored is never a pass.
 */
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
  if (!valid(before.dataSidebar)) return [fail(id, `.ds-shell has data-sidebar=${before.dataSidebar}; it must be expanded or collapsed`, { before })];
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
  const expected = before.dataSidebar === "expanded" ? "collapsed" : "expanded";
  if (toggled.dataSidebar !== expected) {
    return [fail(id, `clicking ${opts.toggle} moved data-sidebar from ${before.dataSidebar} to ${toggled.dataSidebar}, not ${expected}`, { before, toggled })];
  }
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
