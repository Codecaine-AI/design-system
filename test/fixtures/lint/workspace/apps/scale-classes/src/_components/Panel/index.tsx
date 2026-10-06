import { cn } from "@/lib/cn";

const MODE = "blur";

export function Panel({ open }: { open: boolean }) {
  return (
    <section className="bg-panel shadow rounded max-w-2xl animate-spin" data-mode={MODE} title="shadow">
      <b>Note</b> <span className="text-gray-500 leading-6">x</span>
      <div className={cn("drop-shadow", open && "backdrop-blur")} />
      <p className={`inset-shadow ${open ? "blur" : ""}`}>y</p>
    </section>
  );
}
