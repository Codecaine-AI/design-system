import { cn } from "../../../../lib/cn";

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside className={cn("ds-sidebar", collapsed && "is-collapsed")}>
      <button className="ds-sidebar-toggle" type="button" />
    </aside>
  );
}
