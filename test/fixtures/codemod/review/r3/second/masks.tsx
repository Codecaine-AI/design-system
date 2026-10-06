// Codemod review fixture, round 3 second pass (P1-6, P2-10): a mask with a style object; a gradient a mask uses.
export const A = () => (
  <svg>
    <defs>
      <linearGradient id="fade"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#000000" /></linearGradient>
      <mask id="m"><rect fill="url(#fade)" /></mask>
      <mask id="m2" style={{ maskType: "alpha" }}>
        <rect fill="#ffffff" />
      </mask>
      <linearGradient id="edge"><stop offset="0" stopColor="#e6e5e3" /></linearGradient>
    </defs>
    <rect fill="url(#edge)" />
  </svg>
);
