import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Panels } from "./other/Panels";

createRoot(document.getElementById("root")!).render(<><App /><Panels /></>);
