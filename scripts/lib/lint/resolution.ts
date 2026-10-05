/**
 * Check 1, resolution: the app reaches the design system inside the root.
 *
 * - The app's package.json declares @codecaine-ai/design-system the way
 *   `consume.via` says (workspace:, link:, file:, file:vendor/<name>.tgz).
 * - The package resolves from the app root, and its real path is inside the root.
 *   A live link (workspace, link, npm-file, relative-import) must reach the root's
 *   design-system checkout (any source checkout with tokens/ when the root has none),
 *   never a packed copy or a second checkout.
 * - Every design-system file the entry stylesheet loads is inside the root and comes
 *   from the package the app resolves; a local copy of a design-system file (by its
 *   header) is allowed only for consume.via copy.
 * - vendor-tgz: the tgz and the installed copy each carry a dist/css/tokens.css
 *   whose sha256 equals the current build's.
 * - copy: the copied tokens file the entry stylesheet loads has the build's hash.
 * - Every library the app uses that itself depends on the package (workspace
 *   packages, followed through their own dependencies, and installed packages
 *   one level deep) resolves inside the root, and so does its copy of the package.
 * - host-css: nothing to resolve; the registry marks the check n/a.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildFile, fileSha256, sha256 } from "./design-system";
import type { AppContext, CheckOutput, Finding } from "./types";
import { PACKAGE_NAME } from "./types";
import { findPackageDir, isDir, isInside, lineOf, owningPackage, readJson, readText, realpathOrNull } from "./workspace";

const DEP_FIELDS = ["dependencies", "peerDependencies", "devDependencies", "optionalDependencies"] as const;

type Via = AppContext["app"]["consume"]["via"];

const EXPECTED_SPEC: Partial<Record<Via, { test: (spec: string) => boolean; want: string }>> = {
  workspace: { test: (s) => s.startsWith("workspace:"), want: '"workspace:*"' },
  link: { test: (s) => s.startsWith("link:"), want: '"link:@codecaine-ai/design-system"' },
  "npm-file": { test: (s) => s.startsWith("file:") && !s.endsWith(".tgz"), want: '"file:<path to design-system>"' },
  "vendor-tgz": { test: (s) => /^file:.*\.tgz$/.test(s), want: '"file:vendor/<name>.tgz"' },
};

const LIVE: Via[] = ["workspace", "link", "npm-file", "relative-import"];

function declaredSpec(pkg: any, name: string): string | null {
  for (const f of DEP_FIELDS) if (pkg?.[f] && typeof pkg[f][name] === "string") return pkg[f][name];
  return null;
}

function tgzTokensSha(tgz: string, member: string): string | null {
  const r = spawnSync("tar", ["-xzOf", tgz, `package/${member}`], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && r.stdout?.length ? sha256(r.stdout) : null;
}

export function checkResolution(ctx: AppContext): CheckOutput {
  const { app, root, appRoot, ds } = ctx;
  const violations: Finding[] = [];
  const warnings: Finding[] = [];
  const via = app.consume.via;
  const pkgPath = join(appRoot, "package.json");
  const pkgRel = ctx.rel(pkgPath);
  const pkg = readJson(pkgPath);
  const pkgText = readText(pkgPath) ?? "";
  const tokensMember = "dist/css/tokens.css";

  if (via === "host-css") {
    return { violations, warnings, na: `${app.id} consumes the tokens through its host's CSS (consume.via host-css)` };
  }

  // Declaration.
  const expected = EXPECTED_SPEC[via];
  const spec = pkg ? declaredSpec(pkg, PACKAGE_NAME) : null;
  if (expected) {
    if (!pkg) violations.push({ file: pkgRel, line: 0, message: "no package.json in the app root" });
    else if (spec === null) {
      violations.push({ file: pkgRel, line: 1, message: `does not declare ${PACKAGE_NAME}; consume.via ${via} expects ${expected.want}` });
    } else if (!expected.test(spec)) {
      violations.push({ file: pkgRel, line: lineOf(pkgText, `"${PACKAGE_NAME}"`), message: `declares ${PACKAGE_NAME} as "${spec}"; consume.via ${via} expects ${expected.want}` });
    }
  }
  const depLine = lineOf(pkgText, `"${PACKAGE_NAME}"`);

  // Where a live link must lead: the root's design-system checkout when the root has one,
  // else any source checkout (a directory with tokens/), never a packed copy.
  const rootCheckout = realpathOrNull(join(root, "design-system"));
  const canonical = rootCheckout && readJson(join(rootCheckout, "package.json"))?.name === PACKAGE_NAME ? rootCheckout : null;
  const notLive = (dir: string): string | null => {
    if (canonical) return dir === canonical ? null : `reaches ${ctx.rel(dir)}, not the root's design-system checkout (${ctx.rel(canonical)})`;
    return isDir(join(dir, "tokens")) ? null : `reaches ${ctx.rel(dir)}, a packed copy, not a source checkout`;
  };

  // The package itself.
  let dsReal: string | null = null;
  if (via !== "relative-import" && via !== "copy") {
    const found = findPackageDir(PACKAGE_NAME, appRoot);
    dsReal = found ? realpathOrNull(found) : null;
    if (!dsReal) violations.push({ file: pkgRel, line: depLine, message: `${PACKAGE_NAME} does not resolve from ${ctx.rel(appRoot)} (not installed?)` });
    else if (!isInside(dsReal, root)) violations.push({ file: pkgRel, line: depLine, message: `${PACKAGE_NAME} resolves to ${dsReal}, outside the root ${root}` });
    else if (LIVE.includes(via)) {
      const problem = notLive(dsReal);
      if (problem) violations.push({ file: pkgRel, line: depLine, message: `${PACKAGE_NAME} ${problem}; consume.via ${via} needs a live link` });
    }
  }

  // Vendored and copied files match the current build.
  const buildSha = (member: string) => {
    const f = buildFile(ds, member);
    return f ? fileSha256(f) : null;
  };
  if (via === "vendor-tgz") {
    const want = buildSha(tokensMember);
    if (!want) violations.push({ file: pkgRel, line: depLine, message: `the current build has no ${tokensMember} to compare with` });
    if (spec && /^file:.*\.tgz$/.test(spec)) {
      const tgz = join(appRoot, spec.slice("file:".length));
      const tgzReal = realpathOrNull(tgz);
      if (!tgzReal) violations.push({ file: pkgRel, line: depLine, message: `vendored package ${spec.slice(5)} not found` });
      else {
        if (!isInside(tgzReal, root)) violations.push({ file: pkgRel, line: depLine, message: `vendored package ${tgzReal} is outside the root ${root}` });
        const got = tgzTokensSha(tgzReal, tokensMember);
        if (!got) violations.push({ file: ctx.rel(tgzReal), line: 0, message: `the tgz has no package/${tokensMember}` });
        else if (want && got !== want) {
          violations.push({ file: ctx.rel(tgzReal), line: 0, message: `${tokensMember} in the tgz (sha256 ${got.slice(0, 12)}) differs from the current build (${want.slice(0, 12)}); run \`bun run pack\` and vendor the new tgz` });
        }
      }
    }
    if (dsReal && want) {
      const installed = fileSha256(join(dsReal, tokensMember));
      if (!installed) violations.push({ file: ctx.rel(dsReal), line: 0, message: `the installed copy has no ${tokensMember}` });
      else if (installed !== want) {
        violations.push({ file: ctx.rel(join(dsReal, tokensMember)), line: 0, message: `the installed copy (sha256 ${installed.slice(0, 12)}) differs from the current build (${want.slice(0, 12)}); reinstall from the vendored tgz` });
      }
    }
  }

  // Every design-system file the entry stylesheet loads comes from where consume.via says.
  const graph = ctx.loads();
  const dsLoads = graph.loads.filter((l) => l.kind !== "tailwindcss");
  if (via === "copy" || via === "relative-import") {
    if (!graph.entryExists) {
      violations.push({ file: app.entryStylesheet ?? ctx.rel(appRoot), line: 0, message: `consume.via ${via}: the entry stylesheet is missing, so the design-system files cannot be found` });
    } else if (!dsLoads.length) {
      violations.push({ file: ctx.rel(graph.entry!), line: 1, message: `consume.via ${via}: the entry stylesheet loads no design-system file` });
    }
  }
  for (const l of dsLoads) {
    if (!l.path) continue; // reported by the wiring check
    const at = { file: ctx.rel(l.from), line: l.line };
    if (!isInside(l.path, root)) {
      violations.push({ ...at, message: `${l.spec} resolves to ${l.path}, outside the root ${root}` });
      continue;
    }
    if (l.copied) {
      if (via !== "copy") violations.push({ ...at, message: `${l.spec} is a copy of a design-system file (${ctx.rel(l.path)}); consume.via ${via} loads it from the package` });
      continue;
    }
    const owner = owningPackage(l.path);
    if (owner?.name !== PACKAGE_NAME) continue; // text-measure's fonts.css
    const ownerReal = realpathOrNull(owner.dir) ?? owner.dir;
    if (dsReal && ownerReal !== dsReal) {
      violations.push({ ...at, message: `${l.spec} loads ${ctx.rel(l.path)}, not the package the app resolves (${ctx.rel(dsReal)})` });
    } else if (via === "relative-import") {
      const problem = notLive(ownerReal);
      if (problem) violations.push({ ...at, message: `${l.spec} ${problem}` });
    }
  }
  if (via === "copy") {
    const tokens = dsLoads.find((l) => l.copied && (l.kind === "tokens" || l.kind === "tokens-dark-first"));
    if (!tokens?.path) {
      if (graph.entryExists) violations.push({ file: ctx.rel(graph.entry!), line: 1, message: "consume.via copy: no copied tokens.css is loaded from the entry stylesheet" });
    } else {
      const member = tokens.kind === "tokens-dark-first" ? "dist/css/tokens-dark-first.css" : "dist/css/tokens.css";
      const want = buildSha(member);
      const got = fileSha256(tokens.path);
      if (!want) violations.push({ file: ctx.rel(tokens.path), line: 0, message: `the current build has no ${member} to compare with` });
      else if (got !== want) {
        violations.push({ file: ctx.rel(tokens.path), line: 0, message: `copied tokens (sha256 ${got?.slice(0, 12)}) differ from the current build's ${member} (${want.slice(0, 12)}); copy it again` });
      }
    }
  }

  // Libraries the app uses that depend on the package themselves.
  const seen = new Set<string>();
  const queue: Array<{ dir: string; via: string; depth: number }> = [{ dir: appRoot, via: app.id, depth: 0 }];
  while (queue.length) {
    const { dir, via: chain, depth } = queue.shift()!;
    const p = readJson(join(dir, "package.json"));
    if (!p) continue;
    const fields = depth === 0 ? DEP_FIELDS : (["dependencies", "peerDependencies", "optionalDependencies"] as const);
    const names = new Set<string>();
    for (const f of fields) for (const n of Object.keys(p[f] ?? {})) if (n !== PACKAGE_NAME) names.add(n);
    for (const name of names) {
      const found = findPackageDir(name, dir);
      const real = found ? realpathOrNull(found) : null;
      const where = depth === 0 ? { file: pkgRel, line: lineOf(pkgText, `"${name}"`) } : { file: ctx.rel(join(dir, "package.json")), line: 0 };
      if (!real) {
        const s = String(p.dependencies?.[name] ?? p.devDependencies?.[name] ?? p.peerDependencies?.[name] ?? "");
        if (/^(?:workspace|link|file):/.test(s)) warnings.push({ ...where, message: `${name} (${s}) does not resolve; cannot check whether it uses ${PACKAGE_NAME}` });
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const lib = readJson(join(real, "package.json"));
      const libSpec = lib ? declaredSpec(lib, PACKAGE_NAME) : null;
      if (libSpec !== null) {
        const label = depth === 0 ? name : `${name} (through ${chain})`;
        if (!isInside(real, root)) violations.push({ ...where, message: `library ${label} uses ${PACKAGE_NAME} and resolves to ${real}, outside the root ${root}` });
        else {
          const libDs = findPackageDir(PACKAGE_NAME, real);
          const libDsReal = libDs ? realpathOrNull(libDs) : null;
          if (!libDsReal) violations.push({ ...where, message: `library ${label} uses ${PACKAGE_NAME}, which does not resolve from ${ctx.rel(real)}` });
          else if (!isInside(libDsReal, root)) violations.push({ ...where, message: `library ${label} resolves ${PACKAGE_NAME} to ${libDsReal}, outside the root ${root}` });
          else if (dsReal && libDsReal !== dsReal) warnings.push({ ...where, message: `library ${label} resolves ${PACKAGE_NAME} to ${ctx.rel(libDsReal)}, the app to ${ctx.rel(dsReal)}` });
        }
      }
      // Follow workspace packages (real path outside node_modules); installed packages stay one level deep.
      if (!real.includes("/node_modules/") && existsSync(join(real, "package.json"))) queue.push({ dir: real, via: depth === 0 ? name : chain, depth: depth + 1 });
    }
  }

  return { violations, warnings };
}
