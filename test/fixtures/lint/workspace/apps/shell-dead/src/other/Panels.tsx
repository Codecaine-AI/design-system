// Rendered beside the shell, not inside it: App does not import it.
export function Panels() {
  return (
    <>
      <aside className="ds-sidebar">
        <button className="ds-sidebar-toggle" type="button" />
      </aside>
      <div className="ds-workspace">
        <header className="ds-topbar" />
        <main className="ds-main" />
      </div>
    </>
  );
}
