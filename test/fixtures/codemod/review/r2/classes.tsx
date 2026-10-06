// Codemod review fixture, round 2: Tailwind classes outside class lists.
export const isBlue = (variant: string) => variant === "bg-blue-500";
export const tip = "Avoid text-[#ffffff] on light pages.";
export const Hint = () => <span aria-label="text-[#ffffff]" className="bg-blue-600 text-[#ffffff]" />;
export const Row = ({ on }: { on: boolean }) => <div className={`w-full rounded-[2px] text-[11px] ${
  on ? "bg-[#ffffff] text-[#ffffff]" : "bg-transparent"
}`} />;
