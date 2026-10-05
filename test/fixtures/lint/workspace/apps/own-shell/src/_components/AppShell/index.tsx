import type { ReactNode } from "react";

/** Written by hand, not copied from the template: complete .ds-shell markup. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="ds-shell">
      <aside className="ds-sidebar">
        <button className="ds-sidebar-toggle" type="button" aria-label="Toggle sidebar" />
      </aside>
      <div className="ds-workspace">
        <header className="ds-topbar">Own shell</header>
        <main className="ds-main">{children}</main>
      </div>
    </div>
  );
}
