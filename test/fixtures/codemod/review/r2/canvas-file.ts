// Codemod review fixture, round 2: in a file that draws on a canvas, a style-named object is not trusted.
export function draw(ctx: CanvasRenderingContext2D) {
  const textStyle = { color: "#ffffff" };
  ctx.fillStyle = textStyle.color;
}
