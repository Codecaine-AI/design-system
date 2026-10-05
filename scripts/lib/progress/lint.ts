/**
 * The conformance linter's result, as `bun run lint:apps --json` prints it (TOOLING_CONTRACT.md).
 *
 * The progress page never fails because the linter is missing or broken: every way of not getting a
 * report becomes `{ available: false, reason }`, and the page shows "lint: unavailable" per app.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId } from "../registry.ts";

export type CheckStatus = "pass" | "fail" | "n/a" | "warn";

export interface LintViolation {
  file: string;
  line: number;
  message: string;
}

export interface LintCheck {
  id: CheckId | string;
  status: CheckStatus | string;
  violations: LintViolation[];
  /** Warnings flattened to one line each. */
  warnings: string[];
  /** The n/a reason, when the linter reports one. */
  reason?: string;
}

export interface LintApp {
  id: string;
  ok: boolean;
  checks: LintCheck[];
  literals: { hard: number; floor: number } | null;
}

export interface LintReport {
  root: string;
  pass: string | null;
  designSystem: { commit: string; tokensCssSha256: string } | null;
  apps: LintApp[];
}

export type LintSource =
  | { available: true; origin: string; report: LintReport }
  | { available: false; origin: string; reason: string };

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function warningText(w: unknown): string {
  if (typeof w === "string") return w;
  if (isObject(w)) {
    const where = w.file ? `${w.file}${w.line ? `:${w.line}` : ""} ` : "";
    return `${where}${w.message ?? JSON.stringify(w)}`;
  }
  return String(w);
}

/** Parses `lint:apps --json` output. Throws with a reason when the text is not a lint report. */
export function parseLintJson(text: string): LintReport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Tolerate a banner around the JSON object (a package runner echoing its command).
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last <= first) throw new Error("output is not JSON");
    try {
      data = JSON.parse(text.slice(first, last + 1));
    } catch {
      throw new Error("output is not JSON");
    }
  }
  if (!isObject(data) || !Array.isArray(data.apps)) throw new Error('JSON has no "apps" array');
  const apps: LintApp[] = data.apps.filter((a: unknown) => isObject(a) && typeof a.id === "string").map((a: Record<string, any>) => ({
    id: a.id,
    ok: a.ok === true,
    checks: (Array.isArray(a.checks) ? a.checks : []).filter(isObject).map((c: Record<string, any>) => ({
      id: String(c.id),
      status: String(c.status),
      violations: (Array.isArray(c.violations) ? c.violations : []).filter(isObject).map((v: Record<string, any>) => ({
        file: String(v.file ?? ""),
        line: Number(v.line ?? 0),
        message: String(v.message ?? ""),
      })),
      warnings: (Array.isArray(c.warnings) ? c.warnings : []).map(warningText),
      ...(typeof c.reason === "string" ? { reason: c.reason } : {}),
    })),
    literals:
      isObject(a.literals) && typeof a.literals.hard === "number"
        ? { hard: a.literals.hard, floor: typeof a.literals.floor === "number" ? a.literals.floor : 0 }
        : null,
  }));
  const ds = isObject(data.designSystem) ? data.designSystem : null;
  return {
    root: String(data.root ?? ""),
    pass: data.pass == null ? null : String(data.pass),
    designSystem: ds ? { commit: String(ds.commit ?? ""), tokensCssSha256: String(ds.tokensCssSha256 ?? "") } : null,
    apps,
  };
}

/** A lint report saved to a file (`--lint-json`). */
export function readLintFile(path: string): LintSource {
  const origin = path;
  if (!existsSync(path)) return { available: false, origin, reason: `${path} does not exist` };
  try {
    return { available: true, origin, report: parseLintJson(readFileSync(path, "utf8")) };
  } catch (error) {
    return { available: false, origin, reason: `${path}: ${(error as Error).message}` };
  }
}

/**
 * Runs `bun run lint:apps --json --root <root>` in a design-system checkout. Exit 1 is the linter's
 * normal answer when a required check fails, so the report is read whatever the exit code.
 */
export function runLinter(designSystemRoot: string, root: string, timeoutMs = 15 * 60_000): LintSource {
  const origin = `bun run lint:apps --json --root ${root}`;
  if (!existsSync(join(designSystemRoot, "scripts", "lint-apps.ts")))
    return { available: false, origin, reason: "scripts/lint-apps.ts is not in this design-system checkout yet" };
  const result = spawnSync("bun", ["run", "lint:apps", "--json", "--root", root], {
    cwd: designSystemRoot,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.error) return { available: false, origin, reason: `lint:apps did not run: ${result.error.message}` };
  try {
    return { available: true, origin, report: parseLintJson(result.stdout) };
  } catch (error) {
    const detail = (result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    return {
      available: false,
      origin,
      reason: `lint:apps exited ${result.status ?? result.signal}: ${(error as Error).message}${detail ? ` (${detail.slice(0, 200)})` : ""}`,
    };
  }
}
