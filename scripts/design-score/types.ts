/**
 * Shapes shared by design:score: the app config, the checks, findings and the scorecard.
 */
import type { JudgeSummary } from "./judge";


export type Severity = "fail" | "warn";
export type CheckStatus = "pass" | "warn" | "fail" | "n/a";
export type Layer = "static" | "runtime" | "motion" | "judge";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One way to reach a page state. Exactly one verb per step. */
export interface Action {
  click?: string;
  hover?: string;
  press?: string;
  focus?: string;
  waitFor?: string;
  wait?: number;
  /** Scroll this selector into view (block: center). */
  scrollTo?: string;
  /** Mouse to an absolute viewport point: [x, y]. */
  mouse?: [number, number];
  /** Scroll an element (e.g. the app's main scroller) to a top offset: [selector, px]. */
  scroll?: [string, number];
  /** Fail the page when the step's selector is missing (default true). */
  required?: boolean;
}

export interface PageSpec {
  id: string;
  path: string;
  /** Selector to wait for after load. */
  waitFor?: string;
  /**
   * How long (ms) to wait for `waitFor`. Default 15000. Raise it only for a page that is slow in the
   * scorer's headless browser and fast for a person, such as WebGL drawn by the software renderer.
   */
  waitForTimeoutMs?: number;
  actions?: Action[];
  /** Extra wait (ms) after actions, before measuring. Default config.settleMs. */
  settleMs?: number;
  /** Checks to skip on this page, with the reason in `skipReason`. */
  skip?: string[];
  skipReason?: string;
  note?: string;
  /**
   * The page may not load in every setup (it needs a service the app talks to). When loading it, its
   * waitFor or its actions fail, the page is skipped with this reason instead of erroring the run.
   */
  optional?: string;
  /** R-state-shift: elements whose boxes must not change while this page's actions run. */
  shiftWatch?: string;
  /**
   * GET responses this page sees changed, for states the app's data has none of (a Session with a
   * live thread, an open Session under a Library Topic): each JSON response whose URL path is
   * `path` gets `merge`'s top-level keys, and `append`'s items pushed onto its top-level arrays.
   */
  mock?: Array<{ path: string; merge?: Record<string, unknown>; append?: Record<string, unknown[]> }>;
}

/** A layout-property animation the app may keep: reported as allowed, never counted (M-layout-props). */
export interface MotionAllow {
  name: string;
  /** CSS selector the animated element matches. */
  selector: string;
  /** Layout properties allowed on it. */
  props: string[];
  reason: string;
}

export interface ThemeSpec {
  /** localStorage entries set before any page script runs. */
  localStorage?: Record<string, string>;
  /** Query parameters appended to every URL. */
  query?: Record<string, string>;
  /** Playwright colorScheme for the context (default: the theme's name when light/dark). */
  colorScheme?: "light" | "dark";
  /** Selector that must match once the theme is applied, e.g. html[data-theme="dark"]. */
  assert?: string;
}

export interface AppConfig {
  app: string;
  name?: string;
  /** The app's repo, absolute or relative to the workspace root (sourceDirs resolve against it). */
  repo?: string;
  /** An app that is already running. Overridden by --base-url. */
  baseUrl?: string;
  /** Or: start the apps.json entry with app-runner (sandboxed, own ports) and stop it afterwards. */
  registryApp?: string;
  /** Source dirs for the static checks, relative to `repo`. */
  sourceDirs: string[];
  /** Globs (scan-literals --exclude syntax) skipped by the static checks. */
  excludes?: string[];
  themes: Record<string, ThemeSpec>;
  viewports?: Array<{ width: number; height: number }>;
  pages: PageSpec[];
  /** Selectors of drag handles / grips for R-align-near-miss's handle-vs-text rule. */
  handles?: string[];
  /** Selectors whose subtree no runtime check measures (third-party embeds, iframes). */
  ignore?: string[];
  /** Default wait after load and after actions (ms). */
  settleMs?: number;
  /** Texts that mean the page has not loaded yet (a lazy route's placeholder): measuring waits until none shows (up to 20s). */
  loading?: string[];
  /** Max findings kept per check per page variant. */
  cap?: number;
  /** R-state-shift: extra selectors whose click opens something (besides [aria-haspopup]); max controls per page (default 16). */
  shift?: { open?: string[]; max?: number };
  /** M-layout-props allowlist. */
  motionAllow?: MotionAllow[];
}

/** The design areas sub-scores are grouped by. */
export type Area = "layout" | "typography" | "color" | "motion" | "interaction" | "accessibility";

export interface Finding {
  check: string;
  severity: Severity;
  page: string;
  theme: string | null;
  viewport: string | null;
  selector: string | null;
  box: Box | null;
  /** Second element, for pair checks (alignment, control height). */
  other?: { selector: string; box: Box } | null;
  measured: string;
  expected: string;
  message?: string;
  file?: string;
  line?: number;
  /** Crop with the element boxed, relative to the run folder. */
  crop?: string;
  /** Ids of the design-score/rules/ rules this check decides. */
  rules?: string[];
  /** Grouped findings: how many elements (or rows) it stands for, and the group key (component class list). */
  count?: number;
  group?: string;
}

/** A finding the config allows (M-layout-props motionAllow): shown, never counted. */
export interface AllowedFinding extends Finding {
  allowed: string;
  reason: string;
}

/** What a probe returns before page/theme/viewport are attached. */
export type RawFinding = Omit<Finding, "page" | "theme" | "viewport">;

export interface CheckResult {
  findings: RawFinding[];
  /** Findings cut by the cap (per check). */
  cut?: number;
  /** Counts before the cap (the status comes from these). Default: counted from findings. */
  fails?: number;
  warns?: number;
  /** Set when the check could not run here. */
  skipped?: string;
}

export interface CheckDef {
  id: string;
  layer: Layer;
  title: string;
  /** How it decides, in one or two sentences. */
  rule: string;
  /** The area sub-score it counts in (V-judge has none). */
  area?: Area;
}

export interface PageCheck {
  status: CheckStatus;
  fails: number;
  warns: number;
  cut: number;
  note?: string;
  /** The page config skips this check (`skip`). */
  skipped?: true;
}

export interface Shot {
  theme: string;
  viewport: string;
  file: string;
  kind: "state" | "motion" | "reduced-motion";
}

export interface PageResult {
  id: string;
  path: string;
  score: number | null;
  checks: Record<string, PageCheck>;
  shots: Shot[];
  errors: string[];
  /** Set when an `optional` page could not load: every check is n/a and the score is null. */
  skipped?: string;
  /** Per-area sub-scores for this page. */
  areas?: Record<string, number | null>;
}

export interface Scorecard {
  tool: "design-score";
  version: 1;
  app: string;
  label: string | null;
  runId: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  config: { path: string; sha256: string };
  provenance: Record<string, unknown>;
  scoring: string;
  score: number | null;
  checks: CheckDef[];
  /** Per check: how many pages pass, warn, fail, n/a. */
  checkTotals: Record<string, Record<CheckStatus, number>>;
  /** Per-area sub-scores: mean of the page area scores. */
  areas?: Record<string, number | null>;
  pages: PageResult[];
  findings: Finding[];
  /** Findings the config allows (not counted). */
  allowed?: AllowedFinding[];
  judge: JudgeSummary;
}
