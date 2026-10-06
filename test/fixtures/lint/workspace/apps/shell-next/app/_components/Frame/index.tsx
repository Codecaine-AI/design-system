export function Frame() {
  return (
    <div className="ds-shell">
      <aside className="ds-sidebar">
        <button className="ds-sidebar-toggle" type="button" />
      </aside>
      <div className="ds-workspace">
        <header className="ds-topbar" />
        <main className="ds-main" />
      </div>
    </div>
  );
}
