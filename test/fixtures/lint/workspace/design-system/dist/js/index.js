export const cssVar = (path) => `var(--ds-${path.replaceAll(".", "-")})`;
