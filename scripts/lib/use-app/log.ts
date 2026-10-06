/**
 * The `use:app` log: what it visits, what it records per visit, and when the run fails.
 *
 *   visitPlan(app)            every registry route in each theme it is checked in (capture's routeThemes), route by route
 *   stampOf(iso)              the ISO time with ':' written as '-' (it names the log and the screenshot dir)
 *   shotName(...)             <route>-<theme>-<n>-<label>.png
 *   judge(visits, isolation)  the totals, the problems and ok (the exit code)
 */
import { routeThemes } from "../capture";
import type { AppEntry, RouteSpec } from "../registry";
import { safeSegment } from "../safe-paths";

export type Theme = "light" | "dark";

export interface Action {
  kind: "goto" | "step" | "sidebar-toggle" | "hover" | "screenshot";
  /** What it acted on: a URL, a step ("click <selector>"), an element name or a file. */
  target: string;
  ok: boolean;
  error?: string;
  /** Why the safety rules refused it (lib/use-app/safety.ts); a refused step never runs. */
  refused?: string;
  /** Why it was not attempted (no sidebar toggle on the page); not a failure. */
  skipped?: string;
}

/** One route in one theme. */
export interface Visit {
  route: string;
  theme: Theme;
  url: string;
  /** How the theme was reached: default, attribute, storage, click, steps, query or prefers-color-scheme. */
  themeMethod: string;
  actions: Action[];
  screenshots: string[];
  consoleErrors: string[];
  /** Requests that failed (not blocked, not aborted by the page) and responses with status >= 400. */
  failedRequests: string[];
  /** Responses >= 400 the registry's verify.expectedFailures covers, with the reason: reported, not failures. Only on an entry that names some. */
  expectedFailedRequests?: string[];
  /** Requests the guard blocked that the app should not make. */
  blocked: string[];
  /** Blocked requests to the profile's own named ports the run never bound: reported, not failures. */
  expectedBlocked: string[];
}

export interface Isolation {
  violations: string[];
  unproven: boolean;
  unsandboxed: boolean;
}

export interface Totals {
  visits: number;
  screenshots: number;
  hovers: number;
  /** Hovers that did not happen (covered, detached): reported, not failures. */
  hoverErrors: number;
  refused: number;
  /** goto, step, sidebar-toggle and screenshot actions that failed. */
  failedActions: number;
  consoleErrors: number;
  failedRequests: number;
  /** Only when a visit has the list (the entry names verify.expectedFailures). */
  expectedFailedRequests?: number;
  blocked: number;
  expectedBlocked: number;
  violations: number;
}

/** Every registry route in each theme it is checked in (light then dark; dark only on a dark-first surface). */
export function visitPlan(app: AppEntry): Array<{ route: RouteSpec; theme: Theme }> {
  return (app.routes ?? []).flatMap((route) => routeThemes(app, route).map((theme) => ({ route, theme })));
}

/** The ISO time with ':' written as '-': a safe path segment. The log keeps the ISO form. */
export function stampOf(iso: string): string {
  return safeSegment(iso.replace(/:/g, "-"), "timestamp");
}

/** `<route>-<theme>-<n>-<label>.png`; refuses a name that is not one safe path segment. */
export function shotName(route: string, theme: Theme, n: number, label: string): string {
  return safeSegment(`${route}-${theme}-${n}-${label}.png`, "screenshot name");
}

/** The totals, one line per problem, and ok: no problem at all. Hover errors, expected blocks and expected failed requests are not problems. */
export function judge(visits: Visit[], isolation: Isolation, errors: Array<string | undefined> = []): { totals: Totals; problems: string[]; ok: boolean } {
  const actions = visits.flatMap((visit) => visit.actions.map((action) => ({ visit, action })));
  const hovers = actions.filter(({ action }) => action.kind === "hover");
  const failed = actions.filter(({ action }) => action.kind !== "hover" && !action.ok && !action.refused);
  const refused = actions.filter(({ action }) => action.refused);
  const sum = (pick: (visit: Visit) => string[]) => visits.reduce((n, visit) => n + pick(visit).length, 0);
  const totals: Totals = {
    visits: visits.length,
    screenshots: sum((visit) => visit.screenshots),
    hovers: hovers.filter(({ action }) => action.ok).length,
    hoverErrors: hovers.filter(({ action }) => !action.ok).length,
    refused: refused.length,
    failedActions: failed.length,
    consoleErrors: sum((visit) => visit.consoleErrors),
    failedRequests: sum((visit) => visit.failedRequests),
    ...(visits.some((visit) => visit.expectedFailedRequests) ? { expectedFailedRequests: sum((visit) => visit.expectedFailedRequests ?? []) } : {}),
    blocked: sum((visit) => visit.blocked),
    expectedBlocked: sum((visit) => visit.expectedBlocked),
    violations: isolation.violations.length,
  };
  const where = (visit: Visit) => `${visit.route} (${visit.theme})`;
  const problems = [
    ...errors.filter((error): error is string => Boolean(error)),
    ...refused.map(({ visit, action }) => `${where(visit)}: refused ${action.target}: ${action.refused}`),
    ...failed.map(({ visit, action }) => `${where(visit)}: ${action.kind} ${action.target} failed: ${action.error}`),
    ...visits.flatMap((visit) => visit.consoleErrors.map((error) => `${where(visit)}: console error: ${error}`)),
    ...visits.flatMap((visit) => visit.failedRequests.map((request) => `${where(visit)}: failed request: ${request}`)),
    ...visits.flatMap((visit) => visit.blocked.map((request) => `${where(visit)}: blocked request: ${request}`)),
    ...isolation.violations.map((violation) => `isolation: ${violation}`),
    ...(isolation.unproven ? ["isolation: the run profile is unproven"] : []),
    ...(isolation.unsandboxed ? ["isolation: the run had no OS sandbox"] : []),
  ];
  return { totals, problems, ok: problems.length === 0 };
}

/** A checkout's state as git reports it: HEAD and `git status --porcelain` lines (null when git could not read it). */
export interface RepoState {
  dir: string;
  head: string | null;
  status: string[] | null;
}

/**
 * Why the run changed the app's checkout, or null: HEAD moved, or `git status` gained or lost a line
 * between before the start and after stop(). use:app only views; any change fails the run. A checkout git
 * could not read before and after is not compared.
 */
export function checkoutChange(before: RepoState, after: RepoState): string | null {
  if (before.status === null || after.status === null) {
    return before.status === after.status ? null : `git could not read ${before.dir} ${before.status === null ? "before the run" : "after the run"}`;
  }
  const gained = after.status.filter((line) => !before.status!.includes(line));
  const lost = before.status.filter((line) => !after.status!.includes(line));
  const parts = [
    ...(before.head !== after.head ? [`HEAD ${before.head ?? "none"} -> ${after.head ?? "none"}`] : []),
    ...gained.slice(0, 5).map((line) => `now ${JSON.stringify(line)}`),
    ...lost.slice(0, 5).map((line) => `no longer ${JSON.stringify(line)}`),
  ];
  const more = gained.length + lost.length > 10 ? `, and ${gained.length + lost.length - 10} more` : "";
  return parts.length ? `the app's checkout changed during the run (${before.dir}): ${parts.join(", ")}${more}` : null;
}
