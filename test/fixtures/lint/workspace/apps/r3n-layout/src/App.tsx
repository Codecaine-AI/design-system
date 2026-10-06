import { useRef } from "react";

export function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const resize = (w: number) => {
    document.documentElement.style.setProperty("--ds-layout-lane-text", `${w}ch`);
    shellRef.current?.style.setProperty("--ds-layout-sidebar-width", `${w}px`);
    const shell = document.querySelector<HTMLElement>(".app .ds-shell");
    shell!.style.setProperty("--ds-layout-inspector-width", `${w}px`);
    (document.querySelector(".ds-shell") as HTMLElement).style.setProperty("--ds-layout-lane-code", `${w}ch`);
    document.body.style.setProperty("--ds-layout-lane-code", `${w}ch`);
    document.documentElement.style.setProperty("--ds-color-accent", "red");
    document.querySelector<HTMLElement>(".ds-shell .x")!.style.setProperty("--ds-layout-lane-wide", "1px");
  };
  return (
    <div className="ds-shell" ref={shellRef} style={{ "--ds-layout-lane-wide": "1200px" } as React.CSSProperties}>
      <main className="ds-main" style={{ "--ds-layout-lane-text": "50ch" } as React.CSSProperties} onClick={() => resize(80)}>
        <div className="ds-shell [--ds-layout-sidebar-width:300px]" />
        <div className="p-2 [--ds-layout-sidebar-width:300px]" />
      </main>
    </div>
  );
}

export const css = `.docs-app.ds-shell { --ds-layout-sidebar-width: ${288}px; }`;
export const bad = `:root { --ds-layout-sidebar-width: 1px; }`;
