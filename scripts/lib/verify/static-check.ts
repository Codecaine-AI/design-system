/**
 * What verify:apps checks without running the app.
 *
 * packageCheck (every run mode): the design-system package the app uses resolves inside --root and
 * its dist/css/tokens.css is the current build's (sha256). A live or vendored package resolves the way
 * node would from the app root; relative-import follows the entry stylesheet to the package it loads;
 * copy checks the copied tokens file; host-css is n/a (the host resolves the package).
 *
 * staticCheck (run mode none): packageCheck, plus the entry stylesheet really loads that package's
 * tokens.css: active imports only (the linter's load graph strips comments), resolved to the file the
 * package builds, with the build's sha256. The app is reported as not runtime-verified.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildLoadGraph, type Load } from "../lint/loads";
import { clearCaches, findPackageDir, isInside, owningPackage } from "../lint/workspace";
import { type AppEntry, resolvePath } from "../registry";
import { type Assertion, fail, na, pass } from "./assertions";
import type { BuildValues } from "./tokens";

export const PACKAGE = "@codecaine-ai/design-system";
/** Consumers that resolve the package through node resolution from the app root. */
const RESOLVED = new Set(["workspace", "link", "npm-file", "vendor-tgz"]);

const sha256 = (path: string) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/** The build file a tokens load must match: tokens.css, or tokens-dark-first.css. */
function buildMember(load: Pick<Load, "kind">): string {
  return load.kind === "tokens-dark-first" ? "dist/css/tokens-dark-first.css" : "dist/css/tokens.css";
}

function buildSha(values: BuildValues, member: string): string | null {
  return member === "dist/css/tokens.css" ? values.tokensCssSha256 : sha256(join(values.dir, member));
}

/** The first tokens stylesheet the entry loads (tokens-dark-first counts on dark-first surfaces), or null. */
function tokensLoad(app: AppEntry, root: string): { entry: string; exists: boolean; load: Load | null } {
  clearCaches(); // the linter's file and package caches; files may have changed since the last read
  const entry = resolvePath(root, app.entryStylesheet!);
  const graph = buildLoadGraph(entry);
  const kinds = app.theme?.rule === "dark-first" ? ["tokens", "tokens-dark-first"] : ["tokens"];
  return { entry, exists: graph.entryExists, load: graph.loads.find((l) => kinds.includes(l.kind)) ?? null };
}

export interface PackageCheck {
  /** Real path of the design-system package the app resolves (null for copy, host-css, or when it does not resolve). */
  dir: string | null;
  assertions: Assertion[];
}

