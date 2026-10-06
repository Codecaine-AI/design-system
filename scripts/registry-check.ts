#!/usr/bin/env bun
/**
 * registry:check: is apps.json usable against a workspace tree?
 *
 *   bun run registry:check [--root <dir>] [--registry <apps.json>]
 *
 * Runs validateRegistry (structure), then checks against the tree and this design-system checkout:
 *   - every workspace-relative path exists under --root: repo, root, scan paths, entry stylesheet,
 *     command and run cwds, safe-test cwds;
 *   - every profile port is in 47000-47999, not an owner port, unique across apps, and inside the
 *     app's block (47000 + 10 x its index, ten ports);
 *   - every allowedLocalPorts entry is inside the app's block (never an owner port): a run may reach
 *     only processes it starts itself;
 *   - no command, flag or env value names an owner port, a loopback `host:<port>` outside the app's
 *     block, or a `--*port <n>` / `*PORT=<n>` outside it (use `{port:<name>}` for the app's own ports);
 *   - every bun runtime command (`bun test`, `bun run`, `bun <file>`) passes `--no-env-file`, so bun
 *     never auto-loads a `.env` from the app's directory (BUN_OPTIONS covers the processes it spawns);
 *   - `stack.utilityClasses` is a boolean and only set where `stack.tailwind` is "none", and comes with
 *     `stack.hostTailwind` (v3, v4 or uno: the host Tailwind that compiles its classes);
 *   - every allowlist file and fixture exists in this design-system checkout, an allowlist has the
 *     Allowlist shape with a reason on every entry, and no fixture is a .env file;
 *   - every `{ds}/...` script a run starts exists in this checkout.
 * Prints one line per problem and exits 1 when there is any.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { OWNER_PORTS } from "./lib/owner";
import { DESIGN_SYSTEM_ROOT, REGISTRY_PATH, loadRegistry, resolvePath, validateRegistry, type AppEntry, type Registry } from "./lib/registry";

export const PROFILE_PORTS = { min: 47000, max: 47999, block: 10 } as const;

/** Every command an entry runs, labelled for messages. */
function commandTexts(app: AppEntry): Array<[label: string, text: string]> {
  const out: Array<[string, string | undefined]> = [
    ["run.start", app.run?.start],
    ["run.electron.build", app.run?.electron?.build],
    ["commands.install", app.commands?.install],
    ["commands.build", app.commands?.build],
    ["commands.typecheck", app.commands?.typecheck],
    ...(app.tests?.safe ?? []).map((t, i): [string, string] => [`tests.safe[${i}]`, t.cmd]),
  ];
  return out.filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0);
}

/** Commands plus the profile's flags and env values: every string that can carry a port. */
function portTexts(app: AppEntry): Array<[label: string, text: string]> {
  return [
    ...commandTexts(app),
    ...(app.runProfile?.flags?.length ? [["runProfile.flags", app.runProfile.flags.join(" ")] as [string, string]] : []),
    ...Object.entries(app.runProfile?.env ?? {}).map(([key, value]): [string, string] => [`runProfile.env.${key}`, `${key}=${value}`]),
  ];
}

const LOOPBACK_PORT = /(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::|%3[Aa])(\d{1,5})(?!\d)/g;
const PORT_OPTION = /(?:--[A-Za-z-]*port|\b[A-Z_]*PORT)[= ]+(\d{1,5})(?!\d)/g;
const BARE_NUMBER = /(?<![\w.])(\d{4,5})(?![\w.])/g;

/**
 * Ports an entry names outside its own block: owner ports anywhere, loopback `host:<port>` and
 * `--*port <n>` / `*PORT=<n>` outside the block, and allowedLocalPorts outside the block.
 */
