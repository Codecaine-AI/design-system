// Codemod review fixture, round 3 second pass (P1-2): in JS a key reads a variable only when the string is its whole value.
export const Icon = ({ color }: { color: string }) => <path stroke="var(--stroke-c)" />;
export const A = ({ hovered, bg }: { hovered: boolean; bg: string }) => <div style={{ color: hovered ? bg : "var(--ink)" }} />;
export const B = ({ hovered, color }: { hovered: boolean; color: string }) => <div style={{ background: hovered ? color : "var(--surface)" }} />;
export const C = ({ open, bg }: { open: boolean; bg: string }) => <div style={{ borderColor: open ? bg : "var(--line)" }} />;
export const D = () => <div style={{ padding: 4, color: "var(--plain-ink)" }} />;
export const E = () => <div className="bg-[--chip-b] ring-offset-chip" />;
