import type { ReactNode } from "react";

export function Shell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="ds-shell">
      {sidebar}
      <div className="ds-workspace">
        <header className="ds-topbar" />
        <main className="ds-main">{children}</main>
      </div>
    </div>
  );
}
