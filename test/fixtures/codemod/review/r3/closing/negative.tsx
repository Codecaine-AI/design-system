// Codemod review fixture, round-3 close (R3-B3): a leading `-` negates the value; only spacing roots have a negative utility.
export const A = () => <div className="-z-[40] z-[40] -tracking-[0.09em] tracking-[-0.02em] -top-[4px] -mt-[8px]" />;
