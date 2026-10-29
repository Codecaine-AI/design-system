/**
 * The design rules, one file per area: design-score/rules/<area>.json, each `{ "area", "rules": [...] }`.
 * Each rule's `check` (a check id, a list of them, or null) names the checks that decide it. Every
 * finding carries the ids of the rules behind its check.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The six check areas, plus `writing` (copy rules) and `judge` (taste rules for the screenshot judge). */
export const RULE_AREAS = ["layout", "typography", "color", "motion", "interaction", "accessibility", "writing", "judge"] as const;
export type RuleArea = (typeof RULE_AREAS)[number];

export interface RuleRef {
  id: string;
  title?: string;
  area?: string;
  check?: string | string[] | null;
}

/** check id -> rule ids, from a list of rules. */
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

/** Reads every design-score/rules/<area>.json, in RULE_AREAS order (empty when the folder is missing). */
export function loadRules(designSystem: string): { rules: RuleRef[]; dir: string | null } {
  const dir = join(designSystem, "design-score/rules");
  if (!existsSync(dir)) return { rules: [], dir: null };
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const rank = (f: string) => {
    const i = (RULE_AREAS as readonly string[]).indexOf(f.slice(0, -5));
    return i < 0 ? RULE_AREAS.length : i;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const rules: RuleRef[] = [];
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as { area?: string; rules?: RuleRef[] };
    for (const r of parsed.rules ?? []) rules.push({ ...r, area: r.area ?? parsed.area });
  }
  return { rules, dir };
}

/** check id -> rule ids and rule id -> title, from design-score/rules/ (empty maps when it is missing or bad). */
export function loadRuleMap(designSystem: string): { map: Map<string, string[]>; titles: Map<string, string>; path: string | null } {
  try {
    const { rules, dir } = loadRules(designSystem);
    if (!dir) return { map: new Map(), titles: new Map(), path: null };
    return { map: rulesByCheck({ rules }), titles: new Map(rules.map((r) => [r.id, r.title ?? r.id])), path: dir };
  } catch {
    return { map: new Map(), titles: new Map(), path: null };
  }
}
