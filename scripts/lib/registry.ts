/**
 * App registry: the one description of every app the rollout migrates.
 *
 * `apps.json` at the package root holds the entries. Every tool (lint:apps,
 * verify:apps, snapshot, codemod, progress) reads it through this module, so
 * the types below are the contract between them. Add fields only as optional
 * fields, and give every exception a reason.
 *
 * Paths in apps.json are workspace-relative ("codecaine/core/sequence/..."):
 * resolve them against a root with `resolvePath(root, p)`. The root is the
 * workspace tree a tool checks: the rollout mirror (/Users/Ford/workspace-ds)
 * or, after merge, the owner's tree (/Users/Ford/workspace).
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { safeSegment, UnsafePathError } from "./safe-paths";

/** A check or gate that applies, or does not apply for a stated reason. */
export type Requirement = { required: true } | { required: false; reason: string };

export type CheckId = "resolution" | "wiring" | "literals" | "names" | "shell" | "structure";
export type PassId = "1" | "2" | "3";
export type GateId = "lint" | "verify" | "snapshot" | "pixelDiff" | "tests";

export type RunMode = "browser" | "electron" | "static" | "none";

/**
 * How the app consumes @codecaine-ai/design-system.
 * - workspace: bun workspace member with `workspace:*` (Core, or a repo whose root workspaces lists the package)
 * - link: `link:` dependency through a repo-local or global bun link registry
 * - npm-file: npm `file:` dependency on the package directory (a live symlink)
 * - vendor-tgz: `file:vendor/<name>.tgz` packed copy (deployed apps)
 * - host-css: a library that names --ds-* variables and relies on its host to load tokens.css
 * - relative-import: CSS `@import` of the package files by relative path
 * - copy: built CSS copied into the app (no package manager), checked by tokens.css hash
 */
export type ConsumeVia =
  | "workspace"
  | "link"
  | "npm-file"
  | "vendor-tgz"
  | "host-css"
  | "relative-import"
  | "copy";

export type ThemeRule = "light-dark" | "dark-first";

export interface ScanSpec {
  /** Workspace-relative files or directories, from the audit's "Reproduce the counts". */
  paths: string[];
  /** Passed to scan-literals as --exclude. */
  exclude: string[];
  /** Passed to scan-literals as --ext (for example "+md"). */
  ext?: string;
}

export interface RouteSpec {
  id: string;
  /** URL path (browser/static) or a named window/view (electron). */
  path: string;
  /** Themes to capture; defaults to the app's theme rule (light+dark, or dark only for dark-first). */
  themes?: Array<"light" | "dark">;
  viewport?: { width: number; height: number };
  /** CSS selector that must be visible before capture. */
  waitFor?: string;
  /**
   * Navigation/view-only steps to reach the state (click a tab, open a panel). Never submit, save, delete, sync or send.
   * `check` and `uncheck` set a checkbox or switch (an input, or an element with role checkbox or switch and
   * aria-checked) to that state, the way Playwright's setChecked does: a no-op when it is already there.
   */
  steps?: Array<{ action: StepAction; target?: string; value?: string | number }>;
  /**
   * Why this route's light visits skip verify.lightSteps: a page without the theme control (a playground
   * that draws both themes itself). Set only with verify.lightSteps.
   */
  skipLightSteps?: string;
  /** CSS selectors whose boxes are masked in diffs. */
  masks?: string[];
  /** false = captured but never fails a pixel gate. Requires a reason. */
  gating?: boolean;
  reason?: string;
  /**
   * true: the route looks different in dark. `snapshot:diff --exact` fails a gating route whose dark shot
   * in the judged set (B) is byte-identical to its light shot. Otherwise identical shots are only a warning.
   */
  darkDiffers?: boolean;
}

/** The actions a registry step may take (STEP_ACTIONS). */
export type StepAction = "click" | "press" | "hover" | "scroll" | "wait" | "check" | "uncheck";
export const STEP_ACTIONS: readonly StepAction[] = ["click", "press", "hover", "scroll", "wait", "check", "uncheck"];
/** Actions that act on one element and need its selector as `target`. */
const TARGET_ACTIONS: readonly StepAction[] = ["click", "hover", "check", "uncheck"];

/**
 * A step list's problems, one message each: an object per step, an action from STEP_ACTIONS, a string
 * `target` where the action needs one (click, hover, check, uncheck), a string or number `value`.
 */
