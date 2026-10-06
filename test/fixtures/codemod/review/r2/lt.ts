// Codemod review fixture, round 2: a comparison with `<` is not a JSX tag.
import { cssVar } from "@codecaine-ai/design-system";
declare const breakpoint: number;
const isSmall = window.innerWidth<breakpoint;
let color = "#ffffff";
export function pick(n: number, min: number) {
  if (n<min) color = "#ffffff";
  return { isSmall, color, dot: cssVar("color.accent") };
}
