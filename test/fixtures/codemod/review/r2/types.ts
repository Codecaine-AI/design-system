// Codemod review fixture, round 2: literal types are hand edits, wherever they sit.
import { cssVar } from "@codecaine-ai/design-system";
export type Tone = "#ffffff";
export let accent: "#e6e5e3" = "#e6e5e3";
declare function useTone<T>(): T;
export const tone = useTone<"#ffffff">();
export const chipStyle = { background: "#ebebe9", gap: cssVar("space.2") };
