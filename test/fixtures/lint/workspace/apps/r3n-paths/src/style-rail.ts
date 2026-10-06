import { cssVar } from "@codecaine-ai/design-system";

// The app's own Style Rail keys: shaped like token paths, near no real one.
export type RailKey = "layout.radius" | "layout.editor" | "layout.contentWidth" | "layout.side-peek" | "radius.large";
export const groups = { "layout.editor": ["layout.contentWidth", "layout.topPadding"], "layout.sidebar": [] };
// Near misses of real paths: fail.
export const typo = ["color.surface.nope", "color.surfce.page", "space.9"];
// Real typos in cssVar calls: fail.
export const width = cssVar("layout.radius");
export const page = cssVar("color.surfce.page");
export const ok = cssVar("layout.lane.text");
