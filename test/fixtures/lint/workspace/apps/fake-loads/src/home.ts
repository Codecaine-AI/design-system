// A server-rendered page: the module returns the whole HTML document.
export function renderHome(): string {
  return `<!doctype html>
<html><head>
<style>@import url("@codecaine-ai/design-system/fonts.css")</style>
<link rel="stylesheet" href="@codecaine-ai/design-system/tokens.css">
</head><body>home</body></html>`;
}
