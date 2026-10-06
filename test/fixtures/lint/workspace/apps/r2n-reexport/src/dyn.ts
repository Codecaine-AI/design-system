export async function f() {
  const { cssVar } = await import("@codecaine-ai/design-system");
  return cssVar("color.surface.nope3");
}
export async function g() {
  const ds = await import("@codecaine-ai/design-system");
  return ds.cssVar("color.dyn.nope");
}
