// Codemod review fixture, round 3 second pass (P2-8): Tailwind not-* variants are not states.
export const A = () => <div className="not-hover:bg-[#f2f2f1] not-aria-selected:bg-[#ebebe9] aria-selected:bg-[#ebebe9]" />;
