/**
 * Run mode none: the app is not started. verify:apps resolves the package the way the app would
 * and reads its entry stylesheet, and reports the app as not runtime-verified.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { type AppEntry, resolvePath } from "../registry";
import { type Assertion, fail, na, pass } from "./page-checks";
import type { BuildValues } from "./tokens";

const PACKAGE = "@codecaine-ai/design-system";
/** Consumers that resolve the package through node resolution from the app root. */
const RESOLVED = new Set(["workspace", "link", "npm-file", "vendor-tgz"]);

export function staticCheck(app: AppEntry, root: string, values: BuildValues): Assertion[] {
  const out: Assertion[] = [na("runtime", `not runtime-verified: run mode none (${app.run.reason ?? "no reason given"})`)];
  const rootReal = realpathSync(root);
  const inside = (path: string) => path === rootReal || path.startsWith(rootReal + sep);

  if (RESOLVED.has(app.consume.via)) {
    const appRoot = resolvePath(root, app.root);
    try {
      const pkgJson = realpathSync(createRequire(join(appRoot, "package.json")).resolve(`${PACKAGE}/package.json`));
      const pkgDir = dirname(pkgJson);
      const tokensCss = join(pkgDir, "dist/css/tokens.css");
      const sha = existsSync(tokensCss) ? createHash("sha256").update(readFileSync(tokensCss)).digest("hex") : null;
      const detail = { packageDir: pkgDir, tokensCssSha256: sha, buildSha256: values.tokensCssSha256 };
      if (!inside(pkgDir)) out.push(fail("package", `${PACKAGE} resolves outside the root: ${pkgDir}`, detail));
      else if (sha !== values.tokensCssSha256) out.push(fail("package", `${PACKAGE} at ${pkgDir} has a tokens.css that differs from the current build`, detail));
      else out.push(pass("package", `${PACKAGE} resolves inside the root with the current tokens.css`, detail));
    } catch (error) {
      out.push(fail("package", `${PACKAGE} does not resolve from ${appRoot}: ${(error as Error).message.split("\n")[0]}`));
    }
  } else {
    out.push(na("package", `consumes the package via ${app.consume.via}; lint:apps checks its resolution`));
  }

  if (app.entryStylesheet === null) {
    out.push(na("entry-stylesheet", "no entry stylesheet (the host loads the tokens)"));
  } else {
    const path = resolvePath(root, app.entryStylesheet);
    if (!existsSync(path)) {
      out.push(fail("entry-stylesheet", `${app.entryStylesheet} does not exist`));
    } else {
      const text = readFileSync(path, "utf8");
      const loads = {
        fonts: /fonts\.css/.test(text),
        tokens: /tokens(-dark-first)?\.css/.test(text),
        layout: /layout\.css/.test(text),
      };
      out.push(
        loads.tokens
          ? pass("entry-stylesheet", `${app.entryStylesheet} loads the tokens`, { loads })
          : fail("entry-stylesheet", `${app.entryStylesheet} does not load tokens.css`, { loads }),
      );
    }
  }
  return out;
}
