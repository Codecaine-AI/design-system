// Codemod review fixture, round 2: JS values that reach CSS, and values that do not.
import type { CSSProperties } from "react";
export const BASE_SETTINGS = { fontSize: 15, foregroundColor: "#ffffff" };
export const PALETTE = ["#1a1a1a", "#e6e5e3"];
export const option = { series: [{ type: "sankey", label: { color: "#666562", fontSize: 11 }, itemStyle: { color: "#e6e5e3" } }] };
export const Picker = ({ c }: { c?: string }) => <input type="color" value={c ?? "#808080"} />;
export const isWhite = (c: string) => c === "#ffffff";
export const draw = (label: (t: string, c: string) => void) => label("FRONT", "#4a463f");
export const DEFAULT_SETTINGS = { snakeStartColor: "#e6e5e3" };
export const Card = ({ on }: { on: boolean }) => <div style={{ background: on ? "#f2f2f1" : "#ffffff", fontSize: 13 }} />;
export const panelStyle = { borderColor: "#e6e5e3" };
export const box: CSSProperties = { background: "#0078df", color: "#ffffff" };
export const paint = (el: HTMLElement) => {
  el.style.background = "#ffffff";
  el.style.setProperty("--chip", "#ebebe9");
};
export const Dot = ({ on }: { on: boolean }) => <circle fill={on ? "#ffffff" : "#e6e5e3"} />;
export const Tag = () => <Badge color="#e6e5e3" />;
declare const Badge: (p: { color: string }) => null;
export const setAccent = (el: HTMLElement, name: string) => el.style.setProperty(name, "#0078df");
export const Fade = () => <div style={{ maskImage: "linear-gradient(to bottom, rgb(0 0 0 / 0.55), transparent)" }} />;
export const Spread = ({ on }: { on: boolean }) => <div style={{ margin: 0, ...(on ? { background: "#0078df", color: "#ffffff" } : {}) }} />;
export const Label = () => <text fontSize={12}>x</text>;
export const glow = (el: HTMLElement) => { el.style.filter = "drop-shadow(0 0 2px #ffffff)"; };
export const Grain = () => <filter><feFlood floodColor="#808080" /><feDiffuseLighting lightingColor="#ffffff" /></filter>;
export const Chip = () => <span style={{ background: "var(--chip)" }} />;
