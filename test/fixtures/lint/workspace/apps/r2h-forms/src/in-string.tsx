import { createRoot } from "react-dom/client";
import { Shell } from "./_components/Shell";

// <Shell /> in a comment and in a string renders nothing.
const usage = "<Shell>home</Shell>";
createRoot(document.getElementById("root")!).render(<main title={usage}>{String(Shell)}</main>);
