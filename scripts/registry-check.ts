#!/usr/bin/env bun
/**
 * registry:check: is apps.json usable against a workspace tree?
 *
 *   bun run registry:check [--root <dir>] [--registry <apps.json>]
 *
 * Runs validateRegistry (structure: also every step's action, check/uncheck targets, verify.lightSteps,
 * and verify.expectedFailures' method, status 400-599, reason and a "^/" path pattern on the app's own
 * origin), then checks against the tree and this design-system checkout:
 *   - every workspace-relative path exists under --root: repo, root, scan paths, entry stylesheet,
 *     command and run cwds, safe-test cwds;
 *   - every profile port is in 47000-47999, not an owner port, unique across apps, and inside the
 *     app's block (47000 + 10 x its index, ten ports);
 *   - every allowedLocalPorts entry is inside the app's block (never an owner port): a run may reach
 *     only processes it starts itself;
 *   - no port string (commands, flags, env values, every route's path, waitFor and string step
 *     target/value, verify.darkSwitch's and verify.lightSwitch's target, selector, param, value, key
 *     and string step target/value, verify.lightSteps' string target/value, and every
 *     verify.expectedFailures urlPattern) names
 *       - an owner port, as a bare 4-5 digit number (also right after a %XX escape);
 *       - a loopback `host:<port>` or `host%3A<port>` outside the app's block. Loopback hosts, any case:
 *         localhost and *.localhost (trailing dot allowed), 127.x in any dotted form (127.1, 127.0.1,
 *         127.0.0.1), 0.0.0.0, and bracketed IPv6 [::1], [::], [::ffff:127.x] in any spelling;
 *       - a URL (`scheme://[userinfo@]host[:port]`, any scheme but file) whose host is loopback as a
 *         URL parser reads it (also 0x7f.1, 2130706433) and whose port is outside the block, or that has
 *         no explicit port at all: its implicit port is the scheme default, which no run controls;
 *       - a port option outside the block, any case: `-p <n>` / `-p<n>` / `-p=<n>`,
 *         `-[-]<any>port <n>` / `=<n>` / `:<n>`, `<word>port=<n>` / `<word>port:<n>`, `<WORD>PORT <n>`;
 *     use `{port:<name>}` for the app's own ports (a placeholder is never a problem);
 *   - every bun runtime command passes `--no-env-file` where bun reads it, so bun never auto-loads a
 *     `.env` from the app's directory (BUN_OPTIONS covers the processes it spawns): `bun test` and
 *     `bun build` anywhere; `bun run <script>`, `bun x <pkg>` / `bunx <pkg>` (with or without --bun) and
 *     `bun <file>` before the script, package or file (after it, bun hands the flag to the program).
 *     Only install, i, add, remove, pm, link, unlink, create, init, upgrade, outdated, --version and
 *     --help are exempt; `--env-file` is always a problem. Commands split at &&, ||, ;, |, &, ( and ); bun
 *     and bunx are found by name or path, after any VAR=value, exec, env (-i, -u NAME), time, nice, nohup,
 *     command or timeout N (a bun inside a quoted `sh -c '...'` is not seen; BUN_OPTIONS covers it);
 *   - `stack.utilityClasses` is a boolean and only set where `stack.tailwind` is "none", and comes with
 *     `stack.hostTailwind` (v3, v4 or uno: the host Tailwind that compiles its classes);
 *   - every `tests.baselines` key names one of the entry's commands, and its baseline records that command's
 *     text as `cmd`, an integer exit, a date and a method;
 *   - every allowlist file and fixture exists in this design-system checkout, an allowlist has the
 *     Allowlist shape with a reason on every entry, and no fixture is a .env file;
 *   - every `{ds}/...` script a run starts exists in this checkout.
 * Prints one line per problem and exits 1 when there is any.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { OWNER_PORTS } from "./lib/owner";
import { DESIGN_SYSTEM_ROOT, REGISTRY_PATH, loadRegistry, resolvePath, validateRegistry, type AppEntry, type Registry, type RouteSpec } from "./lib/registry";

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

/** Route and theme-switch (dark and light) strings a run navigates to or acts on. Numeric step values (offsets, waits) carry no port. */
function routeTexts(app: AppEntry): Array<[label: string, text: string]> {
  const out: Array<[string, unknown]> = [];
  const steps = (prefix: string, list: RouteSpec["steps"]) =>
    (list ?? []).forEach((step, j) => out.push([`${prefix}.steps[${j}].target`, step.target], [`${prefix}.steps[${j}].value`, step.value]));
  (app.routes ?? []).forEach((route, i) => {
    out.push([`routes[${i}].path`, route.path], [`routes[${i}].waitFor`, route.waitFor]);
    steps(`routes[${i}]`, route.steps);
  });
  for (const name of ["darkSwitch", "lightSwitch"] as const) {
    const sw = app.verify?.[name] as Record<string, unknown> | undefined;
    for (const key of ["target", "selector", "param", "value", "key"]) out.push([`verify.${name}.${key}`, sw?.[key]]);
    if (Array.isArray(sw?.steps)) steps(`verify.${name}`, sw.steps as RouteSpec["steps"]);
  }
  if (Array.isArray(app.verify?.lightSteps)) steps("verify.lightSteps", app.verify.lightSteps);
  (Array.isArray(app.verify?.expectedFailures) ? app.verify.expectedFailures : []).forEach((e, i) => out.push([`verify.expectedFailures[${i}].urlPattern`, e?.urlPattern]));
  return out.filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0);
}

