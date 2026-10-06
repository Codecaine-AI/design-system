import { cssVar, v } from "../../lib/ds";
const c = cssVar("color.surface.nope");
const d = v("color.not.a.token");
const ok = cssVar("color.surface.page");
export const Card = () => <div style={{ color: c, background: d, borderColor: ok }} />;
