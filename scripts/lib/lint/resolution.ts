/**
 * Check 1, resolution: the app reaches the design system inside the root.
 *
 * - The app's package.json declares @codecaine-ai/design-system the way
 *   `consume.via` says (workspace:, link:, file:, file:vendor/<name>.tgz).
 * - The package resolves from the app root, and its real path is inside the root.
 *   A live link (workspace, link, npm-file, relative-import) must reach the root's
 *   design-system checkout (any source checkout with tokens/ when the root has none),
 *   never a packed copy or a second checkout.
 * - Every design-system file the entry stylesheet loads is inside the root, inside a
 *   @codecaine-ai/design-system package (decision 20: no other package's copy, such as
 *   text-measure's fonts.css), and from the package the app resolves; a local copy of a
 *   design-system file (by its header) is allowed only for consume.via copy.
 * - vendor-tgz: the tgz (`package/<file>`) and the installed copy each carry every
 *   shipped file the app needs with the current build's sha256: dist/css/tokens.css,
 *   every design-system file the entry loads from the installed copy, and every file in
 *   the build's fonts/ when fonts.css is loaded. One violation per missing or differing
 *   file and place.
 * - copy: the entry loads a copied tokens file, and every copied design-system file it
 *   loads has the hash of its build file (tokens.css, layout.css, fonts.css, the
 *   Tailwind files, …); for a copied fonts.css, so does each font file its url()s point
 *   at (next to the copy) against fonts/<name> in the build.
 * - Every library the app uses that itself depends on the package (workspace
 *   packages, followed through their own dependencies, and installed packages
 *   one level deep) resolves inside the root, and so does its copy of the package.
 *   That copy must be the app's own; one that differs is a violation, and it is
 *   checked like the app's: a live link must reach the root's checkout, a packed
 *   copy must carry the current build's tokens.css.
 * - A `workspace:`, `link:` or `file:` dependency that does not resolve is a
 *   violation: whether it brings its own copy of the package cannot be checked.
 * - host-css: nothing to resolve; the registry marks the check n/a.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { stripCss } from "../../scan-literals";
import { buildFile, fileSha256, sha256, type DesignSystemBuild } from "./design-system";
import { isDsLoad, type Load } from "./loads";
import type { AppContext, CheckOutput, Finding } from "./types";
import { PACKAGE_NAME } from "./types";
import { findPackageDir, isDir, isFile, isInside, lineAt, lineOf, owningPackage, readJson, readText, realpathOrNull, toPosix } from "./workspace";

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

/** The tgz's member names (`package/…`, a leading `./` dropped); null when tar cannot list it. */
function tgzMembers(tgz: string): Set<string> | null {
  const r = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return new Set(r.stdout.split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean));
}

