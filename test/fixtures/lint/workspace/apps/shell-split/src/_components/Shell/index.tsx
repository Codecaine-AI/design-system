import { cn } from "@/lib/cn";
import { Sidebar } from "./_components/Sidebar";

export function Shell({ wide }: { wide: boolean }) {
  return (
    <div className="ds-shell">
      <Sidebar collapsed={false} />
      <div className={`ds-workspace ${wide ? "is-wide" : ""}`}>
        <header className="ds-topbar" />
        <main className={cn("ds-main")} />
      </div>
    </div>
  );
}
