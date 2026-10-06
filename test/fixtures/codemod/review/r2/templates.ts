// Codemod review fixture, round 2: templates holding code or an SVG image are not CSS.
export const snippet = `const theme = { accent: "#ffffff" };`;
export const cursor = `<svg xmlns="http://www.w3.org/2000/svg"><style>path { fill: #ffffff; }</style></svg>`;
export const page = `<html><body><p>Ink #ffffff</p><style>body { color: #666562; }</style></body></html>`;
declare const darken: (n: number) => (c: string) => string;
export const chipStyle = { color: darken(0.2)("#ffffff"), background: "#ebebe9" };
