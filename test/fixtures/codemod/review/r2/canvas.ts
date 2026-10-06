// Codemod review fixture, round 2: canvas 2D assignments through ternaries, || and ??, and gradient stops.
export function paint(ctx: CanvasRenderingContext2D, showBoard: boolean, pen: { color?: string }, on: boolean) {
  ctx.fillStyle = showBoard ? "#fbf9f1" : "#ffffff";
  ctx.strokeStyle = pen.color || "#ffffff";
  ctx.shadowColor = pen.color ?? "#e6e5e3";
  ctx.fillStyle = on
    ? "#ffffff"
    : "#e6e5e3";
  const g = ctx.createLinearGradient(0, 0, 1, 1);
  g.addColorStop(0, on ? "#ffffff" : "#e6e5e3");
}
