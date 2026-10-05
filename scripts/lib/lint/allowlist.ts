/**
 * Allowlist files (apps/allowlists/<id>.json): the hard literals and Tailwind
 * default-scale classes an app keeps, each with a reason.
 *
 * Matching (the semantics the Allowlist type in registry.ts points to):
 * - `file` is a glob over the workspace-relative path of the file with the hit:
 *   `*` matches within one path segment, `**` across segments, `?` one character.
 *   A glob that names a directory also matches every file below it.
 * - `match` (literals) is a regex that must match the whole literal as scan-literals
 *   reports it, case-insensitive. scan-literals lowercases hex and expands 3/4-digit hex
 *   to 6/8 digits (write "#ff0000" for #f00), lowercases rgb()/hsl() with single
 *   spaces, and drops `!` from Tailwind arbitrary classes.
 * - `className` (twClasses) is a regex that must match the whole class without its
 *   variant prefixes (`text-sm` for `md:hover:text-sm`), case-sensitive.
 * - `category` is a scan-literals hard category; `kind` is the color split
 *   (`definition`, `fallback`, `inline`). Non-color hits are always `inline`.
 * - An entry matches a hit when every field it sets matches.
 * Entries without a reason, bad regexes and a missing file are violations; entries
 * that match nothing are warnings, so the allowlist shrinks with the code.
 */

import type { AppEntry, Allowlist } from "../registry";
import { resolvePath } from "../registry";
import type { Finding } from "./types";
import { lineAt, readText } from "./workspace";

export type LiteralKind = "definition" | "fallback" | "inline";

interface CompiledLiteral {
  file: RegExp;
  match: RegExp | null;
  category?: string;
  kind?: LiteralKind;
  line: number;
  used: number;
}

interface CompiledTw {
  file: RegExp;
  className: RegExp;
  line: number;
  used: number;
}

export interface LoadedAllowlist {
  /** Where the file is, as findings show it. */
  where: string;
  problems: Finding[];
  literals: CompiledLiteral[];
  twClasses: CompiledTw[];
}

export function globToRegExp(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "*") {
      if (clean[i + 1] === "*") {
        re += ".*";
        i++;
        if (clean[i + 1] === "/") {
          re = re.slice(0, -2) + "(?:.*/)?";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

function compile(source: string, flags: string): RegExp {
  return new RegExp(`^(?:${source})$`, flags);
}

export function loadAllowlist(app: AppEntry, registryDir: string, rel: (abs: string) => string): LoadedAllowlist {
  const abs = app.allowlist ? resolvePath(registryDir, app.allowlist) : "";
  const where = app.allowlist ? rel(abs) : "";
  const out: LoadedAllowlist = { where, problems: [], literals: [], twClasses: [] };
  if (!app.allowlist) return out;
  const text = readText(abs);
  if (text === null) {
    out.problems.push({ file: where, line: 0, message: `allowlist file not found (apps.json allowlist: ${app.allowlist})` });
    return out;
  }
  let data: Allowlist;
  try {
    data = JSON.parse(text);
  } catch (err) {
    out.problems.push({ file: where, line: 0, message: `allowlist is not valid JSON: ${(err as Error).message}` });
    return out;
  }
  // Entries appear in file order: search for each one's first value after the previous entry.
  let cursor = 0;
  const entryLine = (e: object) => {
    const needle = JSON.stringify(Object.values(e)[0] ?? "");
    const i = text.indexOf(needle, cursor);
    if (i === -1) return 0;
    cursor = i + needle.length;
    return lineAt(text, i);
  };
  for (const e of data.literals ?? []) {
    const line = entryLine(e);
    if (!e.reason?.trim()) out.problems.push({ file: where, line, message: `literal entry for ${e.file} has no reason` });
    try {
      out.literals.push({
        file: globToRegExp(e.file),
        match: e.match ? compile(e.match, "i") : null,
        category: e.category,
        kind: e.kind,
        line,
        used: 0,
      });
    } catch (err) {
      out.problems.push({ file: where, line, message: `literal entry for ${e.file}: bad regex: ${(err as Error).message}` });
    }
  }
  for (const e of data.twClasses ?? []) {
    const line = entryLine(e);
    if (!e.reason?.trim()) out.problems.push({ file: where, line, message: `twClasses entry for ${e.file} has no reason` });
    try {
      out.twClasses.push({ file: globToRegExp(e.file), className: compile(e.className, ""), line, used: 0 });
    } catch (err) {
      out.problems.push({ file: where, line, message: `twClasses entry for ${e.file}: bad regex: ${(err as Error).message}` });
    }
  }
  return out;
}

/** True when an entry allows this hard literal; counts the use. */
export function allowsLiteral(al: LoadedAllowlist, hit: { file: string; value: string; category: string; kind: LiteralKind }): boolean {
  for (const e of al.literals) {
    if (!e.file.test(hit.file)) continue;
    if (e.match && !e.match.test(hit.value)) continue;
    if (e.category && e.category !== hit.category) continue;
    if (e.kind && e.kind !== hit.kind) continue;
    e.used++;
    return true;
  }
  return false;
}

/** True when an entry allows this Tailwind class; counts the use. */
export function allowsTwClass(al: LoadedAllowlist, file: string, className: string): boolean {
  for (const e of al.twClasses) {
    if (!e.file.test(file) || !e.className.test(className)) continue;
    e.used++;
    return true;
  }
  return false;
}

/** Warnings for entries that matched nothing. */
export function unusedEntries(al: LoadedAllowlist, which: "literals" | "twClasses"): Finding[] {
  const where = al.where;
  return al[which]
    .filter((e) => e.used === 0)
    .map((e) => ({ file: where, line: e.line, message: `${which} entry matches nothing; remove it` }));
}
