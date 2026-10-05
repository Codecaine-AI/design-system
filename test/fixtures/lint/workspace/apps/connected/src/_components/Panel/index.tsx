import { cssVar } from "@codecaine-ai/design-system";
import "./styles.css";

export function Panel() {
  return (
    <section className="panel bg-panel text-ui-sm rounded-pill font-medium" style={{ gap: cssVar("space.2") }}>
      Tokens only
    </section>
  );
}
