// The fixture theme switch: ?theme=dark sets data-theme="dark" on <html>, the design system's theme switch.
// A fixture with "themes": ["light", "dark"] in fixture.json loads it with <script src="../theme.js"></script> in <head>.
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
