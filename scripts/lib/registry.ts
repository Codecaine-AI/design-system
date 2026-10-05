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
  /** Navigation/view-only steps to reach the state (click a tab, open a panel). Never submit, save, delete, sync or send. */
  steps?: Array<{ action: "click" | "press" | "hover" | "scroll" | "wait"; target?: string; value?: string | number }>;
  /** CSS selectors whose boxes are masked in diffs. */
  masks?: string[];
  /** false = captured but never fails a pixel gate. Requires a reason. */
  gating?: boolean;
  reason?: string;
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
}

export interface Exception {
  what: string;
  reason: string;
}

/** How verify:apps proves the app is connected (runtime check). */
export interface VerifySpec {
  /** Route id to verify on; default the first route. */
  route?: string;
  /**
   * Representative chrome elements and the token each CSS property must compute to
   * in the active theme: page background, a panel, body text, a border.
   * Example: { selector: "body", property: "background-color", token: "color.surface.page" }.
   */
  probes: Array<{ selector: string; property: string; token: string }>;
  /** How to switch to dark. On dark-first surfaces dark is the default; the check confirms it instead. */
  darkSwitch:
    | { kind: "attribute"; target?: string }
    | { kind: "storage"; key: string; value: string }
    | { kind: "click"; selector: string }
    | { kind: "query"; param: string; value: string }
    /** Navigation/view-only steps (for example open the style rail, click its dark-mode toggle). Writes may land only in the run's temp state. */
    | { kind: "steps"; steps: NonNullable<RouteSpec["steps"]> };
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
  stack: { summary: string; tailwind: "v4" | "v3" | "none"; packageManager: "bun" | "npm" | "none" };
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
  }
  return problems;
}