/** Commands, the profile's flags and env values, and the route strings: every string that can carry a port. */
function portTexts(app: AppEntry): Array<[label: string, text: string]> {
  return [
    ...commandTexts(app),
    ...(app.runProfile?.flags?.length ? [["runProfile.flags", app.runProfile.flags.join(" ")] as [string, string]] : []),
    ...Object.entries(app.runProfile?.env ?? {}).map(([key, value]): [string, string] => [`runProfile.env.${key}`, `${key}=${value}`]),
    ...routeTexts(app),
  ];
}

/** Whether a host, as written, names this machine once a URL parser reads it (any case, IPv4 or IPv6 spelling). */
function isLoopbackHost(written: string): boolean {
  let host: string;
  try {
    host = new URL(`http://${written}/`).hostname.replace(/\.$/, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "0.0.0.0" ||
    ["[::1]", "[::]", "[::ffff:0:0]"].includes(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
  );
}

/** Not inside a longer name or number, or right after a %XX escape (`%2F%2Flocalhost`). */
const STARTS = String.raw`(?:(?<![\w.%-])|(?<=%[0-9a-f]{2}))`;
/** A bare loopback `host:<port>` or `host%3A<port>`; isLoopbackHost confirms the bracketed forms. */
const LOOPBACK_PORT = new RegExp(String.raw`${STARTS}((?:[a-z0-9-]+\.)*localhost\.?|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|\[[0-9a-f:.]+\])(?::|%3a)(\d{1,5})(?!\d)`, "gi");
/** `scheme://[userinfo@]host[:port]...`: scheme (1), host (2), what follows the host's colon (3). */
const URL_AUTHORITY = /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#@]*@)?(\[[^\]\s/]*\]|[\w.%~-]*)(?::([^\s/?#"'`<>]*))?[^\s"'`<>]*/gi;
const PORT_END = String.raw`(?![\w./-])`;
const PORT_OPTIONS = [
  new RegExp(String.raw`(?<![\w-])-p(?:[=:]|\s+)?(\d{1,5})${PORT_END}`, "gi"), // -p N, -pN, -p=N
  new RegExp(String.raw`(?<![\w-])-[\w-]*port(?:[=:]|\s+)(\d{1,5})${PORT_END}`, "gi"), // --port N, --api-port=N, -port:N
  new RegExp(String.raw`\b\w*port["']?\s*[=:]\s*["']?(\d{1,5})${PORT_END}`, "gi"), // PORT=N, api_port:N, "port": N
  new RegExp(String.raw`\b\w*PORT\s+(\d{1,5})${PORT_END}`, "g"), // PORT N
];
const BARE_NUMBER = new RegExp(String.raw`(?:(?<![\w.])|(?<=%[0-9a-f]{2}))(\d{4,5})(?![\w.])`, "gi");

/**
 * Ports an entry names outside its own block: owner ports anywhere; loopback `host:<port>`, loopback URL
 * ports and port options outside the block; loopback URLs without an explicit port; allowedLocalPorts
 * outside the block. Scans every string portTexts lists.
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
    const reported = new Set<string>();
    const report = (key: string, message: string) => {
      if (reported.has(key)) return;
      reported.add(key);
      problems.push(`${app.id}: ${label} ${message}`);
    };
    const outside = (port: number) => {
      if (!inBlock(port)) report(`port ${port}`, `names port ${port} outside its block ${range} (use {port:<name>})`);
    };
    for (const m of text.matchAll(BARE_NUMBER)) {
      const port = Number(m[1]);
      if (OWNER_PORTS.includes(port)) report(`port ${port}`, `names owner port ${port}`);
    }
    for (const m of text.matchAll(LOOPBACK_PORT)) if (isLoopbackHost(m[1]!)) outside(Number(m[2]));
    for (const m of text.matchAll(URL_AUTHORITY)) {
      if (m[1]!.toLowerCase() === "file" || !isLoopbackHost(m[2]!)) continue;
      const port = m[3] ?? "";
      if (/^\d/.test(port)) outside(parseInt(port, 10));
      else if (!/^\{port:[\w-]+\}/.test(port))
        report(`url ${m[0]}`, `names loopback URL ${m[0]} without an explicit port (its port is the scheme default; give it {port:<name>})`);
    }
    for (const re of PORT_OPTIONS) for (const m of text.matchAll(re)) outside(Number(m[1]));
  }
  return problems;
}

/** bun subcommands that do not run app code under the bun runtime (no .env auto-load). */
const BUN_NON_RUNTIME = new Set(["install", "i", "add", "remove", "pm", "link", "unlink", "create", "init", "upgrade", "outdated"]);
/** bun options that take the next word as their value, so that word is not the script, package or file. */
const BUN_VALUE_OPTIONS = new Set(["--cwd", "--config", "-c", "--env-file", "--preload", "-r", "--require", "--import", "--tsconfig-override", "--define", "-d", "--loader", "-l", "--filter", "-F"]);

/**
 * Why one bun invocation (`command` is bun or bunx) would auto-load .env, or null when it would not:
 * no --no-env-file at all, or one that comes `after` the script, package or file it hands it to.
 */
function bunEnvFileGap(command: string, args: string[]): { after?: string } | null {
  let i = 0;
  let early = false;
  const options = () => {
    for (; i < args.length && args[i]!.startsWith("-"); i++) {
      if (args[i] === "--no-env-file") early = true;
      else if (BUN_VALUE_OPTIONS.has(args[i]!)) i++;
    }
  };
  if (command === "bun") {
    options();
    if (args.slice(0, i).some((a) => a === "--version" || a === "--help")) return null;
    const sub = args[i];
    if (sub && BUN_NON_RUNTIME.has(sub)) return null;
    if (sub === "test" || sub === "build") return args.includes("--no-env-file") ? null : {};
    if (sub === "run" || sub === "x") {
      i++;
      options();
    }
  } else options();
  if (early) return null;
  return args.includes("--no-env-file") ? { after: args[i] } : {};
}

/** Every bun runtime invocation in the entry's commands must pass --no-env-file where bun reads it. */
export function bunEnvFileProblems(app: AppEntry): string[] {
  const problems: string[] = [];
  for (const [label, text] of commandTexts(app)) {
    for (const segment of text.split(/&&|\|\||[;|&()\n]/)) {
      const words = segment.trim().split(/\s+/);
      let i = 0;
      // Wrappers before the command: VAR=value, exec, env (and its -i/-u NAME), time, nice, nohup, command, timeout N.
      for (;;) {
        const word = words[i];
        if (word === undefined) break;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ["exec", "env", "time", "nice", "nohup", "command", "-i", "-"].includes(word)) i++;
        else if (word === "-u" || word === "timeout" || word === "-n") i += 2;
        else break;
      }
      const command = words[i]?.split("/").pop();
      if (command !== "bun" && command !== "bunx") continue;
      // An explicit env file loads whatever it names, whatever --no-env-file says about the default .env.
      if (words.slice(i + 1).some((word) => word === "--env-file" || word.startsWith("--env-file=")))
        problems.push(`${app.id}: ${label} passes --env-file, which loads an env file into the run: ${segment.trim()}`);
      const gap = bunEnvFileGap(command, words.slice(i + 1));
      if (gap?.after) problems.push(`${app.id}: ${label} puts --no-env-file after ${gap.after}, so bun hands it to ${gap.after} and still auto-loads .env (move it before ${gap.after}): ${segment.trim()}`);
      else if (gap) problems.push(`${app.id}: ${label} runs bun without --no-env-file (bun auto-loads .env from its cwd): ${segment.trim()}`);
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

/**
 * `tests.baselines` (what test:apps compares a run with): every key names a command the entry has
 * ("tests.safe[<i>]", "commands.typecheck", "commands.build"), every baseline records `cmd` and it is that
 * command's text (missing: a stale baseline could not be told apart; another text: it is stale), and every
 * baseline has an integer exit, a YYYY-MM-DD date, a method, non-negative integer counts and a string list
 * of failing names.
 */
export function baselineProblems(app: AppEntry): string[] {
  const problems: string[] = [];
  for (const [key, baseline] of Object.entries(app.tests?.baselines ?? {})) {
    const where = `${app.id}: tests.baselines["${key}"]`;
    const safe = /^tests\.safe\[(\d+)\]$/.exec(key);
    const named = /^commands\.(typecheck|build)$/.exec(key);
    const command = safe ? app.tests?.safe?.[Number(safe[1])]?.cmd : named ? app.commands?.[named[1] as "typecheck" | "build"] : undefined;
    if (!command) problems.push(`${where} names no command of the entry (keys: tests.safe[<i>], commands.typecheck, commands.build)`);
    const b = baseline as unknown as Record<string, unknown>;
    if (typeof b?.cmd !== "string") problems.push(`${where} needs cmd, the command text it was recorded for (without it a stale baseline cannot be told apart); re-record it with test:apps`);
    else if (command && b.cmd !== command)
      problems.push(`${where} was recorded for another command (${b.cmd}); re-record it with test:apps (the managing agent)`);
    if (!Number.isInteger(b?.exit)) problems.push(`${where} needs an integer exit`);
    if (typeof b?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) problems.push(`${where} needs a YYYY-MM-DD date`);
    if (typeof b?.method !== "string" || !b.method.trim()) problems.push(`${where} needs a method`);
    for (const count of ["pass", "fail", "errors"])
      if (b?.[count] !== undefined && !(Number.isInteger(b[count]) && (b[count] as number) >= 0)) problems.push(`${where}.${count} must be a non-negative integer`);
    if (b?.failing !== undefined && !(Array.isArray(b.failing) && b.failing.every((name) => typeof name === "string")))
      problems.push(`${where}.failing must be a list of names`);
  }
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
    problems.push(...portProblems(app, { start: blockStart, size: PROFILE_PORTS.block }), ...bunEnvFileProblems(app), ...stackProblems(app), ...baselineProblems(app));

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