/** Every run mode: the package the app uses is inside the root and carries the current build's tokens.css. */
export function packageCheck(app: AppEntry, root: string, values: BuildValues): PackageCheck {
  const rootReal = realpathSync(root);
  const via = app.consume.via;
  const appRoot = resolvePath(root, app.root);
  const judge = (dir: string, how: string): PackageCheck => {
    const tokensCss = join(dir, "dist/css/tokens.css");
    const sha = sha256(tokensCss);
    const detail = { packageDir: dir, how, tokensCssSha256: sha, buildSha256: values.tokensCssSha256 };
    if (!isInside(dir, rootReal)) return { dir, assertions: [fail("package", `${PACKAGE} (${how}) is outside the root: ${dir}`, detail)] };
    if (sha !== values.tokensCssSha256) return { dir, assertions: [fail("package", `${PACKAGE} at ${dir} has a tokens.css that differs from the current build`, detail)] };
    return { dir, assertions: [pass("package", `${PACKAGE} (${how}) is inside the root with the current tokens.css`, detail)] };
  };

  if (RESOLVED.has(via)) {
    const found = findPackageDir(PACKAGE, appRoot);
    if (!found) return { dir: null, assertions: [fail("package", `${PACKAGE} does not resolve from ${appRoot} (consume.via ${via})`)] };
    return judge(realpathSync(found), `resolved from ${app.root}`);
  }
  if (via === "host-css") return { dir: null, assertions: [na("package", "consumes the tokens through its host's CSS (consume.via host-css); the host resolves the package")] };
  if (!app.entryStylesheet) return { dir: null, assertions: [fail("package", `consume.via ${via} needs an entry stylesheet to find the design-system files`)] };
  const { entry, exists, load } = tokensLoad(app, root);
  if (!exists) return { dir: null, assertions: [fail("package", `${app.entryStylesheet} does not exist`)] };
  if (!load?.path) return { dir: null, assertions: [fail("package", `consume.via ${via}: ${app.entryStylesheet} loads no tokens.css that resolves`, { entry })] };
  if (via === "copy") {
    const member = buildMember(load);
    const sha = sha256(load.path);
    const want = buildSha(values, member);
    const detail = { file: load.path, copied: load.copied, sha256: sha, buildSha256: want };
    if (!load.copied) return { dir: null, assertions: [fail("package", `consume.via copy, but ${load.spec} is not a copy of the package's ${member}`, detail)] };
    if (!isInside(load.path, rootReal)) return { dir: null, assertions: [fail("package", `the copied ${member} is outside the root: ${load.path}`, detail)] };
    if (sha !== want) return { dir: null, assertions: [fail("package", `the copied tokens (${load.path}) differ from the current build's ${member}`, detail)] };
    return { dir: null, assertions: [pass("package", `the copied tokens (${load.path}) match the current build's ${member}`, detail)] };
  }
  // relative-import: the package the stylesheet reaches.
  const owner = owningPackage(load.path);
  if (owner?.name !== PACKAGE) return { dir: null, assertions: [fail("package", `${load.spec} loads ${load.path}, which is not in ${PACKAGE}`)] };
  return judge(real(owner.dir), `imported by ${app.entryStylesheet}`);
}

/** Run mode none: the entry stylesheet's active imports load the resolved package's tokens.css. */
export function entryStylesheetCheck(app: AppEntry, root: string, values: BuildValues, packageDir: string | null): Assertion {
  if (app.entryStylesheet === null) return na("entry-stylesheet", "no entry stylesheet (the host loads the tokens)");
  const { entry, exists, load } = tokensLoad(app, root);
  if (!exists) return fail("entry-stylesheet", `${app.entryStylesheet} does not exist`);
  if (!load) return fail("entry-stylesheet", `${app.entryStylesheet} does not load tokens.css (an import inside a comment does not count)`, { entry });
  const member = buildMember(load);
  const detail: Record<string, unknown> = { entry, spec: load.spec, from: load.from, line: load.line, file: load.path, copied: load.copied };
  if (!load.path) return fail("entry-stylesheet", `${load.spec} (${load.from}:${load.line}) does not resolve`, detail);
  const want = buildSha(values, member);
  const sha = sha256(load.path);
  Object.assign(detail, { sha256: sha, buildSha256: want });
  if (load.copied) {
    if (app.consume.via !== "copy") return fail("entry-stylesheet", `${load.spec} is a copy of ${member}; consume.via ${app.consume.via} loads it from the package`, detail);
  } else {
    const owner = owningPackage(load.path);
    const expected = owner?.name === PACKAGE ? real(join(owner.dir, member)) : null;
    if (!expected || real(load.path) !== expected) return fail("entry-stylesheet", `${load.spec} loads ${load.path}, not ${PACKAGE}'s ${member}`, detail);
    if (packageDir && real(owner!.dir) !== packageDir) {
      return fail("entry-stylesheet", `${load.spec} loads ${member} from ${real(owner!.dir)}, not the package the app resolves (${packageDir})`, detail);
    }
  }
  if (sha !== want) return fail("entry-stylesheet", `${load.spec} loads ${load.path}, which differs from the current build's ${member}`, detail);
  return pass("entry-stylesheet", `${app.entryStylesheet} loads ${member} (${load.from}:${load.line}) with the build's content`, detail);
}

/** Run mode none: the app is not started; the package and the entry stylesheet are checked on disk. */
export function staticCheck(app: AppEntry, root: string, values: BuildValues): Assertion[] {
  const pkg = packageCheck(app, root, values);
  return [na("runtime", `not runtime-verified: run mode none (${app.run.reason ?? "no reason given"})`), ...pkg.assertions, entryStylesheetCheck(app, root, values, pkg.dir)];
}
