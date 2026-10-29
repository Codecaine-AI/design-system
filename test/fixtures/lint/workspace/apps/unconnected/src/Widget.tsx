import { cssVar } from "@codecaine-ai/design-system";

export function Widget() {
  return (
    <div
      className="text-sm bg-red-500 rounded-lg text-ui-sm rounded-pill font-medium"
      style={{ padding: cssVar("space.2"), color: cssVar("color.nope") }}
    >
      <span style={{ transition: "opacity 150ms ease-out" }}>fades</span>
      <span className="transition ease-in ease-out">eases</span>
    </div>
  );
}
