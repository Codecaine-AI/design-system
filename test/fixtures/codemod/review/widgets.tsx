// Codemod review fixture: hints from names only, Tailwind tones and alpha, occurrences, CSS comments.
export const Field = ({ f }: { f: () => void }) => (
  <input placeholder="Search" onFocus={f} style={{ color: "#9b9a97", border: "1px solid #e0e0e0" }} />
);
export const Remove = () => <button title="Delete" style={{ background: "#f2f2f1" }}>x</button>;
export const Overlay = () => <button className="text-white hover:bg-white/15">B</button>;
export const Notice = () => <div className="border border-amber-500/40 bg-amber-50 text-amber-900">!</div>;
export const Twice = () => <div className="border-[#e6e5e3]" style={{ background: "#e6e5e3" }} />;
export const opts = { label: "black", color: "black" };
export const tree = `
/* a row without a note runs into the next column */
.tree__note {
  color: #666562;
}
`;
export const shade = (a: number) => ({ background: `rgba(0, 120, 223, ${a})` });
export const Ring = ({ sel }: { sel: boolean }) => <div style={{ border: sel ? "2px solid white" : "none", color: "white" }} />;
export const TAG_CATEGORY_COLORS = { red: "bg-red-100 text-red-800" };
export const Faint = () => <div className="bg-white/1 text-[color:transparent]" />;
export const Row = () => <div className="border hover:bg-gray-100 bg-[#f2f2f1]" />;
export const Size = () => <p className="text-[13px]/5" />;
export const darkTheme = { palette: { primary: { light: "#2a2a2a" } } };
