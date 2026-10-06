import { createRoot } from "react-dom/client";
import type { ShellProps } from "./_components/Shell";

const props: ShellProps = {};
createRoot(document.getElementById("root")!).render(<main {...props}>plain</main>);
