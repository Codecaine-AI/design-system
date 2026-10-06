// Codemod review fixture, round 3 second pass (P2-7): solid only from a background or a definition name.
declare const PrimaryNav: (p: { className?: string }) => null;
export const A = () => <a className="text-white hover:text-primary underline" />;
export const B = () => <div className="border border-primary text-white" />;
export const C = () => <PrimaryNav className="text-white" />;
export const D = () => <div data-accent-hidden className="text-white" />;
export const E = () => <div style={{ background: "var(--primary-50)", color: "#ffffff" }} />;
export const F = () => <div className="bg-blue-600 hover:bg-transparent text-white" />;
export const G = () => <div className="bg-blue-600 hover:bg-blue-700 text-white" />;
