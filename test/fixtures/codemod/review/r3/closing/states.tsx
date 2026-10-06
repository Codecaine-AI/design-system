// Codemod review fixture, round-3 close (R3-B3): class hints come from a template literal's static chunks, never its condition.
export const A = ({ selectedType }: any) => (
  <a className={`rounded border ${
    selectedType ? 'bg-[#ebebe9]' : 'bg-[#f7f7f5]'
  }`} />
);
export const B = () => <div className="bg-[#ebebe9] text-current" />;
export const C = () => <div className="border border-[#d3d1cb] drop-shadow-md" />;
export const D = ({ isSelected }: any) => (
  <div className={`border bg-[#ebebe9] ${
    isSelected ? "ring" : ""
  } px-2`} />
);
export const E = ({ isSelected }: any) => (
  <div className={`tab ${
    isSelected ? "x" : ""
  } px-2`} style={{ background: "#ebebe9" }} />
);
export const F = ({ on }: any) => <div className={`tab ${on ? "x" : ""} active`} style={{ background: "#ebebe9" }} />;
export const G = () => <div className="border-[#d3d1cb] border-current bg-transparent" />;
