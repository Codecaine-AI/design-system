// Codemod review fixture, round 3 (P1-2): white text is on-solid only on a solid fill.
declare const Button: (p: { variant?: string; className?: string }) => null;
declare const EDITOR_STYLE: { accentPurple: string };
export const SearchInput = () => <input style={{ border: "none", outline: "none", color: "#FFFFFF", fontSize: 13, flex: 1 }} />;
export const Result = ({ hovered }: { hovered: boolean }) => <button style={{ border: "none", background: hovered ? "rgba(255,255,255,0.14)" : "transparent", color: "#FFFFFF" }} />;
export const Header = () => <div className="mb-3 flex shrink-0 items-center justify-between gap-3 text-white" />;
export const Close = () => <Button variant="ghost" className="text-white hover:bg-white/15 hover:text-white" />;
export const Unavailable = () => <div className="rounded-md bg-white/10 px-4 py-3 text-xs text-white/70" />;
export const Tip = () => <div style={{ padding: "5px 8px", background: "rgb(25 27 31 / 0.97)", color: "#F4F4F5", border: "1px solid rgb(255 255 255 / 0.12)" }} />;
export const Bar = () => <div style={{ padding: "6px 12px", color: "#ccc" }} />;
export const Item = ({ active, hovered }: { active: boolean; hovered: boolean }) => <div style={{ background: active ? EDITOR_STYLE.accentPurple : hovered ? "rgba(255,255,255,0.10)" : "transparent", color: "#FFFFFF" }} />;
export const Primary = () => <button style={{ background: "#0078df", color: "#ffffff" }} />;
export const Danger = () => <button className="bg-red-600 text-white" />;
export const Cta = () => <button className="btn-primary" style={{ color: "#ffffff" }} />;
