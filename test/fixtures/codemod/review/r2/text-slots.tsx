// Codemod review fixture, round 2: text, aria-label, title and alt are never styles.
export const Swatch = () => (
  <span aria-label="#ffffff" title="#e6e5e3">
    {"#2563eb"}
  </span>
);
export const Img = () => <img alt="#ffffff" src="x.png" />;
