// Codemod review fixture, round 3 (P1-7): a state attribute counts only by its own static value (canvas-renderer ShapesPanel).
export const Panel = ({ exiting }: { exiting: boolean }) => (
  <div
    data-shapes-panel=""
    data-state={exiting ? "closing" : "open"}
    onAnimationEnd={() => undefined}
    style={{
      background: "#FFFFFF",
    }}
  />
);
export const On = () => <div aria-selected="true" style={{ background: "#ebebe9" }} />;
export const Off = () => <div aria-selected="false" style={{ background: "#ebebe9" }} />;
