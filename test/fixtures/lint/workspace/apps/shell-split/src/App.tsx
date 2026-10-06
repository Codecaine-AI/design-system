import { lazy } from "react";

const Shell = lazy(() => import("@/_components/Shell").then((m) => ({ default: m.Shell })));

export function App() {
  return <Shell wide />;
}
