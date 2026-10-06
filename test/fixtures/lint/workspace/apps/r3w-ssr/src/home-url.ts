// The host serves the app's design-system package under /@codecaine-ai/design-system/ (decision 30).
export function page(): string {
  return `<!doctype html>
<html><head>
<link rel="stylesheet" href="/@codecaine-ai/design-system/css/fonts.css">
<link rel="stylesheet" href="/@codecaine-ai/design-system/dist/css/tokens-dark-first.css">
</head><body>home</body></html>`;
}
