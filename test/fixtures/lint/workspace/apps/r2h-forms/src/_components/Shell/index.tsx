import type { ReactNode } from "react";

export type ShellProps = { children?: ReactNode };

export function Shell({ children }: ShellProps) {
  return (
    <div className="ds-shell">
      <aside className="ds-sidebar">
        <button className="ds-sidebar-toggle" type="button" />
      </aside>
      <div className="ds-workspace">
        <header className="ds-topbar" />
        <main className="ds-main">{children}</main>
      </div>
    </div>
  );
}

export default Shell;
