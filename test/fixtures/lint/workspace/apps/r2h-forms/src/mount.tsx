import { createRoot } from "react-dom/client";

// No exports: importing this module runs it, and it renders the shell.
createRoot(document.getElementById("root")!).render(
  <div className="ds-shell">
    <aside className="ds-sidebar">
      <button className="ds-sidebar-toggle" type="button" />
    </aside>
    <div className="ds-workspace">
      <header className="ds-topbar" />
      <main className="ds-main" />
    </div>
  </div>,
);