export function portProblems(app: AppEntry, block: { start: number; size: number }): string[] {
  const problems: string[] = [];
  const range = `${block.start}-${block.start + block.size - 1}`;
  const inBlock = (port: number) => port >= block.start && port < block.start + block.size;
  for (const port of app.runProfile?.allowedLocalPorts ?? []) {
    if (OWNER_PORTS.includes(port)) problems.push(`${app.id}: runProfile.allowedLocalPorts lists owner port ${port}`);
    else if (!inBlock(port)) problems.push(`${app.id}: runProfile.allowedLocalPorts port ${port} is outside its block ${range} (a run may reach only processes it starts)`);
  }
  for (const [label, text] of portTexts(app)) {
    const reported = new Set<number>();
    const report = (port: number, message: string) => {
      if (reported.has(port)) return;
      reported.add(port);
      problems.push(`${app.id}: ${label} ${message}`);
    };
    for (const m of text.matchAll(BARE_NUMBER)) {
      const port = Number(m[1]);
      if (OWNER_PORTS.includes(port)) report(port, `names owner port ${port}`);
    }
    for (const re of [LOOPBACK_PORT, PORT_OPTION])
      for (const m of text.matchAll(re)) {
        const port = Number(m[1]);
        if (!inBlock(port)) report(port, `names port ${port} outside its block ${range} (use {port:<name>})`);
      }
  }
  return problems;
}

/** bun subcommands that do not run app code under the bun runtime (no .env auto-load). */
const BUN_NON_RUNTIME = new Set(["x", "install", "i", "add", "remove", "pm", "link", "unlink", "create", "init", "upgrade", "outdated", "--version", "--help"]);

/** Every bun runtime invocation in the entry's commands must pass --no-env-file. */
export function bunEnvFileProblems(app: AppEntry): string[] {
  const problems: string[] = [];
  for (const [label, text] of commandTexts(app)) {
    for (const segment of text.split(/&&|\|\||[;|\n]/)) {
      const words = segment.trim().split(/\s+/);
      let i = 0;
      while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ["exec", "env", "time", "nice"].includes(words[i]!))) i++;
      if (words[i] !== "bun") continue;
      const args = words.slice(i + 1);
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub && BUN_NON_RUNTIME.has(sub)) continue;
      if (!args.includes("--no-env-file")) problems.push(`${app.id}: ${label} runs bun without --no-env-file (bun auto-loads .env from its cwd): ${segment.trim()}`);
    }
  }
  return problems;
}

export const HOST_TAILWIND = ["v3", "v4", "uno"] as const;

/**
 * `stack.utilityClasses` is optional, boolean, and only meaningful for apps without a Tailwind build.
 * `stack.hostTailwind` names the host Tailwind that compiles those classes: one of HOST_TAILWIND, and
 * set exactly where utilityClasses is true (the codemod and linter need to know which syntax applies).
 */
export function stackProblems(app: AppEntry): string[] {
  const stack = app.stack as { utilityClasses?: unknown; hostTailwind?: unknown; tailwind?: string } | undefined;
  const problems: string[] = [];
  const value = stack?.utilityClasses;
  if (value !== undefined && typeof value !== "boolean") problems.push(`${app.id}: stack.utilityClasses must be true or false`);
  else if (value && stack?.tailwind !== "none") problems.push(`${app.id}: stack.utilityClasses is redundant: stack.tailwind ${stack?.tailwind} already checks Tailwind classes`);
  const host = stack?.hostTailwind;
  if (host !== undefined && !(HOST_TAILWIND as readonly unknown[]).includes(host))
    problems.push(`${app.id}: stack.hostTailwind must be one of ${HOST_TAILWIND.join(", ")}`);
  else if (host !== undefined && value !== true) problems.push(`${app.id}: stack.hostTailwind is set without stack.utilityClasses (it names the host that compiles those classes)`);
  if (value === true && host === undefined) problems.push(`${app.id}: stack.utilityClasses needs stack.hostTailwind (v3, v4 or uno: the host Tailwind that compiles its classes)`);
  return problems;
}

/** Workspace-relative paths an entry promises exist under the root, labelled for messages. */
function workspacePaths(app: AppEntry): Array<[label: string, path: string]> {
  const out: Array<[string, string]> = [
    ["repo", app.repo],
    ["root", app.root],
    ["commands.cwd", app.commands?.cwd],
    ...(app.scan?.paths ?? []).map((p): [string, string] => ["scan path", p]),
    ...(app.tests?.safe ?? []).map((t): [string, string] => ["tests.safe cwd", t.cwd]),
  ].filter((e): e is [string, string] => typeof e[1] === "string");
  if (app.entryStylesheet) out.push(["entryStylesheet", app.entryStylesheet]);
  if (app.run?.cwd) out.push(["run.cwd", app.run.cwd]);
  return out;
}

