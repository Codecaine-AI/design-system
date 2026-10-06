// Codemod review fixture: color literals that are not CSS values.
declare const d3: { rgb(r: number, g: number, b: number): unknown };
export const red = d3.rgb(253, 253, 253);
export const NAMES = { "#ffffff": "White" };
export interface Swatch { tone: "#ffffff" | "#e6e5e3" }
