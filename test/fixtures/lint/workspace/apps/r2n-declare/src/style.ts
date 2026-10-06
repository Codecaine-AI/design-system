export function paint(el: HTMLElement, hue: string) {
  el.style.setProperty("--ds-space-4", "2px");
  el.style.setProperty(`--ds-color-${hue}-solid`, "red");
  return el.style.getPropertyValue("--ds-space-4");
}
export const style = { "--ds-radius-pill": "0", color: "var(--ds-color-surface-page)" };
export const style2 = { ["--ds-radius-pill" as string]: "0" };
export const css = `.x { --ds-shadow-dialog: none; }`;
export const pick = (on: boolean) => (on ? "--ds-space-2" : "--ds-space-4");
export const read = { gap: "var(--ds-space-2)" };
export const cls = "p-2 [--ds-space-2:4px]";
export type Vars = { "--ds-space-2"?: string };
