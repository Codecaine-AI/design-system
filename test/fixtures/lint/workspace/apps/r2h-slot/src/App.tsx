import { Shell } from "./_components/Shell";
import { Sidebar } from "./_components/Sidebar";

// Slot composition: App fills the shell's sidebar slot; Shell does not import Sidebar.
export function App() {
  return <Shell sidebar={<Sidebar />}>home</Shell>;
}