export function stepsProblems(steps: unknown, where: string): string[] {
  if (!Array.isArray(steps)) return [`${where} must be an array of steps`];
  const problems: string[] = [];
  steps.forEach((step, i) => {
    const name = `${where}[${i}]`;
    if (step === null || typeof step !== "object" || Array.isArray(step)) return void problems.push(`${name} must be an object { action, target?, value? }`);
    const s = step as Record<string, unknown>;
    if (!(STEP_ACTIONS as readonly unknown[]).includes(s.action)) problems.push(`${name}.action ${JSON.stringify(s.action)} is not one of ${STEP_ACTIONS.join(", ")}`);
    else if (TARGET_ACTIONS.includes(s.action as StepAction) && (typeof s.target !== "string" || s.target.length === 0)) problems.push(`${name}: ${s.action} needs a target selector`);
    if (s.target !== undefined && typeof s.target !== "string") problems.push(`${name}.target must be a string`);
    if (s.value !== undefined && typeof s.value !== "string" && typeof s.value !== "number") problems.push(`${name}.value must be a string or a number`);
  });
  return problems;
}

/**
 * verify.expectedFailures: a failed request the app makes by design (a resource it probes for and
 * renders without), which use:app reports under expectedFailedRequests instead of failing the run. A
 * request matches when it goes to the app's own origin (the URL the runner read from the server output),
 * its method is `method`, it failed with `status`, and `urlPattern` (a regular expression anchored at
 * the start of the path with a literal first segment, no top-level "|", see patternShapeProblem) matches
 * its path and query. A pattern that matches "/" or a made-up path (CANARY_PATHS) is refused as a blanket. Its matching "Failed to load resource" console
 * error is expected too. Only HTTP statuses 400-599; a request that never got a response is never expected.
 */
export interface ExpectedFailure {
  method: string;
  urlPattern: string;
  status: number;
  reason: string;
}

