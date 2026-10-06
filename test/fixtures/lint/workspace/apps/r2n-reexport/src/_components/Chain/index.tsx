import * as ds from "../../lib/chain";
import fn, { t } from "../../lib/held";
import { cssVar as viaStar } from "../../lib/chain";
export const a = ds.cssVar("color.chain.nope");
export const b = t.light.color.held.nope;
export const c = fn("color.default.nope");
export const d = viaStar("color.star.nope");
export const Chain = () => <div style={{ color: a }} />;
