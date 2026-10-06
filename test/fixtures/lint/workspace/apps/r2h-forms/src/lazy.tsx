import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

const Frame = lazy(() => import("./_components/Shell"));

createRoot(document.getElementById("root")!).render(
  <Suspense fallback={null}>
    <Frame />
  </Suspense>,
);
