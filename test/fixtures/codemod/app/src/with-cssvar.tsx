// Codemod fixture: a file that already imports cssVar from the package.
import { cssVar } from "@codecaine-ai/design-system";

export const chipStyle = { fontSize: 12, background: "#ebebe9", border: "1px solid #e6e5e3" };
export const dot = cssVar("color.accent");
