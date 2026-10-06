import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./_components/Shell";

createRoot(document.getElementById("root")!).render(createElement(Shell, null, "home"));
