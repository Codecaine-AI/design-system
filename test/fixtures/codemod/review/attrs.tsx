// Codemod review fixture: JSX attribute values in a file that imports cssVar under an alias.
import { cssVar as dsVar } from "@codecaine-ai/design-system";

export const Icon = () => (
  <svg>
    <path fill="#ffffff" stroke="#e6e5e3" d="M0 0" />
  </svg>
);
export const chipStyle = { background: "#ebebe9", gap: dsVar("space.2") };