function tgzMemberSha(tgz: string, member: string): string | null {
  const r = spawnSync("tar", ["-xzOf", tgz, member], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && r.stdout ? sha256(r.stdout) : null;
}

/** The build file a copied design-system file stands for, by its load kind. */
const COPY_MEMBER: Partial<Record<string, string>> = {
  tokens: "dist/css/tokens.css",
  "tokens-dark-first": "dist/css/tokens-dark-first.css",
  "host-contract": "dist/css/host-contract.css",
  "host-contract-dark-first": "dist/css/host-contract-dark-first.css",
  layout: "css/layout.css",
  fonts: "css/fonts.css",
  "tw-theme": "dist/tailwind/theme.css",
  "tw-strict": "dist/tailwind/strict.css",
};

/** Every file in the build's fonts/, as `fonts/<name>`. */
function buildFonts(ds: DesignSystemBuild): string[] {
  try {
    return readdirSync(join(ds.dir, "fonts"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `fonts/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/** The @codecaine-ai/design-system package a file sits in (a nameless package.json, such as dist/'s `type: module`, is looked past); null when none. */
function designSystemPackageOf(file: string): { dir: string; name: string } | null {
  let at = file;
  for (let i = 0; i < 16; i++) {
    const owner = owningPackage(at);
    if (!owner || owner.name === PACKAGE_NAME) return owner;
    if (owner.name) return null;
    at = owner.dir;
  }
  return null;
}

/** The members a vendored app ships: tokens.css, every design-system file it loads from the installed copy, and the fonts when fonts.css loads. */
function shippedMembers(ds: DesignSystemBuild, dsReal: string, dsLoads: Load[]): string[] {
  const members = new Set(["dist/css/tokens.css"]);
  let fonts = false;
  for (const l of dsLoads) {
    if (!l.path || l.copied || !isInside(l.path, dsReal)) continue;
    members.add(toPosix(relative(dsReal, l.path)));
    if (l.kind === "fonts") fonts = true;
  }
  if (fonts) for (const f of buildFonts(ds)) members.add(f);
  return [...members];
}

const CSS_URL = /url\(\s*(["']?)([^"')\s]+)\1\s*\)/g;

/** Each font file a copied fonts.css points at (resolved next to the copy) against fonts/<name> in the build. */
function copiedFontFiles(ctx: AppContext, fontsCss: string, buildSha: (member: string) => string | null): Finding[] {
  const out: Finding[] = [];
  const text = readText(fontsCss) ?? "";
  const seen = new Set<string>();
  for (const m of stripCss(text, false).matchAll(CSS_URL)) {
    const url = m[2].replace(/[?#].*$/, "");
    if (!url || /^(?:[a-z]+:|\/\/)/i.test(url)) continue;
    const at = { file: ctx.rel(fontsCss), line: lineAt(text, m.index!) };
    const file = resolve(dirname(fontsCss), url);
    if (seen.has(file)) continue;
    seen.add(file);
    const member = `fonts/${basename(url)}`;
    const want = buildSha(member);
    if (!want) {
      out.push({ ...at, message: `copied fonts.css points at ${url}; the current build has no ${member}` });
      continue;
    }
    if (!isFile(file)) {
      out.push({ ...at, message: `copied fonts.css points at ${url}, which does not exist next to the copy (${ctx.rel(file)}); copy ${member} from the build` });
      continue;
    }
    const got = fileSha256(file);
    if (got !== want) {
      out.push({ file: ctx.rel(file), line: 0, message: `copied font ${basename(file)} (sha256 ${got?.slice(0, 12)}) differs from the current build's ${member} (${want.slice(0, 12)}); copy it again` });
    }
  }
  return out;
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
  const graph = ctx.loads();
  const dsLoads = graph.loads.filter(isDsLoad);
  if (via === "vendor-tgz") {
    const members = dsReal ? shippedMembers(ds, dsReal, dsLoads) : [tokensMember];
    const want = new Map<string, string>();
    for (const m of members) {
      const sha = buildSha(m);
      if (sha) want.set(m, sha);
      else violations.push({ file: pkgRel, line: depLine, message: `the current build has no ${m} to compare with` });
    }
    if (spec && /^file:.*\.tgz$/.test(spec)) {
      const tgz = join(appRoot, spec.slice("file:".length));
      const tgzReal = realpathOrNull(tgz);
      if (!tgzReal) violations.push({ file: pkgRel, line: depLine, message: `vendored package ${spec.slice(5)} not found` });
      else {
        const tgzRel = ctx.rel(tgzReal);
        if (!isInside(tgzReal, root)) violations.push({ file: pkgRel, line: depLine, message: `vendored package ${tgzReal} is outside the root ${root}` });
        const listed = tgzMembers(tgzReal);
        if (!listed) violations.push({ file: tgzRel, line: 0, message: "tar cannot list the vendored tgz" });
        else {
          for (const m of members) {
            const got = listed.has(`package/${m}`) ? tgzMemberSha(tgzReal, `package/${m}`) : null;
            const w = want.get(m);
            if (!got) violations.push({ file: tgzRel, line: 0, message: `the tgz has no package/${m}` });
            else if (w && got !== w) {
              violations.push({ file: tgzRel, line: 0, message: `${m} in the tgz (sha256 ${got.slice(0, 12)}) differs from the current build (${w.slice(0, 12)}); run \`bun run pack\` and vendor the new tgz` });
            }
          }
        }
      }
    }
    if (dsReal) {
      for (const m of members) {
        const w = want.get(m);
        if (!w) continue;
        const got = fileSha256(join(dsReal, m));
        if (!got) violations.push({ file: ctx.rel(dsReal), line: 0, message: `the installed copy has no ${m}` });
        else if (got !== w) {
          violations.push({ file: ctx.rel(join(dsReal, m)), line: 0, message: `${m} in the installed copy (sha256 ${got.slice(0, 12)}) differs from the current build (${w.slice(0, 12)}); reinstall from the vendored tgz` });
        }
      }
    }
  }

  // Every design-system file the entry stylesheet loads comes from where consume.via says.
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
    const owner = designSystemPackageOf(l.path);
    if (!owner) {
      violations.push({ ...at, message: `${l.spec} loads ${ctx.rel(l.path)}, which is not inside a ${PACKAGE_NAME} package; load the file from the package` });
      continue;
    }
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
    if (!tokens?.path && graph.entryExists) {
      violations.push({ file: ctx.rel(graph.entry!), line: 1, message: "consume.via copy: no copied tokens.css is loaded from the entry stylesheet" });
    }
    const checked = new Set<string>();
    for (const l of dsLoads) {
      if (!l.copied || !l.path || checked.has(l.path)) continue;
      checked.add(l.path);
      const member = COPY_MEMBER[l.kind];
      if (!member) continue;
      const want = buildSha(member);
      const got = fileSha256(l.path);
      const label = l.kind === "tokens" || l.kind === "tokens-dark-first" ? "tokens" : basename(l.path);
      if (!want) violations.push({ file: ctx.rel(l.path), line: 0, message: `the current build has no ${member} to compare with` });
      else if (got !== want) {
        violations.push({ file: ctx.rel(l.path), line: 0, message: `copied ${label} (sha256 ${got?.slice(0, 12)}) differs from the current build's ${member} (${want.slice(0, 12)}); copy it again` });
      }
      if (l.kind === "fonts") violations.push(...copiedFontFiles(ctx, l.path, buildSha));
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
        const s = String(p.dependencies?.[name] ?? p.devDependencies?.[name] ?? p.peerDependencies?.[name] ?? p.optionalDependencies?.[name] ?? "");
        if (/^(?:workspace|link|file):/.test(s)) {
          violations.push({ ...where, message: `${name} (${s}) does not resolve, so whether it brings its own ${PACKAGE_NAME} cannot be checked; install or link it` });
        }
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
          else if (libDsReal !== dsReal) {
            if (dsReal) {
              violations.push({ ...where, message: `library ${label} resolves ${PACKAGE_NAME} to ${ctx.rel(libDsReal)}, the app to ${ctx.rel(dsReal)}; the app must load one copy` });
            }
            if (LIVE.includes(via)) {
              const problem = notLive(libDsReal);
              if (problem) violations.push({ ...where, message: `library ${label}: its ${PACKAGE_NAME} ${problem}; consume.via ${via} needs a live link` });
            } else {
              const want = buildSha(tokensMember);
              const got = fileSha256(join(libDsReal, tokensMember));
              if (!got) violations.push({ ...where, message: `library ${label}: its copy of ${PACKAGE_NAME} (${ctx.rel(libDsReal)}) has no ${tokensMember}` });
              else if (want && got !== want) {
                violations.push({ ...where, message: `library ${label}: ${tokensMember} in its copy (${ctx.rel(libDsReal)}, sha256 ${got.slice(0, 12)}) differs from the current build (${want.slice(0, 12)})` });
              }
            }
          }
        }
      }
      // Follow workspace packages (real path outside node_modules); installed packages stay one level deep.
      if (!real.includes("/node_modules/") && existsSync(join(real, "package.json"))) queue.push({ dir: real, via: depth === 0 ? name : chain, depth: depth + 1 });
    }
  }

  return { violations, warnings };
}
