// Codemod review fixture, round 3 (P1-6): paint inside an SVG mask, clipPath or a pattern a mask uses is not color (canvas-renderer shape-previews).
export const Preview = ({ maskId, box }: { maskId: string; box: number }) => (
  <svg>
    <defs>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={box} height={box}>
        <rect width={box} height={box} fill="white" />
      </mask>
      <clipPath id="clip"><rect fill="#ffffff" /></clipPath>
      <pattern id="hatch"><path stroke="#000000" /></pattern>
      <pattern id="dots"><circle fill="#e6e5e3" /></pattern>
    </defs>
    <mask id="cut"><rect fill="url(#hatch)" /></mask>
    <rect fill="white" />
  </svg>
);
