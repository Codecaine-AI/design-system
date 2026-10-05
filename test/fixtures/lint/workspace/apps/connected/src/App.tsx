import { Panel } from "./_components/Panel";

export function App() {
  return (
    <div className="ds-shell">
      <aside className="ds-sidebar">
        <button className="ds-sidebar-toggle" type="button" aria-label="Toggle sidebar" />
      </aside>
      <div className="ds-workspace">
        <header className="ds-topbar">Connected</header>
        <main className="ds-main">
          <Panel />
        </main>
      </div>
    </div>
  );
}
