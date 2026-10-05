export function App() {
  return (
    <div className="ds-shell">
      <aside className="ds-sidebar">
        <button className="ds-sidebar-toggle" type="button" aria-label="Toggle sidebar" />
      </aside>
      <div className="ds-workspace">
        <main className="ds-main">No topbar</main>
      </div>
    </div>
  );
}
