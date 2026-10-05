#!/usr/bin/env bun
/**
 * Freeze the inputs the screenshots render into fixtures/frozen-inputs.tar.gz:
 * both docs corpora, the shared global page theme, the active code theme, and
 * the repo theme folders. BEFORE and AFTER then render byte-identical content,
 * so a diff can only come from the code under test (CSS / components).
 *
 * Run once to create the baseline; it refuses to overwrite an existing fixture
 * without --force (re-freezing means re-capturing BEFORE).
 *
 *   bun freeze.ts [--force]
 *
 * Every source is only READ (rsync from it into a temp dir). Sources:
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { DOCS_SYSTEM_REPO, FIXTURE_ARCHIVE, FIXTURE_MANIFEST } from "./lib/env";

const LIVE_STATE = join(homedir(), ".local/state/codecaine-docs");
const WORKSPACE_REPO = "/Users/Ford/workspace";

const SOURCES = [
  { from: join(DOCS_SYSTEM_REPO, "docs"), to: "corpora/docs-system/docs", exclude: [".index", ".DS_Store"] },
  { from: join(WORKSPACE_REPO, "docs"), to: "corpora/workspace/docs", exclude: [".index", ".DS_Store"] },
  { from: join(LIVE_STATE, "themes"), to: "state/themes", exclude: ["*.bak*", ".DS_Store"] },
  { from: join(LIVE_STATE, "code-themes"), to: "state/code-themes", exclude: [".DS_Store"] },
  { from: join(DOCS_SYSTEM_REPO, "themes"), to: "repo-themes", exclude: [".DS_Store"] },
] as const;

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function gitInfo(repo: string, pathspec: string) {
  try {
    return {
      repo,
      head: run("git", ["-C", repo, "rev-parse", "HEAD"]).trim(),
      dirty: run("git", ["-C", repo, "status", "--porcelain", "--", pathspec]).split("\n").filter(Boolean),
    };
  } catch (error) {
    return { repo, error: error instanceof Error ? error.message : String(error) };
  }
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  return files;
}

const force = process.argv.includes("--force");
if (existsSync(FIXTURE_ARCHIVE) && !force) {
  console.error(`${FIXTURE_ARCHIVE} already exists. Re-freezing changes the baseline: pass --force, then re-capture BEFORE.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "ds-verify-freeze-"));
try {
  for (const source of SOURCES) {
    if (!existsSync(source.from)) throw new Error(`Missing source: ${source.from}`);
    const target = join(work, source.to);
    mkdirSync(target, { recursive: true });
    run("rsync", ["-a", ...source.exclude.flatMap((pattern) => ["--exclude", pattern]), `${source.from}/`, `${target}/`]);
  }
  const files = listFiles(work).map((file) => ({
    path: relative(work, file),
    bytes: statSync(file).size,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
  mkdirSync(join(FIXTURE_ARCHIVE, ".."), { recursive: true });
  // COPYFILE_DISABLE keeps macOS from adding ._ AppleDouble entries.
  const tar = spawnSync("tar", ["-czf", FIXTURE_ARCHIVE, "-C", work, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const archiveSha = createHash("sha256").update(readFileSync(FIXTURE_ARCHIVE)).digest("hex");
  const manifest = {
    createdAt: new Date().toISOString(),
    purpose: "Frozen inputs for the docs-system screenshot harness. snapshot.ts extracts this into its staging dir on every run.",
    archive: { file: "frozen-inputs.tar.gz", sha256: archiveSha, bytes: statSync(FIXTURE_ARCHIVE).size },
    sources: SOURCES.map((source) => ({ from: source.from, to: source.to, exclude: source.exclude })),
    git: {
      docsSystem: gitInfo(DOCS_SYSTEM_REPO, "docs"),
      workspaceDocs: gitInfo(WORKSPACE_REPO, "docs"),
    },
    notes: [
      "state/ is a copy of ~/.local/state/codecaine-docs/{themes,code-themes} only (no tokens, daemon or project files).",
      "The playground does NOT read this fixture: it bundles docs-system/docs/**/doc.json from the live checkout via import.meta.glob.",
    ],
    files,
  };
  writeFileSync(FIXTURE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${FIXTURE_ARCHIVE} (${files.length} files, sha256 ${archiveSha.slice(0, 12)}...)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
