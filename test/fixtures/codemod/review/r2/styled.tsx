// Codemod review fixture, round 2: styled templates with type arguments and interpolated functions; typed class fields.
import type { CSSProperties } from "react";
declare const styled: { div: <P>(s: TemplateStringsArray, ...a: unknown[]) => P };
export const Box = styled.div<{ $on: boolean }>`
  color: #ffffff;
  background: ${({ $on }: { $on: boolean }) => ($on ? "#ffffff" : "#e6e5e3")};
`;
export class Panel {
  private boxStyle: CSSProperties = { color: "#ffffff" };
  private settings = { color: "#ffffff" };
  read() { return [this.boxStyle, this.settings]; }
}
