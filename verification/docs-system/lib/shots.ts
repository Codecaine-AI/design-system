/** shots.json schema, loading, and expansion into one entry per (view, theme). */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_DIR } from "./env";

export type Theme = "light" | "dark" | "split";

export type Step =
  | { action: "click"; selector: string; why?: string }
  | { action: "dblclick"; selector: string; why?: string }
  | { action: "press"; key: string; why?: string }
  | { action: "scroll"; selector: string; top: number; why?: string }
  | { action: "waitFor"; selector: string; state?: "attached" | "visible" | "hidden" | "detached"; why?: string }
  | { action: "wait"; ms: number; why?: string }
  | { action: "hover"; selector: string; why?: string }
  /** document.dispatchEvent(new CustomEvent(event, { detail })) — for app events with no pointer side effects. */
  | { action: "dispatch"; event: string; detail?: unknown; why?: string };

export interface ServerSpec {
  /** Corpus folder inside the fixture: corpora/<corpus>/docs. */
  corpus: string;
  apiPort: number;
  uiPort: number;
}

export interface ShotSpec {
  id: string;
  server: string;
  /** "docs" = the workbench SPA (index.html); "playground" = web/playground.html. */
  app: "docs" | "playground";
  /** Path + query + hash appended to the server's UI origin. */
  url: string;
  /** docs app: one capture per theme. playground: ["split"] (it renders light | dark itself). */
  themes: Theme[];
  /** docs app style rail; default "collapsed". */
  rail?: "open" | "collapsed";
  /** Style rail pane shown when the rail is open (localStorage docs-style-rail-selected). */
  railPane?: string;
  /** Extra localStorage entries written before the app boots (fresh context; nothing persists). */
  localStorage?: Record<string, string>;
  /** Selectors that must exist before steps run (embeds, panels). */
  waitFor?: string[];
  steps?: Step[];
  masks?: { selector: string; reason: string }[];
  settleMs?: number;
  covers?: string;
}

export interface ShotsFile {
  servers: Record<string, ServerSpec>;
  shots: ShotSpec[];
}

export interface ExpandedShot {
  /** File name stem: <id>-<theme>, or <id> for split playground shots. */
  key: string;
  theme: Theme;
  spec: ShotSpec;
}

export function loadShots(): ShotsFile {
  const parsed = JSON.parse(readFileSync(join(HARNESS_DIR, "shots.json"), "utf8")) as ShotsFile;
  const ids = new Set<string>();
  for (const shot of parsed.shots) {
    if (ids.has(shot.id)) throw new Error(`shots.json: duplicate id ${shot.id}`);
    ids.add(shot.id);
    if (!parsed.servers[shot.server]) throw new Error(`shots.json: ${shot.id} names unknown server ${shot.server}`);
    if (shot.app === "playground" && shot.themes.some((theme) => theme !== "split")) {
      throw new Error(`shots.json: playground shot ${shot.id} must use themes ["split"]`);
    }
    if (shot.app === "docs" && shot.themes.some((theme) => theme === "split")) {
      throw new Error(`shots.json: docs shot ${shot.id} cannot use the split theme`);
    }
  }
  return parsed;
}

export function expandShots(file: ShotsFile, only?: Set<string>): ExpandedShot[] {
  const expanded: ExpandedShot[] = [];
  for (const spec of file.shots) {
    for (const theme of spec.themes) {
      const key = theme === "split" ? spec.id : `${spec.id}-${theme}`;
      if (only && !only.has(key) && !only.has(spec.id)) continue;
      expanded.push({ key, theme, spec });
    }
  }
  return expanded;
}
