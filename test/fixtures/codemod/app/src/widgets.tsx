// Codemod fixture: Tailwind classes, inline styles, canvas and data objects.
export function Widgets() {
  return (
    <div className="w-[320px] text-[11px] rounded-[6px] bg-[#fdfdfd] aspect-[16/10]">
      <span className="text-neutral-900 bg-white/95 border-black/10 rounded-[999px]">A</span>
      <button className="hover:bg-[#f2f2f1] dark:bg-[#0d1117] text-neutral-900 text-neutral-900">B</button>
      <p style={{ fontSize: 13, borderRadius: "10px", color: "white" }}>C</p>
    </div>
  );
}

const GHOST = "#0078df";
const AGENT = "#8c2ef2";

export function paint(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#ffffff";
}

export const frame = { id: "root", type: "section", color: "white" };

export const Important = () => <i className="!text-[11px] bg-[#fdfdfd]!" />;