function allowlistProblems(id: string, file: string, text: string): string[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return [`${id}: allowlist ${file} is not JSON (${String(error).split("\n")[0]})`];
  }
  const problems: string[] = [];
  for (const key of ["literals", "twClasses"] as const) {
    if (!Array.isArray(data?.[key])) {
      problems.push(`${id}: allowlist ${file} needs a "${key}" array`);
      continue;
    }
    data[key].forEach((entry: any, i: number) => {
      if (typeof entry?.file !== "string" || !entry.file) problems.push(`${id}: allowlist ${key}[${i}] has no file`);
      if (key === "twClasses" && typeof entry?.className !== "string") problems.push(`${id}: allowlist ${key}[${i}] has no className`);
      if (typeof entry?.reason !== "string" || !entry.reason.trim()) problems.push(`${id}: allowlist ${key}[${i}] has no reason`);
      for (const field of ["match", "className"])
        if (typeof entry?.[field] === "string") {
          try {
            new RegExp(entry[field]);
          } catch {
            problems.push(`${id}: allowlist ${key}[${i}].${field} is not a valid regex`);
          }
        }
    });
  }
  return problems;
}

/** Every problem with the registry against `root` (workspace tree) and `dsRoot` (design-system checkout). */
export function checkRegistry(registry: Registry, opts: { root: string; dsRoot: string }): string[] {
  const problems = validateRegistry(registry);
  const portOwner = new Map<number, string>();
  registry.apps.forEach((app, index) => {
    for (const [label, path] of workspacePaths(app))
      if (!existsSync(resolvePath(opts.root, path))) problems.push(`${app.id}: ${label} ${path} does not exist under ${opts.root}`);

    const blockStart = PROFILE_PORTS.min + PROFILE_PORTS.block * index;
    for (const [name, port] of Object.entries(app.runProfile?.ports ?? {})) {
      const where = `${app.id}: port ${name}=${port}`;
      if (!Number.isInteger(port) || port < PROFILE_PORTS.min || port > PROFILE_PORTS.max)
        problems.push(`${where} is outside ${PROFILE_PORTS.min}-${PROFILE_PORTS.max}`);
      else if (port < blockStart || port >= blockStart + PROFILE_PORTS.block)
        problems.push(`${where} is outside its block ${blockStart}-${blockStart + PROFILE_PORTS.block - 1} (index ${index})`);
      if (OWNER_PORTS.includes(port)) problems.push(`${where} is an owner port`);
      const other = portOwner.get(port);
      if (other) problems.push(`${where} is also used by ${other}`);
      else portOwner.set(port, `${app.id}.${name}`);
    }
    problems.push(...portProblems(app, { start: blockStart, size: PROFILE_PORTS.block }), ...bunEnvFileProblems(app), ...stackProblems(app));

    if (app.allowlist) {
      const file = join(opts.dsRoot, app.allowlist);
      if (!existsSync(file)) problems.push(`${app.id}: allowlist ${app.allowlist} does not exist`);
      else problems.push(...allowlistProblems(app.id, app.allowlist, readFileSync(file, "utf8")));
    }
    for (const fixture of app.runProfile?.fixtures ?? []) {
      if (basename(fixture).startsWith(".env")) problems.push(`${app.id}: fixture ${fixture} is a .env file`);
      if (!existsSync(join(opts.dsRoot, fixture))) problems.push(`${app.id}: fixture ${fixture} does not exist in design-system`);
    }
    for (const m of (app.run?.start ?? "").matchAll(/\{ds\}\/(\S+)/g))
      if (!existsSync(join(opts.dsRoot, m[1]!))) problems.push(`${app.id}: run.start names {ds}/${m[1]}, which does not exist in design-system`);
  });
  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(value("--root") ?? resolve(DESIGN_SYSTEM_ROOT, ".."));
  const registryPath = resolve(value("--registry") ?? REGISTRY_PATH);
  const registry = loadRegistry(registryPath);
  const problems = checkRegistry(registry, { root, dsRoot: DESIGN_SYSTEM_ROOT });
  for (const problem of problems) console.log(problem);
  const runnable = registry.apps.filter((a) => a.run?.mode !== "none").length;
  console.log(`registry: ${registry.apps.length} apps (${runnable} runnable), root ${root}: ${problems.length ? `${problems.length} problem(s)` : "ok"}`);
  process.exit(problems.length ? 1 : 0);
}
