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
 *   - every allowlist file and fixture exists in this design-system checkout, an allowlist has the
 *     Allowlist shape with a reason on every entry, and no fixture is a .env file;
 *   - every `{ds}/...` script a run starts exists in this checkout.
 * Prints one line per problem and exits 1 when there is any.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { DESIGN_SYSTEM_ROOT, REGISTRY_PATH, loadRegistry, resolvePath, validateRegistry, type AppEntry, type Registry } from "./lib/registry";

/** Ports the owner's own services use; a run profile never binds them (TOOLING_CONTRACT.md). */
export const OWNER_PORTS: readonly number[] = [3998, 3999, 4318, 4800, 4801, 4820, 4830, 4840, 4888, 5173, 5174, 9222];
export const PROFILE_PORTS = { min: 47000, max: 47999, block: 10 } as const;

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
