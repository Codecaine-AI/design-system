/**
 * The link from checks to design-score/rules.json: each rule's `check` (a check id, a list of them, or
 * null) names the checks that decide it. Every finding carries the ids of the rules behind its check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuleRef {
  id: string;
  title?: string;
  check?: string | string[] | null;
}

/** check id -> rule ids, from a parsed rules.json. */
export function rulesByCheck(rules: { rules?: RuleRef[] }): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rules.rules ?? []) {
    for (const c of [r.check ?? []].flat()) {
      if (!c) continue;
      out.set(c, [...(out.get(c) ?? []), r.id]);
    }
  }
  return out;
}

/** Loads <designSystem>/design-score/rules.json (an empty map when it is missing or bad). */
export function loadRuleMap(designSystem: string): { map: Map<string, string[]>; titles: Map<string, string>; path: string | null } {
  const path = join(designSystem, "design-score/rules.json");
  if (!existsSync(path)) return { map: new Map(), titles: new Map(), path: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { rules?: RuleRef[] };
    return { map: rulesByCheck(parsed), titles: new Map((parsed.rules ?? []).map((r) => [r.id, r.title ?? r.id])), path };
  } catch {
    return { map: new Map(), titles: new Map(), path: null };
  }
}