/** verify.expectedFailures' problems, one message each (see ExpectedFailure). */
export function expectedFailuresProblems(list: unknown): string[] {
  const where = "verify.expectedFailures";
  if (!Array.isArray(list)) return [`${where} must be an array of { method, urlPattern, status, reason }`];
  const problems: string[] = [];
  list.forEach((entry, i) => {
    const name = `${where}[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return void problems.push(`${name} must be an object { method, urlPattern, status, reason }`);
    const e = entry as Record<string, unknown>;
    if (typeof e.method !== "string" || !/^[A-Z]+$/.test(e.method)) problems.push(`${name}.method must be an upper-case HTTP method (GET, POST, ...)`);
    if (!Number.isInteger(e.status) || (e.status as number) < 400 || (e.status as number) > 599) problems.push(`${name}.status must be an HTTP error status, an integer 400-599`);
    if (typeof e.reason !== "string" || !e.reason.trim()) problems.push(`${name} has no reason`);
    if (typeof e.urlPattern !== "string") problems.push(`${name}.urlPattern must be a string`);
    else {
      const shape = patternShapeProblem(e.urlPattern);
      if (shape) problems.push(`${name}.urlPattern ${JSON.stringify(e.urlPattern)} ${shape}`);
    }
  });
  return problems;
}

/**
 * Paths no expected failure may match: the origin's root, and made-up asset and query paths. A pattern
 * that matches one would excuse failures on paths the entry never named (a missing JS chunk, a font).
 */
export const CANARY_PATHS = ["/", "/__ds_canary__/x.js", "/__ds_canary__?x=1"] as const;

/** A literal first path segment, then "/", an escaped "?" or the end: "^/api/...", "^/api\\?..." or "^/health$". */
const LITERAL_FIRST_SEGMENT = /^\^\/[A-Za-z0-9._~%-]+(?:\/|\\\?|\$)/;

/** Whether the pattern has a `|` outside every group and character class (escapes skipped). */
function topLevelAlternation(pattern: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * Why an expectedFailures urlPattern is not a bounded endpoint pattern, or null. Required, all of:
 * - it compiles as written (an unbalanced ")" that could close a wrapper is refused);
 * - it starts with a literal first path segment (LITERAL_FIRST_SEGMENT), so it is anchored at one
 *   top-level path and never names "every path" or "every .css file";
 * - no `|` at the top level, outside a group (an alternative there would not be anchored);
 * - it matches none of CANARY_PATHS.
 * Matching (expectedFailure) uses the pattern as written and applies the same check, so a pattern that
 * skipped validation excuses nothing.
 */
export function patternShapeProblem(urlPattern: string): string | null {
  let pattern: RegExp;
  try {
    pattern = new RegExp(urlPattern);
  } catch (error) {
    return `is not a valid regular expression: ${(error as Error).message}`;
  }
  if (!LITERAL_FIRST_SEGMENT.test(urlPattern))
    return `must start with "^/" and a literal first path segment, then "/", "\\?" or "$" ("^/api/themes/global$"): it is matched against the path and query on the app's own origin`;
  if (topLevelAlternation(urlPattern)) return `has a top-level "|": put alternatives inside a group after the literal first segment ("^/api/(?:a|b)$")`;
  const blanket = CANARY_PATHS.filter((path) => pattern.test(path));
  if (blanket.length) return `is a blanket pattern: it also matches ${blanket.join(" and ")}; name the one endpoint that fails by design`;
  return null;
}

/**
 * The expected failure that covers a failed request, or undefined. `origin` is the app's own origin;
 * a request to any other origin (another port, another host) is never expected. Without `method` (a
 * console message names only the URL and the status) any entry's method matches.
 */
export function expectedFailure(list: readonly ExpectedFailure[] | undefined, origin: string | undefined, request: { method?: string; url: string; status: number }): ExpectedFailure | undefined {
  if (!list?.length || !origin) return undefined;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(origin).origin) return undefined;
  const path = `${url.pathname}${url.search}`;
  return list.find((e) => (request.method === undefined || e.method === request.method) && e.status === request.status && safeTest(e.urlPattern, path));
}

/** Whether the urlPattern matches the path; a pattern validation would refuse (patternShapeProblem) never does. */
function safeTest(urlPattern: string, path: string): boolean {
  if (typeof urlPattern !== "string" || patternShapeProblem(urlPattern) !== null) return false;
  return new RegExp(urlPattern).test(path);
}

export interface RunProfile {
  /** Extra environment for every process the app starts. */
  env: Record<string, string>;
  /** Variables removed from the inherited environment (service URLs, tokens, credentials). */
  unsetEnv: string[];
  /** HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME point at a fresh temp dir per run. */
  tempHome: true;
  /** Fixture inputs, design-system-relative (for example "apps/fixtures/<id>/..."). Copied into the temp dir. */
  fixtures: string[];
  /** CLI flags that isolate the app (for example docs-cli --standalone --root <fixture>). */
  flags: string[];
  /** Named ports the run assigns; the runner substitutes {port:<name>} in commands. */
  ports: Record<string, number>;
  /** Local ports the app may contact besides its own (none by default). */
  allowedLocalPorts?: number[];
  proof: {
    status: "proven" | "unproven";
    /** How the profile was shown not to reach the owner's services (docs service :4820, kernel :4840, real data). */
    method: string;
    date?: string;
  };
}

export interface RunSpec {
  mode: RunMode;
  /** Required when mode is "none". */
  reason?: string;
  /** Working directory for start, workspace-relative. */
  cwd?: string;
  /** The dev server's web root (Vite `root`), workspace-relative, when it differs from cwd. Served `/src/...` URLs map under it. Default: cwd. */
  serveRoot?: string;
  /** Command that serves the app; may use {port:<name>} and {tmp}. */
  start?: string;
  /** Regex with one capture group that reads the bound URL or port from server output. */
  readyPattern?: string;
  /** electron: path of the built main entry, workspace-relative, and the build command that produces it. */
  electron?: { build: string; main: string };
  /** static: directory to serve after `commands.build`, workspace-relative. */
  staticDir?: string;
}

export interface Commands {
  /** Every command runs from `cwd` (workspace-relative), with run.env sourced and the run profile applied. */
  cwd: string;
  install?: string;
  build?: string;
  typecheck?: string;
}

export interface TestSpec {
  /** Commands that are safe to run under the run profile. */
  safe: Array<{ cmd: string; cwd: string }>;
  /** Commands that must not run, with the reason. */
  unsafe?: Array<{ cmd: string; reason: string }>;
  /**
   * What `bun run test:apps` recorded for each command, keyed by its label: "tests.safe[<i>]",
   * "commands.typecheck", "commands.build". test:apps fails a later run on a failure the baseline does
   * not list. Recorded only from a test:apps report by the managing agent, never by an app worker; a
   * baseline that changes later needs a reason in `exceptions`.
   */
  baselines?: Record<string, TestBaseline>;
}

/** One command's recorded result (see TestSpec.baselines). */
export interface TestBaseline {
  /** The registry command it was recorded for; when the entry's command changes, test:apps fails the stale baseline. */
  cmd?: string;
  /** The command's exit status. */
  exit: number;
  /** Test counts, when the output had a summary test:apps reads (bun test, vitest, unittest). */
  pass?: number;
  fail?: number;
  /** Errors outside tests (bun "N errors", unittest ERROR entries count as failing instead). */
  errors?: number;
  /** Failing tests by name, or tsc errors as "<file>: <TScode>: <message>" (no line numbers), sorted. */
  failing?: string[];
  /** YYYY-MM-DD of the recorded run. */
  date: string;
  /** How it was recorded: test:apps, the root, sandboxed, and how many runs the failing list unites. */
  method: string;
}

export interface Exception {
  what: string;
  reason: string;
}

/** The chrome roles verify:apps needs a probe for: page background, a panel, text, a border. */
export type ProbeRole = "page" | "panel" | "text" | "border";
export const PROBE_ROLES: readonly ProbeRole[] = ["page", "panel", "text", "border"];

/** How the tools put an app in one theme (verify.darkSwitch, verify.lightSwitch). */
export type ThemeSwitch =
  /** Sets data-theme to the theme on `target` (default html). */
  | { kind: "attribute"; target?: string }
  | { kind: "storage"; key: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "query"; param: string; value: string }
  /** Navigation/view-only steps (for example open the style rail, click its dark-mode toggle). Writes may land only in the run's temp state. */
  | { kind: "steps"; steps: NonNullable<RouteSpec["steps"]> };

/**
 * verify.lightSteps' problems, one message each: a non-empty step list (stepsProblems), not on a
 * dark-first entry (verify never reads light there) and not together with a lightSwitch (one way to light).
 */
export function lightStepsProblems(steps: unknown, rule: ThemeRule | undefined, lightSwitch: unknown): string[] {
  const where = "verify.lightSteps";
  const problems = stepsProblems(steps, where);
  if (Array.isArray(steps) && steps.length === 0) problems.push(`${where} is empty (omit it when light needs no steps)`);
  if (rule === "dark-first") problems.push(`${where} is set on a dark-first entry: verify never reads light there, so nothing would check it`);
  if (lightSwitch !== undefined) problems.push(`${where} and verify.lightSwitch are both set: name one way to reach light`);
  return problems;
}

/**
 * The light steps the tools run on a route: the entry's verify.lightSteps, or undefined (none, empty, a
 * dark-first entry, or a route with skipLightSteps).
 */
export function lightSteps(app: { theme?: { rule?: ThemeRule }; verify?: { lightSteps?: unknown } }, route?: Pick<RouteSpec, "skipLightSteps">): NonNullable<RouteSpec["steps"]> | undefined {
  const steps = app.verify?.lightSteps;
  if (app.theme?.rule === "dark-first" || !Array.isArray(steps) || steps.length === 0 || route?.skipLightSteps !== undefined) return undefined;
  return steps as NonNullable<RouteSpec["steps"]>;
}

/** verify.lightSwitch: a stored value only (see VerifySpec.lightSwitch for why). */
export type LightSwitch = { kind: "storage"; key: string; value: string };

/**
 * verify.lightSwitch's problems, one message each. Only `storage` is accepted: it is written before the
 * page loads (capture, use:app) or before a reload (verify, registry:prove) and stays in localStorage
 * across every later navigation. An `attribute` switch is lost when a navigation-only route step loads a
 * new document; `query` is dropped by such a navigation and never reaches an Electron window; `click`
 * and `steps` can navigate without the route being prepared again. No entry needs those for light.
 * A dark-first entry may not set one: verify never reads light there, so nothing would check it.
 */
export function lightSwitchProblems(sw: unknown, rule: ThemeRule | undefined): string[] {
  const where = "verify.lightSwitch";
  if (sw === null || typeof sw !== "object" || Array.isArray(sw)) return [`${where} must be an object { kind: "storage", key, value }`];
  const s = sw as Record<string, unknown>;
  const problems: string[] = [];
  if (s.kind !== "storage")
    problems.push(
      `${where}.kind ${JSON.stringify(s.kind)} is not allowed: lightSwitch accepts only "storage" (a stored value survives the navigation a route step can make; attribute, query, click and steps switches can be lost or skip the route's preparation)`,
    );
  else for (const key of ["key", "value"]) if (typeof s[key] !== "string" || (s[key] as string).length === 0) problems.push(`${where}.${key} must be a non-empty string`);
  if (rule === "dark-first") problems.push(`${where} is set on a dark-first entry: verify never reads light there, so nothing would check it (drop it, or make the rule light-dark)`);
  return problems;
}

/** The light switch the tools apply: the entry's storage lightSwitch, or undefined (none, another kind, or a dark-first entry). */
export function lightSeed(app: { theme?: { rule?: ThemeRule }; verify?: { lightSwitch?: unknown } }): LightSwitch | undefined {
  const sw = app.verify?.lightSwitch as Partial<LightSwitch> | undefined;
  if (app.theme?.rule === "dark-first" || sw?.kind !== "storage" || typeof sw.key !== "string" || typeof sw.value !== "string") return undefined;
  return { kind: "storage", key: sw.key, value: sw.value };
}

/** How verify:apps proves the app is connected (runtime check). */
export interface VerifySpec {
  /** Route id to verify on; default the first route. */
  route?: string;
  /**
   * Representative chrome elements and the token each CSS property must compute to
   * in the active theme: page background, a panel, body text, a border (one probe per role at least).
   * Example: { selector: "body", property: "background-color", token: "color.surface.page" }.
   * `role` overrides the role the token family gives (see probeRole). The property must be one the
   * role reads (ROLE_PROPERTIES); `roleReason` says why an explicit `role` holds on another property.
   * `themes` limits the probe to those themes (board data drawn the same in both, say); default every
   * theme the app is checked in.
   */
  probes: Array<{ selector: string; property: string; token: string; role?: ProbeRole; roleReason?: string; themes?: Array<"light" | "dark"> }>;
  /**
   * Roles the app has no element for, each with the reason; `themes` limits the waiver to those themes
   * (default every theme the app is checked in). A role needs, in each checked theme, a probe or a waiver.
   */
  waivedRoles?: Array<{ role: ProbeRole; reason: string; themes?: Array<"light" | "dark"> }>;
  /** How to switch to dark. On dark-first surfaces dark is the default; the check confirms it instead. */
  darkSwitch: ThemeSwitch;
  /**
   * How to reach light, for a light-dark app that boots dark with empty storage (the product default is
   * dark). Only `storage` (lightSwitchProblems says why); not on dark-first entries. When present:
   * - snapshot capture and use:app write it into localStorage before the page loads, in every light shot;
   * - verify writes it and reloads (re-running the route's waitFor and steps) before the light reads,
   *   after the route was prepared, then reads light, then applies darkSwitch for the dark reads;
   * - registry:prove writes it and reloads before the route's steps in every light load.
   * The stored value stays across navigation-only route steps. Capture and use:app also emulate
   * prefers-color-scheme: light; verify keeps light emulated for both themes, as it always has.
   * Omit it when the app boots light: then light is the app as it boots, as before.
   */
  lightSwitch?: LightSwitch;
  /**
   * Navigation/view-only steps that put the app in light, for an app whose theme state outlives a visit
   * (it saves the choice on its server, so the previous visit's dark carries into the next load). Use
   * `check`/`uncheck` steps so they hold whatever state the page loads in, for example open the colors
   * pane, uncheck the dark-mode toggle, wait for html[data-theme="light"]; the darkSwitch then `check`s it.
   * Every light visit runs them where a dark visit runs darkSwitch's steps: snapshot capture and use:app
   * after the page loads (after waitFor when the route has no steps) and before the route's steps;
   * registry:prove before the route's steps; verify after the route was prepared, before the light reads.
   * Not with lightSwitch, not on dark-first entries. Omit it when a fresh load is light.
   */
  lightSteps?: NonNullable<RouteSpec["steps"]>;
  /** Failed requests the app makes by design: use:app reports them apart and does not fail on them (ExpectedFailure). */
  expectedFailures?: ExpectedFailure[];
  /** Shell apps: the sidebar toggle (default ".ds-sidebar-toggle") and the storage key (default "<app>.sidebar"). */
  sidebar?: { toggle?: string; storageKey?: string };
}

export interface AppEntry {
  id: string;
  name: string;
  wave: 1 | 2 | 3;
  kind: "app" | "library" | "site";
  /** Repo root, workspace-relative. */
  repo: string;
  /** App package root (holds its package.json), workspace-relative. */
  root: string;
  scan: ScanSpec;
  stack: {
    summary: string;
    tailwind: "v4" | "v3" | "none";
    /**
     * true: run the Tailwind default-scale class check even though `tailwind` is "none". For libraries
     * and templates without their own Tailwind build whose class strings their hosts compile.
     */
    utilityClasses?: boolean;
    /**
     * With `utilityClasses`: the Tailwind of the host that compiles this library's (or template's) class
     * strings, which decides which class syntax and default scales apply: "v3" (Tailwind v3 with the
     * design-system preset), "v4" (Tailwind v4 with tailwind-strict.css), "uno" (UnoCSS's Tailwind-compatible
     * preset, as Slidev uses). Libraries with several hosts name the strictest one their code must suit.
     */
    hostTailwind?: "v3" | "v4" | "uno";
    packageManager: "bun" | "npm" | "none";
  };
  consume: { via: ConsumeVia; detail: string };
  /** The stylesheet (or HTML/TS file with inline CSS) that must load fonts, tokens and layout. Workspace-relative. Null for host-css libraries. */
  entryStylesheet: string | null;
  theme: { rule: ThemeRule; storageKey?: string };
  /** Maximum hard literals allowed in scan.paths after pass 1 (0 plus documented exceptions). */
  literalFloor: number;
  /** Design-system-relative allowlist file (apps/allowlists/<id>.json) or null. */
  allowlist: string | null;
  /** Renders the app shell (pass 2 target). */
  shell: boolean;
  /** Follows the folder standard (pass 3 target). Libraries: false. */
  folderStandard: boolean;
  passes: Record<PassId, Requirement>;
  checks: Record<CheckId, Requirement>;
  gates: Record<GateId, Requirement>;
  run: RunSpec;
  commands: Commands;
  tests: TestSpec;
  routes: RouteSpec[];
  runProfile: RunProfile;
  /** Required when gates.verify is required and run.mode is not "none". */
  verify?: VerifySpec;
  exceptions: Exception[];
}

/** Allowlist file shape (apps/allowlists/<id>.json). */
export interface Allowlist {
  /**
   * Hard literal hits that stay. `file` is a workspace-relative glob; `match` is a regex
   * over the hit's literal text (omit to match any); `category` is a scan-literals hard
   * category and `kind` a color split (definition, fallback, inline). An entry matches a hit
   * when every field it sets matches. The linter owns the exact semantics.
   */
  literals: Array<{ file: string; match?: string; category?: string; kind?: "definition" | "fallback" | "inline"; reason: string }>;
  /** Tailwind default-scale classes that stay. `className` is a regex over the class. */
  twClasses: Array<{ file: string; className: string; reason: string }>;
}

export interface Registry {
  $schema?: string;
  version: 1;
  apps: AppEntry[];
}

/**
 * A probe's role: its own `role`, else its token family. color.surface.page is the page; the
 * surface.panel, sidebar, inset and sunken tokens are panels; color.text.* is text; color.border.*
 * is a border. Null for any other token (a font, a status color).
 */
export function probeRole(probe: VerifySpec["probes"][number]): ProbeRole | null {
  if (probe.role) return probe.role;
  const token = probe.token;
  if (token === "color.surface.page") return "page";
  if (/^color\.surface\.(?:panel|sidebar|inset|sunken)$/.test(token)) return "panel";
  if (token.startsWith("color.text.")) return "text";
  if (token.startsWith("color.border.")) return "border";
  return null;
}

/** The route verify:apps checks: verify.route, else the first route. */
export function verifyRoute(app: { verify?: { route?: string }; routes?: RouteSpec[] }): RouteSpec | undefined {
  const id = app.verify?.route;
  return id ? app.routes?.find((route) => route.id === id) : app.routes?.[0];
}

/** The themes verify:apps checks an app in: dark only on a dark-first surface, else light then dark. */
export function checkedThemes(rule: ThemeRule | undefined): Array<"light" | "dark"> {
  return rule === "dark-first" ? ["dark"] : ["light", "dark"];
}

/** Whether a probe is checked in a theme: its own `themes`, else every theme. */
export function probeActive(probe: VerifySpec["probes"][number], theme: "light" | "dark"): boolean {
  return !probe.themes || probe.themes.includes(theme);
}

/**
 * The CSS properties each role's probe reads (SVG equivalents count): a page or a panel paints a
 * background, text a color, a border a border color, an outline or a stroke. A probe on another
 * property holds only with an explicit `role` and a `roleReason`.
 */
export const ROLE_PROPERTIES: Record<ProbeRole, { pattern: RegExp; text: string }> = {
  page: { pattern: /^(?:background-color|fill)$/, text: "background-color or fill" },
  panel: { pattern: /^(?:background-color|fill)$/, text: "background-color or fill" },
  text: { pattern: /^(?:color|fill)$/, text: "color or fill" },
  border: {
    pattern: /^(?:border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?-color|outline-color|stroke)$/,
    text: "border-*-color, outline-color or stroke",
  },
};

const isProbeRole = (role: unknown): role is ProbeRole => (PROBE_ROLES as readonly unknown[]).includes(role);

/** Whether a waiver with a reason covers the role in the theme (a waiver without `themes` covers every theme). */
export function roleWaived(verify: Pick<VerifySpec, "waivedRoles">, role: ProbeRole, theme: "light" | "dark"): boolean {
  return (verify.waivedRoles ?? []).some((w) => w.role === role && Boolean(w.reason?.trim()) && (!w.themes || w.themes.includes(theme)));
}

/** The roles theme.switch must show the dark switch reaches on a light-dark app: every role waived in neither theme. */
export function switchRoles(verify: Pick<VerifySpec, "waivedRoles">): ProbeRole[] {
  return PROBE_ROLES.filter((role) => !roleWaived(verify, role, "light") && !roleWaived(verify, role, "dark"));
}

/**
 * Every problem a verify spec has, one message each; empty when it holds:
 * - each probe's property is one its role reads (ROLE_PROPERTIES), unless an explicit `role` gives a `roleReason`;
 * - each waiver names a role, gives a reason and, when it lists themes, only themes the app is checked in;
 * - in each checked theme every role has a probe active there or a waiver covering that theme;
 * - on a light-dark app every role waived in neither theme has a probe active in both, for theme.switch.
 * validateRegistry (registry:check, every tool's load) and verify:apps' verify-spec assertion both use it.
 */
export function verifySpecProblems(verify: Pick<VerifySpec, "probes" | "waivedRoles">, rule: ThemeRule | undefined): string[] {
  const themes = checkedThemes(rule);
  const probes = verify.probes ?? [];
  const problems: string[] = [];
  probes.forEach((probe, i) => {
    const role = probeRole(probe);
    if (role === null) return;
    const name = `verify.probes[${i}] (${probe.selector} ${probe.property})`;
    if (!isProbeRole(role)) {
      problems.push(`${name} role ${JSON.stringify(role)} is not one of ${PROBE_ROLES.join(", ")}`);
      return;
    }
    const { pattern, text } = ROLE_PROPERTIES[role];
    if (!pattern.test(probe.property) && !(probe.role && probe.roleReason?.trim()))
      problems.push(`${name} is a ${role} probe, but a ${role} probe reads ${text} (or set role with a roleReason saying why ${probe.property} holds the ${role})`);
  });
  (verify.waivedRoles ?? []).forEach((waiver, i) => {
    const name = `verify.waivedRoles[${i}] (${waiver.role})`;
    if (!isProbeRole(waiver.role)) problems.push(`verify.waivedRoles[${i}] role ${JSON.stringify(waiver.role)} is not one of ${PROBE_ROLES.join(", ")}`);
    if (!waiver.reason?.trim()) problems.push(`${name} has no reason`);
    if (waiver.themes === undefined) return;
    if (!Array.isArray(waiver.themes) || waiver.themes.length === 0) problems.push(`${name} has an empty themes list (omit themes to waive every checked theme)`);
    else for (const theme of waiver.themes) if (!themes.includes(theme)) problems.push(`${name} waives ${theme}, a theme the app is not checked in (${themes.join(" and ")})`);
  });
  const missingEverywhere: ProbeRole[] = [];
  const missingIn: string[] = [];
  for (const role of PROBE_ROLES) {
    const gaps = themes.filter((theme) => !roleWaived(verify, role, theme) && !probes.some((probe) => probeRole(probe) === role && probeActive(probe, theme)));
    if (gaps.length === themes.length) missingEverywhere.push(role);
    else for (const theme of gaps) missingIn.push(`verify.probes has no ${role} probe checked in ${theme} (add one, or a verify.waivedRoles entry { role, themes: ["${theme}"], reason })`);
  }
  if (missingEverywhere.length) problems.push(`verify.probes has no ${missingEverywhere.join(", ")} probe (add one, or a verify.waivedRoles entry with a reason)`);
  problems.push(...missingIn);
  if (rule !== "dark-first") {
    for (const role of switchRoles(verify)) {
      const own = probes.filter((probe) => probeRole(probe) === role && themes.some((theme) => probeActive(probe, theme)));
      if (own.length && !own.some((probe) => probeActive(probe, "light") && probeActive(probe, "dark")))
        problems.push(`verify.probes has no ${role} probe checked in both light and dark: theme.switch cannot show the dark switch reaches ${role}`);
    }
  }
  return problems;
}

export const DESIGN_SYSTEM_ROOT = resolve(import.meta.dir, "..", "..");
export const REGISTRY_PATH = join(DESIGN_SYSTEM_ROOT, "apps.json");

export function loadRegistry(path: string = REGISTRY_PATH): Registry {
  return JSON.parse(readFileSync(path, "utf8")) as Registry;
}

export function getApp(registry: Registry, id: string): AppEntry {
  const app = registry.apps.find((a) => a.id === id);
  if (!app) throw new Error(`apps.json: no app "${id}"`);
  return app;
}

/** Resolve a workspace-relative registry path against a root tree. */
export function resolvePath(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

/** safeSegment's refusal as a message, or null when `name` is one safe path segment. */
function unsafeSegment(name: unknown, label: string): string | null {
  try {
    safeSegment(name as string, label);
    return null;
  } catch (error) {
    if (error instanceof UnsafePathError) return error.message;
    throw error;
  }
}

/** Structural problems in the registry, one message each. Empty when valid. */
export function validateRegistry(registry: Registry): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const needReason = (id: string, where: string, r: Requirement | undefined) => {
    if (!r) problems.push(`${id}: ${where} is missing`);
    else if (!r.required && !r.reason?.trim()) problems.push(`${id}: ${where} is n/a without a reason`);
  };
  for (const app of registry.apps) {
    if (seen.has(app.id)) problems.push(`${app.id}: duplicate id`);
    seen.add(app.id);
    for (const p of ["1", "2", "3"] as const) needReason(app.id, `passes.${p}`, app.passes?.[p]);
    for (const c of ["resolution", "wiring", "literals", "names", "shell", "structure"] as const)
      needReason(app.id, `checks.${c}`, app.checks?.[c]);
    for (const g of ["lint", "verify", "snapshot", "pixelDiff", "tests"] as const) needReason(app.id, `gates.${g}`, app.gates?.[g]);
    if (app.run?.mode === "none" && !app.run.reason?.trim()) problems.push(`${app.id}: run mode none without a reason`);
    if (app.run?.mode !== "none" && app.runProfile?.proof?.status !== "proven")
      problems.push(`${app.id}: run mode ${app.run?.mode} needs a proven run profile`);
    for (const e of app.exceptions ?? []) if (!e.reason?.trim()) problems.push(`${app.id}: exception "${e.what}" has no reason`);
    for (const r of app.routes ?? []) if (r.gating === false && !r.reason?.trim()) problems.push(`${app.id}: route ${r.id} is non-gating without a reason`);
    const runnable = app.run?.mode !== undefined && app.run.mode !== "none";
    if (runnable && app.run.mode !== "electron" && !app.run.start && !app.run.staticDir)
      problems.push(`${app.id}: run mode ${app.run.mode} needs run.start (or run.staticDir for static)`);
    if (app.run?.start && !app.run.readyPattern) problems.push(`${app.id}: run.start needs run.readyPattern`);
    if (app.run?.mode === "electron" && !app.run.electron) problems.push(`${app.id}: run mode electron needs run.electron`);
    if (runnable && !app.routes?.length) problems.push(`${app.id}: run mode ${app.run.mode} needs at least one route`);
    if (runnable && app.gates?.verify?.required && !app.verify) problems.push(`${app.id}: gates.verify is required but verify is missing`);
    if (app.verify) for (const problem of verifySpecProblems(app.verify, app.theme?.rule)) problems.push(`${app.id}: ${problem}`);
    if (app.verify?.lightSwitch !== undefined) for (const problem of lightSwitchProblems(app.verify.lightSwitch, app.theme?.rule)) problems.push(`${app.id}: ${problem}`);
    if (app.verify?.lightSteps !== undefined)
      for (const problem of lightStepsProblems(app.verify.lightSteps, app.theme?.rule, app.verify.lightSwitch)) problems.push(`${app.id}: ${problem}`);
    if (app.verify?.expectedFailures !== undefined) for (const problem of expectedFailuresProblems(app.verify.expectedFailures)) problems.push(`${app.id}: ${problem}`);
    for (const r of app.routes ?? []) if (r.steps !== undefined) for (const problem of stepsProblems(r.steps, `routes.${r.id}.steps`)) problems.push(`${app.id}: ${problem}`);
    for (const r of app.routes ?? []) {
      if (r.skipLightSteps === undefined) continue;
      if (typeof r.skipLightSteps !== "string" || !r.skipLightSteps.trim()) problems.push(`${app.id}: route ${r.id} skipLightSteps must be the reason, a non-empty string`);
      if (app.verify?.lightSteps === undefined) problems.push(`${app.id}: route ${r.id} sets skipLightSteps, but the entry has no verify.lightSteps`);
    }
    if (app.verify?.darkSwitch?.kind === "steps") for (const problem of stepsProblems(app.verify.darkSwitch.steps, "verify.darkSwitch.steps")) problems.push(`${app.id}: ${problem}`);
    if (!runnable) {
      for (const g of ["verify", "snapshot"] as const)
        if (app.gates?.[g]?.required) problems.push(`${app.id}: gates.${g} is required but run mode is none`);
    }
    if (app.runProfile?.proof?.status === "proven" && (!app.runProfile.proof.method?.trim() || !app.runProfile.proof.date))
      problems.push(`${app.id}: a proven run profile needs proof.method and proof.date`);
    if (app.verify?.route && !app.routes?.some((r) => r.id === app.verify!.route)) problems.push(`${app.id}: verify.route ${app.verify.route} is not a route`);
    const routeIds = new Set<string>();
    for (const r of app.routes ?? []) {
      if (routeIds.has(r.id)) problems.push(`${app.id}: duplicate route id ${r.id}`);
      routeIds.add(r.id);
    }
    // Route ids name snapshot shots and verify results: each must be one safe path segment.
    const unsafe = [...(app.routes ?? []).map((r) => unsafeSegment(r.id, "route id")), app.verify?.route === undefined ? null : unsafeSegment(app.verify.route, "verify.route")];
    for (const message of unsafe) if (message) problems.push(`${app.id}: ${message} (it names output files)`);
    const ports = app.runProfile?.ports ?? {};
    const texts = [
      app.run?.start,
      app.run?.electron?.build,
      app.commands?.install,
      app.commands?.build,
      app.commands?.typecheck,
      ...(app.runProfile?.flags ?? []),
      ...Object.values(app.runProfile?.env ?? {}),
      ...(app.tests?.safe ?? []).map((t) => t.cmd),
    ];
    for (const text of texts)
      for (const m of (text ?? "").matchAll(/\{port:([A-Za-z0-9_-]+)\}/g))
        if (!(m[1]! in ports)) problems.push(`${app.id}: {port:${m[1]}} names no runProfile.ports entry`);
    if (app.allowlist !== null && app.allowlist !== undefined && app.allowlist !== `apps/allowlists/${app.id}.json`)
      problems.push(`${app.id}: allowlist must be apps/allowlists/${app.id}.json or null`);
    if (!Number.isInteger(app.literalFloor) || app.literalFloor < 0) problems.push(`${app.id}: literalFloor must be a non-negative integer`);
  }
  return problems;
}
