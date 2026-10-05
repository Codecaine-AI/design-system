#!/usr/bin/env bun
/**
 * Isolated launcher for docs-workbench: the "State isolation" recipe of
 * verification/docs-system/README.md, with a corpus copied from repo content instead of
 * the frozen tarball (which holds private docs).
 *
 *   bun apps/fixtures/docs-workbench/serve.ts --root <workspace> --tmp <dir> \
 *     --api-port <n> --ui-port <n> --dead-kernel-port <n>
 *
 * 1. Copies the root's docs-system `docs/` to <tmp>/docs-workbench/corpus/docs and its
 *    `themes/` to <tmp>/docs-workbench/repo-themes (the backlinks index lands in the copy).
 * 2. Refuses to start unless CODECAINE_DOCS_STATE_DIR, _GLOBAL_THEMES and _CODE_THEMES point
 *    under --tmp, and unless DOCS_SHARED_API_*, DOCS_STATIC and DOCS_API are unset.
 * 3. Runs `docs-cli serve --standalone --dev` (never the central service) with --root and
 *    --themes-root at the copies and --kernel-url at a dead port in the app's own block.
 *    Children stay in this process group, so stopping the group stops serve and vite.
 *
 * Reads only the root's repo content; writes only under --tmp (vite still writes its usual
 * dependency cache to docs-workbench's node_modules/.vite).
 */
import { cpSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { ensureTmpDir, parseFixtureArgs, runFixture } from "../lib/fixture-server";

const DOCS_SYSTEM = "codecaine/core/docs-system";
export const STATE_VARS = ["CODECAINE_DOCS_STATE_DIR", "CODECAINE_DOCS_GLOBAL_THEMES", "CODECAINE_DOCS_CODE_THEMES"] as const;
export const FORBIDDEN_VARS = ["DOCS_SHARED_API_URL", "DOCS_SHARED_API_TOKEN", "DOCS_SHARED_PROJECT_ID", "DOCS_STATIC", "DOCS_API"] as const;

/** Problems with the environment the serve would inherit; empty when isolated. */
export function isolationProblems(env: Record<string, string | undefined>, tmp: string): string[] {
  const problems: string[] = [];
  for (const name of STATE_VARS) {
    const value = env[name];
    if (!value) problems.push(`${name} is unset (the serve would use the live ~/.local/state/codecaine-docs)`);
    else if (resolve(value) !== tmp && !resolve(value).startsWith(tmp + sep)) problems.push(`${name}=${value} is outside --tmp ${tmp}`);
  }
  for (const name of FORBIDDEN_VARS) if (env[name] !== undefined) problems.push(`${name} is set; the serve could reach a shared docs authority`);
  for (const name of Object.keys(env)) if (name.startsWith("DOCS_SHARED_API_") && !FORBIDDEN_VARS.includes(name as never)) problems.push(`${name} is set`);
  return problems;
}

async function main() {
  const args = parseFixtureArgs(process.argv.slice(2));
  const { api, ui } = args.ports;
  const deadKernel = args.ports["dead-kernel"];
  if (!api || !ui || !deadKernel) throw new Error("--api-port, --ui-port and --dead-kernel-port are required");
  const problems = isolationProblems(process.env, args.tmp);
  if (problems.length) throw new Error(`not isolated:\n  ${problems.join("\n  ")}`);

  const repo = join(args.root, DOCS_SYSTEM);
  if (!existsSync(join(repo, "packages/docs-cli/src/index.ts"))) throw new Error(`no docs-system checkout at ${repo}`);
  const base = ensureTmpDir(args.tmp, join(args.tmp, "docs-workbench"));
  const corpus = join(base, "corpus", "docs");
  const themes = join(base, "repo-themes");
  ensureTmpDir(args.tmp, join(base, "corpus"));
  cpSync(join(repo, "docs"), corpus, { recursive: true });
  cpSync(join(repo, "themes"), themes, { recursive: true });
  for (const name of STATE_VARS) ensureTmpDir(args.tmp, process.env[name]!);

  const cmd = [
    "bun", "packages/docs-cli/src/index.ts", "serve", "--standalone",
    "--root", corpus, "--themes-root", themes, "--dev",
    "--port", String(api), "--ui-port", String(ui),
    "--kernel-url", `http://127.0.0.1:${deadKernel}`,
  ];
  console.log(`docs-workbench fixture: ${cmd.join(" ")}`);
  const child = Bun.spawn(cmd, { cwd: repo, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  process.exit(await child.exited);
}

if (import.meta.main) await runFixture("docs-workbench fixture", main);
