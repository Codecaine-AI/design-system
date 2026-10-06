// Codemod review fixture, round 2: color props that are not SVG presentation attributes.
declare const MyIcon: (p: { color: string }) => null;
export const A = () => <MyIcon color="#ffffff" />;
export const B = () => <meshStandardMaterial color="#ffffff" />;
export const C = () => <link rel="mask-icon" href="/m.svg" color="#ffffff" />;
export const D = () => <svg><circle fill="#ffffff" /></svg>;
